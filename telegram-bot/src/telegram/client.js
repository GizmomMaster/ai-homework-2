const TELEGRAM_MESSAGE_LIMIT = 4096;

/**
 * Тонкий клиент Telegram Bot API на чистых HTTP-запросах (fetch),
 * без сторонних Telegram-библиотек.
 */
export class TelegramClient {
  /**
   * @param {string} token
   */
  constructor(token) {
    this.apiBase = `https://api.telegram.org/bot${token}`;
  }

  async #call(method, payload) {
    const response = await fetch(`${this.apiBase}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
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
   * @param {{ offset?: number, timeout?: number }} params
   */
  async getUpdates({ offset, timeout = 30 } = {}) {
    return this.#call("getUpdates", { offset, timeout });
  }

  /**
   * Отправляет текстовое сообщение в чат. Автоматически режет текст
   * на части, если он превышает лимит Telegram в 4096 символов.
   * @param {{ chatId: number|string, text: string }} params
   */
  async sendMessage({ chatId, text }) {
    const chunks = splitIntoChunks(text, TELEGRAM_MESSAGE_LIMIT);
    for (const chunk of chunks) {
      await this.#call("sendMessage", { chat_id: chatId, text: chunk });
    }
  }
}

function splitIntoChunks(text, limit) {
  if (text.length <= limit) return [text];

  const chunks = [];
  for (let i = 0; i < text.length; i += limit) {
    chunks.push(text.slice(i, i + limit));
  }
  return chunks;
}
