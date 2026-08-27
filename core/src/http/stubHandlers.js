import { randomUUID } from "node:crypto";
import { notFound } from "./errors.js";

/**
 * Временные обработчики фазы 1: контракт работает целиком, но задания живут
 * в памяти и никуда не отправляются — ни в модель, ни в БД. Нужны, чтобы
 * зафиксировать протокол тестами и дать адаптеру, во что стучаться, пока
 * доменная логика ещё не переехала.
 *
 * В фазе 2 заменяются на реальные: сигнатуры совпадают.
 */
export function createStubHandlers() {
  /** @type {Map<string, object>} jobId → задание */
  const jobs = new Map();
  /** @type {Map<string, string>} idempotencyKey → jobId */
  const byIdempotencyKey = new Map();

  return {
    async health() {
      return { status: "ok", mode: "stub" };
    },

    async enqueueMessage({ adapter, externalId, text, idempotencyKey }) {
      const existingJobId = byIdempotencyKey.get(idempotencyKey);
      if (existingJobId) {
        // Повторная доставка того же апдейта Telegram не должна порождать
        // второе задание — отдаём уже созданное, но не 202: ничего не создали.
        return { status: 200, json: publicJob(jobs.get(existingJobId)) };
      }

      const job = {
        jobId: `j_${randomUUID().replace(/-/g, "")}`,
        adapter,
        externalId,
        status: "queued",
        requestText: text,
        idempotencyKey,
        createdAt: new Date().toISOString(),
      };

      jobs.set(job.jobId, job);
      byIdempotencyKey.set(idempotencyKey, job.jobId);

      return { status: 202, json: publicJob(job) };
    },

    async resetConversation({ adapter, externalId }) {
      return {
        status: 200,
        json: { adapter, externalId, conversationId: null, sessionId: null, mode: "stub" },
      };
    },

    async getJob({ jobId }) {
      const job = jobs.get(jobId);
      if (!job) throw notFound(`Задание ${jobId} не найдено.`);
      return { status: 200, json: publicJob(job) };
    },
  };
}

/** Наружу отдаём только поля контракта, без внутренней кухни. */
function publicJob(job) {
  return { jobId: job.jobId, status: job.status };
}
