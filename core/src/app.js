import { createDatabase } from "./db/database.js";
import { ChatRepository } from "./db/chatRepository.js";
import { JobRepository } from "./db/jobRepository.js";
import { createLlmRunner } from "./llm/index.js";
import { DialogService } from "./domain/DialogService.js";
import { RouterAgent } from "./agents/RouterAgent.js";
import { TheoryAgent } from "./agents/TheoryAgent.js";
import { PlannerAgent } from "./agents/PlannerAgent.js";
import { PlanExecutor } from "./domain/PlanExecutor.js";
import { SummaryAgent } from "./agents/SummaryAgent.js";
import { BinanceClient } from "./tools/BinanceClient.js";
import { createTools } from "./tools/index.js";
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
 *   routerAgent?: import("./agents/RouterAgent.js").RouterAgent,
 *   theoryAgent?: import("./agents/TheoryAgent.js").TheoryAgent,
 *   plannerAgent?: import("./agents/PlannerAgent.js").PlannerAgent,
 *   planExecutor?: import("./domain/PlanExecutor.js").PlanExecutor,
 *   summaryAgent?: import("./agents/SummaryAgent.js").SummaryAgent,
 *   tools?: ReturnType<typeof import("./tools/index.js").createTools>,
 *   fetchImpl?: typeof fetch,
 * }} params
 */
export function createApp({
  config,
  llmRunner,
  routerAgent,
  theoryAgent,
  plannerAgent,
  planExecutor,
  summaryAgent,
  tools,
  fetchImpl,
}) {
  const db = createDatabase(config.sqlitePath);
  const chatRepository = new ChatRepository(db);
  const jobRepository = new JobRepository(db);

  const runner = llmRunner ?? createLlmRunner(config);
  // Свой fetch, а не общий с доставкой callback'ов: это разные направления
  // и разные подмены в тестах — заглушка адаптера ждёт тело запроса, которого
  // у GET к бирже нет.
  const marketTools =
    tools ??
    createTools({
      binance: new BinanceClient({
        baseUrl: config.tools.binanceBaseUrl,
        timeoutMs: config.tools.timeoutMs,
      }),
    });

  const dialogService = new DialogService({
    chatRepository,
    routerAgent: routerAgent ?? new RouterAgent({ llmRunner: runner }),
    theoryAgent: theoryAgent ?? new TheoryAgent({ llmRunner: runner }),
    plannerAgent: plannerAgent ?? new PlannerAgent({ llmRunner: runner, tools: marketTools }),
    planExecutor: planExecutor ?? new PlanExecutor({ tools: marketTools }),
    summaryAgent: summaryAgent ?? new SummaryAgent({ llmRunner: runner }),
    contextWindowTokens: config.contextWindowTokens,
  });

  const callbackDelivery = new CallbackDelivery({
    callbackUrls: config.callbackUrls,
    timeoutMs: config.jobs.deliveryTimeoutMs,
    authToken: config.authToken,
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
  const server = createServer({
    router,
    maxBodyBytes: config.maxBodyBytes,
    authToken: config.authToken,
  });

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
