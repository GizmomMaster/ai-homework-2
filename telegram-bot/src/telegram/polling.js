import { handleMessage } from "../handlers/messageHandler.js";

const RETRY_DELAY_MS = 5000;

/**
 * Бесконечный цикл long polling: получает обновления от Telegram и
 * обрабатывает текстовые сообщения. Сетевые ошибки не останавливают цикл.
 *
 * @param {{
 *   telegramClient: import("./client.js").TelegramClient,
 *   llmRunner: import("../llm/LlmRunner.js").LlmRunner,
 *   signal?: AbortSignal,
 * }} params
 */
export async function startPolling({ telegramClient, llmRunner, signal }) {
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
      const text = message?.text;
      const chatId = message?.chat?.id;

      if (!text || chatId === undefined) {
        continue;
      }

      await handleMessage({ chatId, text, telegramClient, llmRunner });
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
