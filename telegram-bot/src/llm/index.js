import { OllamaRunner } from "./OllamaRunner.js";

/** @typedef {import("./LlmRunner.js").LlmRunner} LlmRunner */

/**
 * Фабрика LLM-раннеров. Чтобы добавить новый локальный LLM-раннер:
 *   1. Создать src/llm/<Provider>Runner.js, реализующий LlmRunner (generate()).
 *   2. Добавить сюда одну ветку switch.
 *   3. Указать LLM_PROVIDER=<provider> в .env.
 * Логика бота (telegram/*, handlers/*) при этом не меняется.
 *
 * @param {import("../config.js").config} config
 * @returns {LlmRunner}
 */
export function createLlmRunner(config) {
  switch (config.llmProvider) {
    case "ollama":
      return new OllamaRunner({ ...config.ollama, numCtx: config.contextWindowTokens });
    default:
      throw new Error(`Неизвестный LLM_PROVIDER: "${config.llmProvider}"`);
  }
}
