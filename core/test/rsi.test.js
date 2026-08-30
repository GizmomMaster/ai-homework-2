import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BinanceClient } from "../src/tools/BinanceClient.js";
import { TtlCache } from "../src/tools/cache.js";
import { TOOL_ERROR, RSI_TOOL, createTools, executeTool, toolNames } from "../src/tools/index.js";
import { RSI_ONLY_BTC_ETH } from "../src/tools/rsi.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "fixtures", "fake-rsi.mjs");
const REAL_SCRIPT = join(here, "..", "scripts", "rsi", "rsi.py");

/**
 * Интерпретатор с установленной TA-Lib, если такой есть. Проверяем импортом,
 * а не наличием файла: python3 в PATH обычно есть, а библиотеки в нём обычно
 * нет, и тест на настоящем скрипте должен различать эти случаи.
 */
function pythonWithTalib() {
  for (const bin of [process.env.RSI_PYTHON_BIN, "python3"]) {
    if (!bin) continue;
    const probe = spawnSync(bin, ["-c", "import talib"], { stdio: "ignore" });
    if (probe.status === 0) return bin;
  }
  return undefined;
}

/** Одна свеча Binance: нам нужна только цена закрытия — четвёртая по счёту. */
function candle(close) {
  return [1700000000000, "1", "2", "0.5", String(close), "10", 1700003599999, "1000", 50, "5", "500", "0"];
}

/** Ряд из 500 свечей, как их вернёт биржа на запрос инструмента. */
const KLINES = Array.from({ length: 500 }, (_, i) => candle(100 + i));

/**
 * Инструмент поверх заглушки скрипта. `mode` дописывается к аргументам через
 * подменённый spawn: настоящий запуск подпроцесса при этом сохраняется —
 * проверяем именно его, а не выдуманный child_process.
 */
function build({ mode = "ok", rows = KLINES, timeoutMs = 5000, pythonBin = process.execPath, scriptPath = FIXTURE } = {}) {
  const requests = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    requests.push(Object.fromEntries(parsed.searchParams));
    return { ok: true, status: 200, json: async () => rows };
  };

  const tools = createTools({
    binance: new BinanceClient({ baseUrl: "http://binance.test", fetchImpl }),
    cache: new TtlCache(),
    rsi: {
      pythonBin,
      scriptPath,
      timeoutMs,
      // mode: null — запускаем настоящий скрипт, ему такого аргумента не знать.
      ...(mode === null ? {} : { spawnImpl: (bin, args, options) => spawn(bin, [...args, "--mode", mode], options) }),
    },
  });

  return { tools, requests, run: (params) => executeTool(tools, RSI_TOOL, params) };
}

describe("инструмент RSI", () => {
  describe("реестр", () => {
    it("без настроек Python в реестр не попадает", () => {
      const tools = createTools({ binance: {} });
      assert.ok(!toolNames(tools).includes(RSI_TOOL), "инструмент, который всегда отказывает, хуже отсутствующего");
    });

    it("с настройками появляется и объявляет ограничение в описании", () => {
      const { tools } = build();
      assert.ok(toolNames(tools).includes(RSI_TOOL));
      // Планировщик читает описание — ограничение должно быть видно ему, а не
      // только тому, кто дойдёт до исходников.
      assert.match(tools[RSI_TOOL].description, /BTC и ETH/);
    });
  });

  describe("поддерживаемые монеты", () => {
    it("считает для BTC", async () => {
      const outcome = await build().run({ symbol: "BTCUSDT" });

      assert.equal(outcome.ok, true);
      assert.equal(outcome.value.symbol, "BTCUSDT");
      assert.equal(outcome.value.rsi, 61.42);
      assert.equal(outcome.value.zone, "нейтральная");
    });

    it("принимает монету без пары: BTC — это BTCUSDT", async () => {
      const outcome = await build().run({ symbol: "btc" });
      assert.equal(outcome.value.symbol, "BTCUSDT");
    });

    it("считает для ETH", async () => {
      const outcome = await build().run({ symbol: "ETH" });
      assert.equal(outcome.value.symbol, "ETHUSDT");
    });

    it("отказывает по любой другой монете и объясняет, почему", async () => {
      const outcome = await build().run({ symbol: "SOLUSDT" });

      assert.equal(outcome.ok, false);
      assert.equal(outcome.error.code, TOOL_ERROR.unsupportedAsset);
      // Текст уходит модели вместе с неудавшимся шагом и попадает в отчёт.
      assert.equal(outcome.error.message, RSI_ONLY_BTC_ETH);
    });

    it("отказ по неподдерживаемой монете не стоит ни свечей, ни подпроцесса", async () => {
      const ctx = build();
      await ctx.run({ symbol: "DOGEUSDT" });
      assert.equal(ctx.requests.length, 0);
    });
  });

  describe("параметры и запрос свечей", () => {
    it("по умолчанию берёт часовые свечи и период 14", async () => {
      const ctx = build();
      const outcome = await ctx.run({ symbol: "BTCUSDT" });

      assert.equal(outcome.value.interval, "1h");
      assert.equal(outcome.value.length, 14);
      assert.equal(ctx.requests[0].interval, "1h");
    });

    it("просит 500 свечей: по короткой истории RSI не сойдётся с терминалом", async () => {
      const ctx = build();
      await ctx.run({ symbol: "BTCUSDT" });

      assert.equal(ctx.requests[0].limit, "500");
      assert.equal(ctx.requests[0].symbol, "BTCUSDT");
    });

    it("передаёт скрипту цены закрытия и запрещает ему ходить в сеть", async () => {
      const outcome = await build().run({ symbol: "BTCUSDT" });

      assert.equal(outcome.value.echo.noFetch, true, "свечи у нас уже есть, второй HTTP-клиент не нужен");
      assert.equal(outcome.value.echo.lastClose, 599);
      assert.equal(outcome.value.samples, 500);
    });

    it("отдаёт заданные интервал и период", async () => {
      const outcome = await build().run({ symbol: "ETHUSDT", interval: "1d", length: 21 });

      assert.equal(outcome.value.interval, "1d");
      assert.equal(outcome.value.length, 21);
    });

    it("отвергает выдуманный интервал, не доходя до биржи", async () => {
      const ctx = build();
      const outcome = await ctx.run({ symbol: "BTCUSDT", interval: "1 час" });

      assert.equal(outcome.error.code, TOOL_ERROR.invalidParams);
      assert.equal(ctx.requests.length, 0);
    });

    it("отвергает период вне границ", async () => {
      const outcome = await build().run({ symbol: "BTCUSDT", length: 500 });
      assert.equal(outcome.error.code, TOOL_ERROR.invalidParams);
    });

    it("повторный вызов берётся из кеша: подпроцесс запускается один раз", async () => {
      const ctx = build();
      await ctx.run({ symbol: "BTCUSDT" });
      await ctx.run({ symbol: "BTCUSDT" });

      assert.equal(ctx.requests.length, 1);
    });
  });

  describe("отказы расчёта", () => {
    it("нет интерпретатора — отдельный код, а не «биржа ответила ошибкой»", async () => {
      const outcome = await build({ pythonBin: "/nonexistent/python" }).run({ symbol: "BTCUSDT" });

      assert.equal(outcome.ok, false);
      assert.equal(outcome.error.code, TOOL_ERROR.computationFailed);
      assert.match(outcome.error.message, /интерпретатор/);
    });

    it("скрипт упал с трассировкой вместо JSON", async () => {
      const outcome = await build({ mode: "garbage" }).run({ symbol: "BTCUSDT" });

      assert.equal(outcome.error.code, TOOL_ERROR.computationFailed);
      assert.match(outcome.error.message, /не JSON/);
    });

    it("скрипт объяснил отказ сам — берём его объяснение", async () => {
      const outcome = await build({ mode: "broken" }).run({ symbol: "BTCUSDT" });

      assert.equal(outcome.error.code, TOOL_ERROR.computationFailed);
      assert.equal(outcome.error.message, "Мало свечей.");
    });

    it("список монет в скрипте главнее: его отказ по монете остаётся отказом по монете", async () => {
      // Расходиться списки не должны, но если разойдутся — причина не должна
      // превратиться в «не удалось выполнить расчёт».
      const outcome = await build({ mode: "refusal" }).run({ symbol: "BTCUSDT" });

      assert.equal(outcome.error.code, TOOL_ERROR.unsupportedAsset);
      assert.equal(outcome.error.message, "Только BTC и ETH.");
    });

    it("зависший расчёт убивается по таймауту, а не держит шаг плана", async () => {
      const startedAt = Date.now();
      const outcome = await build({ mode: "hang", timeoutMs: 300 }).run({ symbol: "BTCUSDT" });

      assert.equal(outcome.error.code, TOOL_ERROR.computationFailed);
      assert.match(outcome.error.message, /не ответил/);
      assert.ok(Date.now() - startedAt < 5000, "ждали таймаут, а не завершения подпроцесса");
    });
  });

  describe("настоящий скрипт", () => {
    /**
     * Проверка самого расчёта на эталонном ряде Уайлдера из «New Concepts in
     * Technical Trading Systems» — том, по которому RSI сверяют все реализации.
     * Пропускается там, где не поставлены зависимости Python: расчёт живёт в
     * TA-Lib, и её отсутствие — это ненастроенное окружение, а не поломка кода.
     */
    const WILDER = [
      44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4245, 45.8433, 46.0826,
      45.8931, 46.0328, 45.614, 46.282, 46.282, 46.0028, 46.0328, 46.4116, 46.2222, 45.6439,
      46.2122, 46.2521, 45.7137, 46.4515, 45.7835, 45.3548, 44.0288, 44.1783, 44.2181, 44.5672,
      43.4205, 42.6628, 43.1314,
    ];

    const python = pythonWithTalib();
    const available = python && existsSync(REAL_SCRIPT);
    const skipReason = "нет Python с TA-Lib: pip install -r core/scripts/rsi/requirements.txt";

    it("считает RSI так же, как эталонные значения Уайлдера", async (t) => {
      if (!available) return t.skip(skipReason);

      const ctx = build({
        mode: null,
        pythonBin: python,
        scriptPath: REAL_SCRIPT,
        rows: WILDER.map(candle),
      });
      const outcome = await ctx.run({ symbol: "BTCUSDT" });

      assert.equal(outcome.ok, true, outcome.error?.message);
      assert.equal(outcome.value.rsi, 37.77);
      assert.deepEqual(outcome.value.recent, [41.46, 41.87, 45.46, 37.3, 33.08]);
    });

    it("отказывается считать по слишком короткому ряду", async (t) => {
      if (!available) return t.skip(skipReason);

      const ctx = build({
        mode: null,
        pythonBin: python,
        scriptPath: REAL_SCRIPT,
        rows: [candle(1), candle(2), candle(3)],
      });
      const outcome = await ctx.run({ symbol: "ETHUSDT" });

      assert.equal(outcome.error.code, TOOL_ERROR.computationFailed);
      assert.match(outcome.error.message, /цен закрытия/);
    });
  });
});
