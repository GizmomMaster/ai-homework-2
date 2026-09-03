import { CORE_UNAVAILABLE_TEXT, findCommand } from "../handlers/commands.js";
import { log, logError } from "../logger.js";
import { sendSafely } from "./send.js";

const DEFAULT_RETRY_DELAY_MS = 5000;

/**
 * Предел паузы между попытками. Пока Telegram недоступен, смысла долбиться
 * каждые пять секунд нет: обновления он держит у себя сутки, так что ничего
 * не теряется, а вот лог за час недоступности разбухает на семьсот записей.
 * Минута — компромисс: и не шумит, и не задерживает возврат к работе.
 */
const MAX_RETRY_DELAY_MS = 60_000;

/**
 * Причина неудачного `fetch` словами.
 *
 * Сам `fetch` бросает «fetch failed» — одинаково для потерянного DNS,
 * отвергнутого соединения и молчащего хоста. Настоящий код лежит в `cause`,
 * а при нескольких адресах (IPv6 и IPv4) — в его `errors`.
 */
function describeFetchError(error) {
  const cause = error?.cause;
  if (!cause) return error?.message ?? String(error);

  const first = Array.isArray(cause.errors) ? cause.errors[0] : cause;
  const code = first?.code ?? cause.code;
  return code ? `${error.message} (${code})` : error.message;
}

/**
 * Отчёт о неудачах опроса.
 *
 * Одна и та же ошибка каждые несколько секунд превращает лог в стену, в
 * которой не видно ничего другого. Поэтому подробности — только у первой,
 * дальше короткие отметки: пока пауза растёт, на каждом её удвоении, а когда
 * она упёрлась в предел — раз в десять попыток.
 */
function createFailureReporter(maxDelayMs = MAX_RETRY_DELAY_MS) {
  let failures = 0;
  let since = 0;

  return {
    /** @returns {number} пауза перед следующей попыткой, мс */
    fail(error, baseDelayMs) {
      failures += 1;
      if (failures === 1) since = Date.now();

      const delay = Math.min(baseDelayMs * 2 ** (failures - 1), maxDelayMs);
      const capped = delay >= maxDelayMs;

      if (failures === 1) {
        logError("Ошибка получения обновлений от Telegram:", error);
      } else if (!capped || failures % 10 === 0) {
        logError(
          `Telegram недоступен уже ${elapsed(since)} (попыток: ${failures}, ` +
            `следующая через ${Math.round(delay / 1000)} с): ${describeFetchError(error)}`,
        );
      }

      return delay;
    },

    /** Возврат к работе стоит отметить: иначе в логе видны только неудачи. */
    recovered() {
      if (failures === 0) return;
      log(`Связь с Telegram восстановлена: ${failures} неудачных попыток за ${elapsed(since)}.`);
      failures = 0;
    },
  };
}

function elapsed(since) {
  const seconds = Math.round((Date.now() - since) / 1000);
  if (seconds < 60) return `${seconds} с`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} мин` : `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`;
}

const NON_TEXT_WARNING =
  "Я умею обрабатывать только текстовые сообщения. Файлы, изображения, " +
  "голосовые и другие вложения не поддерживаются.";

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
 *   maxRetryDelayMs?: number,
 * }} params
 *   `retryDelayMs` — стартовая пауза после неудачи, `maxRetryDelayMs` — её
 *   потолок: пауза удваивается с каждой неудачей подряд и упирается в него.
 */
export async function startPolling({
  telegramClient,
  coreClient,
  maxMessageLength,
  signal,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  maxRetryDelayMs = MAX_RETRY_DELAY_MS,
}) {
  let offset = undefined;
  const failures = createFailureReporter(maxRetryDelayMs);

  log("Бот запущен, ожидание сообщений...");

  while (!signal?.aborted) {
    let updates;
    try {
      updates = await telegramClient.getUpdates({ offset, signal });
      failures.recovered();
    } catch (error) {
      if (signal?.aborted) break;
      await sleep(failures.fail(error, retryDelayMs), signal);
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
