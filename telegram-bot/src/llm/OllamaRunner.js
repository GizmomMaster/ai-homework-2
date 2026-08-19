/** @typedef {import("./LlmRunner.js").LlmRunner} LlmRunner */

/**
 * Реализация LlmRunner поверх Ollama HTTP API (эндпоинт /api/generate).
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
   * @param {string} prompt
   * @returns {Promise<string>}
   */
  async generate(prompt) {
    let response;
    try {
      response = await fetch(`${this.baseUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          prompt,
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
    if (typeof data.response !== "string") {
      throw new Error("Некорректный формат ответа от Ollama.");
    }

    return data.response;
  }
}
