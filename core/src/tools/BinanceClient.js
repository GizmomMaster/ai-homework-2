import { TOOL_ERROR, ToolError, describeFetchError } from "./errors.js";

/** Код Binance для неизвестной торговой пары. */
const BINANCE_UNKNOWN_SYMBOL = -1121;

/**
 * Клиент публичного REST API Binance.
 *
 * Работает только с открытыми эндпоинтами: ни ключей, ни подписи, ни доступа
 * к средствам пользователя. Читать рыночные данные — всё, что эта система
 * умеет и должна уметь (§4 спецификации).
 *
 * Базовый адрес приходит из конфига и никогда из параметров вызова — по той
 * же причине, по которой из конфига берутся адреса callback'ов: иначе вывод
 * языковой модели определял бы, к какому хосту сервис пойдёт.
 */
export class BinanceClient {
  /**
   * @param {{ baseUrl: string, timeoutMs?: number, fetchImpl?: typeof fetch }} options
   */
  constructor({ baseUrl, timeoutMs = 10000, fetchImpl = fetch }) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
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
    // URLSearchParams экранирует значения сам; путь при этом складывается
    // только из констант нашего кода, поэтому подставить в него чужой сегмент
    // неоткуда.
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
          `Binance не ответила за ${this.timeoutMs} мс (${path}).`,
        );
      }
      throw new ToolError(
        TOOL_ERROR.unavailable,
        `Не удалось обратиться к Binance (${path}): ${describeFetchError(error)}`,
      );
    }

    if (!response.ok) throw await this.#httpError(response, path);

    try {
      return await response.json();
    } catch {
      throw new ToolError(TOOL_ERROR.upstreamError, `Binance вернула не JSON (${path}).`);
    }
  }

  async #httpError(response, path) {
    // 418 — ответ Binance тому, кто продолжил стучаться после 429.
    if (response.status === 429 || response.status === 418) {
      return new ToolError(
        TOOL_ERROR.rateLimited,
        `Binance ограничила частоту запросов (${response.status}).`,
      );
    }

    const body = await response.json().catch(() => null);
    if (body?.code === BINANCE_UNKNOWN_SYMBOL) {
      return new ToolError(
        TOOL_ERROR.unknownSymbol,
        "Binance не знает такой торговой пары.",
      );
    }

    return new ToolError(
      TOOL_ERROR.upstreamError,
      `Binance ответила ${response.status} на ${path}.`,
    );
  }
}
