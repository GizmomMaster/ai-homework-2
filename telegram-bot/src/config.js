import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { loadEnvFile } from "./env.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
loadEnvFile(join(projectRoot, ".env"));

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

/**
 * Относительные пути к БД разрешаются от корня проекта, а не от текущего
 * рабочего каталога: иначе `node src/index.js`, запущенный из другого места,
 * создал бы вторую пустую базу и «потерял» историю переписки.
 */
function resolveFromProjectRoot(path) {
  return isAbsolute(path) || path === ":memory:" ? path : resolve(projectRoot, path);
}

export const config = {
  telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
  llmProvider: process.env.LLM_PROVIDER || "ollama",
  maxMessageLength: positiveInt("MAX_MESSAGE_LENGTH", 1000),
  contextWindowTokens: positiveInt("CONTEXT_WINDOW_TOKENS", 50000),
  sqlitePath: resolveFromProjectRoot(process.env.SQLITE_DB_PATH || "./data/bot.db"),
  ollama: {
    baseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
    model: process.env.OLLAMA_MODEL || "llama3",
    timeoutMs: positiveInt("OLLAMA_TIMEOUT_MS", 300000),
  },
};
