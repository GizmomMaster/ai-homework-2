import { createDatabase } from "./db/database.js";
import { ChatRepository } from "./db/chatRepository.js";
import { JobRepository } from "./db/jobRepository.js";
import { createLlmRunner } from "./llm/index.js";
import { DialogService, PROGRESS_STAGE } from "./domain/DialogService.js";
import { initTelemetry } from "./telemetry/recorder.js";
import { InstrumentedLlmRunner } from "./telemetry/InstrumentedLlmRunner.js";
import { RouterAgent } from "./agents/RouterAgent.js";
import { TheoryAgent } from "./agents/TheoryAgent.js";
import { PlannerAgent } from "./agents/PlannerAgent.js";
import { PlanExecutor } from "./domain/PlanExecutor.js";
import { SummaryAgent } from "./agents/SummaryAgent.js";
import { MarketOverviewAgent } from "./agents/MarketOverviewAgent.js";
import { MarketOverviewService } from "./domain/MarketOverviewService.js";
import { BinanceClient } from "./tools/BinanceClient.js";
import { CoinGeckoClient } from "./tools/CoinGeckoClient.js";
import { createTools } from "./tools/index.js";
import { findRsiPython } from "./tools/pythonBin.js";
import { loadSkills } from "./skills/index.js";
import { CallbackDelivery } from "./jobs/CallbackDelivery.js";
import { ProgressNotifier } from "./jobs/ProgressNotifier.js";
import { JobRunner } from "./jobs/JobRunner.js";
import { createHandlers } from "./http/handlers.js";
import { createRoutes } from "./http/routes.js";
import { createServer } from "./http/server.js";
import { log } from "./logger.js";

/**
 * Настройки инструмента RSI вместе с найденным интерпретатором — или
 * `undefined`, если считать нечем.
 *
 * Инструмент, отсутствующий в реестре, лучше сломанного: планировщик строит
 * план по реестру и на несуществующую возможность шаг не потратит. Поэтому
 * ищем интерпретатор один раз здесь, при сборке приложения, а не при первом
 * вызове — к тому моменту решение принимать поздно.
 *
 * @param {{ enabled: boolean, scriptPath: string, timeoutMs?: number }} settings
 */
function resolveRsi({ enabled, ...settings } = {}) {
  if (!enabled) return undefined;

  const pythonBin = findRsiPython();
  if (!pythonBin) {
    log(
      "Инструмент RSI отключён: не найден Python с библиотекой TA-Lib. " +
        "Поставить: pip install -r scripts/rsi/requirements.txt",
    );
    return undefined;
  }
  return { ...settings, pythonBin };
}

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
 *   overviewAgent?: import("./agents/MarketOverviewAgent.js").MarketOverviewAgent,
 *   tools?: ReturnType<typeof import("./tools/index.js").createTools>,
 *   fetchImpl?: typeof fetch,
 *   progressNotifier?: import("./jobs/ProgressNotifier.js").ProgressNotifier,
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
  overviewAgent,
  tools,
  fetchImpl,
  progressNotifier,
}) {
  const db = createDatabase(config.sqlitePath);
  const chatRepository = new ChatRepository(db);
  const jobRepository = new JobRepository(db);
  initTelemetry(db, { pricing: config.telemetry.pricing });

  const runner = llmRunner ?? createLlmRunner(config);
  const runnerLabels = { provider: config.llmProvider, model: config[config.llmProvider]?.model };
  // Один экземпляр InstrumentedLlmRunner на агента: agentId/stage помечают,
  // кто именно потратил токены, — сам runner при этом общий и не меняется
  // (см. core/src/telemetry/InstrumentedLlmRunner.js). Оборачивает только
  // раннер по умолчанию: агент, переданный явно (тесты — фейками), уже
  // собран вызывающим кодом и телеметрию не увидит.
  const instrumented = (agentId, stage) =>
    new InstrumentedLlmRunner(runner, { agentId, stage, ...runnerLabels });
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
      coingecko: new CoinGeckoClient({
        baseUrl: config.tools.coingeckoBaseUrl,
        timeoutMs: config.tools.timeoutMs,
      }),
      rsi: resolveRsi(config.tools.rsi),
    });

  const dialogService = new DialogService({
    chatRepository,
    routerAgent: routerAgent ?? new RouterAgent({ llmRunner: instrumented("router", PROGRESS_STAGE.routing) }),
    theoryAgent: theoryAgent ?? new TheoryAgent({ llmRunner: instrumented("theory", PROGRESS_STAGE.answering) }),
    plannerAgent:
      plannerAgent ??
      new PlannerAgent({
        llmRunner: instrumented("planner", PROGRESS_STAGE.planning),
        tools: marketTools,
        skills: loadSkills(config.skillsDir),
      }),
    planExecutor: planExecutor ?? new PlanExecutor({ tools: marketTools }),
    summaryAgent: summaryAgent ?? new SummaryAgent({ llmRunner: instrumented("summary", PROGRESS_STAGE.summarizing) }),
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
    progressNotifier:
      progressNotifier ??
      new ProgressNotifier({ callbackUrls: config.callbackUrls, authToken: config.authToken }),
    pollIntervalMs: config.jobs.pollIntervalMs,
    deliveryMaxAttempts: config.jobs.deliveryMaxAttempts,
    deliveryBackoffMs: config.jobs.deliveryBackoffMs,
  });

  const marketOverviewService = new MarketOverviewService({
    tools: marketTools,
    // Не часть конвейера заданий (см. PROGRESS_STAGE) — /start отвечает
    // синхронно, поэтому здесь собственная метка стадии, а не одна из них.
    overviewAgent: overviewAgent ?? new MarketOverviewAgent({ llmRunner: instrumented("market_overview", "market_overview") }),
  });

  const router = createRoutes(
    createHandlers({
      chatRepository,
      jobRepository,
      dialogService,
      jobRunner,
      marketOverviewService,
    }),
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
