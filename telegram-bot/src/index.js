import { config } from "./config.js";
import { TelegramClient } from "./telegram/client.js";
import { startPolling } from "./telegram/polling.js";
import { createLlmRunner } from "./llm/index.js";
import { createDatabase } from "./db/database.js";
import { ChatRepository } from "./db/chatRepository.js";
import { commandMenu } from "./handlers/commands.js";
import { log, logError } from "./logger.js";

const telegramClient = new TelegramClient(config.telegramBotToken);
const llmRunner = createLlmRunner(config);
const db = createDatabase(config.sqlitePath);
const chatRepository = new ChatRepository(db);

// Меню команд берётся из того же реестра, что и обработчики, — список
// в меню и реально работающие команды не могут разъехаться.
await telegramClient.setMyCommands(commandMenu()).catch((error) => {
  logError("Не удалось зарегистрировать команды бота в меню Telegram:", error);
});

// Graceful shutdown: докер при `docker compose down` шлёт SIGTERM, Ctrl+C —
// SIGINT. Обрываем long polling и аккуратно закрываем БД, чтобы SQLite
// успел сбросить WAL-журнал.
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
    llmRunner,
    chatRepository,
    maxMessageLength: config.maxMessageLength,
    contextWindowTokens: config.contextWindowTokens,
    signal: shutdown.signal,
  });
} catch (error) {
  logError("Бот аварийно завершил работу:", error);
  db.close();
  process.exit(1);
}

db.close();
log("Бот остановлен.");
