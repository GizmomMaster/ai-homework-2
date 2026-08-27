import { LLM_ERROR, LlmError } from "./LlmRunner.js";

/** @typedef {import("./LlmRunner.js").LlmRunner} LlmRunner */
/** @typedef {import("./LlmRunner.js").ChatMessage} ChatMessage */
/** @typedef {import("./LlmRunner.js").ChatResult} ChatResult */

/**
 * Реализация LlmRunner поверх Ollama HTTP API (эндпоинт /api/chat).
 * Используется /api/chat, а не /api/generate: позволяет передать модели
 * полную историю сессии и получить честную статистику по токенам
 * (`prompt_eval_count`/`eval_count`) для отслеживания контекстного окна.
 * @implements {LlmRunner}
 */
export class OllamaRunner {
  /**
   * @param {{ baseUrl: string, model: string, numCtx?: number, timeoutMs?: number }} options
   */
  constructor({ baseUrl, model, numCtx, timeoutMs }) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.model = model;
    this.numCtx = numCtx;
    this.timeoutMs = timeoutMs;
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
          // Без явного num_ctx Ollama берёт контекст модели по умолчанию
          // (часто заметно меньше нашего лимита) и молча обрезает старые
          // сообщения истории — счётчик токенов тогда не растёт до лимита,
          // а колеблется. Задаём num_ctx = наш лимит.
          ...(this.numCtx ? { options: { num_ctx: this.numCtx } } : {}),
        }),
        // Без таймаута зависший запрос держал бы задание в работе бессрочно.
        signal: this.timeoutMs ? AbortSignal.timeout(this.timeoutMs) : undefined,
      });
    } catch (error) {
      if (error.name === "TimeoutError" || error.name === "AbortError") {
        throw new LlmError(
          LLM_ERROR.timeout,
          `Ollama не ответила за ${this.timeoutMs} мс. Возможно, модель слишком тяжёлая ` +
            `для этой машины или значение OLLAMA_TIMEOUT_MS слишком мало.`,
        );
      }
      throw new LlmError(
        LLM_ERROR.unavailable,
        `Не удалось подключиться к Ollama по адресу ${this.baseUrl}. ` +
          `Убедитесь, что Ollama запущена. Причина: ${error.message}`,
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new LlmError(
        LLM_ERROR.unavailable,
        `Ollama вернула ошибку ${response.status} ${response.statusText}: ${text}`,
      );
    }

    const data = await response.json();
    if (!data.message || typeof data.message.content !== "string") {
      throw new LlmError(LLM_ERROR.badResponse, "Некорректный формат ответа от Ollama.");
    }

    return {
      content: data.message.content,
      promptTokens: data.prompt_eval_count ?? 0,
      completionTokens: data.eval_count ?? 0,
    };
  }
}
