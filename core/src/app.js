import { createDatabase } from "./db/database.js";
import { ChatRepository } from "./db/chatRepository.js";
import { JobRepository } from "./db/jobRepository.js";
import { createLlmRunner } from "./llm/index.js";
import { DialogService } from "./domain/DialogService.js";
import { CallbackDelivery } from "./jobs/CallbackDelivery.js";
import { JobRunner } from "./jobs/JobRunner.js";
import { createHandlers } from "./http/handlers.js";
import { createRoutes } from "./http/routes.js";
import { createServer } from "./http/server.js";

/**
 * Сборка приложения из частей. Вынесена из точки входа, чтобы тесты могли
 * поднять Core целиком с подменёнными зависимостями (БД в памяти, заглушка
 * модели) — и проверять не отдельные классы, а поведение сервиса.
 *
 * @param {{
 *   config: import("./config.js").config,
 *   llmRunner?: import("./llm/LlmRunner.js").LlmRunner,
 *   fetchImpl?: typeof fetch,
 * }} params
 */
export function createApp({ config, llmRunner, fetchImpl }) {
  const db = createDatabase(config.sqlitePath);
  const chatRepository = new ChatRepository(db);
  const jobRepository = new JobRepository(db);

  const dialogService = new DialogService({
    chatRepository,
    llmRunner: llmRunner ?? createLlmRunner(config),
    contextWindowTokens: config.contextWindowTokens,
  });

  const callbackDelivery = new CallbackDelivery({
    callbackUrls: config.callbackUrls,
    timeoutMs: config.jobs.deliveryTimeoutMs,
    fetchImpl,
  });

  const jobRunner = new JobRunner({
    db,
    chatRepository,
    jobRepository,
    dialogService,
    callbackDelivery,
    pollIntervalMs: config.jobs.pollIntervalMs,
    deliveryMaxAttempts: config.jobs.deliveryMaxAttempts,
    deliveryBackoffMs: config.jobs.deliveryBackoffMs,
  });

  const router = createRoutes(
    createHandlers({ chatRepository, jobRepository, dialogService, jobRunner }),
  );
  const server = createServer({ router, maxBodyBytes: config.maxBodyBytes });

  return {
    db,
    server,
    jobRunner,
    chatRepository,
    jobRepository,
    dialogService,

    start() {
      jobRunner.start();
    },

    /** Сначала останавливаем обработку заданий, потом закрываем БД. */
    async stop() {
      await jobRunner.stop();
      db.close();
    },
  };
}
