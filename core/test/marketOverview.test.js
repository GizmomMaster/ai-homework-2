import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createFakeOverviewAgent, muteConsole, startCoreApp } from "./helpers.js";
import { TOOL_ERROR, ToolError } from "../src/tools/errors.js";
import { BinanceClient } from "../src/tools/BinanceClient.js";
import { CoinGeckoClient } from "../src/tools/CoinGeckoClient.js";
import { TtlCache } from "../src/tools/cache.js";
import {
  MAX_OVERVIEW_COINS,
  buildMarketOverview,
  yesterdayStartMs,
} from "../src/tools/marketOverview.js";
import { renderMarketOverview } from "../src/domain/renderMarketOverview.js";
import { MarketOverviewService, unusableCommentary } from "../src/domain/MarketOverviewService.js";
import { buildBrief } from "../src/agents/MarketOverviewAgent.js";
import { createTools, executeTool } from "../src/tools/index.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Полдень 28 августа 2026 UTC — «сейчас» во всех тестах ниже. */
const NOW = Date.UTC(2026, 7, 28, 12, 0, 0) + DAY_MS;
const DAY_START = Date.UTC(2026, 7, 28);

/** Строка рейтинга CoinGecko — поля те, что реально приходят. */
function coin(symbol, { id = symbol.toLowerCase(), rank = 1, cap = 1e12 } = {}) {
  return {
    id,
    symbol: symbol.toLowerCase(),
    name: symbol,
    market_cap_rank: rank,
    current_price: 100,
    price_change_percentage_24h: 1.5,
    total_volume: 5e8,
    market_cap: cap,
  };
}

/** Дневная свеча Binance: двенадцать позиций, значения строками. */
function candle(openTime, { open = "100", close = "110", quoteVolume = "1000000" } = {}) {
  return [openTime, open, "120", "90", close, "500", openTime + DAY_MS - 1, quoteVolume, 100, "0", "0", "0"];
}

/**
 * Готовая сводка — то, что вернул бы `buildMarketOverview`. Нужна и отрисовке,
 * и эндпоинту, поэтому лежит здесь, а не внутри одного из блоков.
 *
 * Монеты подобраны так, чтобы задеть все особые случаи разом: биткоин
 * задаёт максимальную ширину колонки, DOGE — цену меньше единицы, которую
 * нельзя округлять, а FIGR_HELOC — тикер с подчёркиванием, взятый не с биржи.
 */
const OVERVIEW = {
  dayStartMs: DAY_START,
  excluded: { stablecoins: ["USDT"], wrapped: ["WBTC"] },
  coins: [
    {
      symbol: "BTC", name: "Bitcoin", source: "binance",
      open: 80249.59, close: 77845.87, changePercent: -2.995, dayVolume: 1.56e9,
      price: 78033, priceChangePercent24h: 0.66, volume24h: 1.73e10, marketCap: 1.56e12,
    },
    {
      symbol: "DOGE", name: "Dogecoin", source: "binance",
      open: 0.08716, close: 0.085109, changePercent: -2.35, dayVolume: 3.42e8,
      price: 0.085109, priceChangePercent24h: 1.37, volume24h: 3.38e8, marketCap: 1.32e10,
    },
    {
      symbol: "FIGR_HELOC", name: "Figure Heloc", source: "coingecko", binanceMiss: "not_listed",
      open: 1.0185, close: 1.0398, changePercent: 2.1, dayVolume: 1.72e8,
      price: 1.041, priceChangePercent24h: 0.48, volume24h: 5.95e7, marketCap: 2.27e10,
    },
  ],
};

/**
 * Подменённые клиенты. `candles` и `charts` — карты «символ (или id) → тело
 * ответа»; отсутствующий ключ означает отказ, то есть «пары нет».
 */
function clients({ ranking = [], candles = {}, charts = {} } = {}) {
  const calls = { binance: [], coingecko: [] };

  const binance = new BinanceClient({
    baseUrl: "http://binance.test",
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      const symbol = parsed.searchParams.get("symbol");
      calls.binance.push(symbol);
      const body = candles[symbol];
      if (!body) {
        // Так Binance отвечает на неизвестную пару.
        return { ok: false, status: 400, json: async () => ({ code: -1121, msg: "Invalid symbol." }) };
      }
      return { ok: true, status: 200, json: async () => body };
    },
  });

  const coingecko = new CoinGeckoClient({
    baseUrl: "http://coingecko.test",
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      calls.coingecko.push(parsed.pathname);
      if (parsed.pathname === "/api/v3/coins/markets") {
        return { ok: true, status: 200, json: async () => ranking };
      }
      const id = parsed.pathname.split("/")[4];
      const body = charts[id];
      if (!body) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => body };
    },
  });

  return { binance, coingecko, calls };
}

describe("обзор рынка", () => {
  describe("отбор монет", () => {
    it("исключает стейблкоины и обёртки, добирая следующие по капитализации", async () => {
      const { binance, coingecko } = clients({
        ranking: [
          coin("BTC", { rank: 1 }),
          coin("USDT", { rank: 2 }),
          coin("WBTC", { rank: 3 }),
          coin("ETH", { rank: 4 }),
          coin("STETH", { rank: 5 }),
          coin("SOL", { rank: 6 }),
        ],
        candles: {
          BTCUSDT: [candle(DAY_START), candle(DAY_START + DAY_MS)],
          ETHUSDT: [candle(DAY_START), candle(DAY_START + DAY_MS)],
          SOLUSDT: [candle(DAY_START), candle(DAY_START + DAY_MS)],
        },
      });

      const overview = await buildMarketOverview({ binance, coingecko, limit: 3, now: NOW });

      assert.deepEqual(
        overview.coins.map((c) => c.symbol),
        ["BTC", "ETH", "SOL"],
      );
      assert.deepEqual(overview.excluded.stablecoins, ["USDT"]);
      assert.deepEqual(overview.excluded.wrapped, ["WBTC", "STETH"]);
    });

    it("отдаёт не больше запрошенного числа монет", async () => {
      const ranking = ["BTC", "ETH", "SOL", "XRP", "DOGE"].map((s, i) => coin(s, { rank: i + 1 }));
      const { binance, coingecko } = clients({ ranking });

      const overview = await buildMarketOverview({ binance, coingecko, limit: 2, now: NOW });

      assert.equal(overview.coins.length, 2);
    });
  });

  describe("итоги вчерашних суток", () => {
    it("берёт завершённую вчерашнюю свечу, а не сегодняшнюю", async () => {
      const { binance, coingecko } = clients({
        ranking: [coin("BTC")],
        candles: {
          BTCUSDT: [
            candle(DAY_START, { open: "80000", close: "77600" }),
            // Сегодняшняя, ещё не закрытая: попасть в сводку не должна.
            candle(DAY_START + DAY_MS, { open: "77600", close: "78100" }),
          ],
        },
      });

      const [btc] = (await buildMarketOverview({ binance, coingecko, limit: 1, now: NOW })).coins;

      assert.equal(btc.open, 80000);
      assert.equal(btc.close, 77600);
      assert.equal(btc.source, "binance");
      assert.equal(Number(btc.changePercent.toFixed(2)), -3);
    });

    it("объём берёт из quoteVolume, а не из объёма в базовой монете", async () => {
      const { binance, coingecko } = clients({
        ranking: [coin("BTC")],
        candles: { BTCUSDT: [candle(DAY_START, { quoteVolume: "1560927602" })] },
      });

      const [btc] = (await buildMarketOverview({ binance, coingecko, limit: 1, now: NOW })).coins;

      assert.equal(btc.dayVolume, 1560927602);
    });

    it("отвергает свечу за другие сутки", async () => {
      const { binance, coingecko } = clients({
        ranking: [coin("BTC")],
        // Свеча позапрошлого дня: подставлять её в отчёт о вчера нельзя.
        candles: { BTCUSDT: [candle(DAY_START - DAY_MS)] },
      });

      const [btc] = (await buildMarketOverview({ binance, coingecko, limit: 1, now: NOW })).coins;

      assert.equal(btc.open, null);
      assert.equal(btc.source, null);
    });

    it("для монет без пары на Binance берёт дневные точки CoinGecko", async () => {
      const { binance, coingecko, calls } = clients({
        ranking: [coin("HYPE", { id: "hyperliquid" })],
        candles: {}, // HYPEUSDT не листится
        charts: {
          hyperliquid: {
            prices: [
              [DAY_START, 84.67],
              [DAY_START + DAY_MS, 80.91],
            ],
            total_volumes: [
              [DAY_START, 1e9],
              [DAY_START + DAY_MS, 1.43e9],
            ],
          },
        },
      });

      const [hype] = (await buildMarketOverview({ binance, coingecko, limit: 1, now: NOW })).coins;

      assert.equal(hype.source, "coingecko");
      assert.equal(hype.open, 84.67);
      assert.equal(hype.close, 80.91);
      assert.equal(hype.dayVolume, 1.43e9);
      assert.ok(calls.binance.includes("HYPEUSDT"), "биржу всё же спросили — откат только после отказа");
    });

    it("точки ищет по метке времени, а не по позиции в массиве", async () => {
      const { binance, coingecko } = clients({
        ranking: [coin("HYPE", { id: "hyperliquid" })],
        charts: {
          hyperliquid: {
            // Лишняя точка в начале сдвинула бы индексы.
            prices: [
              [DAY_START - DAY_MS, 1],
              [DAY_START, 84.67],
              [DAY_START + DAY_MS, 80.91],
            ],
            total_volumes: [[DAY_START + DAY_MS, 5]],
          },
        },
      });

      const [hype] = (await buildMarketOverview({ binance, coingecko, limit: 1, now: NOW })).coins;

      assert.equal(hype.open, 84.67);
    });

    it("монета без истории попадает в сводку с пустыми полями, а не роняет её", async () => {
      const { binance, coingecko } = clients({
        ranking: [coin("BTC"), coin("GHOST", { id: "ghost", rank: 2 })],
        candles: { BTCUSDT: [candle(DAY_START)] },
      });

      const overview = await buildMarketOverview({ binance, coingecko, limit: 2, now: NOW });

      assert.equal(overview.coins.length, 2);
      assert.equal(overview.coins[1].source, null);
      assert.equal(overview.coins[1].changePercent, null);
    });
  });

  describe("обращение к источникам", () => {
    it("к бирже ходит разом, к CoinGecko — по одному", async (t) => {
      muteConsole(t);
      let concurrentGecko = 0;
      let peakGecko = 0;

      const ranking = ["AAA", "BBB", "CCC"].map((s, i) => coin(s, { rank: i + 1 }));
      const { binance } = clients({ ranking });
      // Ни одной пары на бирже — значит все три уйдут в откат.
      const coingecko = new CoinGeckoClient({
        baseUrl: "http://coingecko.test",
        fetchImpl: async (url) => {
          const parsed = new URL(url);
          if (parsed.pathname === "/api/v3/coins/markets") {
            return { ok: true, status: 200, json: async () => ranking };
          }
          concurrentGecko += 1;
          peakGecko = Math.max(peakGecko, concurrentGecko);
          await new Promise((resolve) => setTimeout(resolve, 5));
          concurrentGecko -= 1;
          return { ok: false, status: 404, json: async () => ({}) };
        },
      });

      await buildMarketOverview({ binance, coingecko, limit: 3, now: NOW });

      // Пачка одновременных запросов упирается в лимит бесплатного тарифа:
      // в лучшем случае 429, в худшем — оборванные соединения.
      assert.equal(peakGecko, 1, "откаты к CoinGecko должны идти по одному");
    });

    it("отказ одного источника не мешает остальным монетам", async (t) => {
      muteConsole(t);
      const { binance, coingecko } = clients({
        ranking: [coin("BTC"), coin("HYPE", { id: "hyperliquid", rank: 2 })],
        candles: { BTCUSDT: [candle(DAY_START, { open: "80000", close: "77600" })] },
        // hyperliquid не отвечает — откат для него провалится
      });

      const overview = await buildMarketOverview({ binance, coingecko, limit: 2, now: NOW });

      assert.equal(overview.coins[0].source, "binance");
      assert.equal(overview.coins[1].source, null, "строка осталась, но без цифр");
      assert.equal(overview.coins.length, 2);
    });

    // Откат срабатывает и когда пары нет, и когда биржа не ответила. Причина
    // видна только здесь: дальше от неё остаётся один `source`, а сноска в
    // сводке у этих двух случаев разная.
    it("помечает откат отсутствием пары, когда биржа так и сказала", async (t) => {
      muteConsole(t);
      const { binance, coingecko } = clients({
        ranking: [coin("HYPE", { id: "hyperliquid" })],
        charts: {
          hyperliquid: {
            prices: [[DAY_START, 84.67], [DAY_START + DAY_MS, 80.91]],
            total_volumes: [[DAY_START + DAY_MS, 1e9]],
          },
        },
      });

      const overview = await buildMarketOverview({ binance, coingecko, limit: 1, now: NOW });

      assert.equal(overview.coins[0].source, "coingecko");
      assert.equal(overview.coins[0].binanceMiss, "not_listed");
    });

    it("помечает откат недоступностью, когда биржа просто не ответила", async (t) => {
      muteConsole(t);
      const { coingecko } = clients({
        ranking: [coin("SOL", { id: "solana" })],
        charts: {
          solana: {
            prices: [[DAY_START, 120], [DAY_START + DAY_MS, 130]],
            total_volumes: [[DAY_START + DAY_MS, 1e9]],
          },
        },
      });
      // Пара на бирже есть, но взять свечу не вышло — это другой случай, и
      // обещать пользователю отсутствие листинга здесь нельзя.
      const binance = new BinanceClient({
        baseUrl: "http://binance.test",
        fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
      });

      const overview = await buildMarketOverview({ binance, coingecko, limit: 1, now: NOW });

      assert.equal(overview.coins[0].source, "coingecko");
      assert.equal(overview.coins[0].binanceMiss, "unavailable");
    });
  });

  describe("кеш итогов суток", () => {
    it("не перезапрашивает закрытую свечу", async () => {
      const cache = new TtlCache();
      const ranking = [coin("BTC")];
      const candles = { BTCUSDT: [candle(DAY_START)] };

      const first = clients({ ranking, candles });
      await buildMarketOverview({ ...first, cache, limit: 1, now: NOW });
      const second = clients({ ranking, candles });
      await buildMarketOverview({ ...second, cache, limit: 1, now: NOW });

      // Рейтинг спрашиваем заново — цены живут минуту. А вот сутки закрыты
      // и до полуночи не изменятся.
      assert.equal(second.calls.binance.length, 0, "свеча взята из кеша");
      assert.deepEqual(second.calls.coingecko, ["/api/v3/coins/markets"]);
    });

    it("в новые сутки берёт свежую свечу", async () => {
      const cache = new TtlCache();
      const ranking = [coin("BTC")];

      const first = clients({ ranking, candles: { BTCUSDT: [candle(DAY_START)] } });
      await buildMarketOverview({ ...first, cache, limit: 1, now: NOW });

      const second = clients({ ranking, candles: { BTCUSDT: [candle(DAY_START + DAY_MS)] } });
      await buildMarketOverview({ ...second, cache, limit: 1, now: NOW + DAY_MS });

      assert.deepEqual(second.calls.binance, ["BTCUSDT"], "дата в ключе сменилась вместе с сутками");
    });

    it("не запоминает неудачу: оборванная сеть не закрепляет н/д на сутки", async (t) => {
      muteConsole(t);
      const cache = new TtlCache();
      const ranking = [coin("HYPE", { id: "hyperliquid" })];
      const chart = {
        hyperliquid: {
          prices: [[DAY_START, 84.67], [DAY_START + DAY_MS, 80.91]],
          total_volumes: [[DAY_START + DAY_MS, 1e9]],
        },
      };

      // Первый заход: CoinGecko не отвечает по истории.
      const failed = clients({ ranking });
      const first = await buildMarketOverview({ ...failed, cache, limit: 1, now: NOW });
      assert.equal(first.coins[0].source, null);

      // Второй: источник ожил — пробел должен затянуться, а не остаться.
      const ok = clients({ ranking, charts: chart });
      const second = await buildMarketOverview({ ...ok, cache, limit: 1, now: NOW });

      assert.equal(second.coins[0].source, "coingecko");
      assert.equal(second.coins[0].open, 84.67);
    });

    it("без кеша работает как прежде", async () => {
      const ranking = [coin("BTC")];
      const candles = { BTCUSDT: [candle(DAY_START)] };

      const c = clients({ ranking, candles });
      await buildMarketOverview({ ...c, limit: 1, now: NOW });
      await buildMarketOverview({ ...c, limit: 1, now: NOW });

      assert.equal(c.calls.binance.length, 2);
    });
  });

  describe("границы суток", () => {
    it("считает вчерашнюю полночь UTC независимо от времени запуска", () => {
      const morning = yesterdayStartMs(Date.UTC(2026, 7, 29, 0, 5));
      const evening = yesterdayStartMs(Date.UTC(2026, 7, 29, 23, 55));

      assert.equal(morning, Date.UTC(2026, 7, 28));
      assert.equal(evening, Date.UTC(2026, 7, 28));
    });
  });

  describe("реестр инструментов", () => {
    it("без источника капитализации инструмент обзора не появляется", () => {
      const { binance } = clients();
      assert.equal(Object.keys(createTools({ binance })).includes("get_crypto_market_overview"), false);
    });

    it("с источником капитализации инструмент доступен планировщику", () => {
      const { binance, coingecko } = clients({ ranking: [] });
      assert.ok(Object.keys(createTools({ binance, coingecko })).includes("get_crypto_market_overview"));
    });

    it("отвергает limit сверх предела, не обращаясь к сети", async () => {
      const { binance, coingecko, calls } = clients({ ranking: [coin("BTC")] });
      const tools = createTools({ binance, coingecko });

      const result = await executeTool(tools, "get_crypto_market_overview", {
        limit: MAX_OVERVIEW_COINS + 1,
      });

      assert.equal(result.ok, false);
      assert.equal(result.error.code, "invalid_params");
      assert.equal(calls.coingecko.length, 0);
    });
  });

  describe("отрисовка", () => {
    const text = renderMarketOverview(OVERVIEW);

    it("заворачивает таблицы в блоки кода — иначе колонки в Telegram разъедутся", () => {
      const fences = text.match(/```/g) ?? [];
      assert.equal(fences.length, 4, "две таблицы — четыре ограничителя");
    });

    it("выравнивает колонки по правому краю", () => {
      const rows = text.split("```")[1].trim().split("\n");
      // Колонка выровнена, если значение в каждой строке кончается там же,
      // где кончается её заголовок. Проверяем на процентах: тикеры и цены в
      // этой таблице разной длины, так что случайно это не совпадёт.
      const edge = rows[0].indexOf("Δ%") + "Δ%".length;

      assert.ok(rows.length >= 4, "заголовок и три монеты");
      for (const row of rows.slice(1)) {
        assert.match(
          row.slice(0, edge),
          /[-+]\d+\.\d{2}$/,
          `строка "${row}" не выровнена по колонке Δ%`,
        );
      }
    });

    it("показывает знак изменения и не округляет дешёвые монеты в ноль", () => {
      assert.match(text, /-3\.00/, "падение со знаком минус");
      assert.match(text, /\+1\.37/, "рост со знаком плюс");
      assert.match(text, /0\.0851/, "DOGE не должен схлопнуться в 0.09");
    });

    it("сокращает объёмы и капитализации", () => {
      assert.match(text, /\$1\.56B/);
      assert.match(text, /\$1\.56T/);
    });

    it("называет дату прошедших суток", () => {
      assert.match(text, /28 августа 2026/);
    });

    it("сообщает, что именно отфильтровано", () => {
      assert.match(text, /Стейблкоины исключены/);
      assert.match(text, /USDT/);
      assert.match(text, /Обёртки/);
    });

    it("разводит два разных окна процентов", () => {
      assert.match(text, /календарные сутки/);
      assert.match(text, /скользящие сутки/);
    });

    it("отмечает строки, посчитанные не по бирже", () => {
      assert.match(text, /данным CoinGecko/);
      assert.match(text, /FIGR_HELOC/);
    });

    // Откат на CoinGecko случается по двум разным причинам, и сноска у них
    // разная: отсутствие пары — свойство монеты, молчание биржи — сегодняшняя
    // заминка. Обещать пользователю первое там, где случилось второе, нельзя.
    it("не приписывает монете отсутствие пары, когда молчала биржа", () => {
      const overview = {
        ...OVERVIEW,
        coins: [{ ...OVERVIEW.coins[2], symbol: "SOL", binanceMiss: "unavailable" }],
      };

      const notes = renderMarketOverview(overview);

      assert.match(notes, /Binance не ответила, сутки посчитаны по данным CoinGecko/);
      assert.doesNotMatch(notes, /Нет пары к USDT/);
    });

    it("разводит две причины отката по разным сноскам", () => {
      const overview = {
        ...OVERVIEW,
        coins: [
          { ...OVERVIEW.coins[2], symbol: "HYPE", binanceMiss: "not_listed" },
          { ...OVERVIEW.coins[2], symbol: "SOL", binanceMiss: "unavailable" },
        ],
      };

      const notes = renderMarketOverview(overview);

      assert.match(notes, /Нет пары к USDT на Binance[^\n]*`HYPE`/);
      assert.match(notes, /Binance не ответила[^\n]*`SOL`/);
    });

    it("тикер с подчёркиванием берёт в инлайн-код, чтобы не сломать курсив", () => {
      // Голый FIGR_HELOC внутри _…_ рвёт разметку курсива у адаптера.
      const notes = text.split("```").pop();
      assert.match(notes, /`FIGR_HELOC`/);
    });

    it("даёт примеры запросов", () => {
      assert.match(text, /Что можно спросить/);
      assert.match(text, /\?/);
    });
  });

  describe("комментарий модели", () => {
    /** Сервис поверх заглушек: инструмент отдаёт готовые данные. */
    function service(overviewAgent) {
      return new MarketOverviewService({
        tools: { get_crypto_market_overview: { async run() { return OVERVIEW; } } },
        overviewAgent,
      });
    }

    it("вставляет текст модели над таблицей", async () => {
      const agent = createFakeOverviewAgent();
      const result = await service(agent).compose();

      assert.equal(result.commentary, "model");
      assert.match(result.text, /Рынок снижался/, "текст модели на месте");
      assert.match(result.text, /```/, "таблицы всё равно собрал код");
      assert.equal(agent.calls.length, 1);
    });

    it("модель получает готовые к печати числа", async () => {
      const agent = createFakeOverviewAgent();
      await service(agent).compose();

      const brief = buildBrief(agent.calls[0]);
      assert.match(brief, /BTC \| за сутки -3\.00%/);
      assert.match(brief, /28 августа 2026/);
      // Пересчёт на модели развёл бы её текст с цифрами в таблице под ним.
      assert.doesNotMatch(brief, /80249\.59000000/);
    });

    it("отказ модели стоит одного абзаца, а не всей сводки", async (t) => {
      muteConsole(t);
      const agent = createFakeOverviewAgent(new Error("модель недоступна"));

      const result = await service(agent).compose();

      assert.equal(result.ok, true);
      assert.equal(result.commentary, "none");
      // Данные уже оплачены запросами к двум внешним API — терять их нельзя.
      assert.match(result.text, /Крипторынок за 28 августа 2026/);
      assert.match(result.text, /```/);
      assert.match(result.text, /BTC/);
    });

    it("без агента сводка выходит без комментария", async () => {
      const result = await service(undefined).compose();

      assert.equal(result.commentary, "none");
      assert.match(result.text, /Крипторынок/);
    });

    describe("проверка комментария", () => {
      it("пропускает связный абзац", () => {
        assert.equal(unusableCommentary("Рынок снижался, BTC потерял 3%."), undefined);
      });

      it("отвергает пустой ответ", () => {
        assert.match(unusableCommentary(""), /пуст/);
      });

      it("отвергает блок кода: таблицу рисуют без модели", () => {
        assert.match(unusableCommentary("Рынок упал\n```\nBTC 1\n```"), /блок кода/);
      });

      it("отвергает попытку нарисовать таблицу палками", () => {
        assert.match(unusableCommentary("| BTC | -3% |"), /таблица/);
      });

      it("одиночная палка в тексте безобидна", () => {
        assert.equal(unusableCommentary("Рынок упал | заметно"), undefined);
      });

      it("отвергает простыню вместо пары фраз", () => {
        assert.match(unusableCommentary("а".repeat(800)), /вместо пары фраз/);
      });
    });
  });

  describe("GET /v1/market/overview", () => {
    let core;
    afterEach(async () => {
      await core?.close();
      core = undefined;
    });

    /** Реестр из одного инструмента: остальные этому эндпоинту не нужны. */
    function overviewTools(run) {
      return {
        get_crypto_market_overview: { description: "", parameters: {}, required: [], run },
      };
    }

    it("отдаёт сводку с комментарием модели", async () => {
      core = await startCoreApp({
        tools: overviewTools(async () => OVERVIEW),
        overviewAgent: createFakeOverviewAgent(),
      });

      const response = await core.request("GET", "/v1/market/overview");

      assert.equal(response.status, 200);
      assert.equal(response.json.commentary, "model");
      assert.match(response.json.text, /Рынок снижался/);
      assert.match(response.json.text, /```/, "таблицы должны приехать блоками кода");
    });

    it("при отказе модели отдаёт сводку без комментария, а не ошибку", async (t) => {
      muteConsole(t);
      core = await startCoreApp({
        tools: overviewTools(async () => OVERVIEW),
        overviewAgent: createFakeOverviewAgent(new Error("модель недоступна")),
      });

      const response = await core.request("GET", "/v1/market/overview");

      assert.equal(response.status, 200);
      assert.equal(response.json.commentary, "none");
      assert.match(response.json.text, /Крипторынок за 28 августа 2026/);
    });

    it("отказ источника отдаёт 503 с кодом причины, а не 500", async (t) => {
      muteConsole(t);
      core = await startCoreApp({
        tools: overviewTools(async () => {
          throw new ToolError(TOOL_ERROR.rateLimited, "CoinGecko ограничил частоту запросов (429).");
        }),
      });

      const response = await core.request("GET", "/v1/market/overview");

      assert.equal(response.status, 503);
      assert.equal(response.json.error.code, TOOL_ERROR.rateLimited);
    });

    it("подробности отказа наружу не уходят", async (t) => {
      muteConsole(t);
      core = await startCoreApp({
        tools: overviewTools(async () => {
          throw new Error("ECONNREFUSED 10.0.0.5:443");
        }),
      });

      const response = await core.request("GET", "/v1/market/overview");

      assert.doesNotMatch(JSON.stringify(response.json), /10\.0\.0\.5/);
    });
  });
});
