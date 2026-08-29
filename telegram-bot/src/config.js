import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadEnvFile } from "./env.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnvFile(join(__dirname, "..", ".env"));

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Отсутствует обязательная переменная окружения ${name}. ` +
        `Проверьте файл .env (см. .env.example).`,
    );
  }
  return value;
}

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

export const config = {
  telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
  /** Адрес Bot API. Меняется только для сквозных тестов и локальных прокси. */
  telegramApiBaseUrl: process.env.TELEGRAM_API_BASE_URL || "https://api.telegram.org",
  maxMessageLength: positiveInt("MAX_MESSAGE_LENGTH", 1000),

  /** Куда адаптер отправляет сообщения пользователей. */
  core: {
    baseUrl: process.env.CORE_BASE_URL || "http://localhost:8080",
    // Общий с Core секрет: подписывает исходящие запросы и проверяется
    // на входящих callback'ах. Не задан — проверка выключена.
    authToken: process.env.CORE_AUTH_TOKEN || undefined,
    timeoutMs: positiveInt("CORE_TIMEOUT_MS", 10000),
    /**
     * Исключение из правила выше: обзор рынка для /start Core собирает прямо
     * в запросе — модели там нет, но есть поход в два внешних API, и на
     * холодном кеше это секунды, а не миллисекунды.
     */
    overviewTimeoutMs: positiveInt("CORE_OVERVIEW_TIMEOUT_MS", 30000),
    // Core отвечает сразу, не дожидаясь модели, поэтому долгих ожиданий тут
    // нет — повторы нужны только на случай, что Core ещё поднимается.
    retries: positiveInt("CORE_RETRIES", 3),
    retryDelayMs: positiveInt("CORE_RETRY_DELAY_MS", 1000),
  },

  /** Локальный сервер, на который Core доставляет готовые ответы. */
  callback: {
    authToken: process.env.CORE_AUTH_TOKEN || undefined,
    port: positiveInt("CALLBACK_PORT", 8081),
    host: process.env.CALLBACK_HOST || "0.0.0.0",
    path: process.env.CALLBACK_PATH || "/callbacks/replies",
  },
};
