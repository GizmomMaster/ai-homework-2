import { TOOL_ERROR, ToolError, describeFetchError } from "./errors.js";

/**
 * Общая часть клиентов публичных REST API рыночных данных.
 *
 * `BinanceClient` и `CoinGeckoClient` делали одно и то же слово в слово:
 * нормализация базового адреса, сборка query, таймаут, разбор отказов сети,
 * проверка, что тело — вообще JSON. Отличались они ровно двумя вещами, и обе
 * остались у наследников: **разбор кодов ответа** (у каждого источника свои) и
 * **род названия** в сообщениях — «Binance ответила», но «CoinGecko ответил».
 *
 * Держать это в одном месте важно не ради экономии строк. Здесь проходят два
 * правила, разъезжаться которым между источниками нельзя:
 *
 *   - **базовый адрес приходит из конфига и никогда из параметров вызова.**
 *     Параметры формирует языковая модель, и адрес среди них означал бы, что
 *     её вывод решает, к какому хосту пойдёт сервис;
 *   - **путь складывается только из констант нашего кода**, а значения запроса
 *     экранирует `URLSearchParams` — подставить в путь чужой сегмент неоткуда.
 *
 * Ни один клиент не использует ключей и подписи: система читает открытые
 * рыночные данные и ничего больше (§4 спецификации).
 */
export class PublicApiClient {
  /**
   * @param {{
   *   baseUrl: string,
   *   vendor: { name: string, answered: string, returned: string },
   *   timeoutMs?: number,
   *   fetchImpl?: typeof fetch,
   * }} options
   *   `vendor` — как называть источник в сообщениях об отказе. Глаголы в нём
   *   потому, что род у названий разный, а сообщения читает человек.
   */
  constructor({ baseUrl, vendor, timeoutMs = 10000, fetchImpl = fetch }) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.vendor = vendor;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  /**
   * @param {string} path путь эндпоинта, из нашего кода, не из параметров
   * @param {Record<string, string|number>} [query] уже проверенные значения
   * @returns {Promise<unknown>}
   * @throws {ToolError}
   */
  async get(path, query = {}) {
    const { name, answered, returned } = this.vendor;

    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value));
    }
    const suffix = params.toString();
    const url = `${this.baseUrl}${path}${suffix ? `?${suffix}` : ""}`;

    let response;
    try {
      response = await this.fetchImpl(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error.name === "TimeoutError" || error.name === "AbortError") {
        throw new ToolError(
          TOOL_ERROR.timeout,
          `${name} не ${answered} за ${this.timeoutMs} мс (${path}).`,
        );
      }
      throw new ToolError(
        TOOL_ERROR.unavailable,
        `Не удалось обратиться к ${name} (${path}): ${describeFetchError(error)}`,
      );
    }

    if (!response.ok) throw await this.httpError(response, path);

    try {
      return await response.json();
    } catch {
      throw new ToolError(TOOL_ERROR.upstreamError, `${name} ${returned} не JSON (${path}).`);
    }
  }

  /**
   * Отказ по коду ответа. Наследник переопределяет и разбирает коды своего
   * источника, а всё, чего не узнал, отдаёт сюда.
   *
   * @param {Response} response
   * @param {string} path
   * @returns {Promise<ToolError>}
   */
  async httpError(response, path) {
    const { name, answered } = this.vendor;
    return new ToolError(
      TOOL_ERROR.upstreamError,
      `${name} ${answered} ${response.status} на ${path}.`,
    );
  }
}
