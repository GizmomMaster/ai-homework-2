import { findCommand } from "../handlers/commands.js";
import { log, logError } from "../logger.js";
import { sendSafely } from "./send.js";

const DEFAULT_RETRY_DELAY_MS = 5000;

const NON_TEXT_WARNING =
  "Я умею обрабатывать только текстовые сообщения. Файлы, изображения, " +
  "голосовые и другие вложения не поддерживаются.";

const CORE_UNAVAILABLE_TEXT =
  "Сервис временно недоступен, попробуйте ещё раз через минуту.";

/**
 * Бесконечный цикл long polling: получает обновления от Telegram и передаёт
 * сообщения в Core. Ответ модели сюда не возвращается — Core доставит его
 * отдельным запросом на callback-сервер адаптера.
 *
 * Не-текстовые и слишком длинные сообщения отклоняются здесь же, до обращения
 * к Core. Команды бота разбираются реестром из handlers/commands.js.
 *
 * @param {{
 *   telegramClient: import("./client.js").TelegramClient,
 *   coreClient: import("../core/CoreClient.js").CoreClient,
 *   maxMessageLength: number,
 *   signal?: AbortSignal,
 *   retryDelayMs?: number,
 * }} params
 */
export async function startPolling({
  telegramClient,
  coreClient,
  maxMessageLength,
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
      await handleUpdate(update, { telegramClient, coreClient, maxMessageLength });
    }
  }

  log("Polling остановлен.");
}

/**
 * Маршрутизация одного апдейта: отсев не-текста и слишком длинных сообщений,
 * команды, остальное — в Core.
 */
async function handleUpdate(update, { telegramClient, coreClient, maxMessageLength }) {
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
    await command.handle({ chatId, telegramClient, coreClient });
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

  try {
    const job = await coreClient.sendMessage({ chatId, text, updateId: update.update_id });
    log(`[chat ${chatId}] Сообщение передано в Core (job ${job.jobId}, ${text.length} симв.).`);
  } catch (error) {
    logError(`[chat ${chatId}] Не удалось передать сообщение в Core:`, error);
    await sendSafely(telegramClient, chatId, CORE_UNAVAILABLE_TEXT);
  }
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
