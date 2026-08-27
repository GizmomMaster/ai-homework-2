import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
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

export const config = {
  /** Порт HTTP-API оркестратора. */
  port: positiveInt("CORE_PORT", 8080),
  /**
   * 0.0.0.0 — чтобы сервис был доступен другим контейнерам compose-сети.
   * Наружу порт не публикуется, только внутрь сети.
   */
  host: process.env.CORE_HOST || "0.0.0.0",
  /** Предел размера тела запроса; сообщения пользователей заведомо меньше. */
  maxBodyBytes: positiveInt("CORE_MAX_BODY_BYTES", 64 * 1024),
};
