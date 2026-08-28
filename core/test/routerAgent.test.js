import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ROUTER_CONTEXT_MESSAGES,
  ROUTER_INTENT,
  ROUTER_PROMPT,
  ROUTER_SCHEMA,
  RouterAgent,
  isRouterVerdict,
} from "../src/agents/RouterAgent.js";
import { LLM_ERROR } from "../src/llm/LlmRunner.js";
import { createFakeLlmRunner } from "./helpers.js";

const verdict = {
  intent: ROUTER_INTENT.taskRequest,
  isCryptoRelated: true,
  confidence: 0.9,
  topicSummary: "цена BTC",
  clarificationQuestion: null,
  outOfScopeReason: null,
};

/** Заглушка модели, отвечающая заданным JSON. */
function runnerReturning(value, tokens = { promptTokens: 700, completionTokens: 60 }) {
  return createFakeLlmRunner({ content: JSON.stringify(value), ...tokens });
}

describe("RouterAgent", () => {
  describe("обращение к модели", () => {
    it("подставляет системный промпт перед репликами", async () => {
      const llmRunner = runnerReturning(verdict);

      await new RouterAgent({ llmRunner }).classify({ history: [], text: "цена BTC?" });

      assert.deepEqual(llmRunner.calls[0], [
        { role: "system", content: ROUTER_PROMPT },
        { role: "user", content: "цена BTC?" },
      ]);
    });

    it("просит ответ по схеме и на нулевой температуре", async () => {
      const llmRunner = runnerReturning(verdict);

      await new RouterAgent({ llmRunner }).classify({ history: [], text: "цена BTC?" });

      assert.deepEqual(llmRunner.options[0], { format: ROUTER_SCHEMA, temperature: 0 });
    });

    it("показывает только хвост истории", async () => {
      const llmRunner = runnerReturning(verdict);
      const history = Array.from({ length: 20 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `реплика ${i}`,
      }));

      await new RouterAgent({ llmRunner }).classify({ history, text: "и что там?" });

      // Системное сообщение, хвост истории и новая реплика.
      const sent = llmRunner.calls[0];
      assert.equal(sent.length, 1 + ROUTER_CONTEXT_MESSAGES + 1);
      assert.equal(sent[1].content, "реплика 14");
      assert.equal(sent.at(-1).content, "и что там?");
    });

    it("короткую историю передаёт целиком", async () => {
      const llmRunner = runnerReturning(verdict);
      const history = [{ role: "user", content: "первый" }];

      await new RouterAgent({ llmRunner }).classify({ history, text: "второй" });

      assert.equal(llmRunner.calls[0].length, 3);
    });
  });

  describe("разбор вердикта", () => {
    it("возвращает поля вердикта и потраченные токены", async () => {
      const llmRunner = runnerReturning(verdict);

      const result = await new RouterAgent({ llmRunner }).classify({ history: [], text: "?" });

      assert.equal(result.intent, ROUTER_INTENT.taskRequest);
      assert.equal(result.topicSummary, "цена BTC");
      assert.deepEqual(result.usage, { promptTokens: 700, completionTokens: 60 });
    });

    it("неразбираемый ответ → код llm_bad_response", async () => {
      const llmRunner = createFakeLlmRunner({
        content: "извините, не понял",
        promptTokens: 1,
        completionTokens: 1,
      });

      await assert.rejects(
        () => new RouterAgent({ llmRunner }).classify({ history: [], text: "?" }),
        (error) => {
          assert.equal(error.code, LLM_ERROR.badResponse);
          return true;
        },
      );
    });

    it("выдуманный интент → код llm_bad_response", async () => {
      const llmRunner = runnerReturning({ ...verdict, intent: "SOMETHING_ELSE" });

      await assert.rejects(
        () => new RouterAgent({ llmRunner }).classify({ history: [], text: "?" }),
        (error) => {
          assert.equal(error.code, LLM_ERROR.badResponse);
          return true;
        },
      );
    });

    it("нехватка обязательных полей → код llm_bad_response", async () => {
      const llmRunner = runnerReturning({ intent: ROUTER_INTENT.outOfScope });

      await assert.rejects(
        () => new RouterAgent({ llmRunner }).classify({ history: [], text: "?" }),
        (error) => {
          assert.equal(error.code, LLM_ERROR.badResponse);
          return true;
        },
      );
    });
  });

  describe("схема и валидатор", () => {
    it("перечисление интентов в схеме совпадает с ROUTER_INTENT", () => {
      assert.deepEqual(
        [...ROUTER_SCHEMA.properties.intent.enum].sort(),
        Object.values(ROUTER_INTENT).sort(),
      );
    });

    it("промпт содержит правило, отобранное замером", () => {
      assert.match(ROUTER_PROMPT, /УТОЧНЯЮЩИЕ ПРАВИЛА/);
    });

    it("валидатор отвергает не-объекты", () => {
      for (const value of [null, "строка", 42, [verdict]]) {
        assert.equal(isRouterVerdict(value), false);
      }
    });
  });
});
