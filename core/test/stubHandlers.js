import { randomUUID } from "node:crypto";
import { notFound } from "../src/http/errors.js";

/**
 * Заглушка обработчиков HTTP-контракта: задания живут в памяти и никуда не
 * отправляются — ни в модель, ни в БД.
 *
 * Появилась в фазе 1, когда доменной логики ещё не было, и осталась как
 * тестовый двойник: тесты транспорта (маршруты, разбор тела, коды ответа,
 * проверка секрета) проверяют сам транспорт, и настоящие обработчики со всей
 * их обвязкой им незачем — поведение домена проверяется отдельно, на
 * собранном приложении (`coreApp.test.js`).
 *
 * Лежит рядом с тестами, а не в `src/`: единственный, кто её импортирует, —
 * `test/helpers.js`, а в образ сервиса код, который никогда не выполняется в
 * эксплуатации, ехать не должен.
 */
export function createStubHandlers() {
  /** @type {Map<string, object>} jobId → задание */
  const jobs = new Map();
  /** @type {Map<string, string>} idempotencyKey → jobId */
  const byIdempotencyKey = new Map();

  return {
    /** Заглушке взять обзор неоткуда: внешних источников у неё нет. */
    async marketOverview() {
      return { status: 503, json: { error: { code: "unavailable" } } };
    },

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
