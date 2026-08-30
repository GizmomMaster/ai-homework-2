import { notFound } from "./errors.js";
import { log } from "../logger.js";

/**
 * Настоящие обработчики HTTP-контракта: тонкий слой между маршрутами и
 * доменом. Здесь нет ни бизнес-правил, ни работы с моделью — только
 * разрешение диалога, постановка задания в очередь и перевод внутренних
 * объектов в поля контракта.
 *
 * @param {{
 *   chatRepository: import("../db/chatRepository.js").ChatRepository,
 *   jobRepository: import("../db/jobRepository.js").JobRepository,
 *   dialogService: import("../domain/DialogService.js").DialogService,
 *   jobRunner: import("../jobs/JobRunner.js").JobRunner,
 *   marketOverviewService: import("../domain/MarketOverviewService.js").MarketOverviewService,
 * }} deps
 */
export function createHandlers({
  chatRepository,
  jobRepository,
  dialogService,
  jobRunner,
  marketOverviewService,
}) {
  return {
    async health() {
      return { status: "ok" };
    },

    /**
     * Обзор рынка для приветственного экрана адаптера.
     *
     * Синхронный, в отличие от сообщений: состав ответа задан командой и не
     * зависит от формулировки пользователя, поэтому ни маршрутизатор, ни
     * планировщик здесь не нужны — модель вызывается ровно один раз, чтобы
     * оформить уже собранные данные. Ждать столько же, сколько ждут ответа на
     * вопрос, не приходится, и заводить ради этого задание с доставкой в
     * callback значило бы городить машинерию под задержку, которой нет.
     */
    async marketOverview({ limit }) {
      const result = await marketOverviewService.compose({ limit });

      if (!result.ok) {
        // 503, а не 500: недоступны внешние источники, а не сломан Core.
        // Адаптеру этого достаточно, чтобы предложить повторить.
        return { status: 503, json: { error: { code: result.error.code } } };
      }

      return {
        status: 200,
        json: { text: result.text, commentary: result.commentary, usage: result.usage },
      };
    },

    async enqueueMessage({ adapter, externalId, text, idempotencyKey }) {
      const conversation = chatRepository.getOrCreateConversation(adapter, externalId);
      const { job, created } = jobRepository.createOrGet({
        conversationId: conversation.id,
        idempotencyKey,
        requestText: text,
      });

      if (created) {
        log(`[job ${job.id}] Принято сообщение из ${adapter}:${externalId} (${text.length} симв.).`);
        jobRunner.wake();
      }

      // 202 — создали задание; 200 — такое уже было, ничего не изменилось.
      return { status: created ? 202 : 200, json: publicJob(job) };
    },

    async resetConversation({ adapter, externalId }) {
      const conversation = chatRepository.getOrCreateConversation(adapter, externalId);
      const session = dialogService.reset(conversation.id);
      log(`[${adapter}:${externalId}] Начат новый диалог (сессия ${session.id}).`);

      return {
        status: 200,
        json: { conversationId: conversation.id, sessionId: session.id },
      };
    },

    async getJob({ jobId }) {
      const job = jobRepository.findById(jobId);
      if (!job) throw notFound(`Задание ${jobId} не найдено.`);
      return { status: 200, json: publicJob(job) };
    },
  };
}

/** Наружу отдаём только поля контракта, без внутренней кухни. */
function publicJob(job) {
  return {
    jobId: job.id,
    status: job.status,
    ...(job.replyText !== undefined ? { reply: { text: job.replyText } } : {}),
    ...(job.reason !== undefined ? { reason: job.reason } : {}),
    ...(job.usage !== undefined ? { usage: job.usage } : {}),
  };
}
