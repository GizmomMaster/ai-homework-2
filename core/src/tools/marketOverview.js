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
 *   cache?: import("./cache.js").TtlCache,
 *   limit?: number,
 *   now?: number,
 * }} deps
 *   `cache` необязателен: без него итоги суток берутся заново каждый раз —
 *   так удобнее в тестах, где важно посчитать обращения к источнику.
 */
export async function buildMarketOverview({
  coingecko,
  binance,
  cache,
  limit = 10,
  now = Date.now(),
}) {
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
  const history = await collectHistory({ selected, binance, coingecko, cache, dayStart });

  return {
    dayStartMs: dayStart,
    coins: selected.map((coin, index) => ({ ...coin, ...history[index] })),
    excluded,
  };
}

/**
 * Пары нет на бирже. Отдельно от `null`, потому что судьба у них в кеше
 * разная: это устойчивый факт, а `null` — «в этот раз не получилось».
 */
const NOT_LISTED = Object.freeze({ notListed: true });

/** Пусто: монета остаётся в сводке, но со `н/д` вместо цифр. */
const NO_HISTORY = { open: null, close: null, changePercent: null, dayVolume: null, source: null };

/**
 * Сколько держать итоги прошедших суток.
 *
 * Сутки закрыты, и их свеча больше не изменится — до самой полуночи, когда
 * ключ кеша сменится вместе с датой. Сутки с запасом и держим: перезапрашивать
 * неизменное каждую минуту вместе с текущими ценами незачем, а именно это и
 * происходило, пока весь обзор жил под одним коротким сроком.
 */
const DAY_HISTORY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Кеширует итоги суток по одной монете.
 *
 * Неудача (`null` от источника) наружу уходит как `undefined` — такое
 * {@link TtlCache} не запоминает. Разница существенная: оборванное соединение
 * к CoinGecko иначе закрепило бы `н/д` для монеты на сутки вперёд, хотя
 * следующий запрос прошёл бы без единой заминки.
 */
function cachedDay(cache, key, produce) {
  if (!cache) return produce();
  return cache.through(key, DAY_HISTORY_TTL_MS, async () => (await produce()) ?? undefined);
}

/**
 * Итоги вчерашних суток по всем монетам. Не бросает: отказ по одной строке —
 * это `н/д` в таблице, а не потеря всего отчёта (то же решение, что и у
 * `executeTool` для шагов плана).
 *
 * Два источника опрашиваются **по-разному, и это не случайность**. У Binance
 * лимит считается весом запросов и щедр — десяток свечей можно взять разом.
 * У CoinGecko на бесплатном тарифе лимит низкий, и пачка одновременных
 * запросов упирается в него: в лучшем случае приходит 429, в худшем соединения
 * просто рвутся. Поэтому откат идёт по одной монете за раз — он всё равно
 * нужен единицам из десятки, так что на общем времени это почти не сказывается.
 */
async function collectHistory({ selected, binance, coingecko, cache, dayStart }) {
  const fromBinance = await Promise.all(
    selected.map((coin) =>
      // Дата в ключе — не для уникальности, а вместо инвалидации: в полночь
      // ключ сменится сам, и вчерашняя запись перестанет находиться.
      cachedDay(cache, `day:b:${coin.symbol}:${dayStart}`, () =>
        binanceDay({ symbol: coin.symbol, binance, dayStart }),
      ),
    ),
  );

  const history = [];
  for (const [index, coin] of selected.entries()) {
    const candle = fromBinance[index];
    if (candle && candle !== NOT_LISTED) {
      history[index] = candle;
      continue;
    }
    history[index] =
      (await cachedDay(cache, `day:g:${coin.id}:${dayStart}`, () =>
        coingeckoDay({ id: coin.id, coingecko, dayStart }),
      )) ?? NO_HISTORY;
  }

  return history;
}

/**
 * Дневная свеча Binance по паре `<ТИКЕР>USDT`.
 *
 * `limit=2`, берётся элемент `[0]` — вчерашняя **завершённая** свеча; `[1]` —
 * сегодняшняя, ещё не закрытая, ей в сводке за прошедшие сутки не место.
 *
 * Три разных исхода, и различать их важно из-за кеша:
 *   - свеча — успех;
 *   - {@link NOT_LISTED} — пары нет в листинге. Факт устойчивый: до полуночи
 *     пара не появится, и запоминать его можно наравне с самой свечой;
 *   - `null` — не сложилось: сеть, лимит, свеча не за те сутки. Такое
 *     запоминать нельзя, иначе одна заминка закрепит пробел до конца дня.
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
    if (error instanceof ToolError && error.code === TOOL_ERROR.unknownSymbol) return NOT_LISTED;
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
