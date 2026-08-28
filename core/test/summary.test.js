import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SUMMARY_PROMPT,
  SUMMARY_TEMPERATURE,
  SummaryAgent,
  buildBrief,
} from "../src/agents/SummaryAgent.js";
import { THEORY_TEMPERATURE } from "../src/agents/TheoryAgent.js";
import { compactForPrompt } from "../src/domain/compactForPrompt.js";
import { createFakeLlmRunner } from "./helpers.js";

/** Ряд свечей заданной длины с растущей ценой. */
function candles(count) {
  return Array.from({ length: count }, (_, i) => ({
    openTime: 1_700_000_000_000 + i * 3_600_000,
    open: 100 + i,
    high: 105 + i,
    low: 95 + i,
    close: 102 + i,
    volume: 10,
    quoteVolume: 1000,
    trades: 50,
  }));
}

describe("сжатие данных для промпта", () => {
  describe("свечи", () => {
    it("длинный ряд заменяется сводкой", () => {
      const compact = compactForPrompt({ symbol: "BTCUSDT", candles: candles(500) });

      assert.equal(compact.candles, undefined, "сырой ряд в промпт не уходит");
      assert.equal(compact.candlesSummary.count, 500);
      assert.equal(compact.candlesSummary.open, 100);
      assert.equal(compact.candlesSummary.close, 601);
    });

    it("считает экстремумы и объёмы у себя, а не поручает модели", () => {
      // Арифметика на языковой модели — худший из способов её выполнить.
      const compact = compactForPrompt({ candles: candles(100) });

      assert.equal(compact.candlesSummary.high, 204);
      assert.equal(compact.candlesSummary.low, 95);
      assert.equal(compact.candlesSummary.totalVolume, 1000);
      assert.equal(compact.candlesSummary.totalQuoteVolume, 100000);
    });

    it("оставляет опорные точки, включая первую и последнюю", () => {
      const compact = compactForPrompt({ candles: candles(500) });

      assert.equal(compact.candlesSample.length, 10);
      assert.equal(compact.candlesSample[0].close, 102);
      assert.equal(compact.candlesSample.at(-1).close, 601);
    });

    it("короткий ряд оставляет как есть — сжимать нечего", () => {
      const compact = compactForPrompt({ candles: candles(4) });

      assert.equal(compact.candles.length, 4);
      assert.equal(compact.candlesSample, undefined);
    });

    it("пустой ряд не роняет расчёт", () => {
      assert.deepEqual(compactForPrompt({ candles: [] }).candlesSummary, { count: 0 });
    });

    it("считает изменение и размах в процентах", () => {
      const compact = compactForPrompt({ candles: candles(11) });

      assert.equal(compact.candlesSummary.changePercent, 12);
      assert.ok(compact.candlesSummary.rangePercent > 0);
    });
  });

  describe("прочие ряды", () => {
    it("длинный список обрезается с указанием остатка", () => {
      const pairs = Array.from({ length: 40 }, (_, i) => ({ symbol: `P${i}` }));

      const compact = compactForPrompt({ pairs });

      assert.equal(compact.pairs.length, 15);
      assert.equal(compact.pairsOmitted, 25);
    });

    it("короткий список проходит нетронутым", () => {
      const compact = compactForPrompt({ largestBids: [{ price: 1, qty: 2 }] });

      assert.equal(compact.largestBids.length, 1);
      assert.equal(compact.largestBidsOmitted, undefined);
    });

    it("скаляры не трогает", () => {
      assert.deepEqual(compactForPrompt({ symbol: "BTCUSDT", price: 1.5 }), {
        symbol: "BTCUSDT",
        price: 1.5,
      });
    });
  });
});

describe("задание для сводящего агента", () => {
  const steps = [
    { action: "Объём BTC", ok: true, value: { quoteVolume: 1000 } },
    { action: "Объём NOSUCH", ok: false, error: { code: "unknown_symbol" } },
  ];

  it("несёт вопрос пользователя, задачу и данные", () => {
    const brief = buildBrief({ question: "сравни объёмы", taskSummary: "Сравнение", steps });

    assert.match(brief, /ВОПРОС ПОЛЬЗОВАТЕЛЯ: сравни объёмы/);
    assert.match(brief, /ЗАДАЧА: Сравнение/);
    assert.match(brief, /quoteVolume/);
  });

  it("перечисляет и то, чего собрать не удалось", () => {
    // Без этого модель не узнает о пробеле и напишет отчёт как полный.
    const brief = buildBrief({ question: "?", taskSummary: "t", steps });

    assert.match(brief, /СОБРАТЬ НЕ УДАЛОСЬ:\n- Объём NOSUCH/);
  });

  it("не упоминает раздел о пробелах, когда всё удалось", () => {
    const brief = buildBrief({ question: "?", taskSummary: "t", steps: [steps[0]] });

    assert.doesNotMatch(brief, /НЕ УДАЛОСЬ/);
  });

  it("сжимает данные шага перед вставкой", () => {
    const brief = buildBrief({
      question: "?",
      taskSummary: "t",
      steps: [{ action: "свечи", ok: true, value: { candles: candles(500) } }],
    });

    assert.match(brief, /candlesSummary/);
    assert.ok(brief.length < 4000, `длина промпта ${brief.length}`);
  });
});

describe("SummaryAgent", () => {
  it("обращается к модели со своим промптом и температурой", async () => {
    const llmRunner = createFakeLlmRunner();

    await new SummaryAgent({ llmRunner }).summarize({
      question: "?",
      taskSummary: "t",
      steps: [],
    });

    assert.equal(llmRunner.calls[0][0].content, SUMMARY_PROMPT);
    assert.equal(llmRunner.options[0].temperature, SUMMARY_TEMPERATURE);
  });

  it("температура ниже, чем у теории: здесь важнее верность цифрам", () => {
    assert.ok(SUMMARY_TEMPERATURE < THEORY_TEMPERATURE);
    assert.ok(SUMMARY_TEMPERATURE > 0);
  });

  it("истории диалога не видит — числа из прошлых отчётов спутать нечем", async () => {
    const llmRunner = createFakeLlmRunner();

    await new SummaryAgent({ llmRunner }).summarize({
      question: "вопрос",
      taskSummary: "t",
      steps: [],
    });

    assert.equal(llmRunner.calls[0].length, 2, "только системное сообщение и задание");
  });

  describe("системный промпт", () => {
    it("запрещает любые числа, кроме данных", () => {
      assert.match(SUMMARY_PROMPT, /Не используй никаких чисел, кроме тех, что даны/);
    });

    it("требует оговорить неполноту данных", () => {
      assert.match(SUMMARY_PROMPT, /не делай вид, что вывод полный/);
    });

    it("требует начинать с ответа, а не с перечисления", () => {
      assert.match(SUMMARY_PROMPT, /Начни с ответа на заданный вопрос/);
    });
  });
});
