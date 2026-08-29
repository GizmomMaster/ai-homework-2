import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_PLAN_STEPS,
  PlannerAgent,
  buildPlanSchema,
  buildPlannerPrompt,
  isPlan,
} from "../src/agents/PlannerAgent.js";
import { PlanExecutor } from "../src/domain/PlanExecutor.js";
import { renderReport } from "../src/domain/renderReport.js";
import { BinanceClient } from "../src/tools/BinanceClient.js";
import { createTools } from "../src/tools/index.js";
import { LLM_ERROR } from "../src/llm/LlmRunner.js";
import { createFakeLlmRunner } from "./helpers.js";

const tools = createTools({ binance: new BinanceClient({ baseUrl: "http://binance.test" }) });

const plan = {
  canExecute: true,
  taskSummary: "Сравнение объёмов",
  plan: [
    {
      action: "Объём BTCUSDT",
      toolToUse: "get_crypto_24h_ticker_stats",
      parameters: { symbol: "BTCUSDT" },
    },
  ],
  fallbackMessage: null,
};

function runnerReturning(value) {
  return createFakeLlmRunner({
    content: JSON.stringify(value),
    promptTokens: 900,
    completionTokens: 120,
  });
}

describe("PlannerAgent", () => {
  describe("схема плана", () => {
    const schema = buildPlanSchema(tools);

    it("перечисляет ровно те инструменты, что есть в реестре", () => {
      assert.deepEqual(
        schema.properties.plan.items.properties.toolToUse.enum,
        Object.keys(tools),
      );
    });

    it("ограничивает имена параметров объединением по всем инструментам", () => {
      const params = schema.properties.plan.items.properties.parameters.properties;
      for (const key of ["symbol", "interval", "limit", "startTime", "minVolumeUsd"]) {
        assert.ok(key in params, key);
      }
    });

    it("интервал свечей ограничен грамматикой, а не только проверкой", () => {
      const interval = schema.properties.plan.items.properties.parameters.properties.interval;
      assert.ok(Array.isArray(interval.enum) && interval.enum.includes("1h"));
    });

    it("не просит полей, которые спецификация требует, а исполнение не использует", () => {
      // reasoning, expectedOutput и executionEstimate убраны намеренно: они
      // удлиняют генерацию и ни на что не влияют.
      const step = schema.properties.plan.items.properties;
      for (const dropped of ["reasoning", "expectedOutput"]) {
        assert.ok(!(dropped in step), dropped);
      }
      assert.ok(!("executionEstimate" in schema.properties));
    });

    it("ставит потолок на число шагов", () => {
      assert.equal(schema.properties.plan.maxItems, MAX_PLAN_STEPS);
    });
  });

  describe("промпт", () => {
    const prompt = buildPlannerPrompt(tools);

    it("перечисляет все инструменты реестра с параметрами", () => {
      for (const [name, tool] of Object.entries(tools)) {
        assert.ok(prompt.includes(name), name);
        assert.ok(prompt.includes(tool.description), name);
      }
      assert.ok(prompt.includes("symbol"));
    });

    it("говорит, что шаги независимы: исполнитель запускает их одновременно", () => {
      assert.match(prompt, /одновременно/);
    });

    it("запрещает обещать выполнить позже", () => {
      assert.match(prompt, /не обещай/i);
    });
  });

  describe("разбор ответа", () => {
    it("возвращает план и потраченные токены", async () => {
      const llmRunner = runnerReturning(plan);

      const result = await new PlannerAgent({ llmRunner, tools }).plan({
        history: [],
        text: "объём BTC",
      });

      assert.equal(result.canExecute, true);
      assert.equal(result.plan.length, 1);
      assert.deepEqual(result.usage, { promptTokens: 900, completionTokens: 120 });
      assert.equal(result.truncated, false);
    });

    it("отсутствующий план — это пустой список, а не падение", async () => {
      const llmRunner = runnerReturning({
        canExecute: false,
        taskSummary: "Покупка BTC",
        fallbackMessage: "Торговые операции не поддерживаются.",
      });

      const result = await new PlannerAgent({ llmRunner, tools }).plan({ history: [], text: "?" });

      assert.deepEqual(result.plan, []);
      assert.equal(result.fallbackMessage, "Торговые операции не поддерживаются.");
    });

    it("слишком длинный план обрезается и помечается", async () => {
      const step = plan.plan[0];
      const llmRunner = runnerReturning({
        ...plan,
        plan: Array.from({ length: MAX_PLAN_STEPS + 4 }, () => step),
      });

      const result = await new PlannerAgent({ llmRunner, tools }).plan({ history: [], text: "?" });

      assert.equal(result.plan.length, MAX_PLAN_STEPS);
      assert.equal(result.truncated, true);
    });

    it("неразбираемый ответ — llm_bad_response", async () => {
      const llmRunner = createFakeLlmRunner({
        content: "не смог",
        promptTokens: 1,
        completionTokens: 1,
      });

      await assert.rejects(
        () => new PlannerAgent({ llmRunner, tools }).plan({ history: [], text: "?" }),
        (error) => {
          assert.equal(error.code, LLM_ERROR.badResponse);
          return true;
        },
      );
    });

    it("валидатор отвергает план без обязательных полей", () => {
      assert.equal(isPlan({ canExecute: true, taskSummary: "x" }), true);
      assert.equal(isPlan({ canExecute: "да", taskSummary: "x" }), false);
      assert.equal(isPlan({ canExecute: true }), false);
      assert.equal(isPlan({ canExecute: true, taskSummary: "x", plan: "нет" }), false);
      assert.equal(isPlan(null), false);
    });
  });
});

describe("PlanExecutor", () => {
  /** Реестр из одного инструмента, поведением которого управляет тест. */
  function toolbox(run) {
    return { probe: { description: "тест", parameters: {}, required: [], run } };
  }

  it("выполняет все шаги и сохраняет их порядок", async () => {
    const executor = new PlanExecutor({
      tools: toolbox(async ({ n }) => ({ n })),
    });

    const result = await executor.run([
      { action: "первый", toolToUse: "probe", parameters: { n: 1 } },
      { action: "второй", toolToUse: "probe", parameters: { n: 2 } },
      { action: "третий", toolToUse: "probe", parameters: { n: 3 } },
    ]);

    assert.deepEqual(result.steps.map((s) => s.value.n), [1, 2, 3]);
    assert.deepEqual(result.steps.map((s) => s.stepNumber), [1, 2, 3]);
    assert.equal(result.succeeded, 3);
  });

  it("порядок сохраняется, даже когда шаги завершаются вразнобой", async () => {
    const executor = new PlanExecutor({
      tools: toolbox(async ({ delay, n }) => {
        await new Promise((r) => setTimeout(r, delay));
        return { n };
      }),
    });

    const result = await executor.run([
      { action: "медленный", toolToUse: "probe", parameters: { delay: 30, n: 1 } },
      { action: "быстрый", toolToUse: "probe", parameters: { delay: 0, n: 2 } },
    ]);

    assert.deepEqual(result.steps.map((s) => s.value.n), [1, 2]);
  });

  it("шаги идут одновременно, а не по очереди", async () => {
    let running = 0;
    let peak = 0;
    const executor = new PlanExecutor({
      tools: toolbox(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 20));
        running -= 1;
        return {};
      }),
    });

    await executor.run(
      Array.from({ length: 6 }, (_, i) => ({ action: `${i}`, toolToUse: "probe" })),
    );

    assert.ok(peak > 1, "шаги выполнялись последовательно");
  });

  it("одновременных запросов не больше трёх — квота биржи общая на адрес", async () => {
    let running = 0;
    let peak = 0;
    const executor = new PlanExecutor({
      tools: toolbox(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 20));
        running -= 1;
        return {};
      }),
    });

    await executor.run(
      Array.from({ length: 8 }, (_, i) => ({ action: `${i}`, toolToUse: "probe" })),
    );

    assert.ok(peak <= 3, `одновременно выполнялось ${peak}`);
  });

  it("упавший шаг не мешает остальным", async () => {
    const executor = new PlanExecutor({
      tools: toolbox(async ({ fail }) => {
        if (fail) throw new Error("сломалось");
        return { ok: true };
      }),
    });

    const result = await executor.run([
      { action: "хороший", toolToUse: "probe", parameters: {} },
      { action: "плохой", toolToUse: "probe", parameters: { fail: true } },
    ]);

    assert.equal(result.succeeded, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.steps[0].ok, true);
    assert.equal(result.steps[1].ok, false);
    assert.equal(typeof result.steps[1].error.code, "string");
  });

  it("несуществующий инструмент — отказ шага, а не падение плана", async () => {
    const executor = new PlanExecutor({ tools: toolbox(async () => ({})) });

    const result = await executor.run([{ action: "?", toolToUse: "выдуманный" }]);

    assert.equal(result.steps[0].ok, false);
    assert.equal(result.failed, 1);
  });

  it("пустой план не ломает исполнителя", async () => {
    const executor = new PlanExecutor({ tools: toolbox(async () => ({})) });

    assert.deepEqual(await executor.run([]), { steps: [], succeeded: 0, failed: 0 });
  });

  describe("промежуточный статус (onStep)", () => {
    it("вызывается на каждый завершённый шаг", async () => {
      const executor = new PlanExecutor({ tools: toolbox(async () => ({})) });
      const seen = [];

      await executor.run(
        [
          { action: "первый", toolToUse: "probe" },
          { action: "второй", toolToUse: "probe" },
        ],
        { onStep: (step) => seen.push(step) },
      );

      assert.equal(seen.length, 2);
      assert.deepEqual(
        seen.map((s) => s.action),
        ["первый", "второй"],
      );
      assert.ok(seen.every((s) => s.totalSteps === 2));
    });

    it("сообщает нарастающий счётчик завершённых шагов", async () => {
      const executor = new PlanExecutor({
        tools: toolbox(async ({ delay }) => {
          await new Promise((r) => setTimeout(r, delay ?? 0));
          return {};
        }),
      });
      const counts = [];

      await executor.run(
        [
          { action: "медленный", toolToUse: "probe", parameters: { delay: 20 } },
          { action: "быстрый", toolToUse: "probe", parameters: { delay: 0 } },
        ],
        { onStep: (step) => counts.push(step.completedCount) },
      );

      assert.deepEqual(counts, [1, 2]);
    });

    it("сообщает исход шага (ok/отказ)", async () => {
      const executor = new PlanExecutor({
        tools: toolbox(async ({ fail }) => {
          if (fail) throw new Error("сломалось");
          return {};
        }),
      });
      const seen = [];

      await executor.run(
        [
          { action: "хороший", toolToUse: "probe", parameters: {} },
          { action: "плохой", toolToUse: "probe", parameters: { fail: true } },
        ],
        { onStep: (step) => seen.push(step) },
      );

      assert.equal(seen.find((s) => s.action === "хороший").ok, true);
      assert.equal(seen.find((s) => s.action === "плохой").ok, false);
    });

    it("необязателен — план выполняется и без него", async () => {
      const executor = new PlanExecutor({ tools: toolbox(async () => ({})) });

      const result = await executor.run([{ action: "?", toolToUse: "probe" }]);

      assert.equal(result.succeeded, 1);
    });
  });
});

describe("сборка отчёта", () => {
  it("выносит задачу заголовком, а шаги — разделами", () => {
    const text = renderReport({
      taskSummary: "Цена BTC",
      steps: [{ action: "Текущая цена", ok: true, value: { symbol: "BTCUSDT", price: 79363.81 } }],
    });

    assert.match(text, /\*\*Цена BTC\*\*/);
    assert.match(text, /\*\*Текущая цена\*\*/);
    assert.match(text, /пара: BTCUSDT/);
  });

  it("переводит имена полей и разделяет разряды", () => {
    const text = renderReport({
      taskSummary: "t",
      steps: [{ action: "a", ok: true, value: { quoteVolume: 1409346861.106 } }],
    });

    assert.match(text, /объём, USDT: 1 409 346 861\.11/);
  });

  it("не разделяет разряды в дробной части", () => {
    const text = renderReport({
      taskSummary: "t",
      steps: [{ action: "a", ok: true, value: { imbalance: -0.2145 } }],
    });

    assert.match(text, /дисбаланс: -0\.2145/);
  });

  it("сохраняет значащие цифры у дешёвых активов", () => {
    const text = renderReport({
      taskSummary: "t",
      steps: [{ action: "a", ok: true, value: { price: 0.00001234 } }],
    });

    assert.match(text, /цена: 0\.00001234/);
  });

  it("объясняет отказ шага по-человечески", () => {
    const text = renderReport({
      taskSummary: "t",
      steps: [{ action: "Объём NOSUCH", ok: false, error: { code: "unknown_symbol" } }],
    });

    assert.match(text, /не знает такой торговой пары/);
  });

  it("оговаривает неполноту — иначе частичный отчёт читается как полный", () => {
    const text = renderReport({
      taskSummary: "t",
      steps: [
        { action: "a", ok: true, value: { price: 1 } },
        { action: "b", ok: false, error: { code: "timeout" } },
      ],
    });

    assert.match(text, /Данные неполные: 1 из 2/);
  });

  it("обрезает длинные списки", () => {
    const text = renderReport({
      taskSummary: "t",
      steps: [
        {
          action: "a",
          ok: true,
          value: { pairs: Array.from({ length: 30 }, (_, i) => ({ symbol: `P${i}` })) },
        },
      ],
    });

    assert.match(text, /…ещё 22/);
  });

  it("пропускает пустые поля, а не печатает null", () => {
    const text = renderReport({
      taskSummary: "t",
      steps: [{ action: "a", ok: true, value: { price: 1, bestBid: null, imbalance: undefined } }],
    });

    assert.doesNotMatch(text, /null|undefined/);
  });
});
