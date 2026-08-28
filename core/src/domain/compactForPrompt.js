/**
 * Сжатие результатов инструментов перед отправкой модели.
 *
 * Инструмент вправе вернуть пятьсот свечей или полсотни торговых пар — для
 * расчётов это нормально, для промпта нет. Дело не только в размере окна:
 * модель, которой скормили длинный ряд чисел, начинает пересказывать его
 * построчно вместо того, чтобы делать вывод, и с большей охотой путает
 * значения местами.
 *
 * Поэтому ряды заменяются тем, что от них нужно в отчёте: границами,
 * экстремумами, суммой и десятком опорных точек. Считаем здесь, у себя, —
 * арифметика на модели была бы худшим из способов её выполнить.
 */

/** Сколько опорных точек оставлять от длинного ряда свечей. */
const SERIES_POINTS = 10;

/** Предел длины для прочих массивов. */
const MAX_ITEMS = 15;

/**
 * @param {object} value результат инструмента
 * @returns {object} он же, пригодный для промпта
 */
export function compactForPrompt(value) {
  if (value === null || typeof value !== "object") return value;

  const compact = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "candles" && Array.isArray(item)) {
      compact.candlesSummary = summariseCandles(item);
      if (item.length > SERIES_POINTS) compact.candlesSample = downsample(item, SERIES_POINTS);
      else compact.candles = item;
      continue;
    }

    if (Array.isArray(item) && item.length > MAX_ITEMS) {
      compact[key] = item.slice(0, MAX_ITEMS);
      compact[`${key}Omitted`] = item.length - MAX_ITEMS;
      continue;
    }

    compact[key] = item;
  }
  return compact;
}

/**
 * Сводка по ряду свечей: то, ради чего свечи обычно и запрашивают.
 * @param {Array<{open:number, high:number, low:number, close:number, volume:number, quoteVolume:number, openTime:number}>} candles
 */
function summariseCandles(candles) {
  if (candles.length === 0) return { count: 0 };

  const first = candles[0];
  const last = candles.at(-1);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const open = first.open;
  const close = last.close;

  return {
    count: candles.length,
    from: iso(first.openTime),
    to: iso(last.openTime),
    open,
    close,
    changePercent: open > 0 ? round(((close - open) / open) * 100, 2) : null,
    high: Math.max(...highs),
    low: Math.min(...lows),
    // Размах к цене — грубая, но понятная мера волатильности за период.
    rangePercent: close > 0 ? round(((Math.max(...highs) - Math.min(...lows)) / close) * 100, 2) : null,
    totalVolume: round(sum(candles.map((c) => c.volume)), 4),
    totalQuoteVolume: round(sum(candles.map((c) => c.quoteVolume)), 2),
  };
}

/**
 * Равномерная выборка точек, обязательно включая первую и последнюю: по ней
 * видно форму движения, а не только его итог.
 */
function downsample(candles, points) {
  const step = (candles.length - 1) / (points - 1);
  const picked = [];
  for (let i = 0; i < points; i += 1) {
    const c = candles[Math.round(i * step)];
    picked.push({ time: iso(c.openTime), close: c.close });
  }
  return picked;
}

function iso(ms) {
  return typeof ms === "number" ? new Date(ms).toISOString().slice(0, 16) : ms;
}

function sum(values) {
  return values.reduce((acc, v) => acc + (Number.isFinite(v) ? v : 0), 0);
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
