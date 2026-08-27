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
   * @param {{ baseUrl: string, model: string }} options
   */
  constructor({ baseUrl, model }) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.model = model;
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
