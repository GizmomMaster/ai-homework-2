import { log } from "../logger.js";

/** Имя адаптера в адресации Core. */
export const ADAPTER_NAME = "telegram";

/**
 * Ошибка обращения к Core. `retriable` говорит, имело ли смысл повторять:
 * на неверный запрос (4xx) повторять бессмысленно, на обрыв связи — да.
 */
export class CoreUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "CoreUnavailableError";
  }
}

/**
 * Клиент Core Orchestrator. Адаптер не знает ни про модель, ни про историю —
 * только про этот контракт.
 *
 * Ответ модели сюда не приходит: Core отвечает сразу, а готовый текст
 * доставляет отдельным запросом на callback-сервер адаптера.
 */
export class CoreClient {
  /**
   * @param {{
   *   baseUrl: string,
   *   timeoutMs?: number,
   *   retries?: number,
   *   retryDelayMs?: number,
   *   fetchImpl?: typeof fetch,
   * }} options
   */
  constructor({
    baseUrl,
    timeoutMs = 10000,
    overviewTimeoutMs = 30000,
    retries = 3,
    retryDelayMs = 1000,
    authToken,
    fetchImpl = fetch,
  }) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.authToken = authToken;
    this.timeoutMs = timeoutMs;
    this.overviewTimeoutMs = overviewTimeoutMs;
    this.retries = retries;
    this.retryDelayMs = retryDelayMs;
    this.fetchImpl = fetchImpl;
  }

  /**
   * Ставит сообщение пользователя в обработку. Возвращает описание задания;
   * сам ответ модели придёт позже, в callback.
   *
   * @param {{ chatId: number|string, text: string, updateId: number }} params
   */
  async sendMessage({ chatId, text, updateId }) {
    return this.#call("POST", `${this.#conversationPath(chatId)}/messages`, {
      text,
      // Ключ идемпотентности из update_id Telegram: повторная доставка того
      // же апдейта не заставит модель отвечать дважды.
      idempotencyKey: `${ADAPTER_NAME}:${chatId}:${updateId}`,
    });
  }

  /**
   * Сбрасывает контекст диалога (команда /new).
   * @param {{ chatId: number|string }} params
   */
  async reset({ chatId }) {
    return this.#call("POST", `${this.#conversationPath(chatId)}/reset`);
  }

  /**
   * Обзор рынка для приветствия (команда /start).
   *
   * В отличие от сообщений, ответ приходит прямо здесь, а не в callback:
   * состав обзора задан командой, поэтому разбирать запрос и планировать шаги
   * не нужно — модель вызывается один раз, чтобы оформить уже собранные
   * данные. Ждать столько же, сколько ответа на вопрос, не приходится, и
   * заводить ради этого задание незачем. Но два внешних API плюс вызов
   * модели — это секунды, поэтому таймаут свой, больше обычного.
   *
   * Повторов здесь нет, и это отличие от остальных вызовов существенное.
   * Обычный повтор рассчитан на то, что Core ещё поднимается, — тогда вторая
   * попытка почти бесплатна. Здесь же истёкший таймаут означает не «Core не
   * встал», а «модель медленно пишет»: повтор заставит её начать генерацию
   * заново, добавит нагрузки на видеокарту и только отдалит ответ. Данные
   * инструмента переживают повтор в кеше, работа модели — нет.
   *
   * @returns {Promise<{ text: string, composedBy?: string }>}
   */
  async marketOverview() {
    return this.#call("GET", "/v1/market/overview", undefined, {
      timeoutMs: this.overviewTimeoutMs,
      retries: 0,
    });
  }

  #conversationPath(chatId) {
    return `/v1/conversations/${ADAPTER_NAME}/${encodeURIComponent(String(chatId))}`;
  }

  async #call(method, path, body, { timeoutMs = this.timeoutMs, retries = this.retries } = {}) {
    let lastError;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (attempt > 0) {
        await sleep(this.retryDelayMs);
        log(`Повторная попытка обращения к Core (${attempt}/${retries}): ${method} ${path}`);
      }

      try {
        return await this.#attempt(method, path, body, timeoutMs);
      } catch (error) {
        if (!(error instanceof CoreUnavailableError)) throw error;
        lastError = error;
      }
    }

    throw lastError;
  }

  async #attempt(method, path, body, timeoutMs) {
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(this.authToken ? { "X-Core-Token": this.authToken } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new CoreUnavailableError(
        `Core недоступен по адресу ${this.baseUrl}: ${error.message}`,
      );
    }

    if (response.status >= 500) {
      // Временная неисправность на стороне Core — имеет смысл повторить.
      throw new CoreUnavailableError(`Core ответил ${response.status}.`);
    }

    const payload = await response.json().catch(() => undefined);

    if (!response.ok) {
      // 4xx — это наша ошибка в запросе, повторять бессмысленно.
      const detail = payload?.error?.message ?? `HTTP ${response.status}`;
      throw new Error(`Core отклонил запрос ${method} ${path}: ${detail}`);
    }

    return payload;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
