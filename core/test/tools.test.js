import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BinanceClient } from "../src/tools/BinanceClient.js";
import { TtlCache } from "../src/tools/cache.js";
import { TOOL_ERROR, createTools, executeTool } from "../src/tools/index.js";

/** Одна суточная сводка Binance — поля те, что реально приходят. */
const ticker = {
  symbol: "BTCUSDT",
  priceChangePercent: "2.5",
  weightedAvgPrice: "61000.00",
  lastPrice: "61500.00",
  bidPrice: "61495.00",
  askPrice: "61505.00",
  highPrice: "62000.00",
  lowPrice: "60000.00",
  volume: "12000.5",
  quoteVolume: "738000000.00",
  count: 1500000,
};

/**
 * Подменённый fetch: отдаёт заготовки по пути запроса и копит обращения.
 * @param {Record<string, unknown|(() => unknown)>} routes
 */
function fakeBinance(routes, { status = 200 } = {}) {
  const requests = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    requests.push({ path: parsed.pathname, query: Object.fromEntries(parsed.searchParams) });
    const route = routes[parsed.pathname];
    const body = typeof route === "function" ? route(parsed) : route;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  return { requests, fetchImpl };
}

function build(routes, options) {
  const binanceFake = fakeBinance(routes, options);
  const binance = new BinanceClient({
    baseUrl: "http://binance.test",
    fetchImpl: binanceFake.fetchImpl,
  });
  const cache = new TtlCache();
  return { ...binanceFake, cache, tools: createTools({ binance, cache }) };
}

describe("крипто-инструменты", () => {
  describe("реестр", () => {
    it("содержит пять инструментов спецификации", () => {
      const { tools } = build({});
      assert.equal(Object.keys(tools).length, 5);
    });

    it("у каждого есть назначение и параметры — из них строится промпт планировщика", () => {
      const { tools } = build({});
      for (const [name, tool] of Object.entries(tools)) {
        assert.ok(tool.description.length > 20, name);
        assert.equal(typeof tool.parameters, "object", name);
        assert.ok(Array.isArray(tool.required), name);
        assert.equal(typeof tool.run, "function", name);
      }
    });

    it("обязательные параметры перечислены среди описанных", () => {
      const { tools } = build({});
      for (const [name, tool] of Object.entries(tools)) {
        for (const key of tool.required) {
          assert.ok(key in tool.parameters, `${name}.${key}`);
        }
      }
    });
  });

  describe("текущая цена", () => {
    it("возвращает цену, спред и изменение за сутки", async () => {
      const { tools } = build({ "/api/v3/ticker/24hr": ticker });

      const result = await executeTool(tools, "get_crypto_current_price", { symbol: "btcusdt" });

      assert.equal(result.ok, true);
      assert.deepEqual(result.value, {
        symbol: "BTCUSDT",
        price: 61500,
        bid: 61495,
        ask: 61505,
        spreadPercent: 0.0163,
        priceChangePercent24h: 2.5,
        high24h: 62000,
        low24h: 60000,
      });
    });

    it("запрашивает пару в верхнем регистре", async () => {
      const { tools, requests } = build({ "/api/v3/ticker/24hr": ticker });

      await executeTool(tools, "get_crypto_current_price", { symbol: "btcusdt" });

      assert.equal(requests[0].query.symbol, "BTCUSDT");
    });
  });

  describe("суточная статистика", () => {
    it("делит кеш с текущей ценой — сводка у них одна", async () => {
      const { tools, requests } = build({ "/api/v3/ticker/24hr": ticker });

      await executeTool(tools, "get_crypto_current_price", { symbol: "BTCUSDT" });
      await executeTool(tools, "get_crypto_24h_ticker_stats", { symbol: "BTCUSDT" });

      assert.equal(requests.length, 1, "биржу опросили один раз");
    });

    // Именно так их и выполняет PlanExecutor: шаги независимы и идут
    // параллельно. Пока кеш заполнялся только после ответа биржи, оба шага
    // успевали промахнуться мимо него и сходить на биржу порознь.
    it("делит кеш и при одновременном вызове, а не только последовательном", async () => {
      const { tools, requests } = build({ "/api/v3/ticker/24hr": ticker });

      await Promise.all([
        executeTool(tools, "get_crypto_current_price", { symbol: "BTCUSDT" }),
        executeTool(tools, "get_crypto_24h_ticker_stats", { symbol: "BTCUSDT" }),
      ]);

      assert.equal(requests.length, 1, "биржу опросили один раз");
    });

    it("возвращает объёмы и число сделок", async () => {
      const { tools } = build({ "/api/v3/ticker/24hr": ticker });

      const { value } = await executeTool(tools, "get_crypto_24h_ticker_stats", {
        symbol: "BTCUSDT",
      });

      assert.equal(value.quoteVolume, 738000000);
      assert.equal(value.trades, 1500000);
      assert.equal(value.weightedAvgPrice, 61000);
    });
  });

  describe("исторические свечи", () => {
    const rows = [
      [1700000000000, "60000", "61000", "59500", "60800", "120.5", 0, "7300000", 4200],
      [1700003600000, "60800", "61500", "60700", "61400", "98.2", 0, "6000000", 3900],
    ];

    it("раскладывает массив свечи по именам", async () => {
      const { tools } = build({ "/api/v3/klines": rows });

      const { value } = await executeTool(tools, "get_crypto_historical_klines", {
        symbol: "BTCUSDT",
        interval: "1h",
      });

      assert.deepEqual(value.candles[0], {
        openTime: 1700000000000,
        open: 60000,
        high: 61000,
        low: 59500,
        close: 60800,
        volume: 120.5,
        quoteVolume: 7300000,
        trades: 4200,
      });
    });

    it("без limit просит сотню свечей", async () => {
      const { tools, requests } = build({ "/api/v3/klines": rows });

      await executeTool(tools, "get_crypto_historical_klines", {
        symbol: "BTCUSDT",
        interval: "1d",
      });

      assert.equal(requests[0].query.limit, "100");
    });

    it("отвергает интервал, которого у биржи нет", async () => {
      const { tools, requests } = build({ "/api/v3/klines": rows });

      const result = await executeTool(tools, "get_crypto_historical_klines", {
        symbol: "BTCUSDT",
        interval: "1min",
      });

      assert.equal(result.ok, false);
      assert.equal(result.error.code, TOOL_ERROR.invalidParams);
      assert.equal(requests.length, 0, "до сети дело не дошло");
    });

    it("не пропускает запрос свыше предела спецификации", async () => {
      const { tools } = build({ "/api/v3/klines": rows });

      const result = await executeTool(tools, "get_crypto_historical_klines", {
        symbol: "BTCUSDT",
        interval: "1h",
        limit: 5000,
      });

      assert.equal(result.error.code, TOOL_ERROR.invalidParams);
    });
  });

  describe("стакан", () => {
    const book = {
      bids: [["61000", "1.5"], ["60990", "12.0"], ["60980", "0.3"]],
      asks: [["61010", "0.7"], ["61020", "2.0"], ["61030", "0.1"]],
    };

    it("считает агрегаты вместо того, чтобы отдавать стакан целиком", async () => {
      const { tools } = build({ "/api/v3/depth": book });

      const { value } = await executeTool(tools, "get_crypto_orderbook_depth", {
        symbol: "BTCUSDT",
      });

      assert.equal(value.bestBid, 61000);
      assert.equal(value.bestAsk, 61010);
      assert.equal(value.bidVolume, 13.8);
      assert.equal(value.askVolume, 2.8);
      assert.equal(value.levelsScanned, 6);
    });

    it("перевес спроса даёт положительный дисбаланс", async () => {
      const { tools } = build({ "/api/v3/depth": book });

      const { value } = await executeTool(tools, "get_crypto_orderbook_depth", {
        symbol: "BTCUSDT",
      });

      assert.ok(value.imbalance > 0 && value.imbalance <= 1);
      assert.equal(value.imbalance, round((13.8 - 2.8) / 16.6));
    });

    it("показывает крупнейшие уровни — это и есть стенки", async () => {
      const { tools } = build({ "/api/v3/depth": book });

      const { value } = await executeTool(tools, "get_crypto_orderbook_depth", {
        symbol: "BTCUSDT",
      });

      assert.deepEqual(value.largestBids[0], { price: 60990, qty: 12 });
    });

    it("пустой стакан не роняет расчёт", async () => {
      const { tools } = build({ "/api/v3/depth": { bids: [], asks: [] } });

      const { value } = await executeTool(tools, "get_crypto_orderbook_depth", {
        symbol: "BTCUSDT",
      });

      assert.equal(value.bestBid, null);
      assert.equal(value.imbalance, null);
    });
  });

  describe("скрининг по объёму", () => {
    const all = [
      { symbol: "BTCUSDT", quoteVolume: "900000000", lastPrice: "61500", priceChangePercent: "2.5", count: 1 },
      { symbol: "ETHUSDT", quoteVolume: "400000000", lastPrice: "3400", priceChangePercent: "-1.2", count: 2 },
      { symbol: "SOLUSDT", quoteVolume: "150000000", lastPrice: "140", priceChangePercent: "5.0", count: 3 },
      { symbol: "ETHBTC", quoteVolume: "999999999999", lastPrice: "0.055", priceChangePercent: "0.1", count: 4 },
      { symbol: "TINYUSDT", quoteVolume: "1000", lastPrice: "0.01", priceChangePercent: "9.0", count: 5 },
    ];

    it("сортирует по объёму и обрезает до limit", async () => {
      const { tools } = build({ "/api/v3/ticker/24hr": all });

      const { value } = await executeTool(tools, "get_crypto_top_by_volume", { limit: 2 });

      assert.deepEqual(value.pairs.map((p) => p.symbol), ["BTCUSDT", "ETHUSDT"]);
    });

    it("оставляет только пары к USDT — иначе объём не в долларах", async () => {
      // ETHBTC с огромным объёмом в BTC не должен возглавить список.
      const { tools } = build({ "/api/v3/ticker/24hr": all });

      const { value } = await executeTool(tools, "get_crypto_top_by_volume", {});

      assert.ok(!value.pairs.some((p) => p.symbol === "ETHBTC"));
    });

    it("отсекает мелочь по minVolumeUsd", async () => {
      const { tools } = build({ "/api/v3/ticker/24hr": all });

      const { value } = await executeTool(tools, "get_crypto_top_by_volume", {
        minVolumeUsd: 200_000_000,
      });

      assert.deepEqual(value.pairs.map((p) => p.symbol), ["BTCUSDT", "ETHUSDT"]);
    });

    it("тяжёлый запрос кешируется независимо от limit", async () => {
      const { tools, requests } = build({ "/api/v3/ticker/24hr": all });

      await executeTool(tools, "get_crypto_top_by_volume", { limit: 2 });
      await executeTool(tools, "get_crypto_top_by_volume", { limit: 5 });

      assert.equal(requests.length, 1);
      assert.equal(requests[0].query.symbol, undefined, "сводка по всем парам");
    });
  });

  describe("отказы", () => {
    it("несуществующий инструмент — отказ, а не исключение", async () => {
      const { tools } = build({});

      const result = await executeTool(tools, "get_crypto_moon_phase", {});

      assert.equal(result.ok, false);
      assert.equal(result.error.code, TOOL_ERROR.invalidParams);
    });

    it("имя инструмента чистится перед попаданием в лог", async () => {
      const { tools } = build({});

      const result = await executeTool(tools, "tool<script>alert(1)</script>", {});

      assert.doesNotMatch(result.error.message, /</);
    });

    it("неожиданное тело ответа — upstream_error", async () => {
      const { tools } = build({ "/api/v3/klines": { unexpected: true } });

      const result = await executeTool(tools, "get_crypto_historical_klines", {
        symbol: "BTCUSDT",
        interval: "1h",
      });

      assert.equal(result.error.code, TOOL_ERROR.upstreamError);
    });

    it("никакой отказ не выбрасывается наружу", async () => {
      const { tools } = build({}, { status: 500 });

      for (const name of Object.keys(tools)) {
        const result = await executeTool(tools, name, { symbol: "BTCUSDT", interval: "1h" });
        assert.equal(result.ok, false, name);
        assert.equal(typeof result.error.code, "string", name);
      }
    });
  });
});

function round(value) {
  return Math.round(value * 10_000) / 10_000;
}
