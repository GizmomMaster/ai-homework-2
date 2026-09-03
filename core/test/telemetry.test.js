import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createDatabase } from "../src/db/database.js";
import { runInJob, nextTurn, markSeen } from "../src/telemetry/context.js";
import { initTelemetry, recordToolCall } from "../src/telemetry/recorder.js";
import { InstrumentedLlmRunner } from "../src/telemetry/InstrumentedLlmRunner.js";
import { estimateCostUsd } from "../src/telemetry/pricing.js";

describe("telemetry/context", () => {
  it("вне runInJob turn/markSeen безопасно ничего не делают", () => {
    assert.equal(nextTurn(), 0);
    assert.equal(markSeen("x"), false);
  });

  it("turn растёт монотонно внутри одного задания", async () => {
    await runInJob({ jobId: "j1", conversationId: 1 }, async () => {
      assert.equal(nextTurn(), 1);
      assert.equal(nextTurn(), 2);
      assert.equal(nextTurn(), 3);
    });
  });

  it("каждое задание получает свой собственный счётчик и набор увиденного", async () => {
    await runInJob({ jobId: "j1", conversationId: 1 }, async () => {
      nextTurn();
      assert.equal(markSeen("привет"), false);
    });
    await runInJob({ jobId: "j2", conversationId: 1 }, async () => {
      assert.equal(nextTurn(), 1, "новое задание начинает счёт заново");
      assert.equal(markSeen("привет"), false, "и не помнит строки из прошлого задания");
    });
  });

  it("markSeen отличает первую и повторную отправку одной строки", async () => {
    await runInJob({ jobId: "j1", conversationId: 1 }, async () => {
      assert.equal(markSeen("текст"), false);
      assert.equal(markSeen("текст"), true);
      assert.equal(markSeen("другой текст"), false);
    });
  });
});

describe("telemetry/pricing", () => {
  it("считает стоимость по цене за миллион токенов", () => {
    const cost = estimateCostUsd({
      promptTokens: 1_000_000,
      completionTokens: 500_000,
      pricing: { inputPerMillion: 3, outputPerMillion: 15 },
    });
    assert.equal(cost, 3 + 7.5);
  });

  it("нулевые цены дают нулевую стоимость", () => {
    const cost = estimateCostUsd({
      promptTokens: 100,
      completionTokens: 100,
      pricing: { inputPerMillion: 0, outputPerMillion: 0 },
    });
    assert.equal(cost, 0);
  });
});

describe("telemetry/recorder + InstrumentedLlmRunner", () => {
  let db;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initTelemetry(db, { pricing: { inputPerMillion: 1, outputPerMillion: 2 } });
  });

  it("InstrumentedLlmRunner прозрачно проксирует chat() и пишет строку в llm_calls", async () => {
    const inner = {
      async chat(messages, options) {
        assert.deepEqual(options, { temperature: 0 });
        return { content: "ответ", promptTokens: 100, completionTokens: 20, reasoningTokens: 5 };
      },
    };
    const runner = new InstrumentedLlmRunner(inner, {
      agentId: "router",
      stage: "routing",
      provider: "lmstudio",
      model: "bonsai-27b",
    });

    let result;
    await runInJob({ jobId: "job-1", conversationId: 42 }, async () => {
      result = await runner.chat(
        [
          { role: "system", content: "ты маршрутизатор" },
          { role: "user", content: "какая цена BTC?" },
        ],
        { temperature: 0 },
      );
    });

    assert.equal(result.content, "ответ");

    const rows = db.prepare("SELECT * FROM llm_calls").all();
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.job_id, "job-1");
    assert.equal(row.agent_id, "router");
    assert.equal(row.stage, "routing");
    assert.equal(row.turn_number, 1);
    assert.equal(row.provider, "lmstudio");
    assert.equal(row.model, "bonsai-27b");
    assert.equal(row.prompt_tokens, 100);
    assert.equal(row.completion_tokens, 20);
    assert.equal(row.reasoning_tokens, 5);
    assert.equal(row.repeated_prompt_tokens_estimate, 0, "первый вызов задания — всё ново");
    assert.equal(row.ok, 1);
    assert.ok(row.estimated_cost_usd > 0);
  });

  it("вторая отправка той же строки в том же задании считается повторной", async () => {
    const inner = {
      async chat() {
        return { content: "ответ", promptTokens: 50, completionTokens: 10 };
      },
    };
    const router = new InstrumentedLlmRunner(inner, {
      agentId: "router",
      stage: "routing",
      provider: "lmstudio",
      model: "m",
    });
    const planner = new InstrumentedLlmRunner(inner, {
      agentId: "planner",
      stage: "planning",
      provider: "lmstudio",
      model: "m",
    });

    const sharedHistory = { role: "user", content: "покажи цену ETH" };

    await runInJob({ jobId: "job-2", conversationId: 1 }, async () => {
      await router.chat([{ role: "system", content: "роутер" }, sharedHistory]);
      // Планировщик получает другой системный промпт, но ту же реплику
      // пользователя — она уже "увидена" в этом задании.
      await planner.chat([{ role: "system", content: "планировщик" }, sharedHistory]);
    });

    const rows = db.prepare("SELECT agent_id, repeated_prompt_tokens_estimate FROM llm_calls ORDER BY id").all();
    assert.equal(rows[0].agent_id, "router");
    assert.equal(rows[0].repeated_prompt_tokens_estimate, 0);
    assert.equal(rows[1].agent_id, "planner");
    assert.ok(
      rows[1].repeated_prompt_tokens_estimate > 0,
      "повторная реплика пользователя должна попасть в repeated_prompt_tokens_estimate",
    );
  });

  it("ошибка внутреннего раннера тоже записывается и пробрасывается дальше", async () => {
    const failure = Object.assign(new Error("нет ответа"), { code: "llm_timeout" });
    const inner = {
      async chat() {
        throw failure;
      },
    };
    const runner = new InstrumentedLlmRunner(inner, {
      agentId: "theory",
      stage: "answering",
      provider: "ollama",
      model: "qwen3:8b",
    });

    await runInJob({ jobId: "job-3", conversationId: 1 }, async () => {
      await assert.rejects(() => runner.chat([{ role: "user", content: "x" }]), failure);
    });

    const row = db.prepare("SELECT * FROM llm_calls WHERE job_id = 'job-3'").get();
    assert.equal(row.ok, 0);
    assert.equal(row.error_code, "llm_timeout");
    assert.equal(row.prompt_tokens, 0);
  });

  it("recordToolCall пишет строку в tool_calls в том же задании", async () => {
    await runInJob({ jobId: "job-4", conversationId: 1 }, async () => {
      recordToolCall({
        toolName: "get_crypto_current_price",
        stepNumber: 1,
        inputSize: 20,
        outputSize: 200,
        outputTokensEstimate: 70,
        durationMs: 120,
        ok: true,
      });
    });

    const row = db.prepare("SELECT * FROM tool_calls WHERE job_id = 'job-4'").get();
    assert.equal(row.tool_name, "get_crypto_current_price");
    assert.equal(row.turn_number, 1);
    assert.equal(row.ok, 1);
  });
});
