import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { JOB_STATUS } from "../src/db/jobRepository.js";
import { createTestRepositories } from "./helpers.js";

/** Репозитории + готовый диалог, к которому можно цеплять задания. */
function setup() {
  const { db, chatRepository, jobRepository } = createTestRepositories();
  const conversation = chatRepository.getOrCreateConversation("telegram", 8123);
  const create = (overrides = {}) =>
    jobRepository.createOrGet({
      conversationId: conversation.id,
      idempotencyKey: "tg:8123:1",
      requestText: "привет",
      ...overrides,
    });
  return { db, chatRepository, jobRepository, conversation, create };
}

describe("JobRepository", () => {
  describe("создание и идемпотентность", () => {
    it("создаёт задание в статусе queued", () => {
      const { create } = setup();

      const { job, created } = create();

      assert.equal(created, true);
      assert.equal(job.status, JOB_STATUS.queued);
      assert.equal(job.requestText, "привет");
      assert.match(job.id, /^j_[0-9a-f]{32}$/);
    });

    it("на повтор ключа возвращает существующее задание", () => {
      const { create } = setup();

      const first = create();
      const second = create();

      assert.equal(second.created, false);
      assert.equal(second.job.id, first.job.id);
    });

    it("разные ключи дают разные задания", () => {
      const { create } = setup();

      const first = create();
      const second = create({ idempotencyKey: "tg:8123:2" });

      assert.notEqual(second.job.id, first.job.id);
    });
  });

  describe("очередь", () => {
    it("отдаёт задания в порядке создания", () => {
      const { create, jobRepository } = setup();
      const first = create().job;
      create({ idempotencyKey: "tg:8123:2" });

      assert.equal(jobRepository.nextQueued().id, first.id);
    });

    it("не отдаёт задание, взятое в работу", () => {
      const { create, jobRepository } = setup();
      const { job } = create();

      jobRepository.markRunning(job.id);

      assert.equal(jobRepository.nextQueued(), undefined);
    });

    it("возвращает пустую очередь как undefined", () => {
      assert.equal(setup().jobRepository.nextQueued(), undefined);
    });
  });

  describe("завершение", () => {
    it("сохраняет ответ и статистику", () => {
      const { create, jobRepository } = setup();
      const { job } = create();

      jobRepository.finish(job.id, {
        status: JOB_STATUS.completed,
        replyText: "ответ модели",
        usage: { totalTokens: 52, contextLimit: 1000 },
      });

      const stored = jobRepository.findById(job.id);
      assert.equal(stored.status, JOB_STATUS.completed);
      assert.equal(stored.replyText, "ответ модели");
      assert.deepEqual(stored.usage, { totalTokens: 52, contextLimit: 1000 });
    });

    it("сохраняет причину отказа", () => {
      const { create, jobRepository } = setup();
      const { job } = create();

      jobRepository.finish(job.id, { status: JOB_STATUS.rejected, reason: "context_limit" });

      const stored = jobRepository.findById(job.id);
      assert.equal(stored.status, JOB_STATUS.rejected);
      assert.equal(stored.reason, "context_limit");
      assert.equal(stored.replyText, undefined);
    });
  });

  describe("восстановление после перезапуска", () => {
    it("возвращает в очередь задания, застрявшие в running", () => {
      const { create, jobRepository } = setup();
      const { job } = create();
      jobRepository.markRunning(job.id);

      const requeued = jobRepository.requeueStale();

      assert.equal(requeued, 1);
      assert.equal(jobRepository.findById(job.id).status, JOB_STATUS.queued);
    });

    it("не трогает уже завершённые задания", () => {
      const { create, jobRepository } = setup();
      const { job } = create();
      jobRepository.finish(job.id, { status: JOB_STATUS.completed, replyText: "ответ" });

      assert.equal(jobRepository.requeueStale(), 0);
      assert.equal(jobRepository.findById(job.id).status, JOB_STATUS.completed);
    });
  });

  describe("доставка", () => {
    const finished = () => {
      const ctx = setup();
      const { job } = ctx.create();
      ctx.jobRepository.finish(job.id, { status: JOB_STATUS.completed, replyText: "ответ" });
      return { ...ctx, job };
    };

    it("возвращает завершённое, но не доставленное задание", () => {
      const { jobRepository, job } = finished();

      const pending = jobRepository.pendingDelivery({ maxAttempts: 3 });

      assert.equal(pending.length, 1);
      assert.equal(pending[0].id, job.id);
    });

    it("не возвращает задание, которое ещё в очереди", () => {
      const { create, jobRepository } = setup();
      create();

      assert.equal(jobRepository.pendingDelivery({ maxAttempts: 3 }).length, 0);
    });

    it("не возвращает доставленное задание", () => {
      const { jobRepository, job } = finished();

      jobRepository.markDelivered(job.id);

      assert.equal(jobRepository.pendingDelivery({ maxAttempts: 3 }).length, 0);
      assert.ok(jobRepository.findById(job.id).deliveredAt);
    });

    it("откладывает следующую попытку после неудачи", () => {
      const { jobRepository, job } = finished();
      const later = Date.now() + 60000;

      jobRepository.markDeliveryFailed(job.id, later);

      assert.equal(
        jobRepository.pendingDelivery({ maxAttempts: 3 }).length,
        0,
        "до наступления срока задание не берётся",
      );
      assert.equal(
        jobRepository.pendingDelivery({ maxAttempts: 3, now: later + 1 }).length,
        1,
        "после наступления срока — берётся",
      );
      assert.equal(jobRepository.findById(job.id).deliveryAttempts, 1);
    });

    it("перестаёт пытаться после исчерпания попыток", () => {
      const { jobRepository, job } = finished();

      for (let i = 0; i < 3; i += 1) jobRepository.markDeliveryFailed(job.id, Date.now() - 1);

      assert.equal(jobRepository.pendingDelivery({ maxAttempts: 3 }).length, 0);
      assert.equal(jobRepository.findById(job.id).deliveryAttempts, 3);
    });
  });
});
