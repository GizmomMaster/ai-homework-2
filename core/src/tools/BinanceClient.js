import { TOOL_ERROR, ToolError } from "./errors.js";
import { PublicApiClient } from "./PublicApiClient.js";

/** Код Binance для неизвестной торговой пары. */
const BINANCE_UNKNOWN_SYMBOL = -1121;

/**
 * Клиент публичного REST API Binance.
 *
 * Работает только с открытыми эндпоинтами: ни ключей, ни подписи, ни доступа
 * к средствам пользователя. Читать рыночные данные — всё, что эта система
 * умеет и должна уметь (§4 спецификации).
 *
 * Всё, что общего у клиентов рыночных данных — сборка запроса, таймаут,
 * проверка тела, — живёт в {@link PublicApiClient}. Здесь остаётся своё:
 * коды отказа, которые у биржи собственные.
 */
export class BinanceClient extends PublicApiClient {
  /**
   * @param {{ baseUrl: string, timeoutMs?: number, fetchImpl?: typeof fetch }} options
   */
  constructor(options) {
    super({ ...options, vendor: { name: "Binance", answered: "ответила", returned: "вернула" } });
  }

  /** @param {Response} response */
  async httpError(response, path) {
    // 418 — ответ Binance тому, кто продолжил стучаться после 429.
    if (response.status === 429 || response.status === 418) {
      return new ToolError(
        TOOL_ERROR.rateLimited,
        `Binance ограничила частоту запросов (${response.status}).`,
      );
    }

    const body = await response.json().catch(() => null);
    if (body?.code === BINANCE_UNKNOWN_SYMBOL) {
      return new ToolError(TOOL_ERROR.unknownSymbol, "Binance не знает такой торговой пары.");
    }

    return super.httpError(response, path);
  }
}
