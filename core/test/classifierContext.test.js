import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { truncateForClassifier } from "../src/domain/classifierContext.js";

describe("truncateForClassifier", () => {
  it("не трогает короткие сообщения", () => {
    const history = [{ role: "user", content: "какая цена BTC?" }];
    assert.deepEqual(truncateForClassifier(history), history);
  });

  it("обрезает длинные сообщения и помечает обрезку многоточием", () => {
    const long = "а".repeat(500);
    const [result] = truncateForClassifier([{ role: "assistant", content: long }], {
      maxChars: 300,
    });
    assert.equal(result.content.length, 301);
    assert.equal(result.content.endsWith("…"), true);
    assert.equal(result.role, "assistant");
  });

  it("не мутирует исходный массив/сообщения", () => {
    const original = [{ role: "assistant", content: "а".repeat(500) }];
    const snapshot = JSON.stringify(original);
    truncateForClassifier(original, { maxChars: 10 });
    assert.equal(JSON.stringify(original), snapshot);
  });

  it("сообщение ровно на границе не обрезается", () => {
    const exact = "а".repeat(300);
    const [result] = truncateForClassifier([{ role: "user", content: exact }], { maxChars: 300 });
    assert.equal(result.content, exact);
  });
});
