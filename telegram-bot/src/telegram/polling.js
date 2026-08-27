import { handleMessage } from "../handlers/messageHandler.js";
import { log, logError } from "../logger.js";

const RETRY_DELAY_MS = 5000;

/**
 * Бесконечный цикл long polling: получает обновления от Telegram и
 * обрабатывает текстовые сообщения. Сетевые ошибки не останавливают цикл.
 * Не-текстовые сообщения и сообщения, превышающие лимит длины, отклоняются
 * с предупреждением пользователю — до обращения к LLM.
 *
 * @param {{
 *   telegramClient: import("./client.js").TelegramClient,
 *   llmRunner: import("../llm/LlmRunner.js").LlmRunner,
 *   maxMessageLength: number,
 *   signal?: AbortSignal,
 * }} params
 */
export async function startPolling({ telegramClient, llmRunner, maxMessageLength, signal }) {
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

      await handleMessage({ chatId, text, telegramClient, llmRunner });
    }
  }
}

async function warnUser(telegramClient, chatId, text) {
  await telegramClient.sendMessage({ chatId, text }).catch((error) => {
    logError(`[chat ${chatId}] Не удалось отправить предупреждение пользователю:`, error);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
