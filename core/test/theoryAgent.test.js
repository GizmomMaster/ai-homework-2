import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TextAgent } from "../src/agents/TextAgent.js";
import { THEORY_PROMPT, THEORY_TEMPERATURE, TheoryAgent } from "../src/agents/TheoryAgent.js";
import { ROUTER_PROMPT } from "../src/agents/RouterAgent.js";
import { createFakeLlmRunner } from "./helpers.js";

describe("TextAgent", () => {
  it("подставляет системное сообщение перед репликами", async () => {
    const llmRunner = createFakeLlmRunner();
    const agent = new TextAgent({ llmRunner, systemPrompt: "инструкция" });

    await agent.answer([{ role: "user", content: "вопрос" }]);

    assert.deepEqual(llmRunner.calls[0], [
      { role: "system", content: "инструкция" },
      { role: "user", content: "вопрос" },
    ]);
  });

  it("передаёт историю целиком — в отличие от маршрутизатора", async () => {
    const llmRunner = createFakeLlmRunner();
    const agent = new TextAgent({ llmRunner, systemPrompt: "инструкция" });
    const history = Array.from({ length: 20 }, (_, i) => ({ role: "user", content: `${i}` }));

    await agent.answer(history);

    assert.equal(llmRunner.calls[0].length, 21);
  });

  it("схему не запрашивает: нужен связный текст, а не JSON", async () => {
    const llmRunner = createFakeLlmRunner();

    await new TextAgent({ llmRunner, systemPrompt: "и", temperature: 0.7 }).answer([]);

    assert.equal(llmRunner.options[0].format, undefined);
    assert.equal(llmRunner.options[0].temperature, 0.7);
  });

  it("возвращает ответ модели вместе со счётчиками токенов", async () => {
    const llmRunner = createFakeLlmRunner({
      content: "текст",
      promptTokens: 300,
      completionTokens: 90,
    });

    assert.deepEqual(await new TextAgent({ llmRunner, systemPrompt: "и" }).answer([]), {
      content: "текст",
      promptTokens: 300,
      completionTokens: 90,
    });
  });
});

describe("TheoryAgent", () => {
  it("обращается к модели со своим промптом и ненулевой температурой", async () => {
    const llmRunner = createFakeLlmRunner();

    await new TheoryAgent({ llmRunner }).answer([{ role: "user", content: "что такое маржа?" }]);

    assert.equal(llmRunner.calls[0][0].content, THEORY_PROMPT);
    assert.equal(llmRunner.options[0].temperature, THEORY_TEMPERATURE);
  });

  it("температура не нулевая — иначе проза выходит однообразной", () => {
    assert.ok(THEORY_TEMPERATURE > 0 && THEORY_TEMPERATURE <= 1);
  });

  describe("системный промпт", () => {
    it("запрещает называть текущие рыночные значения", () => {
      // Ключевое требование ветки: доступа к данным у неё нет, а выдуманное
      // число трейдер примет за настоящее.
      assert.match(THEORY_PROMPT, /Не называй текущих котировок/);
    });

    it("требует признавать незнание", () => {
      assert.match(THEORY_PROMPT, /не знаешь точно/);
    });

    it("не путается с промптом маршрутизатора", () => {
      assert.notEqual(THEORY_PROMPT, ROUTER_PROMPT);
      assert.doesNotMatch(THEORY_PROMPT, /JSON/);
    });
  });
});
