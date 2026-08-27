/**
 * Ошибка, которую HTTP-слой умеет превратить в ответ с телом
 * `{ error: { code, message } }`. Всё остальное, что долетит до сервера,
 * считается внутренней ошибкой и отдаётся как 500 без подробностей.
 */
export class HttpError extends Error {
  /**
   * @param {number} status HTTP-статус ответа
   * @param {string} code машиночитаемый код для клиента
   * @param {string} message человекочитаемое пояснение
   */
  constructor(status, code, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (message) => new HttpError(400, "invalid_request", message);
export const notFound = (message) => new HttpError(404, "not_found", message);

/**
 * Проверяет, что значение — непустая строка. Используется и для параметров
 * пути, и для полей тела запроса, поэтому сообщение включает имя поля.
 *
 * @param {unknown} value
 * @param {string} field
 * @param {{ maxLength?: number }} [options]
 * @returns {string}
 */
export function requireString(value, field, { maxLength } = {}) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw badRequest(`Поле "${field}" обязательно и должно быть непустой строкой.`);
  }
  if (maxLength !== undefined && value.length > maxLength) {
    throw badRequest(`Поле "${field}" длиннее допустимых ${maxLength} символов.`);
  }
  return value;
}
