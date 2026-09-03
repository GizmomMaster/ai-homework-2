import { recordLlmCall } from "./recorder.js";

/** @typedef {import("../llm/LlmRunner.js").LlmRunner} LlmRunner */

/**
 * Декоратор LlmRunner, который пишет телеметрию каждого chat() и не меняет
 * контракт — агенты (JsonAgent, TextAgent) не знают о его существовании.
 * Один экземпляр оборачивает раннер одного агента: agentId/stage заданы при
 * создании, а не выводятся из содержимого запроса, — так телеметрия верно
 * разносит токены по Router/Theory/Planner/Summary/MarketOverview, даже
 * если их системные промпты когда-нибудь станут похожи.
 * @implements {LlmRunner}
 */
export class InstrumentedLlmRunner {
  /**
   * @param {LlmRunner} inner
   * @param {{ agentId: string, stage: string, provider: string, model: string }} labels
   */
  constructor(inner, { agentId, stage, provider, model }) {
    this.inner = inner;
    this.agentId = agentId;
    this.stage = stage;
    this.provider = provider;
    this.model = model;
  }

  /**
   * @param {Array<{ role: string, content: string }>} messages
   * @param {object} [options]
   */
  async chat(messages, options) {
    const startedAt = Date.now();
    try {
      const result = await this.inner.chat(messages, options);
      recordLlmCall({
        agentId: this.agentId,
        stage: this.stage,
        provider: this.provider,
        model: this.model,
        messages,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        reasoningTokens: result.reasoningTokens ?? 0,
        latencyMs: Date.now() - startedAt,
        ok: true,
      });
      return result;
    } catch (error) {
      recordLlmCall({
        agentId: this.agentId,
        stage: this.stage,
        provider: this.provider,
        model: this.model,
        messages,
        promptTokens: 0,
        completionTokens: 0,
        latencyMs: Date.now() - startedAt,
        ok: false,
        errorCode: error.code ?? "unknown",
      });
      throw error;
    }
  }
}
