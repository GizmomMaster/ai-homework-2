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
 * Режим «размышления» гибридных reasoning-моделей (Qwen3 и подобных).
 * Значение "omit" убирает поле из запроса: модели без поддержки размышления
 * отвергают запрос, в котором оно есть.
 */
function thinkMode(name, defaultValue) {
  const raw = process.env[name];
  if (!raw) return defaultValue;

  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "omit") return "omit";
  throw new Error(
    `Переменная окружения ${name} должна быть "true", "false" или "omit", получено: "${raw}".`,
  );
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
  /**
   * Общий секрет между Core и адаптерами. Если не задан, проверка выключена —
   * допустимо при локальной разработке, но не при запуске в compose.
   */
  authToken: process.env.CORE_AUTH_TOKEN || undefined,

  sqlitePath: resolveFromProjectRoot(process.env.SQLITE_DB_PATH || "./data/core.db"),
  /**
   * Бюджет диалога в токенах. Передаётся модели как num_ctx, поэтому упирается
   * не только в нативное окно модели (у qwen3:8b — 32768), но и в память:
   * KV-кеш у неё около 144 КиБ на токен, то есть 16000 токенов стоят ~2.3 ГБ
   * поверх ~5 ГБ весов. Полные 32768 добавили бы ещё столько же и на карте с
   * 12 ГБ шли бы впритык.
   */
  contextWindowTokens: positiveInt("CONTEXT_WINDOW_TOKENS", 16000),

  llmProvider: process.env.LLM_PROVIDER || "ollama",
  ollama: {
    baseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
    model: process.env.OLLAMA_MODEL || "qwen3:8b",
    timeoutMs: positiveInt("OLLAMA_TIMEOUT_MS", 120000),
    think: thinkMode("OLLAMA_THINK", false),
  },

  jobs: {
    pollIntervalMs: positiveInt("JOB_POLL_INTERVAL_MS", 500),
    deliveryMaxAttempts: positiveInt("CALLBACK_MAX_ATTEMPTS", 6),
    deliveryBackoffMs: positiveInt("CALLBACK_BACKOFF_MS", 2000),
    deliveryTimeoutMs: positiveInt("CALLBACK_TIMEOUT_MS", 10000),
  },

  callbackUrls: callbackUrls(),
};
