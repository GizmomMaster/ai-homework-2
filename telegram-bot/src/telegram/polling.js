import { handleMessage } from "../handlers/messageHandler.js";
import { findCommand } from "../handlers/commands.js";
import { log, logError } from "../logger.js";
import { sendSafely } from "./send.js";

const DEFAULT_RETRY_DELAY_MS = 5000;

const NON_TEXT_WARNING =
  "Я умею обрабатывать только текстовые сообщения. Файлы, изображения, " +
  "голосовые и другие вложения не поддерживаются.";

/**
 * Бесконечный цикл long polling: получает обновления от Telegram и
 * обрабатывает текстовые сообщения. Сетевые ошибки не останавливают цикл.
 * Не-текстовые сообщения и сообщения, превышающие лимит длины, отклоняются
 * с предупреждением пользователю — до обращения к LLM. Команды бота
 * (`/new`, `/start`, `/help`) обрабатываются реестром из handlers/commands.js.
 *
 * Завершается, когда сработает `signal` (graceful shutdown).
 *
 * @param {{
 *   telegramClient: import("./client.js").TelegramClient,
 *   llmRunner: import("../llm/LlmRunner.js").LlmRunner,
 *   chatRepository: import("../db/chatRepository.js").ChatRepository,
 *   maxMessageLength: number,
 *   contextWindowTokens: number,
 *   signal?: AbortSignal,
 *   retryDelayMs?: number,
 * }} params
 */
export async function startPolling({
  telegramClient,
  llmRunner,
  chatRepository,
  maxMessageLength,
  contextWindowTokens,
  signal,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
}) {
  let offset = undefined;

  log("Бот запущен, ожидание сообщений...");

  while (!signal?.aborted) {
    let updates;
    try {
      updates = await telegramClient.getUpdates({ offset, signal });
    } catch (error) {
      if (signal?.aborted) break;
      logError("Ошибка получения обновлений от Telegram:", error);
      await sleep(retryDelayMs, signal);
      continue;
    }

    for (const update of updates) {
      if (signal?.aborted) break;
      offset = update.update_id + 1;
      await handleUpdate(update, {
        telegramClient,
        llmRunner,
        chatRepository,
        maxMessageLength,
        contextWindowTokens,
      });
    }
  }

  log("Polling остановлен.");
}

/**
 * Маршрутизация одного апдейта: отсев не-текста и слишком длинных сообщений,
 * команды, обычные сообщения в LLM.
 */
async function handleUpdate(update, deps) {
  const { telegramClient, llmRunner, chatRepository, maxMessageLength, contextWindowTokens } = deps;

  const message = update.message;
  const chatId = message?.chat?.id;
  if (chatId === undefined) return;

  const text = message.text;

  if (typeof text !== "string") {
    log(`[chat ${chatId}] Получено неподдерживаемое сообщение (не текст) — отправлено предупреждение.`);
    await sendSafely(telegramClient, chatId, NON_TEXT_WARNING);
    return;
  }

  const command = findCommand(text);
  if (command) {
    await command.handle({ chatId, telegramClient, chatRepository });
    return;
  }

  if (text.length > maxMessageLength) {
    log(
      `[chat ${chatId}] Сообщение превышает лимит длины (${text.length} > ${maxMessageLength} симв.) — отправлено предупреждение.`,
    );
    await sendSafely(
      telegramClient,
      chatId,
      `Сообщение слишком длинное: ${text.length} симв. Максимум — ${maxMessageLength} симв. ` +
        `Сократите текст и отправьте снова.`,
    );
    return;
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

/** Пауза, прерываемая сигналом остановки, — чтобы не ждать при shutdown. */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });

    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}
