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

export const config = {
  telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
  llmProvider: process.env.LLM_PROVIDER || "ollama",
  ollama: {
    baseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
    model: process.env.OLLAMA_MODEL || "llama3",
  },
};
