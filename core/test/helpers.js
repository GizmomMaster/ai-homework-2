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
    llmProvider: "ollama",
    ollama: { baseUrl: "http://ollama.test", model: "test-model", timeoutMs: 1000 },
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
 * Заглушка LlmRunner. `reply` — объект ответа, функция от messages или Error.
 */
export function createFakeLlmRunner(
  reply = { content: "ответ", promptTokens: 10, completionTokens: 5 },
) {
  const calls = [];
  return {
    calls,
    async chat(messages) {
      calls.push(messages);
      const result = typeof reply === "function" ? reply(messages) : reply;
      if (result instanceof Error) throw result;
      return result;
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
export async function startCoreApp({ llmRunner, transport, config: overrides } = {}) {
  const config = testConfig(overrides);
  const callbackTransport = transport ?? createFakeCallbackTransport();
  const app = createApp({
    config,
    llmRunner: llmRunner ?? createFakeLlmRunner(),
    fetchImpl: callbackTransport.fetchImpl,
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
export async function startCore({ handlers, maxBodyBytes } = {}) {
  const router = createRoutes(handlers ?? createStubHandlers());
  const server = createServer({ router, maxBodyBytes });

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
    async request(method, path, { body, rawBody } = {}) {
      const hasBody = rawBody !== undefined || body !== undefined;
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: hasBody ? { "Content-Type": "application/json" } : undefined,
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
