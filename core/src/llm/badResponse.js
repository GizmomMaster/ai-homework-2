/**
 * Сообщения об ответах модели, которые не удалось прочитать.
 *
 * Голого «некорректный формат ответа» для разбора недостаточно: по нему не
 * отличить незагруженную модель от reasoning-модели, потратившей всю
 * генерацию на размышление, а воспроизвести случай удаётся не всегда — к
 * моменту, когда до лога дошли руки, модель может быть уже другой.
 *
 * Поэтому к догадке о причине всегда прикладывается само тело ответа и
 * размер запроса. Сообщение уходит только в лог Core (см. `JobRunner`), к
 * пользователю наружу идёт лишь код причины, так что место для подробностей
 * здесь есть.
 */

/** Сколько знаков тела ответа оставлять в сообщении. */
const BODY_EXCERPT_LIMIT = 500;

/**
 * @param {{
 *   vendor: string,
 *   hint: string,
 *   data: unknown,
 *   messages?: Array<{ role: string, content: string }>,
 *   format?: "json"|object,
 * }} input
 * @returns {string}
 */
export function badResponseMessage({ vendor, hint, data, messages, format }) {
  const parts = [hint, `Ответ ${vendor}: ${excerpt(data)}`];
  if (messages) parts.push(`Запрос: ${describeRequest(messages, format)}`);
  return parts.join(" ");
}

/**
 * Размер запроса — первое, что хочется знать при пустом ответе: промпт
 * длиннее контекста, заданного при загрузке модели, обрывает генерацию, а по
 * телу ответа этого не видно. Знаки, а не токены: токенайзер модели нам
 * недоступен, а порядок величины виден и так.
 */
function describeRequest(messages, format) {
  const chars = messages.reduce((sum, message) => sum + (message.content?.length ?? 0), 0);
  const schema = format === undefined ? "без схемы" : format === "json" ? "json" : "json_schema";
  return `${messages.length} сообщ., ~${chars} знаков, ${schema}`;
}

/** @param {unknown} data */
export function excerpt(data) {
  let text;
  try {
    text = JSON.stringify(data);
  } catch {
    return "(тело не сериализуется)";
  }
  if (text === undefined) return "(пустое тело)";
  return text.length > BODY_EXCERPT_LIMIT ? `${text.slice(0, BODY_EXCERPT_LIMIT)}…` : text;
}
