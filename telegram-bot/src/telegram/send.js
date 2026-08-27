import { logError } from "../logger.js";

/**
 * Отправляет сообщение пользователю, гася ошибки отправки в лог.
 *
 * Используется для служебных сообщений (предупреждения, ответы на команды,
 * сообщение об ошибке): если Telegram недоступен, ронять обработку одного
 * апдейта и тем более весь цикл polling не нужно.
 *
 * @param {import("./client.js").TelegramClient} telegramClient
 * @param {number|string} chatId
 * @param {string} text
 * @param {{ parseMode?: "HTML" }} [options]
 * @returns {Promise<boolean>} удалось ли отправить
 */
export async function sendSafely(telegramClient, chatId, text, { parseMode } = {}) {
  try {
    await telegramClient.sendMessage({ chatId, text, parseMode });
    return true;
  } catch (error) {
    logError(`[chat ${chatId}] Не удалось отправить сообщение пользователю:`, error);
    return false;
  }
}
