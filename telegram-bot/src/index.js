import { config } from "./config.js";
import { TelegramClient } from "./telegram/client.js";
import { startPolling } from "./telegram/polling.js";
import { createLlmRunner } from "./llm/index.js";
import { createDatabase } from "./db/database.js";
import { ChatRepository } from "./db/chatRepository.js";
import { logError } from "./logger.js";

const telegramClient = new TelegramClient(config.telegramBotToken);
const llmRunner = createLlmRunner(config);
const db = createDatabase(config.sqlitePath);
const chatRepository = new ChatRepository(db);

await telegramClient
  .setMyCommands([
    { command: "new", description: "Начать новый диалог (сбросить контекст)" },
  ])
  .catch((error) => {
    logError("Не удалось зарегистрировать команды бота в меню Telegram:", error);
  });

startPolling({
  telegramClient,
  llmRunner,
  chatRepository,
  maxMessageLength: config.maxMessageLength,
  contextWindowTokens: config.contextWindowTokens,
}).catch((error) => {
  console.error("Бот аварийно завершил работу:", error);
  process.exit(1);
});
