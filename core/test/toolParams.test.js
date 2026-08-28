import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TOOL_ERROR } from "../src/tools/errors.js";
import {
  DEPTH_LIMITS,
  KLINE_INTERVALS,
  optionalAmount,
  optionalCount,
  optionalDepthLimit,
  optionalTimestamp,
  requireInterval,
  requireSymbol,
} from "../src/tools/params.js";

/** Проверяет, что вызов отвергнут именно как невалидные параметры. */
function rejects(fn) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, TOOL_ERROR.invalidParams);
    return true;
  });
}

describe("проверка параметров инструментов", () => {
  describe("символ торговой пары", () => {
    it("принимает обычную пару", () => {
      assert.equal(requireSymbol("BTCUSDT"), "BTCUSDT");
    });

    it("приводит регистр — модель охотно пишет строчными", () => {
      assert.equal(requireSymbol("btcusdt"), "BTCUSDT");
      assert.equal(requireSymbol("  ethUsdt  "), "ETHUSDT");
    });

    it("принимает пары с цифрами", () => {
      assert.equal(requireSymbol("1000SATSUSDT"), "1000SATSUSDT");
    });

    it("отвергает всё, чем можно испортить запрос", () => {
      // Ровно то, ради чего эта проверка существует: значение приезжает из
      // вывода модели и уходит в URL внешней биржи.
      for (const bad of [
        "BTC/USDT",
        "BTCUSDT&symbol=ETHUSDT",
        "BTCUSDT?limit=5000",
        "../../account",
        "BTC USDT",
        "BTC\nUSDT",
        "BTCUSDT#",
        "",
        "   ",
        "A".repeat(21),
        "A",
      ]) {
        rejects(() => requireSymbol(bad));
      }
    });

    it("отвергает не-строки", () => {
      for (const bad of [undefined, null, 42, {}, ["BTCUSDT"]]) rejects(() => requireSymbol(bad));
    });

    it("не подставляет значение в текст ошибки", () => {
      // Иначе недоверенный ввод попал бы в лог как есть.
      assert.throws(
        () => requireSymbol("BTC/../etc/passwd"),
        (error) => {
          assert.doesNotMatch(error.message, /passwd/);
          return true;
        },
      );
    });
  });

  describe("интервал свечей", () => {
    it("принимает все интервалы Binance", () => {
      for (const interval of KLINE_INTERVALS) {
        assert.equal(requireInterval(interval), interval);
      }
    });

    it("отвергает похожее, но чужое", () => {
      for (const bad of ["1min", "60", "1H", "2d", "", undefined, 15]) {
        rejects(() => requireInterval(bad));
      }
    });
  });

  describe("количество", () => {
    it("подставляет значение по умолчанию", () => {
      assert.equal(optionalCount(undefined, { max: 500, fallback: 100, name: "limit" }), 100);
      assert.equal(optionalCount(null, { max: 500, fallback: 100, name: "limit" }), 100);
    });

    it("принимает число в границах и строку с числом", () => {
      assert.equal(optionalCount(50, { max: 500, fallback: 100, name: "limit" }), 50);
      assert.equal(optionalCount("50", { max: 500, fallback: 100, name: "limit" }), 50);
    });

    it("отвергает выход за границы и дробное", () => {
      for (const bad of [0, -1, 501, 1.5, "много", NaN, Infinity]) {
        rejects(() => optionalCount(bad, { max: 500, fallback: 100, name: "limit" }));
      }
    });
  });

  describe("глубина стакана", () => {
    it("принимает только значения из набора Binance", () => {
      for (const limit of DEPTH_LIMITS) assert.equal(optionalDepthLimit(limit), limit);
    });

    it("не подменяет соседним значением, а отвергает", () => {
      // Молчаливая подмена параметра хуже внятного отказа: планировщик
      // получил бы не тот срез, о котором просил, и не узнал бы об этом.
      for (const bad of [1, 7, 99, 101, 10000]) rejects(() => optionalDepthLimit(bad));
    });

    it("без значения берёт сотню", () => {
      assert.equal(optionalDepthLimit(undefined), 100);
    });
  });

  describe("метка времени", () => {
    it("отсутствие — это не ошибка", () => {
      assert.equal(optionalTimestamp(undefined), undefined);
    });

    it("принимает разумную метку", () => {
      const stamp = Date.now() - 86_400_000;
      assert.equal(optionalTimestamp(stamp), stamp);
    });

    it("отвергает будущее дальше суток и отрицательное", () => {
      rejects(() => optionalTimestamp(Date.now() + 10 * 86_400_000));
      rejects(() => optionalTimestamp(-1));
      rejects(() => optionalTimestamp("вчера"));
    });
  });

  describe("сумма", () => {
    it("принимает ноль и положительное", () => {
      assert.equal(optionalAmount(0, { name: "minVolumeUsd" }), 0);
      assert.equal(optionalAmount(1e6, { name: "minVolumeUsd" }), 1e6);
    });

    it("отвергает отрицательное и нечисло", () => {
      rejects(() => optionalAmount(-1, { name: "minVolumeUsd" }));
      rejects(() => optionalAmount("много", { name: "minVolumeUsd" }));
    });
  });
});
