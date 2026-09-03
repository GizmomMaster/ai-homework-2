import { TOOL_ERROR, ToolError } from "./errors.js";
import { PublicApiClient } from "./PublicApiClient.js";

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
 * Как и у Binance, только открытые эндпоинты: ни ключей, ни подписи. Общая
 * механика запроса — в {@link PublicApiClient}; здесь остаётся своё отношение
 * к лимиту частоты.
 */
export class CoinGeckoClient extends PublicApiClient {
  /**
   * @param {{ baseUrl: string, timeoutMs?: number, fetchImpl?: typeof fetch }} options
   */
  constructor(options) {
    super({ ...options, vendor: { name: "CoinGecko", answered: "ответил", returned: "вернул" } });
  }

  /** @param {Response} response */
  async httpError(response, path) {
    // На бесплатном тарифе лимит частоты низкий и выбирается легко: это
    // штатный исход, а не поломка, и вызывающий код должен уметь его пережить
    // (показать монету без истории, а не потерять весь отчёт).
    if (response.status === 429) {
      return new ToolError(TOOL_ERROR.rateLimited, "CoinGecko ограничил частоту запросов (429).");
    }

    return super.httpError(response, path);
  }
}
