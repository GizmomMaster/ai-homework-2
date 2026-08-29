/**
 * Коды отказа инструмента. Переживают границу шага плана: исполнитель по ним
 * решает, помечать шаг неудачным и продолжать или прекращать целиком.
 */
export const TOOL_ERROR = {
  /** Параметры не прошли проверку — как правило, ошибка планировщика. */
  invalidParams: "invalid_params",
  /** Биржа не знает такой торговой пары. */
  unknownSymbol: "unknown_symbol",
  /** Упёрлись в лимит запросов биржи. */
  rateLimited: "rate_limited",
  /** Биржа ответила ошибкой или неожиданным телом. */
  upstreamError: "upstream_error",
  /** Не дождались ответа. */
  timeout: "timeout",
  /** Не смогли подключиться. */
  unavailable: "unavailable",
};

/**
 * Причина неудачного `fetch` словами.
 *
 * Сам `fetch` бросает `TypeError: fetch failed` — сообщение, одинаковое для
 * потерянного DNS, отвергнутого соединения, оборванного TLS и упёршегося в
 * лимит хоста. Настоящая причина лежит в `cause`, и без неё запись в логе
 * не отличает «нет сети» от «биржа нас придержала».
 *
 * @param {Error & { cause?: unknown }} error
 * @returns {string}
 */
export function describeFetchError(error) {
  const cause = error.cause;
  if (!cause) return error.message;

  // Happy eyeballs пробует несколько адресов (IPv6 и IPv4) и складывает
  // отказы в AggregateError — коды у них обычно одинаковые, хватит первого.
  const first = Array.isArray(cause.errors) ? cause.errors[0] : cause;
  const code = first?.code ?? cause.code;

  return code ? `${error.message} (${code})` : `${error.message} (${first?.message ?? cause})`;
}

/**
 * Отказ инструмента с машиночитаемым кодом.
 *
 * Наружу из слоя инструментов исключения не летят: `executeTool` ловит их и
 * превращает в результат. Класс нужен, чтобы код причины не потерялся по
 * дороге от HTTP-клиента до исполнителя.
 */
export class ToolError extends Error {
  /**
   * @param {string} code один из {@link TOOL_ERROR}
   * @param {string} message текст для лога Core, не для пользователя
   */
  constructor(code, message) {
    super(message);
    this.name = "ToolError";
    this.code = code;
  }
}
