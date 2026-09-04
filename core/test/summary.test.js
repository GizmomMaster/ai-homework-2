import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SUMMARY_PROMPT,
  SUMMARY_TEMPERATURE,
  SummaryAgent,
  buildBrief,
  dedupeStepValues,
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

  it("передаёт причину отказа: она бывает содержательным ответом", () => {
    // «RSI считается только для BTC и ETH» — это то, что пользователь должен
    // прочитать. Без причины модель напишет размытое «данные получить не
    // удалось» и подменит ответ отговоркой.
    const brief = buildBrief({
      question: "RSI по SOL?",
      taskSummary: "RSI",
      steps: [
        {
          action: "RSI по SOL",
          ok: false,
          error: { code: "unsupported_asset", message: "Пока показатель RSI считается только для BTC и ETH." },
        },
      ],
    });

    assert.match(brief, /- RSI по SOL: Пока показатель RSI считается только для BTC и ETH\./);
  });

  it("не упоминает раздел о пробелах, когда всё удалось", () => {
    const brief = buildBrief({ question: "?", taskSummary: "t", steps: [steps[0]] });

    assert.doesNotMatch(brief, /НЕ УДАЛОСЬ/);
  });

  it("печатает данные без отступов: их читает модель, а платим за них мы", () => {
    // Отступы нужны человеку, разбирающему JSON глазами. Модели они не
    // говорят ничего, а стоят 13% длины на плоском объекте и 23% на
    // вложенном — при том что данные шагов и есть основная часть этого
    // промпта.
    const brief = buildBrief({
      question: "?",
      taskSummary: "t",
      steps: [{ action: "цена BTC", ok: true, value: { symbol: "BTCUSDT", price: 1, bid: 2 } }],
    });

    assert.match(brief, /\{"symbol":"BTCUSDT","price":1,"bid":2\}/);
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

describe("дедупликация полей между шагами", () => {
  it("убирает поле, уже показанное более ранним шагом по той же монете", () => {
    const steps = [
      { action: "цена BTC", ok: true, value: { symbol: "BTCUSDT", lastPrice: 65000, priceChangePercent: 1.2 } },
      { action: "статистика BTC", ok: true, value: { symbol: "BTCUSDT", priceChangePercent: 1.2, volume: 900 } },
    ];

    const [, second] = dedupeStepValues(steps);

    assert.equal(second.value.priceChangePercent, undefined, "повтор того же значения убран");
    assert.equal(second.value.volume, 900, "уникальное поле остаётся");
  });

  it("никогда не убирает symbol, даже если он совпадает у всех шагов", () => {
    const steps = [
      { action: "a", ok: true, value: { symbol: "ETHUSDT", price: 1 } },
      { action: "b", ok: true, value: { symbol: "ETHUSDT", volume: 2 } },
    ];

    const [, second] = dedupeStepValues(steps);

    assert.equal(second.value.symbol, "ETHUSDT");
  });

  it("не трогает поле, если значение у шагов разное", () => {
    const steps = [
      { action: "a", ok: true, value: { symbol: "SOLUSDT", priceChangePercent: 1.2 } },
      { action: "b", ok: true, value: { symbol: "SOLUSDT", priceChangePercent: 1.9 } },
    ];

    const [, second] = dedupeStepValues(steps);

    assert.equal(second.value.priceChangePercent, 1.9);
  });

  it("ловит пересечение между реальными инструментами, названное по-разному", () => {
    // get_crypto_current_price и get_crypto_24h_ticker_stats — настоящая
    // пара инструментов, ради которой дедуп и написан. Binance называет одно
    // и то же поле по-разному в двух эндпоинтах (lastPrice/price,
    // priceChangePercent/priceChangePercent24h, high/high24h, low/low24h) —
    // без учёта алиасов сравнение по точному имени поля не находит здесь
    // вообще ничего, хотя данные пересекаются на 4 поля из 7-8.
    const steps = [
      {
        action: "текущая цена BTC",
        ok: true,
        value: {
          symbol: "BTCUSDT",
          price: 65000,
          bid: 64990,
          ask: 65010,
          spreadPercent: 0.03,
          priceChangePercent24h: 1.8,
          high24h: 65800,
          low24h: 63900,
        },
      },
      {
        action: "суточная статистика BTC",
        ok: true,
        value: {
          symbol: "BTCUSDT",
          lastPrice: 65000,
          priceChangePercent: 1.8,
          weightedAvgPrice: 64500,
          volume: 42300,
          quoteVolume: 2_750_000_000,
          trades: 900000,
          high: 65800,
          low: 63900,
        },
      },
    ];

    const [, second] = dedupeStepValues(steps);

    assert.equal(second.value.lastPrice, undefined, "то же значение, что price в первом шаге");
    assert.equal(second.value.priceChangePercent, undefined, "то же значение, что priceChangePercent24h");
    assert.equal(second.value.high, undefined, "то же значение, что high24h");
    assert.equal(second.value.low, undefined, "то же значение, что low24h");
    assert.equal(second.value.weightedAvgPrice, 64500, "поле без пересечения остаётся");
    assert.equal(second.value.trades, 900000);
  });

  it("не дедуплицирует между разными монетами", () => {
    const steps = [
      { action: "a", ok: true, value: { symbol: "BTCUSDT", priceChangePercent: 1.2 } },
      { action: "b", ok: true, value: { symbol: "ETHUSDT", priceChangePercent: 1.2 } },
    ];

    const [, second] = dedupeStepValues(steps);

    assert.equal(second.value.priceChangePercent, 1.2);
  });

  it("неудачные шаги и шаги без symbol проходят без изменений", () => {
    const steps = [
      { action: "a", ok: false, error: { code: "upstream_error" } },
      { action: "b", ok: true, value: { quoteVolume: 1000 } },
    ];

    assert.deepEqual(dedupeStepValues(steps), steps);
  });

  it("buildBrief применяет дедуп: повтор не попадает в текст задания", () => {
    const brief = buildBrief({
      question: "сравни цену и объём BTC",
      taskSummary: "t",
      steps: [
        { action: "цена BTC", ok: true, value: { symbol: "BTCUSDT", priceChangePercent24h: 1.2 } },
        { action: "статистика BTC", ok: true, value: { symbol: "BTCUSDT", priceChangePercent24h: 1.2, trades: 500 } },
      ],
    });

    // priceChangePercent24h должен встретиться один раз, а не дважды.
    const occurrences = brief.split("priceChangePercent24h").length - 1;
    assert.equal(occurrences, 1);
    assert.match(brief, /trades/);
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
