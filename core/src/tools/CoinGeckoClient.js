import { TOOL_ERROR, ToolError } from "./errors.js";

/**
 * Клиент публичного REST API CoinGecko.
 *
 * Нужен ровно за тем, чего нет у Binance: **рыночной капитализации**. Биржа
 * знает только про торговые пары и их объёмы — сколько всего монет выпущено и
 * сколько стоит вся сеть, она не знает и знать не должна. Поэтому рейтинг
 * «топ-10 по капитализации» строится здесь, а котировки по-прежнему берутся
 * с биржи (см. `BinanceClient`).
 *
 * Второе назначение — откат для монет, которых нет в листинге Binance: у
 * CoinGecko есть дневная история по всем монетам рейтинга, включая те, что на
 * этой бирже не торгуются.
 *
 * Как и у Binance, только открытые эндпоинты: ни ключей, ни подписи. Базовый
 * адрес приходит из конфига и никогда из параметров вызова — иначе вывод
 * языковой модели определял бы, к какому хосту пойдёт сервис.
 */
export class CoinGeckoClient {
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
          `CoinGecko не ответил за ${this.timeoutMs} мс (${path}).`,
        );
      }
      throw new ToolError(
        TOOL_ERROR.unavailable,
        `Не удалось обратиться к CoinGecko (${path}): ${error.message}`,
      );
    }

    // На бесплатном тарифе лимит частоты низкий и выбирается легко: это
    // штатный исход, а не поломка, и вызывающий код должен уметь его пережить
    // (показать монету без истории, а не потерять весь отчёт).
    if (response.status === 429) {
      throw new ToolError(TOOL_ERROR.rateLimited, "CoinGecko ограничил частоту запросов (429).");
    }

    if (!response.ok) {
      throw new ToolError(
        TOOL_ERROR.upstreamError,
        `CoinGecko ответил ${response.status} на ${path}.`,
      );
    }

    try {
      return await response.json();
    } catch {
      throw new ToolError(TOOL_ERROR.upstreamError, `CoinGecko вернул не JSON (${path}).`);
    }
  }
}
