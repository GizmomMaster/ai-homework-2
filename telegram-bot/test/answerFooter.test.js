import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { answerFooter } from "../src/handlers/answerFooter.js";
import { markdownToTelegramHtml } from "../src/telegram/markdown.js";

const full = {
  promptTokens: 1180,
  completionTokens: 240,
  totalTokens: 1420,
  contextLimit: 16000,
  durationMs: 12400,
};

describe("подпись под ответом", () => {
  describe("состав", () => {
    it("показывает время и стоимость ответа", () => {
      const footer = answerFooter(full);

      assert.match(footer, /12\.4 с/);
      assert.match(footer, /1.420 токенов/, "сумма промпта и генерации");
    });

    it("складывает токены всех обращений к модели за задание", () => {
      // За один вопрос к модели ходят маршрутизатор, планировщик и сводящий
      // агент; показать только последнего значило бы занизить цену ответа.
      assert.match(answerFooter({ promptTokens: 900, completionTokens: 100 }), /1.000/);
    });

    it("без данных не показывается вовсе", () => {
      assert.equal(answerFooter(undefined), "");
      assert.equal(answerFooter({}), "");
    });

    it("не показывает остаток контекста — только время и стоимость ответа", () => {
      const footer = answerFooter(full);

      assert.doesNotMatch(footer, /tokens\)/);
      assert.doesNotMatch(footer, /16000/);
    });

    it("одно время, если модель не звали", () => {
      const footer = answerFooter({ promptTokens: 0, completionTokens: 0, durationMs: 2100 });

      assert.match(footer, /2\.1 с/);
      assert.doesNotMatch(footer, /токен/);
    });
  });

  describe("время", () => {
    it("до секунды — миллисекунды", () => {
      assert.match(answerFooter({ durationMs: 810 }), /810 мс/);
    });

    it("до минуты — секунды с десятой", () => {
      assert.match(answerFooter({ durationMs: 12400 }), /12\.4 с/);
    });

    it("дольше минуты — минуты и секунды", () => {
      assert.match(answerFooter({ durationMs: 94318 }), /1 мин 34 с/);
    });
  });

  describe("согласование числительных", () => {
    // Кириллица, а не \w: тот не покрывает русские буквы, зато прихватывает
    // подчёркивание — маркер курсива, которым подпись обёрнута.
    const word = (n) => answerFooter({ promptTokens: n }).match(/токен[а-я]*/)[0];

    it("единственное число", () => {
      for (const n of [1, 21, 81, 101]) assert.equal(word(n), "токен", `${n}`);
    });

    it("двойственное", () => {
      for (const n of [2, 3, 4, 22, 104]) assert.equal(word(n), "токена", `${n}`);
    });

    it("множественное", () => {
      for (const n of [5, 25, 1420]) assert.equal(word(n), "токенов", `${n}`);
    });

    it("второй десяток — исключение", () => {
      for (const n of [11, 12, 13, 14, 111]) assert.equal(word(n), "токенов", `${n}`);
    });
  });

  describe("разметка", () => {
    it("превращается в курсив, а не остаётся сырыми подчёркиваниями", () => {
      const html = markdownToTelegramHtml(answerFooter(full));

      assert.match(html, /^<i>/);
      assert.match(html, /<\/i>$/);
      assert.doesNotMatch(html, /_/);
    });
  });
});
