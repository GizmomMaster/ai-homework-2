import { LLM_ERROR, LlmError } from "./LlmRunner.js";

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
 * Тело ответа как JSON — с отказом, который переживёт границу сервисов.
 *
 * Голый `response.json()` бросает `SyntaxError`, а это не {@link LlmError}:
 * `DialogService` не опознает его код и отдаст `internal_error` — «баг у нас»
 * вместо «провайдер ответил не тем». А ответить не тем при статусе 200 он
 * вполне может: прокси или туннель перед LM Studio отдаёт свою HTML-страницу,
 * и по коду ответа этого не видно. `BinanceClient` разбирает этот случай
 * давно — раннеры отставали.
 *
 * @param {Response} response
 * @param {string} vendor имя провайдера для сообщения
 * @returns {Promise<unknown>}
 * @throws {LlmError}
 */
export async function readJson(response, vendor) {
  let raw;
  try {
    raw = await response.text();
  } catch (error) {
    throw new LlmError(
      LLM_ERROR.unavailable,
      `Соединение с ${vendor} оборвалось на чтении ответа: ${error.message}`,
    );
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new LlmError(
      LLM_ERROR.badResponse,
      badResponseMessage({
        vendor,
        hint: `${vendor} вернула не JSON при статусе ${response.status}.`,
        data: raw,
      }),
    );
  }
}

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
