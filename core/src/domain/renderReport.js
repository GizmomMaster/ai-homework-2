/**
 * Шаблонная сборка отчёта из результатов шагов.
 *
 * Временная: в фазе 5 её место займёт сведение отчёта моделью, которой
 * достанутся те же структурированные значения. Пока задача скромнее — не
 * сочинить текст, а показать числа так, чтобы их можно было прочитать: сырой
 * JSON в мессенджере нечитаем, а ждать связной прозы от шаблона незачем.
 *
 * Разметка — Markdown: адаптер превращает его в HTML Telegram.
 */

/** Человеческие имена полей. Всё, чего здесь нет, печатается как есть. */
const LABELS = {
  symbol: "пара",
  price: "цена",
  lastPrice: "цена",
  bid: "покупка",
  ask: "продажа",
  spreadPercent: "спред, %",
  priceChangePercent24h: "за 24ч, %",
  priceChangePercent: "изменение, %",
  weightedAvgPrice: "средневзвешенная",
  high24h: "максимум за 24ч",
  low24h: "минимум за 24ч",
  high: "максимум",
  low: "минимум",
  volume: "объём (базовый)",
  quoteVolume: "объём, USDT",
  trades: "сделок",
  bestBid: "лучшая покупка",
  bestAsk: "лучшая продажа",
  bidVolume: "объём заявок на покупку",
  askVolume: "объём заявок на продажу",
  imbalance: "дисбаланс",
  largestBids: "крупнейшие покупки",
  largestAsks: "крупнейшие продажи",
  levelsScanned: "уровней просмотрено",
  interval: "интервал",
  candles: "свечи",
  rsi: "RSI",
  zone: "зона",
  recent: "предыдущие значения",
  overbought: "порог перекупленности",
  oversold: "порог перепроданности",
  samples: "свечей в расчёте",
  length: "период",
  asOf: "на момент",
  pairs: "пары",
  minVolumeUsd: "порог объёма, USDT",
  quoteAsset: "котируемый актив",
  openTime: "начало",
  open: "открытие",
  close: "закрытие",
  qty: "объём",
};

/** Сколько элементов массива показывать: остальное только зашумит сообщение. */
const MAX_ROWS = 8;

/** Понятные пользователю причины отказа шага. */
const ERRORS = {
  invalid_params: "неверные параметры запроса",
  unknown_symbol: "биржа не знает такой торговой пары",
  rate_limited: "биржа ограничила частоту запросов",
  upstream_error: "биржа ответила ошибкой",
  timeout: "биржа не ответила вовремя",
  unavailable: "не удалось связаться с биржей",
  unsupported_asset: "этот актив инструментом не поддерживается",
  computation_failed: "не удалось выполнить расчёт",
};

/**
 * @param {{
 *   taskSummary: string,
 *   steps: Array<{ action: string, ok: boolean, value?: object, error?: { code: string } }>,
 *   truncated?: boolean,
 * }} input
 * @returns {string}
 */
export function renderReport({ taskSummary, steps, truncated = false }) {
  const parts = [`**${taskSummary}**`];

  for (const step of steps) {
    if (step.ok) {
      parts.push(`**${step.action}**\n${renderValue(step.value)}`);
    } else {
      parts.push(`**${step.action}**\n_Не удалось: ${describeError(step.error)}._`);
    }
  }

  const failed = steps.filter((s) => !s.ok).length;
  if (failed > 0 && failed < steps.length) {
    // Явная оговорка обязательна: без неё частичный отчёт читается как полный.
    parts.push(`_Данные неполные: ${failed} из ${steps.length} шагов не удались._`);
  }
  if (truncated) {
    parts.push(`_План был длиннее и выполнен частично._`);
  }

  return parts.join("\n\n");
}

function describeError(error) {
  return ERRORS[error?.code] ?? "неизвестная ошибка";
}

/** @param {object} value */
function renderValue(value) {
  return Object.entries(value)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([key, v]) => renderField(key, v))
    .join("\n");
}

function renderField(key, value) {
  const label = LABELS[key] ?? key;

  if (Array.isArray(value)) {
    if (value.length === 0) return `${label}: нет`;
    const shown = value.slice(0, MAX_ROWS).map((row) => `  • ${renderRow(row)}`);
    if (value.length > MAX_ROWS) shown.push(`  • …ещё ${value.length - MAX_ROWS}`);
    return `${label}:\n${shown.join("\n")}`;
  }

  return `${label}: ${renderScalar(key, value)}`;
}

function renderRow(row) {
  if (row === null || typeof row !== "object") return String(row);
  return Object.entries(row)
    .map(([key, v]) => `${LABELS[key] ?? key} ${renderScalar(key, v)}`)
    .join(", ");
}

function renderScalar(key, value) {
  if (typeof value !== "number") return String(value);
  if (key === "openTime" || key === "closeTime") return new Date(value).toISOString().slice(0, 16);

  // Крупные суммы разделяем узкими пробелами, мелкие цены не округляем:
  // потерять значащие цифры у актива ценой в доли цента хуже, чем показать
  // длинное число.
  const digits = Math.abs(value) >= 1000 ? 2 : Math.abs(value) >= 1 ? 4 : 8;
  return groupThousands(trimZeros(value.toFixed(digits)));
}

function trimZeros(text) {
  return text.includes(".") ? text.replace(/\.?0+$/, "") : text;
}
/** Разделяет разряды только в целой части: в дробной это была бы бессмыслица. */
function groupThousands(text) {
  const [whole, fraction] = text.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}