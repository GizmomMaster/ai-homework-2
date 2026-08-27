import { handleMessage } from "../handlers/messageHandler.js";
import { log, logError } from "../logger.js";

const RETRY_DELAY_MS = 5000;

/**
 * Бесконечный цикл long polling: получает обновления от Telegram и
 * обрабатывает текстовые сообщения. Сетевые ошибки не останавливают цикл.
 * Не-текстовые сообщения и сообщения, превышающие лимит длины, отклоняются
 * с предупреждением пользователю — до обращения к LLM. Команда /new
 * начинает новую сессию диалога (сброс контекста для конкретного чата).
 *
 * @param {{
 *   telegramClient: import("./client.js").TelegramClient,
 *   llmRunner: import("../llm/LlmRunner.js").LlmRunner,
 *   chatRepository: import("../db/chatRepository.js").ChatRepository,
 *   maxMessageLength: number,
 *   contextWindowTokens: number,
 *   signal?: AbortSignal,
 * }} params
 */
export async function startPolling({
  telegramClient,
  llmRunner,
  chatRepository,
  maxMessageLength,
  contextWindowTokens,
  signal,
}) {
  let offset = undefined;

  console.log("Бот запущен, ожидание сообщений...");

  while (!signal?.aborted) {
    let updates;
    try {
      updates = await telegramClient.getUpdates({ offset });
    } catch (error) {
      console.error("Ошибка получения обновлений от Telegram:", error.message);
      await sleep(RETRY_DELAY_MS);
      continue;
    }

    for (const update of updates) {
      offset = update.update_id + 1;

      const message = update.message;
      const chatId = message?.chat?.id;

      if (chatId === undefined) {
        continue;
      }

      const text = message.text;

      if (typeof text !== "string") {
        log(`[chat ${chatId}] Получено неподдерживаемое сообщение (не текст) — отправлено предупреждение.`);
        await warnUser(
          telegramClient,
          chatId,
          "Я умею обрабатывать только текстовые сообщения. Файлы, изображения, голосовые и другие вложения не поддерживаются.",
        );
        continue;
      }

      if (isCommand(text, "/new")) {
        chatRepository.createSession(chatId);
        log(`[chat ${chatId}] Начат новый диалог по команде /new.`);
        await warnUser(
          telegramClient,
          chatId,
          "Начат новый диалог. История предыдущего общения сохранена, но больше не используется как контекст.",
        );
        continue;
      }

      if (text.length > maxMessageLength) {
        log(
          `[chat ${chatId}] Сообщение превышает лимит длины (${text.length} > ${maxMessageLength} симв.) — отправлено предупреждение.`,
        );
        await warnUser(
          telegramClient,
          chatId,
          `Сообщение слишком длинное: ${text.length} симв. Максимум — ${maxMessageLength} симв. Сократите текст и отправьте снова.`,
        );
        continue;
      }

      await handleMessage({
        chatId,
        text,
        telegramClient,
        llmRunner,
        chatRepository,
        contextWindowTokens,
      });
    }
  }
}

/**
 * Проверяет, является ли текст сообщения Telegram-командой `command`,
 * учитывая возможный суффикс с именем бота (например, `/new@MyBot`).
 * @param {string} text
 * @param {string} command
 */
function isCommand(text, command) {
  const firstWord = text.trim().split(/\s+/)[0] || "";
  return firstWord.split("@")[0].toLowerCase() === command;
}

async function warnUser(telegramClient, chatId, text) {
  await telegramClient.sendMessage({ chatId, text }).catch((error) => {
    logError(`[chat ${chatId}] Не удалось отправить предупреждение пользователю:`, error);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
