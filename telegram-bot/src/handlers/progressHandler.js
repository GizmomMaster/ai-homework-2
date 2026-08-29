import { logError } from "../logger.js";

/** Сколько завершённых заданий помним, чтобы игнорировать запоздавший статус. */
const FINISHED_JOBS_LIMIT = 500;

/**
 * Показывает пользователю, чем занят агент прямо сейчас, — как индикатор
 * «печатает…» у Claude и подобных ассистентов, только с содержательным
 * текстом вместо спиннера: «Строю план...», «Собираю данные: шаг 2/3...».
 *
 * Реализовано одним сообщением на задание, которое редактируется по мере
 * смены стадии и удаляется, когда приходит окончательный ответ, — вместо
 * того чтобы засорять чат новым сообщением на каждый шаг.
 *
 * Состояние живёт только в памяти процесса: при перезапуске бота максимум
 * останется одно недоудалённое статусное сообщение в чате — не страшно.
 *
 * @param {{ telegramClient: import("../telegram/client.js").TelegramClient }} deps
 */
export function createProgressTracker({ telegramClient }) {
  /** @type {Map<string, { chatId: string|number, messageId: number }>} */
  const messages = new Map();
  /** @type {Set<string>} задания, для которых уже пришёл окончательный ответ. */
  const finishedJobs = new Set();

  return {
    /** Обрабатывает payload со статусом "progress", пришедший от Core. */
    async handle(payload) {
      // Финальный ответ мог обогнать запоздавший статус по сети — тогда
      // заводить для него новое сообщение, которое уже некому будет убрать,
      // не нужно.
      if (finishedJobs.has(payload.jobId)) return;

      const text = progressText(payload.progress);
      if (!text) return;

      const chatId = payload.externalId;
      const existing = messages.get(payload.jobId);

      try {
        if (existing) {
          await telegramClient.editMessageText({ chatId, messageId: existing.messageId, text });
        } else {
          const sent = await telegramClient.sendMessage({ chatId, text });
          if (sent?.message_id) {
            messages.set(payload.jobId, { chatId, messageId: sent.message_id });
          }
        }
      } catch (error) {
        // Статус — удобство, а не гарантия: не получилось обновить — не
        // страшно, окончательный ответ всё равно придёт отдельным сообщением.
        logError(`[job ${payload.jobId}] Не удалось обновить статус обработки:`, error);
      }
    },

    /** Убирает статусное сообщение задания — вызывается перед отправкой финального ответа. */
    async finish(jobId) {
      remember(finishedJobs, jobId);

      const existing = messages.get(jobId);
      if (!existing) return;
      messages.delete(jobId);

      try {
        await telegramClient.deleteMessage({ chatId: existing.chatId, messageId: existing.messageId });
      } catch (error) {
        logError(`[job ${jobId}] Не удалось удалить статусное сообщение:`, error);
      }
    },
  };
}

/** Множество с ограниченным размером: выбрасываем самые старые записи. */
function remember(set, value) {
  set.add(value);
  if (set.size > FINISHED_JOBS_LIMIT) {
    set.delete(set.values().next().value);
  }
}

/**
 * Текст стадии для пользователя. Код стадии выбирает Core (см.
 * `PROGRESS_STAGE` в DialogService), а как это назвать — забота канала,
 * тот же принцип, что и у `rejectionText` в replyHandler.js.
 *
 * @param {{ stage?: string, totalSteps?: number, step?: { stepNumber: number, totalSteps: number, action: string } }} [progress]
 */
function progressText(progress) {
  switch (progress?.stage) {
    case "routing":
      return "🧭 Разбираю запрос...";
    case "answering":
      return "💬 Формулирую ответ...";
    case "planning":
      return "🗺 Строю план сбора данных...";
    case "executing":
      return progress.step
        ? `📊 Собираю данные: шаг ${progress.step.stepNumber}/${progress.step.totalSteps} — ${progress.step.action}`
        : `📊 Собираю данные: ${progress.totalSteps} шаг(ов)...`;
    case "summarizing":
      return "📝 Свожу отчёт...";
    default:
      return undefined;
  }
}
