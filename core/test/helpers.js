import { createRoutes } from "../src/http/routes.js";
import { createStubHandlers } from "../src/http/stubHandlers.js";
import { createServer } from "../src/http/server.js";
import { createApp } from "../src/app.js";
import { createDatabase } from "../src/db/database.js";
import { ChatRepository } from "../src/db/chatRepository.js";
import { JobRepository } from "../src/db/jobRepository.js";

/** Конфиг для тестов: БД в памяти, короткие паузы, фиктивный адрес callback'а. */
export function testConfig(overrides = {}) {
  return {
    port: 0,
    host: "127.0.0.1",
    maxBodyBytes: 64 * 1024,
    sqlitePath: ":memory:",
    contextWindowTokens: 1000,
    llmProvider: "lmstudio",
    ollama: { baseUrl: "http://ollama.test", model: "test-model", timeoutMs: 1000 },
    lmstudio: { baseUrl: "http://lmstudio.test", model: "test-model", timeoutMs: 1000 },
    tools: {
      binanceBaseUrl: "http://binance.test",
      coingeckoBaseUrl: "http://coingecko.test",
      timeoutMs: 500,
      // Инструмент RSI выключен (пустой pythonBin): тесты приложения проверяют
      // очередь и доставку, и запускать в них подпроцессы незачем. Сам
      // инструмент проверяется в rsi.test.js.
      rsi: { pythonBin: "", scriptPath: "rsi.py", timeoutMs: 1000 },
    },
    jobs: {
      pollIntervalMs: 10,
      deliveryMaxAttempts: 3,
      deliveryBackoffMs: 20,
      deliveryTimeoutMs: 500,
    },
    callbackUrls: { telegram: "http://adapter.test/callbacks/replies" },
    ...overrides,
  };
}

/** Репозитории поверх общей БД в памяти — для тестов слоя данных. */
export function createTestRepositories() {
  const db = createDatabase(":memory:");
  return { db, chatRepository: new ChatRepository(db), jobRepository: new JobRepository(db) };
}

/**
 * Заглушка маршрутизатора. `verdict` — объект вердикта, функция от входа
 * или Error.
 */
export function createFakeRouter(verdict = { intent: "THEORY_QUESTION" }) {
  const calls = [];
  return {
    calls,
    async classify(input) {
      calls.push(input);
      const result = typeof verdict === "function" ? verdict(input) : verdict;
      if (result instanceof Error) throw result;
      return {
        isCryptoRelated: true,
        confidence: 0.9,
        topicSummary: "тема",
        usage: { promptTokens: 20, completionTokens: 8 },
        ...result,
      };
    },
  };
}

/**
 * Заглушка LlmRunner. `reply` — объект ответа, функция от messages или Error.
 */
export function createFakeLlmRunner(
  reply = { content: "ответ", promptTokens: 10, completionTokens: 5 },
) {
  const calls = [];
  const options = [];
  return {
    calls,
    /** Опции вызова параллельным массивом: дописывать их в `calls` нельзя — тесты сравнивают его целиком. */
    options,
    async chat(messages, callOptions) {
      calls.push(messages);
      options.push(callOptions);
      const result = typeof reply === "function" ? reply(messages) : reply;
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

/**
 * Заглушка теоретического агента. Внутри тот же fake-раннер, поэтому тесты
 * по-прежнему видят, что именно ушло модели, — только через `.calls` агента.
 */
export function createFakeTheoryAgent(
  reply = { content: "ответ", promptTokens: 40, completionTokens: 12 },
) {
  const llmRunner = createFakeLlmRunner(reply);
  return {
    calls: llmRunner.calls,
    options: llmRunner.options,
    answer: (messages) => llmRunner.chat(messages),
  };
}

/**
 * Заглушка ProgressNotifier: копит статусы вместо похода в сеть. Отдельно от
 * `createFakeCallbackTransport`, потому что статусы обработки и доставка
 * финального ответа — разные вещи, и смешивать их в одном массиве `delivered`
 * не стоит: тесты, ждущие ровно один финальный результат, иначе увидят там
 * ещё и промежуточные события.
 */
export function createFakeProgressNotifier() {
  const calls = [];
  return {
    calls,
    notify(job, conversation, progress) {
      calls.push({ jobId: job.id, conversation, progress });
    },
  };
}

/**
 * Заглушка планировщика. `result` — объект плана, функция от входа или Error.
 */
export function createFakePlanner(result = { canExecute: false, fallbackMessage: "не умею" }) {
  const calls = [];
  return {
    calls,
    async plan(input) {
      calls.push(input);
      const value = typeof result === "function" ? result(input) : result;
      if (value instanceof Error) throw value;
      return {
        taskSummary: "задача",
        plan: [],
        fallbackMessage: null,
        truncated: false,
        usage: { promptTokens: 300, completionTokens: 40 },
        ...value,
      };
    },
  };
}

/**
 * Заглушка исполнителя плана: превращает шаги в результаты по функции
 * `outcome(step)`; по умолчанию все шаги успешны. Зовёт `onStep` так же, как
 * настоящий PlanExecutor (по одному на шаг, в порядке плана — здесь он и так
 * синхронный, без параллелизма), чтобы можно было проверять сквозную
 * проводку прогресса через DialogService, не поднимая настоящие инструменты.
 */
export function createFakeExecutor(outcome = () => ({ ok: true, value: { ok: 1 } })) {
  const calls = [];
  return {
    calls,
    async run(plan, { onStep } = {}) {
      calls.push(plan);
      const steps = plan.map((step, index) => {
        const result = {
          stepNumber: index + 1,
          action: step.action ?? step.toolToUse,
          tool: step.toolToUse,
          ...outcome(step, index),
        };
        onStep?.({
          stepNumber: result.stepNumber,
          totalSteps: plan.length,
          action: result.action,
          ok: result.ok,
          completedCount: index + 1,
        });
        return result;
      });
      const succeeded = steps.filter((s) => s.ok).length;
      return { steps, succeeded, failed: steps.length - succeeded };
    },
  };
}

/**
 * Заглушка сводящего агента. `reply` — ответ модели, функция от входа или Error.
 */
export function createFakeSummaryAgent(
  reply = { content: "Сводка по данным.", promptTokens: 500, completionTokens: 60 },
) {
  const calls = [];
  return {
    calls,
    async summarize(input) {
      calls.push(input);
      const value = typeof reply === "function" ? reply(input) : reply;
      if (value instanceof Error) throw value;
      return value;
    },
  };
}

/**
 * Заглушка агента комментария к сводке. По умолчанию отвечает связным
 * абзацем — таблицы модель больше не пишет, их собирает код.
 */
export function createFakeOverviewAgent(
  reply = {
    content: "Рынок снижался: BTC потерял 3.00%, из общей картины выбился TRX (+1.10%).",
    promptTokens: 400,
    completionTokens: 90,
  },
) {
  const calls = [];
  return {
    calls,
    async comment(overview) {
      calls.push(overview);
      const value = typeof reply === "function" ? reply(overview) : reply;
      if (value instanceof Error) throw value;
      return value;
    },
  };
}

/**
 * Подменённый fetch для доставки callback'ов: копит доставленные полезные
 * нагрузки и умеет падать заданное число раз подряд.
 *
 * @param {{ failTimes?: number, status?: number }} [options]
 */
export function createFakeCallbackTransport({ failTimes = 0, status = 200 } = {}) {
  const delivered = [];
  let remainingFailures = failTimes;

  const fetchImpl = async (url, options) => {
    const payload = JSON.parse(options.body);
    if (remainingFailures > 0) {
      remainingFailures -= 1;
      throw new Error("адаптер недоступен");
    }
    delivered.push({ url, payload });
    return { ok: status >= 200 && status < 300, status };
  };

  return { delivered, fetchImpl, attemptsLeftToFail: () => remainingFailures };
}

/**
 * Поднимает Core целиком (БД в памяти, подменённые модель и транспорт
 * callback'ов) и отдаёт `request` поверх настоящего HTTP.
 */
export async function startCoreApp({
  llmRunner,
  routerAgent,
  theoryAgent,
  plannerAgent,
  planExecutor,
  summaryAgent,
  overviewAgent,
  tools,
  transport,
  progressNotifier,
  config: overrides,
} = {}) {
  const config = testConfig(overrides);
  const callbackTransport = transport ?? createFakeCallbackTransport();
  const app = createApp({
    config,
    llmRunner: llmRunner ?? createFakeLlmRunner(),
    routerAgent: routerAgent ?? createFakeRouter(),
    theoryAgent: theoryAgent ?? createFakeTheoryAgent(),
    plannerAgent: plannerAgent ?? createFakePlanner(),
    planExecutor: planExecutor ?? createFakeExecutor(),
    summaryAgent: summaryAgent ?? createFakeSummaryAgent(),
    overviewAgent,
    tools,
    fetchImpl: callbackTransport.fetchImpl,
    // По умолчанию — заглушка, а не настоящий ProgressNotifier: иначе
    // прогресс-пинги на каждый вызов process() шли бы через тот же fetchImpl,
    // что и доставка ответа, и попадали бы в тот же массив `delivered`,
    // смешивая статусы с финальным результатом в тестах, которые его не ждут.
    progressNotifier: progressNotifier ?? createFakeProgressNotifier(),
  });

  app.start();
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const { port } = app.server.address();

  return {
    app,
    config,
    delivered: callbackTransport.delivered,
    ...requestApi(`http://127.0.0.1:${port}`),
    async close() {
      await new Promise((resolve) => app.server.close(resolve));
      await app.stop();
    },
  };
}

/** Поднимает только HTTP-слой с заглушками — для проверок контракта. */
export async function startCore({ handlers, maxBodyBytes, authToken } = {}) {
  const router = createRoutes(handlers ?? createStubHandlers());
  const server = createServer({ router, maxBodyBytes, authToken });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    ...requestApi(`http://127.0.0.1:${port}`),
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function requestApi(baseUrl) {
  return {
    baseUrl,
    async request(method, path, { body, rawBody, token } = {}) {
      const hasBody = rawBody !== undefined || body !== undefined;
      const headers = {
        ...(hasBody ? { "Content-Type": "application/json" } : {}),
        ...(token ? { "X-Core-Token": token } : {}),
      };
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
        body:
          rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined,
      });

      const text = await response.text();
      let json;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }

      return { status: response.status, json, text, headers: response.headers };
    },
  };
}

/** Заглушка, всегда роняющая обработчик, — для проверки ответа 500. */
export function throwingHandlers(error = new Error("boom")) {
  const fail = async () => {
    throw error;
  };
  return { health: fail, enqueueMessage: fail, resetConversation: fail, getJob: fail };
}

/** Ждёт выполнения условия, чтобы не завязываться на фиксированные паузы. */
export async function waitFor(predicate, { timeoutMs = 3000, label = "условие" } = {}) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Таймаут ожидания: ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Глушит вывод логгера на время теста, чтобы не засорять отчёт. */
export function muteConsole(t) {
  const originalError = console.error;
  const originalLog = console.log;
  console.error = () => {};
  console.log = () => {};
  t.after(() => {
    console.error = originalError;
    console.log = originalLog;
  });
}
