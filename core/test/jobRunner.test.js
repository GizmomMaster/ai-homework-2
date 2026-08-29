import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { JobRunner } from "../src/jobs/JobRunner.js";
import { CallbackDelivery } from "../src/jobs/CallbackDelivery.js";
import { DialogService } from "../src/domain/DialogService.js";
import { JOB_STATUS } from "../src/db/jobRepository.js";
import {
  createFakeCallbackTransport,
  createFakeProgressNotifier,
  createFakeRouter,
  createFakeTheoryAgent,
  createTestRepositories,
  muteConsole,
  waitFor,
 } from "./helpers.js";

/**
 * Собирает JobRunner поверх общей БД. В отличие от тестов приложения целиком,
 * здесь важно пережить «перезапуск»: репозитории и БД остаются те же, а
 * раннер создаётся заново — как после падения процесса.
 */
function buildEnv({ theoryAgent, transport, jobRepositoryOverrides, progressNotifier } = {}) {
  const { db, chatRepository, jobRepository } = createTestRepositories();
  const conversation = chatRepository.getOrCreateConversation("telegram", "8123");
  const callbackTransport = transport ?? createFakeCallbackTransport();
  const runnerJobs = Object.assign(Object.create(jobRepository), jobRepositoryOverrides ?? {});
  const fakeProgressNotifier = progressNotifier ?? createFakeProgressNotifier();

  const makeRunner = () =>
    new JobRunner({
      db,
      chatRepository,
      jobRepository: runnerJobs,
      dialogService: new DialogService({
        chatRepository,
        routerAgent: createFakeRouter(),
        theoryAgent: theoryAgent ?? createFakeTheoryAgent(),
        contextWindowTokens: 1000,
      }),
      callbackDelivery: new CallbackDelivery({
        callbackUrls: { telegram: "http://adapter.test/callbacks/replies" },
        fetchImpl: callbackTransport.fetchImpl,
      }),
      progressNotifier: fakeProgressNotifier,
      pollIntervalMs: 10,
      deliveryMaxAttempts: 3,
      deliveryBackoffMs: 20,
    });

  const enqueue = (text = "привет", key = "tg:8123:1") =>
    jobRepository.createOrGet({
      conversationId: conversation.id,
      idempotencyKey: key,
      requestText: text,
    }).job;

  return {
    db,
    chatRepository,
    jobRepository,
    conversation,
    delivered: callbackTransport.delivered,
    progressCalls: fakeProgressNotifier.calls,
    makeRunner,
    enqueue,
    activeSession: () => chatRepository.getOrCreateActiveSession(conversation.id),
  };
}

/** Запускает раннер и гарантированно останавливает его после теста. */
function runUntil(t, env) {
  const runner = env.makeRunner();
  t.after(() => runner.stop());
  runner.start();
  return runner;
}

describe("JobRunner", () => {
  describe("обычная обработка", () => {
    it("берёт задание из очереди, записывает историю и доставляет ответ", async (t) => {
      muteConsole(t);
      const env = buildEnv();
      const job = env.enqueue("привет");

      runUntil(t, env);
      await waitFor(() => env.delivered.length === 1, { label: "ответ доставлен" });

      assert.equal(env.jobRepository.findById(job.id).status, JOB_STATUS.completed);
      assert.deepEqual(env.chatRepository.getMessages(env.activeSession().id), [
        { role: "user", content: "привет" },
        { role: "assistant", content: "ответ" },
      ]);
    });

    it("помечает задание доставленным", async (t) => {
      muteConsole(t);
      const env = buildEnv();
      const job = env.enqueue();

      runUntil(t, env);
      await waitFor(() => env.delivered.length === 1, { label: "ответ доставлен" });

      assert.ok(env.jobRepository.findById(job.id).deliveredAt);
    });

    it("обрабатывает задания по очереди в порядке поступления", async (t) => {
      muteConsole(t);
      const theoryAgent = createFakeTheoryAgent((messages) => ({
        content: `эхо: ${messages.at(-1).content}`,
        promptTokens: 1,
        completionTokens: 1,
      }));
      const env = buildEnv({ theoryAgent });
      env.enqueue("первый", "tg:8123:1");
      env.enqueue("второй", "tg:8123:2");

      runUntil(t, env);
      await waitFor(() => env.delivered.length === 2, { label: "оба ответа доставлены" });

      assert.deepEqual(
        env.delivered.map((d) => d.payload.reply.text),
        ["эхо: первый", "эхо: второй"],
      );
    });
  });

  describe("промежуточный статус", () => {
    it("уведомляет о стадиях обработки с адресом диалога", async (t) => {
      muteConsole(t);
      const env = buildEnv();
      env.enqueue("привет");

      runUntil(t, env);
      await waitFor(() => env.delivered.length === 1, { label: "ответ доставлен" });

      assert.ok(env.progressCalls.length > 0, "хотя бы стадия маршрутизации отправлена");
      assert.equal(env.progressCalls[0].conversation.adapter, "telegram");
      assert.equal(env.progressCalls[0].conversation.externalId, "8123");
      assert.equal(typeof env.progressCalls[0].jobId, "string");
    });

    it("без progressNotifier задание всё равно обрабатывается", async (t) => {
      muteConsole(t);
      // false — явно «раннер без уведомлений о прогрессе», в отличие от
      // отсутствия опции вовсе (тогда buildEnv подставил бы заглушку).
      const env = buildEnv({ progressNotifier: false });
      const job = env.enqueue("привет");

      runUntil(t, env);
      await waitFor(() => env.delivered.length === 1, { label: "ответ доставлен" });

      assert.equal(env.jobRepository.findById(job.id).status, JOB_STATUS.completed);
    });
  });

  describe("восстановление после перезапуска", () => {
    it("возвращает в работу задание, застрявшее в running", async (t) => {
      muteConsole(t);
      const env = buildEnv();
      const job = env.enqueue("привет");
      // Имитируем падение процесса ровно в момент обработки.
      env.jobRepository.markRunning(job.id);

      runUntil(t, env);
      await waitFor(() => env.delivered.length === 1, { label: "задание переобработано" });

      assert.equal(env.jobRepository.findById(job.id).status, JOB_STATUS.completed);
    });

    it("не переспрашивает модель для уже завершённого задания", async (t) => {
      muteConsole(t);
      const theoryAgent = createFakeTheoryAgent();
      const env = buildEnv({ theoryAgent });
      const job = env.enqueue();
      // Ответ получен и сохранён, но доставить его не успели.
      env.jobRepository.finish(job.id, { status: JOB_STATUS.completed, replyText: "готовый ответ" });

      runUntil(t, env);
      await waitFor(() => env.delivered.length === 1, { label: "ответ дослан" });

      assert.equal(theoryAgent.calls.length, 0, "модель не опрашивалась повторно");
      assert.equal(env.delivered[0].payload.reply.text, "готовый ответ");
    });

    it("дошлёт недоставленный отказ, а не только успешный ответ", async (t) => {
      muteConsole(t);
      const env = buildEnv();
      const job = env.enqueue();
      env.jobRepository.finish(job.id, {
        status: JOB_STATUS.rejected,
        reason: "context_limit",
      });

      runUntil(t, env);
      await waitFor(() => env.delivered.length === 1, { label: "отказ дослан" });

      assert.equal(env.delivered[0].payload.status, "rejected");
      assert.equal(env.delivered[0].payload.reason, "context_limit");
    });
  });

  describe("атомарность записи", () => {
    it("при сбое смены статуса история не остаётся записанной", async (t) => {
      muteConsole(t);
      const env = buildEnv({
        jobRepositoryOverrides: {
          finish() {
            throw new Error("сбой записи статуса");
          },
        },
      });
      const job = env.enqueue("привет");

      runUntil(t, env);
      // Даём циклу несколько итераций, чтобы он точно попробовал обработать.
      await new Promise((resolve) => setTimeout(resolve, 120));

      assert.deepEqual(
        env.chatRepository.getMessages(env.activeSession().id),
        [],
        "транзакция откатила запись обмена целиком",
      );
      assert.equal(
        env.jobRepository.findById(job.id).status,
        JOB_STATUS.running,
        "задание осталось незавершённым — его подберёт requeueStale при рестарте",
      );
      assert.equal(env.delivered.length, 0);
    });
  });

  describe("остановка", () => {
    it("stop дожидается завершения цикла", async (t) => {
      muteConsole(t);
      const env = buildEnv();
      const runner = env.makeRunner();
      runner.start();

      await assert.doesNotReject(() => runner.stop());
    });

    it("после остановки новые задания не берутся", async (t) => {
      muteConsole(t);
      const theoryAgent = createFakeTheoryAgent();
      const env = buildEnv({ theoryAgent });
      const runner = env.makeRunner();
      runner.start();
      await runner.stop();

      env.enqueue("после остановки");
      await new Promise((resolve) => setTimeout(resolve, 60));

      assert.equal(theoryAgent.calls.length, 0);
    });
  });
});
