import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripThinking } from "../src/llm/stripThinking.js";

describe("stripThinking", () => {
  it("без блока размышления возвращает текст как есть и нулевые reasoningTokens", () => {
    assert.deepEqual(stripThinking("простой ответ"), {
      content: "простой ответ",
      reasoningTokens: 0,
    });
  });

  it("вырезает закрытый блок и оценивает его длину", () => {
    const result = stripThinking("<think>ага</think>Ответ");
    assert.equal(result.content, "Ответ");
    assert.ok(result.reasoningTokens > 0, "reasoningTokens должен быть положительным");
  });

  it("вырезает незакрытый блок при обрыве генерации", () => {
    const result = stripThinking("Ответ\n<think>не дописал");
    assert.equal(result.content, "Ответ");
    assert.ok(result.reasoningTokens > 0);
  });

  it("не считает закрытый блок дважды", () => {
    // Оба регэкспа матчатся на "<think>" независимо — эта проверка защищает
    // от регрессии, при которой закрытый блок засчитывается и как закрытый,
    // и как «незакрытый», задваивая reasoningTokens.
    const closed = stripThinking("<think>ага</think>Ответ").reasoningTokens;
    const asIfUnclosed = stripThinking("Ответ\n<think>ага").reasoningTokens;
    assert.ok(
      closed <= asIfUnclosed + 2,
      `закрытый блок (${closed}) не должен быть заметно длиннее сопоставимого незакрытого (${asIfUnclosed})`,
    );
  });

  it("несколько блоков размышления суммируются", () => {
    const one = stripThinking("<think>раз</think>Ответ").reasoningTokens;
    const two = stripThinking("<think>раз</think><think>два</think>Ответ").reasoningTokens;
    assert.ok(two > one, "два блока должны давать больше токенов, чем один");
  });
});
