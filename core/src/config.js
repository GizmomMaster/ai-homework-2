import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { loadEnvFile } from "./env.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
loadEnvFile(join(projectRoot, ".env"));

function positiveInt(name, defaultValue) {
  const raw = process.env[name];
  if (!raw) return defaultValue;

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `Переменная окружения ${name} должна быть положительным целым числом, получено: "${raw}".`,
    );
  }
  return value;
}

/**
 * Относительные пути к БД разрешаются от корня сервиса, а не от текущего
 * рабочего каталога: иначе запуск из другого места молча создал бы вторую
 * пустую базу.
 */
function resolveFromProjectRoot(path) {
  return isAbsolute(path) || path === ":memory:" ? path : resolve(projectRoot, path);
}

/**
 * Адреса callback-эндпоинтов адаптеров: куда Core отправляет готовый ответ.
 * Держим их в конфиге, а не принимаем в запросе, — так сервис не превратить
 * в отправщика запросов на произвольный адрес.
 */
function callbackUrls() {
  const urls = {};
  if (process.env.ADAPTER_TELEGRAM_CALLBACK_URL) {
    urls.telegram = process.env.ADAPTER_TELEGRAM_CALLBACK_URL;
  }
  return urls;
}

export const config = {
  port: positiveInt("CORE_PORT", 8080),
  host: process.env.CORE_HOST || "0.0.0.0",
  maxBodyBytes: positiveInt("CORE_MAX_BODY_BYTES", 64 * 1024),

  sqlitePath: resolveFromProjectRoot(process.env.SQLITE_DB_PATH || "./data/core.db"),
  contextWindowTokens: positiveInt("CONTEXT_WINDOW_TOKENS", 50000),

  llmProvider: process.env.LLM_PROVIDER || "ollama",
  ollama: {
    baseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
    model: process.env.OLLAMA_MODEL || "llama3",
    timeoutMs: positiveInt("OLLAMA_TIMEOUT_MS", 300000),
  },

  jobs: {
    pollIntervalMs: positiveInt("JOB_POLL_INTERVAL_MS", 500),
    deliveryMaxAttempts: positiveInt("CALLBACK_MAX_ATTEMPTS", 6),
    deliveryBackoffMs: positiveInt("CALLBACK_BACKOFF_MS", 2000),
    deliveryTimeoutMs: positiveInt("CALLBACK_TIMEOUT_MS", 10000),
  },

  callbackUrls: callbackUrls(),
};
