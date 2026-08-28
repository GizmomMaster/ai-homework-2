import { BinanceClient } from "./BinanceClient.js";
import { TtlCache } from "./cache.js";
import { TOOL_ERROR, ToolError } from "./errors.js";
import {
  KLINE_INTERVALS,
  optionalAmount,
  optionalCount,
  optionalDepthLimit,
  optionalTimestamp,
  requireInterval,
  requireSymbol,
} from "./params.js";

export { TOOL_ERROR, ToolError } from "./errors.js";

/**
 * Время жизни кеша по инструментам. Разное не для красоты: срез стакана
 * устаревает за секунды, суточная сводка живёт минуту без потери смысла,
 * а сводка по всем парам — самый тяжёлый запрос, и её стоит держать дольше
 * всего.
 */
const TTL = {
  ticker: 20_000,
  klines: 60_000,
  depth: 5_000,
  screener: 120_000,
};

/** Максимум свечей за раз — предел из §4 спецификации. */
const MAX_KLINES = 500;

/**
 * Реестр крипто-инструментов (§4 спецификации).
 *
 * Все работают через **публичные эндпоинты без приватных ключей**: система
 * читает рыночные данные и ничего больше — ни ордеров, ни кошельков.
 *
 * Определения лежат данными, а не разбросаны по коду, потому что из них
 * собирается ещё и промпт планировщика: список имён, назначение и параметры
 * должны браться из одного места, иначе планировщик рано или поздно начнёт
 * звать инструмент, которого нет.
 *
 * @param {{
 *   binance: BinanceClient,
 *   cache?: TtlCache,
 * }} deps
 */
export function createTools({ binance, cache = new TtlCache() }) {
  /** Суточная сводка по паре. Общая для двух инструментов — и кеш общий. */
  const ticker24h = (symbol) =>
    cache.through(`t24:${symbol}`, TTL.ticker, () =>
      binance.get("/api/v3/ticker/24hr", { symbol }),
    );

  return {
    get_crypto_current_price: {
      description:
        "Текущая спотовая цена пары, лучшие цены покупки и продажи (спред) и изменение за 24 часа.",
      parameters: {
        symbol: { type: "string", description: "Торговая пара, например BTCUSDT" },
      },
      required: ["symbol"],
      async run(params) {
        const symbol = requireSymbol(params.symbol);
        const t = await ticker24h(symbol);
        const bid = Number(t.bidPrice);
        const ask = Number(t.askPrice);

        return {
          symbol,
          price: Number(t.lastPrice),
          bid,
          ask,
          // Спред в процентах полезнее абсолютного: он сопоставим между парами.
          spreadPercent: ask > 0 ? round(((ask - bid) / ask) * 100, 4) : null,
          priceChangePercent24h: Number(t.priceChangePercent),
          high24h: Number(t.highPrice),
          low24h: Number(t.lowPrice),
        };
      },
    },

    get_crypto_historical_klines: {
      description:
        "Исторические свечи (OHLCV) и объёмы за период. Годится для динамики цены, " +
        "волатильности и сравнения активности по времени.",
      parameters: {
        symbol: { type: "string", description: "Торговая пара, например ETHUSDT" },
        interval: {
          type: "string",
          enum: KLINE_INTERVALS,
          description: "Размер свечи",
        },
        limit: {
          type: "integer",
          description: `Сколько свечей вернуть, до ${MAX_KLINES} (по умолчанию 100)`,
        },
        startTime: { type: "integer", description: "Начало периода, метка времени в мс" },
      },
      required: ["symbol", "interval"],
      async run(params) {
        const symbol = requireSymbol(params.symbol);
        const interval = requireInterval(params.interval);
        const limit = optionalCount(params.limit, {
          max: MAX_KLINES,
          fallback: 100,
          name: "limit",
        });
        const startTime = optionalTimestamp(params.startTime);

        const rows = await cache.through(
          `kl:${symbol}:${interval}:${limit}:${startTime ?? ""}`,
          TTL.klines,
          () => binance.get("/api/v3/klines", { symbol, interval, limit, startTime }),
        );

        if (!Array.isArray(rows)) {
          throw new ToolError(TOOL_ERROR.upstreamError, "Ожидался массив свечей.");
        }

        // Binance отдаёт свечу массивом из двенадцати позиций. Раскладываем по
        // именам здесь: дальше по конвейеру эти данные попадут в промпт, и
        // «candle[7]» там не объяснить.
        return {
          symbol,
          interval,
          candles: rows.map((r) => ({
            openTime: r[0],
            open: Number(r[1]),
            high: Number(r[2]),
            low: Number(r[3]),
            close: Number(r[4]),
            volume: Number(r[5]),
            quoteVolume: Number(r[7]),
            trades: r[8],
          })),
        };
      },
    },

    get_crypto_24h_ticker_stats: {
      description:
        "Агрегированная статистика за 24 часа: объём в базовом и котируемом активе, " +
        "средневзвешенная цена, число сделок, максимум и минимум.",
      parameters: {
        symbol: { type: "string", description: "Торговая пара, например SOLUSDT" },
      },
      required: ["symbol"],
      async run(params) {
        const symbol = requireSymbol(params.symbol);
        const t = await ticker24h(symbol);

        return {
          symbol,
          lastPrice: Number(t.lastPrice),
          priceChangePercent: Number(t.priceChangePercent),
          weightedAvgPrice: Number(t.weightedAvgPrice),
          volume: Number(t.volume),
          quoteVolume: Number(t.quoteVolume),
          trades: t.count,
          high: Number(t.highPrice),
          low: Number(t.lowPrice),
        };
      },
    },

    get_crypto_orderbook_depth: {
      description:
        "Срез книги ордеров: заявки на покупку и продажу. Показывает крупные стенки " +
        "ликвидности и перевес спроса или предложения.",
      parameters: {
        symbol: { type: "string", description: "Торговая пара, например BTCUSDT" },
        limit: {
          type: "integer",
          description: "Глубина среза: 5, 10, 20, 50, 100, 500, 1000 или 5000 (по умолчанию 100)",
        },
      },
      required: ["symbol"],
      async run(params) {
        const symbol = requireSymbol(params.symbol);
        const limit = optionalDepthLimit(params.limit);

        const book = await cache.through(`dp:${symbol}:${limit}`, TTL.depth, () =>
          binance.get("/api/v3/depth", { symbol, limit }),
        );

        const bids = levels(book.bids);
        const asks = levels(book.asks);
        const bidVolume = sum(bids);
        const askVolume = sum(asks);
        const total = bidVolume + askVolume;

        // Сам стакан в отчёт целиком не нужен и в промпт не поместится:
        // отдаём агрегаты, крупнейшие уровни и верхушку среза.
        return {
          symbol,
          bestBid: bids[0]?.price ?? null,
          bestAsk: asks[0]?.price ?? null,
          bidVolume: round(bidVolume, 4),
          askVolume: round(askVolume, 4),
          /** От −1 (сплошные продавцы) до +1 (сплошные покупатели). */
          imbalance: total > 0 ? round((bidVolume - askVolume) / total, 4) : null,
          largestBids: biggest(bids),
          largestAsks: biggest(asks),
          levelsScanned: bids.length + asks.length,
        };
      },
    },

    get_crypto_top_by_volume: {
      // Имя расходится со спецификацией намеренно: там инструмент назван
      // ...top_volume_gainers, «gainers» — это лидеры роста цены, тогда как
      // описание и назначение говорят про объём торгов. Планировщик выбирает
      // инструмент по имени, и на расхождении промахивался бы.
      description:
        "Скрининг рынка: пары к USDT, отсортированные по суточному объёму торгов. " +
        "Показывает, где сейчас основная активность.",
      parameters: {
        limit: { type: "integer", description: "Сколько пар вернуть, до 50 (по умолчанию 10)" },
        minVolumeUsd: {
          type: "number",
          description: "Отбросить пары с суточным объёмом меньше указанного (в USDT)",
        },
      },
      required: [],
      async run(params) {
        const limit = optionalCount(params.limit, { max: 50, fallback: 10, name: "limit" });
        const minVolumeUsd = optionalAmount(params.minVolumeUsd, { name: "minVolumeUsd" });

        // Самый дорогой вызов во всём наборе: без параметра symbol Binance
        // отдаёт сводку по всем парам разом — несколько мегабайт и вес на два
        // порядка больше обычной котировки. Кешируется отдельно и надолго,
        // а ключ не зависит от limit: фильтрацию делаем у себя.
        const all = await cache.through(`scr`, TTL.screener, () =>
          binance.get("/api/v3/ticker/24hr"),
        );

        if (!Array.isArray(all)) {
          throw new ToolError(TOOL_ERROR.upstreamError, "Ожидался массив тикеров.");
        }

        const pairs = all
          // Только пары к USDT: для них котируемый объём и есть объём в
          // долларах, иначе minVolumeUsd не с чем сравнивать.
          .filter((t) => typeof t.symbol === "string" && t.symbol.endsWith("USDT"))
          .map((t) => ({
            symbol: t.symbol,
            quoteVolume: Number(t.quoteVolume),
            lastPrice: Number(t.lastPrice),
            priceChangePercent: Number(t.priceChangePercent),
            trades: t.count,
          }))
          .filter((t) => Number.isFinite(t.quoteVolume) && t.quoteVolume >= minVolumeUsd)
          .sort((a, b) => b.quoteVolume - a.quoteVolume)
          .slice(0, limit);

        return { quoteAsset: "USDT", minVolumeUsd, pairs };
      },
    },
  };
}

/**
 * Выполняет инструмент, не бросая исключений: отказ одного шага не должен
 * ронять весь план — отчёт собирается из того, что удалось (решение 04 из
 * плана реализации).
 *
 * @param {ReturnType<typeof createTools>} tools
 * @param {string} name
 * @param {Record<string, unknown>} params
 * @returns {Promise<{ ok: true, value: object } | { ok: false, error: { code: string, message: string } }>}
 */
export async function executeTool(tools, name, params = {}) {
  const tool = tools[name];
  if (!tool) {
    return failure(TOOL_ERROR.invalidParams, `Инструмента "${sanitize(name)}" не существует.`);
  }

  try {
    return { ok: true, value: await tool.run(params) };
  } catch (error) {
    if (error instanceof ToolError) return failure(error.code, error.message);
    // Всё прочее — баг у нас, а не отказ биржи. Не маскируем под upstream.
    return failure(TOOL_ERROR.upstreamError, `${error.name}: ${error.message}`);
  }
}

/** Имена инструментов для перечисления в схеме плана (фаза 4). */
export function toolNames(tools) {
  return Object.keys(tools);
}

function failure(code, message) {
  return { ok: false, error: { code, message } };
}

/** Имя приезжает из вывода модели и попадает в лог — обрезаем и чистим. */
function sanitize(name) {
  return String(name).replace(/[^\w.-]/g, "").slice(0, 60);
}

function levels(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map(([price, qty]) => ({ price: Number(price), qty: Number(qty) }))
    .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.qty));
}

function sum(rows) {
  return rows.reduce((acc, l) => acc + l.qty, 0);
}

function biggest(rows, count = 3) {
  return [...rows].sort((a, b) => b.qty - a.qty).slice(0, count);
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
