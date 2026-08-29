import { TOOL_ERROR, ToolError } from "./errors.js";
import { logError } from "../logger.js";

/** Сутки в миллисекундах. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Стейблкоины: их место в рейтинге определяется размером эмиссии, а не
 * рынком, и «изменение цены за сутки» у них равно нулю по устройству. В
 * сводке они заняли бы треть строк, ничего не сообщая.
 *
 * Список по тикерам, а не по идентификаторам CoinGecko: тикер приходит и из
 * рейтинга, и из листинга биржи, поэтому сверять по нему можно в обоих местах.
 */
export const STABLECOINS = new Set([
  "USDT", "USDC", "USDS", "DAI", "USDE", "FDUSD", "PYUSD", "TUSD", "BUSD",
  "USD1", "RLUSD", "USDD", "FRAX", "LUSD", "GUSD", "EURC", "USDG", "USDX",
  "BUIDL", "SUSDE", "SUSDS", "BSC-USD", "USDP", "EURS", "XAUT", "PAXG",
]);

/**
 * Обёртки и стейкинг-деривативы: WBTC — это тот же биткоин в другой сети,
 * stETH — заложенный эфир. В рейтинге они идут отдельными строками, и топ-10
 * наполовину превращается в повторение BTC и ETH под другими именами.
 *
 * Исключение спорнее, чем со стейблкоинами (это всё-таки самостоятельные
 * активы со своей ценой), поэтому что именно отфильтровано, сводка показывает
 * пользователю — молча подменять состав десятки нельзя.
 */
export const WRAPPED = new Set([
  "WBTC", "CBBTC", "SOLVBTC", "LBTC", "STBTC", "TBTC",
  "STETH", "WSTETH", "WEETH", "WBETH", "RETH", "EZETH", "METH", "WETH",
  "WBNB", "BNSOL", "JITOSOL", "MSOL", "JUPSOL",
]);

/**
 * Сколько монет запрашивать из рейтинга, чтобы после фильтрации осталось
 * достаточно. Стейблкоины и обёртки занимают в верхушке рейтинга примерно
 * каждую третью строку, поэтому запас нужен изрядный.
 */
const FETCH_DEPTH = 30;

/** Верхняя граница выдачи: столько строк ещё читается с телефона. */
export const MAX_OVERVIEW_COINS = 15;

/**
 * Начало вчерашних суток по UTC в миллисекундах.
 *
 * Эпоха выровнена по полуночи UTC, поэтому целочисленное деление на сутки и
 * даёт границу дня — без разбора календаря и без зависимости от часового
 * пояса машины, на которой запущен Core.
 *
 * @param {number} [now]
 */
export function yesterdayStartMs(now = Date.now()) {
  return Math.floor(now / DAY_MS) * DAY_MS - DAY_MS;
}

/**
 * Сводка по рынку: топ монет по капитализации с итогами вчерашних суток.
 *
 * Два источника не от хорошей жизни, а по необходимости:
 *
 *   - **рейтинг** может дать только CoinGecko: капитализации у биржи нет;
 *   - **итоги суток** правильнее брать с Binance — там это настоящая дневная
 *     свеча с ценами открытия и закрытия и честным объёмом торгов, тогда как
 *     у CoinGecko есть лишь снимки цены на границах суток;
 *   - но часть монет верхушки рейтинга на Binance **не листится** (на август
 *     2026 это, например, HYPE и FIGR_HELOC), и для них остаётся CoinGecko.
 *
 * Границы суток у обоих источников — полночь UTC, поэтому цифры сопоставимы.
 * Из какого источника взята строка, видно в поле `source`: методики разные, и
 * скрывать это от пользователя не стоит.
 *
 * @param {{
 *   coingecko: import("./CoinGeckoClient.js").CoinGeckoClient,
 *   binance: import("./BinanceClient.js").BinanceClient,
 *   limit?: number,
 *   now?: number,
 * }} deps
 */
export async function buildMarketOverview({ coingecko, binance, limit = 10, now = Date.now() }) {
  const ranked = await coingecko.get("/api/v3/coins/markets", {
    vs_currency: "usd",
    order: "market_cap_desc",
    per_page: FETCH_DEPTH,
    page: 1,
  });

  if (!Array.isArray(ranked)) {
    throw new ToolError(TOOL_ERROR.upstreamError, "CoinGecko вернул не массив монет рейтинга.");
  }

  const excluded = { stablecoins: [], wrapped: [] };
  const selected = [];

  for (const row of ranked) {
    if (selected.length >= limit) break;
    const symbol = String(row?.symbol ?? "").toUpperCase();
    if (!symbol) continue;

    if (STABLECOINS.has(symbol)) {
      excluded.stablecoins.push(symbol);
      continue;
    }
    if (WRAPPED.has(symbol)) {
      excluded.wrapped.push(symbol);
      continue;
    }

    selected.push({
      rank: row.market_cap_rank ?? null,
      id: String(row.id ?? ""),
      symbol,
      name: String(row.name ?? symbol),
      // Текущее состояние — из того же ответа, лишних запросов не нужно.
      price: numberOrNull(row.current_price),
      priceChangePercent24h: numberOrNull(row.price_change_percentage_24h),
      volume24h: numberOrNull(row.total_volume),
      marketCap: numberOrNull(row.market_cap),
    });
  }

  const dayStart = yesterdayStartMs(now);
  const history = await Promise.all(
    selected.map((coin) => yesterday({ coin, binance, coingecko, dayStart })),
  );

  return {
    dayStartMs: dayStart,
    coins: selected.map((coin, index) => ({ ...coin, ...history[index] })),
    excluded,
  };
}

/**
 * Итоги вчерашних суток по одной монете. Не бросает: отказ по одной строке —
 * это `н/д` в таблице, а не потеря всего отчёта (то же решение, что и у
 * `executeTool` для шагов плана).
 */
async function yesterday({ coin, binance, coingecko, dayStart }) {
  const fromBinance = await binanceDay({ symbol: coin.symbol, binance, dayStart });
  if (fromBinance) return fromBinance;

  const fromCoingecko = await coingeckoDay({ id: coin.id, coingecko, dayStart });
  if (fromCoingecko) return fromCoingecko;

  return { open: null, close: null, changePercent: null, dayVolume: null, source: null };
}

/**
 * Дневная свеча Binance по паре `<ТИКЕР>USDT`.
 *
 * `limit=2`, берётся элемент `[0]` — вчерашняя **завершённая** свеча; `[1]` —
 * сегодняшняя, ещё не закрытая, ей в сводке за прошедшие сутки не место.
 *
 * Возвращает `null`, если пары нет в листинге (Binance отвечает на такое
 * ошибкой `unknown_symbol`) или если свеча пришла не за те сутки.
 */
async function binanceDay({ symbol, binance, dayStart }) {
  let rows;
  try {
    rows = await binance.get("/api/v3/klines", {
      symbol: `${symbol}USDT`,
      interval: "1d",
      limit: 2,
    });
  } catch (error) {
    // Отсутствие пары — ожидаемый исход, а не сбой: молча уходим на откат.
    if (error instanceof ToolError && error.code === TOOL_ERROR.unknownSymbol) return null;
    logError(`Не удалось получить дневную свечу ${symbol}USDT:`, error);
    return null;
  }

  const candle = Array.isArray(rows) ? rows[0] : undefined;
  if (!Array.isArray(candle)) return null;

  // Свечи 1d у Binance выровнены по полуночи UTC. Если открытие не совпало с
  // ожидаемой границей, значит взята не та свеча — подставлять её в отчёт
  // о вчерашних сутках нельзя.
  if (Number(candle[0]) !== dayStart) return null;

  const open = Number(candle[1]);
  const close = Number(candle[4]);
  // Объём берём из индекса 7 (quoteVolume, в USDT), а не из 5: тот считается
  // в базовой монете и между разными парами несопоставим.
  const dayVolume = Number(candle[7]);

  if (!Number.isFinite(open) || !Number.isFinite(close) || open === 0) return null;

  return {
    open,
    close,
    changePercent: ((close - open) / open) * 100,
    dayVolume: Number.isFinite(dayVolume) ? dayVolume : null,
    source: "binance",
  };
}

/**
 * Откат для монет без пары на Binance: дневные точки CoinGecko.
 *
 * `days=2&interval=daily` возвращает снимки на границах суток — цена на
 * начало вчерашнего дня и на его конец (он же начало сегодняшнего). Точки
 * ищем по метке времени, а не по индексу: состав ответа зависит от того, в
 * какой момент суток его запросили.
 */
async function coingeckoDay({ id, coingecko, dayStart }) {
  if (!id) return null;

  let chart;
  try {
    chart = await coingecko.get(`/api/v3/coins/${encodeURIComponent(id)}/market_chart`, {
      vs_currency: "usd",
      days: 2,
      interval: "daily",
    });
  } catch (error) {
    logError(`Не удалось получить дневную историю CoinGecko для ${id}:`, error);
    return null;
  }

  const open = pointAt(chart?.prices, dayStart);
  const close = pointAt(chart?.prices, dayStart + DAY_MS);
  if (open === null || close === null || open === 0) return null;

  return {
    open,
    close,
    changePercent: ((close - open) / open) * 100,
    // У CoinGecko это не объём за сутки, а скользящий суточный объём на
    // момент закрытия — величина близкая, но не та же самая. Считать её
    // дневной свечой нельзя, поэтому источник строки видно в отчёте.
    dayVolume: pointAt(chart?.total_volumes, dayStart + DAY_MS),
    source: "coingecko",
  };
}

/** Значение ряда `[[метка, число], …]` на заданной метке времени. */
function pointAt(series, timestamp) {
  if (!Array.isArray(series)) return null;
  const found = series.find((point) => Array.isArray(point) && Number(point[0]) === timestamp);
  return found ? numberOrNull(found[1]) : null;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
