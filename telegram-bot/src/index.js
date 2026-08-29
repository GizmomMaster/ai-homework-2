import { config } from "./config.js";
import { TelegramClient } from "./telegram/client.js";
import { startPolling } from "./telegram/polling.js";
import { CoreClient } from "./core/CoreClient.js";
import { createCallbackServer } from "./http/callbackServer.js";
import { handleReply } from "./handlers/replyHandler.js";
import { createProgressTracker } from "./handlers/progressHandler.js";
import { commandMenu } from "./handlers/commands.js";
import { log, logError } from "./logger.js";

const telegramClient = new TelegramClient(config.telegramBotToken, {
  apiBaseUrl: config.telegramApiBaseUrl,
});
const coreClient = new CoreClient(config.core);

const progressTracker = createProgressTracker({ telegramClient });

// Сервер для готовых ответов от Core. Поднимаем до старта polling: иначе
// первый же ответ мог бы прийти в закрытый порт.
const callbackServer = createCallbackServer({
  path: config.callback.path,
  authToken: config.callback.authToken,
  // Промежуточный статус ("прогресс") показываем отдельным обработчиком —
  // это не ответ пользователю, а обновление статусного сообщения.
  onReply: (payload) =>
    payload.status === "progress"
      ? progressTracker.handle(payload)
      : handleReply({ payload, telegramClient, progressTracker }),
});

await new Promise((resolve, reject) => {
  callbackServer.once("error", reject);
  callbackServer.listen(config.callback.port, config.callback.host, () => {
    log(
      `Приём ответов от Core: http://${config.callback.host}:${config.callback.port}${config.callback.path}`,
    );
    resolve();
  });
});

// Меню команд берётся из того же реестра, что и обработчики, — список
// в меню и реально работающие команды не могут разъехаться.
await telegramClient.setMyCommands(commandMenu()).catch((error) => {
  logError("Не удалось зарегистрировать команды бота в меню Telegram:", error);
});

log(`Core Orchestrator: ${config.core.baseUrl}`);

// Graceful shutdown: docker compose down шлёт SIGTERM, Ctrl+C — SIGINT.
const shutdown = new AbortController();
for (const signalName of ["SIGINT", "SIGTERM"]) {
  process.once(signalName, () => {
    log(`Получен ${signalName}, завершаю работу...`);
    shutdown.abort();
  });
}

try {
  await startPolling({
    telegramClient,
    coreClient,
    maxMessageLength: config.maxMessageLength,
    signal: shutdown.signal,
  });
} catch (error) {
  logError("Бот аварийно завершил работу:", error);
  callbackServer.close();
  process.exit(1);
}

callbackServer.close(() => log("Бот остановлен."));
