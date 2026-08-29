import { config } from "./config.js";
import { createApp } from "./app.js";
import { log, logError } from "./logger.js";

const app = createApp({ config });

app.start();
app.server.listen(config.port, config.host, () => {
  log(`Core Orchestrator слушает http://${config.host}:${config.port}`);
  const activeModel = config[config.llmProvider]?.model;
  log(`Модель: ${config.llmProvider}/${activeModel}, контекст ${config.contextWindowTokens} токенов.`);

  const adapters = Object.keys(config.callbackUrls);
  if (adapters.length === 0) {
    log("ВНИМАНИЕ: не задан ни один callback-адрес адаптера — ответы доставить будет некуда.");
  } else {
    log(`Адаптеры: ${adapters.join(", ")}.`);
  }
});

app.server.on("error", (error) => {
  logError("Не удалось запустить HTTP-сервер:", error);
  process.exit(1);
});

// Graceful shutdown: docker compose down шлёт SIGTERM, Ctrl+C — SIGINT.
// Порядок важен: перестаём принимать запросы, доводим текущее задание,
// затем закрываем БД, чтобы SQLite сбросил WAL-журнал.
for (const signalName of ["SIGINT", "SIGTERM"]) {
  process.once(signalName, () => {
    log(`Получен ${signalName}, завершаю работу...`);
    app.server.close(async () => {
      await app.stop();
      log("Core Orchestrator остановлен.");
    });
  });
}
