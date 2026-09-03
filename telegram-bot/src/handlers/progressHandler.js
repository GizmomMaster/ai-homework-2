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
  /** @type {Map<string, number>} наибольший применённый номер события задания. */
  const appliedSeq = new Map();
  /** @type {Map<string, Promise<void>>} цепочка обработки событий задания. */
  const queues = new Map();

  /** Одно событие. Вызывается строго по одному на задание — см. `handle`. */
  async function apply(payload) {
    // Финальный ответ мог обогнать запоздавший статус по сети — тогда
    // заводить для него новое сообщение, которое уже некому будет убрать,
    // не нужно.
    if (finishedJobs.has(payload.jobId)) return;

    // Стадии уходят из Core отдельными запросами без ожидания ответа, и
    // порядок их доставки не гарантирован: без этой проверки запоздавшее
    // «разбираю запрос» затёрло бы уже показанное «свожу отчёт». Номер
    // проставляет JobRunner; старый Core его не шлёт — тогда полагаемся на
    // порядок прихода, как и раньше.
    const seq = payload.progress?.seq;
    if (typeof seq === "number") {
      if (seq <= (appliedSeq.get(payload.jobId) ?? 0)) return;
      appliedSeq.set(payload.jobId, seq);
    }

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
  }

  return {
    /** Обрабатывает payload со статусом "progress", пришедший от Core. */
    handle(payload) {
      // События одного задания выстраиваются в цепочку. Приходят они
      // независимыми HTTP-запросами и во времени пересекаются, а первое из
      // них заводит сообщение, которое остальные редактируют: два
      // одновременных «первых» события завели бы два сообщения, и одно
      // осталось бы в чате навсегда — убрать `finish` умеет только одно.
      const previous = queues.get(payload.jobId) ?? Promise.resolve();
      const current = previous.then(() => apply(payload));
      queues.set(payload.jobId, current);
      // Цепочка живёт, пока по заданию есть что обрабатывать. Обычно её
      // убирает `finish`, но окончательный ответ может и не прийти (Core
      // упал) — тогда запись снимет за собой последнее же событие.
      current.then(() => {
        if (queues.get(payload.jobId) === current) queues.delete(payload.jobId);
      });
      return current;
    },

    /** Убирает статусное сообщение задания — вызывается перед отправкой финального ответа. */
    async finish(jobId) {
      remember(finishedJobs, jobId);

      // Дожидаемся уже начатых событий: то из них, что прошло проверку
      // finishedJobs до этой отметки, иначе успело бы завести сообщение
      // после того, как мы его удалили, — и оно осталось бы в чате.
      await queues.get(jobId);
      queues.delete(jobId);
      appliedSeq.delete(jobId);

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
