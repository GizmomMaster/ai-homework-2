import { readFileSync } from "node:fs";

/**
 * Минимальный парсер .env-файлов без внешних зависимостей.
 * Поддерживает строки вида KEY=VALUE, пустые строки и комментарии (#).
 * Не перезаписывает переменные, уже заданные в process.env.
 */
export function loadEnvFile(path) {
  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return;
  }

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) continue;

    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}
