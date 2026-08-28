import { TOOL_ERROR, ToolError } from "./errors.js";

/**
 * Проверка параметров инструментов.
 *
 * Это не гигиена, а **граница доверия**. Аргументы сюда приезжают из вывода
 * языковой модели: планировщик волен выдумать что угодно, включая строку с
 * косой чертой, точкой с запятой или собственными query-параметрами. Дальше
 * этот слой строит URL к внешней бирже — значит, невалидированное значение
 * превращается в произвольный исходящий запрос от имени нашего сервиса.
 *
 * Поэтому здесь всё разрешено списком, а не запрещено проверкой: символ
 * обязан состоять из букв и цифр, интервал — совпадать с одним из известных,
 * число — попасть в границы. Всё остальное отвергается с
 * {@link TOOL_ERROR.invalidParams}, не доходя до сети.
 */

/**
 * Символы Binance — только заглавные буквы и цифры (`BTCUSDT`, `1000SATSUSDT`).
 * Регистр приводим сами: модель охотно пишет `btcusdt`, и отвергать такое
 * было бы придиркой, а вот всё остальное — нет.
 */
const SYMBOL = /^[A-Z0-9]{2,20}$/;

/** Интервалы свечей, которые понимает Binance. */
export const KLINE_INTERVALS = [
  "1s", "1m", "3m", "5m", "15m", "30m",
  "1h", "2h", "4h", "6h", "8h", "12h",
  "1d", "3d", "1w", "1M",
];

/** Допустимые значения глубины стакана: Binance принимает только их. */
export const DEPTH_LIMITS = [5, 10, 20, 50, 100, 500, 1000, 5000];

function fail(message) {
  throw new ToolError(TOOL_ERROR.invalidParams, message);
}

/**
 * @param {unknown} value
 * @returns {string} символ в верхнем регистре
 */
export function requireSymbol(value) {
  if (typeof value !== "string" || value.trim() === "") {
    fail("Не указан символ торговой пары (symbol).");
  }
  const symbol = value.trim().toUpperCase();
  if (!SYMBOL.test(symbol)) {
    // В сообщение символ не подставляем: он попадёт в лог, а это ввод из
    // недоверенного источника. Длины и вида достаточно, чтобы понять причину.
    fail(`Символ торговой пары содержит недопустимые знаки (длина ${symbol.length}).`);
  }
  return symbol;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function requireInterval(value) {
  if (typeof value !== "string" || !KLINE_INTERVALS.includes(value)) {
    fail(`Интервал свечей должен быть одним из: ${KLINE_INTERVALS.join(", ")}.`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {{ min?: number, max: number, fallback: number, name: string }} bounds
 * @returns {number}
 */
export function optionalCount(value, { min = 1, max, fallback, name }) {
  if (value === undefined || value === null) return fallback;

  const count = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(count) || count < min || count > max) {
    fail(`Параметр ${name} должен быть целым числом от ${min} до ${max}.`);
  }
  return count;
}

/**
 * Глубина стакана: Binance принимает не любое число, а одно из фиксированного
 * набора. Ближайшее большее подставлять не станем — молчаливая подмена
 * параметра хуже внятного отказа.
 *
 * @param {unknown} value
 * @returns {number}
 */
export function optionalDepthLimit(value, fallback = 100) {
  if (value === undefined || value === null) return fallback;

  const limit = typeof value === "number" ? value : Number(value);
  if (!DEPTH_LIMITS.includes(limit)) {
    fail(`Глубина стакана должна быть одной из: ${DEPTH_LIMITS.join(", ")}.`);
  }
  return limit;
}

/**
 * Метка времени в миллисекундах. Верхняя граница — сутки вперёд: биржа не
 * знает будущего, а запрос с датой из 2500 года выглядит галлюцинацией.
 *
 * @param {unknown} value
 * @returns {number|undefined}
 */
export function optionalTimestamp(value, { name = "startTime" } = {}) {
  if (value === undefined || value === null) return undefined;

  const stamp = typeof value === "number" ? value : Number(value);
  const limit = Date.now() + 24 * 60 * 60 * 1000;
  if (!Number.isInteger(stamp) || stamp < 0 || stamp > limit) {
    fail(`Параметр ${name} должен быть меткой времени в миллисекундах.`);
  }
  return stamp;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
export function optionalAmount(value, { fallback = 0, name }) {
  if (value === undefined || value === null) return fallback;

  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    fail(`Параметр ${name} должен быть неотрицательным числом.`);
  }
  return amount;
}
