import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { recordLlmCall, recordToolCall, isTelemetryEnabled } from "../src/telemetry/recorder.js";

/**
 * Отдельный файл: node --test запускает каждый файл в своём процессе, а
 * recorder.js — модуль-синглтон (как logger.js). Только так можно проверить
 * поведение ДО initTelemetry() — в telemetry.test.js он уже вызван в
 * beforeEach для других проверок.
 */
describe("telemetry/recorder без initTelemetry", () => {
  it("isTelemetryEnabled() говорит false", () => {
    assert.equal(isTelemetryEnabled(), false);
  });

  it("recordLlmCall и recordToolCall молча ничего не делают", () => {
    assert.doesNotThrow(() =>
      recordLlmCall({
        agentId: "router",
        stage: "routing",
        provider: "lmstudio",
        model: "m",
        messages: [{ role: "user", content: "x" }],
        promptTokens: 1,
        completionTokens: 1,
        latencyMs: 1,
        ok: true,
      }),
    );
    assert.doesNotThrow(() =>
      recordToolCall({
        toolName: "get_crypto_current_price",
        inputSize: 1,
        outputSize: 1,
        outputTokensEstimate: 1,
        durationMs: 1,
        ok: true,
      }),
    );
  });
});
