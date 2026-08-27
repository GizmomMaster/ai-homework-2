import { config } from "./config.js";
import { TelegramClient } from "./telegram/client.js";
import { startPolling } from "./telegram/polling.js";
import { createLlmRunner } from "./llm/index.js";

const telegramClient = new TelegramClient(config.telegramBotToken);
const llmRunner = createLlmRunner(config);

startPolling({
  telegramClient,
  llmRunner,
  maxMessageLength: config.maxMessageLength,
}).catch((error) => {
  console.error("Бот аварийно завершил работу:", error);
  process.exit(1);
});
