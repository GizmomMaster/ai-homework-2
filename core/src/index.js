import { config } from "./config.js";
import { createRoutes } from "./http/routes.js";
import { createStubHandlers } from "./http/stubHandlers.js";
import { createServer } from "./http/server.js";
import { log, logError } from "./logger.js";

const router = createRoutes(createStubHandlers());
const server = createServer({ router, maxBodyBytes: config.maxBodyBytes });

server.listen(config.port, config.host, () => {
  log(`Core Orchestrator слушает http://${config.host}:${config.port} (режим: заглушки)`);
});

server.on("error", (error) => {
  logError("Не удалось запустить HTTP-сервер:", error);
  process.exit(1);
});

// Graceful shutdown: docker compose down шлёт SIGTERM, Ctrl+C — SIGINT.
// Даём серверу дообслужить открытые запросы и только потом выходим.
for (const signalName of ["SIGINT", "SIGTERM"]) {
  process.once(signalName, () => {
    log(`Получен ${signalName}, завершаю работу...`);
    server.close(() => {
      log("Core Orchestrator остановлен.");
    });
  });
}
