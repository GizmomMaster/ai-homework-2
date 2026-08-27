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
    retries = 3,
    retryDelayMs = 1000,
    authToken,
    fetchImpl = fetch,
  }) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.authToken = authToken;
    this.timeoutMs = timeoutMs;
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

  #conversationPath(chatId) {
    return `/v1/conversations/${ADAPTER_NAME}/${encodeURIComponent(String(chatId))}`;
  }

  async #call(method, path, body) {
    let lastError;

    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      if (attempt > 0) {
        await sleep(this.retryDelayMs);
        log(`Повторная попытка обращения к Core (${attempt}/${this.retries}): ${method} ${path}`);
      }

      try {
        return await this.#attempt(method, path, body);
      } catch (error) {
        if (!(error instanceof CoreUnavailableError)) throw error;
        lastError = error;
      }
    }

    throw lastError;
  }

  async #attempt(method, path, body) {
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(this.authToken ? { "X-Core-Token": this.authToken } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
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
