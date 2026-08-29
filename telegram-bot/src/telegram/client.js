import { logError } from "../logger.js";

const TELEGRAM_MESSAGE_LIMIT = 4096;
const LONG_POLL_TIMEOUT_SEC = 30;

/**
 * Тонкий клиент Telegram Bot API на чистых HTTP-запросах (fetch),
 * без сторонних Telegram-библиотек.
 */
export class TelegramClient {
  /**
   * @param {string} token
   * @param {{ apiBaseUrl?: string }} [options] адрес Bot API; переопределяется
   *   для сквозных тестов и локальных прокси.
   */
  constructor(token, { apiBaseUrl = "https://api.telegram.org" } = {}) {
    this.apiBase = `${apiBaseUrl.replace(/\/+$/, "")}/bot${token}`;
  }

  async #call(method, payload, { signal } = {}) {
    const response = await fetch(`${this.apiBase}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });

    const data = await response.json();
    if (!data.ok) {
      throw new Error(
        `Telegram API (${method}) вернул ошибку: ${data.description || response.status}`,
      );
    }
    return data.result;
  }

  /**
   * Long polling: ждёт до `timeout` секунд новые обновления начиная с `offset`.
   * `signal` позволяет оборвать ожидание при остановке бота.
   *
   * @param {{ offset?: number, timeout?: number, signal?: AbortSignal }} params
   */
  async getUpdates({ offset, timeout = LONG_POLL_TIMEOUT_SEC, signal } = {}) {
    return this.#call("getUpdates", { offset, timeout }, { signal });
  }

  /**
   * Регистрирует список команд бота — они появляются в меню Telegram
   * (кнопка "/" рядом с полем ввода).
   * @param {Array<{ command: string, description: string }>} commands
   */
  async setMyCommands(commands) {
    return this.#call("setMyCommands", { commands });
  }

  /**
   * Отправляет текстовое сообщение в чат. Автоматически режет текст
   * на части, если он превышает лимит Telegram в 4096 символов.
   *
   * @param {{ chatId: number|string, text: string, parseMode?: "HTML" }} params
   *   `text` уже должен быть в формате `parseMode` (например, HTML-разметка
   *   Telegram, если указан `parseMode: "HTML"`).
   * @returns {Promise<object>} результат Telegram API для **последней**
   *   отправленной части (объект сообщения с `message_id`) — этого достаточно,
   *   чтобы потом отредактировать или удалить статусное сообщение, которое
   *   всегда укладывается в одну часть.
   */
  async sendMessage({ chatId, text, parseMode }) {
    const chunks = splitIntoChunks(text, TELEGRAM_MESSAGE_LIMIT);
    let result;
    for (const chunk of chunks) {
      result = await this.#sendChunk(chatId, chunk, parseMode);
    }
    return result;
  }

  /**
   * Редактирует уже отправленное сообщение — используется для обновления
   * статуса обработки на месте, без спама новыми сообщениями в чат.
   * @param {{ chatId: number|string, messageId: number, text: string, parseMode?: "HTML" }} params
   */
  async editMessageText({ chatId, messageId, text, parseMode }) {
    return this.#call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...(parseMode ? { parse_mode: parseMode } : {}),
    });
  }

  /**
   * Удаляет сообщение — используется, чтобы убрать статусное сообщение,
   * когда пришёл окончательный ответ.
   * @param {{ chatId: number|string, messageId: number }} params
   */
  async deleteMessage({ chatId, messageId }) {
    return this.#call("deleteMessage", { chat_id: chatId, message_id: messageId });
  }

  async #sendChunk(chatId, text, parseMode) {
    if (!parseMode) {
      return this.#call("sendMessage", { chat_id: chatId, text });
    }

    try {
      return await this.#call("sendMessage", { chat_id: chatId, text, parse_mode: parseMode });
    } catch (error) {
      // Разметка могла не распарситься (например, теги оказались разорваны
      // при нарезке на части) — не теряем сообщение, а отправляем как есть.
      logError(
        `[chat ${chatId}] Не удалось отправить сообщение с parse_mode=${parseMode}, отправляю как обычный текст:`,
        error,
      );
      return this.#call("sendMessage", { chat_id: chatId, text });
    }
  }
}

/**
 * Режет текст на части не длиннее `limit`, по возможности по границам строк —
 * так меньше шансов разорвать HTML-тег или слово посередине.
 */
export function splitIntoChunks(text, limit) {
  if (text.length <= limit) return [text];

  const chunks = [];
  let rest = text;

  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    // Ищем последний перенос строки в пределах лимита; если строка одна
    // длинная (например, база64 или минифицированный код) — режем жёстко.
    const breakAt = window.lastIndexOf("\n");
    const cut = breakAt > 0 ? breakAt + 1 : limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }

  if (rest.length > 0) chunks.push(rest);
  return chunks;
}
