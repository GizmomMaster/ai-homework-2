/** @typedef {import("./LlmRunner.js").LlmRunner} LlmRunner */
/** @typedef {import("./LlmRunner.js").ChatMessage} ChatMessage */
/** @typedef {import("./LlmRunner.js").ChatResult} ChatResult */

/**
 * Реализация LlmRunner поверх Ollama HTTP API (эндпоинт /api/chat).
 * Используется /api/chat, а не /api/generate, чтобы передавать модели
 * полную историю сообщений сессии и получать честную статистику по токенам
 * (`prompt_eval_count`/`eval_count`) для отслеживания контекстного окна.
 * @implements {LlmRunner}
 */
export class OllamaRunner {
  /**
   * @param {{ baseUrl: string, model: string, numCtx?: number }} options
   */
  constructor({ baseUrl, model, numCtx }) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.model = model;
    this.numCtx = numCtx;
  }

  /**
   * @param {ChatMessage[]} messages
   * @returns {Promise<ChatResult>}
   */
  async chat(messages) {
    let response;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: false,
          // Без явного num_ctx Ollama использует контекст модели по умолчанию
          // (часто заметно меньше нашего CONTEXT_WINDOW_TOKENS) и молча
          // обрезает старые сообщения истории, чтобы уместиться в него —
          // из-за этого счётчик токенов не растёт до настроенного лимита,
          // а колеблется/уменьшается. Задаём num_ctx = наш лимит, чтобы
          // модель реально держала в памяти окно нужного размера.
          ...(this.numCtx ? { options: { num_ctx: this.numCtx } } : {}),
        }),
      });
    } catch (error) {
      throw new Error(
        `Не удалось подключиться к Ollama по адресу ${this.baseUrl}. ` +
          `Убедитесь, что Ollama запущена. Причина: ${error.message}`,
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `Ollama вернула ошибку ${response.status} ${response.statusText}: ${text}`,
      );
    }

    const data = await response.json();
    if (!data.message || typeof data.message.content !== "string") {
      throw new Error("Некорректный формат ответа от Ollama.");
    }

    return {
      content: data.message.content,
      promptTokens: data.prompt_eval_count ?? 0,
      completionTokens: data.eval_count ?? 0,
    };
  }
}
