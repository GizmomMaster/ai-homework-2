import { log, logError } from "../logger.js";
import { sendSafely } from "../telegram/send.js";

/**
 * @typedef {Object} CommandContext
 * @property {number|string} chatId
 * @property {import("../telegram/client.js").TelegramClient} telegramClient
 * @property {import("../core/CoreClient.js").CoreClient} coreClient
 *
 * @typedef {Object} BotCommand
 * @property {string} command      имя без ведущего слэша
 * @property {string} description  текст для меню Telegram
 * @property {(ctx: CommandContext) => Promise<void>} handle
 */

const NEW_CHAT_TEXT =
  "Начат новый диалог. История предыдущего общения сохранена, " +
  "но больше не используется как контекст.";

const CORE_UNAVAILABLE_TEXT =
  "Сервис временно недоступен, попробуйте ещё раз через минуту.";

const HELP_TEXT =
  "Я передаю ваши сообщения языковой модели и присылаю её ответ.\n\n" +
  "Диалог ведётся с учётом истории переписки, поэтому можно задавать " +
  "уточняющие вопросы.\n\n" +
  "Команды:\n" +
  "/new — начать новый диалог (сбросить контекст)\n" +
  "/help — эта справка\n\n" +
  "Когда контекст диалога заполнится, я попрошу начать новый через /new.";

/** Сбрасывает контекст в Core; при недоступности честно сообщает об этом. */
async function resetConversation({ chatId, telegramClient, coreClient }, confirmation) {
  try {
    await coreClient.reset({ chatId });
  } catch (error) {
    logError(`[chat ${chatId}] Не удалось сбросить контекст в Core:`, error);
    await sendSafely(telegramClient, chatId, CORE_UNAVAILABLE_TEXT);
    return;
  }

  log(`[chat ${chatId}] Начат новый диалог.`);
  await sendSafely(telegramClient, chatId, confirmation);
}

/**
 * Реестр команд бота — единственный источник правды и для меню Telegram
 * (`setMyCommands`), и для обработки входящих сообщений.
 *
 * Разбор синтаксиса команды — забота адаптера (он знает про `/new@BotName`),
 * а её смысл живёт в Core: сброс контекста делает `POST …/reset`.
 *
 * @type {BotCommand[]}
 */
export const commands = [
  {
    command: "new",
    description: "Начать новый диалог (сбросить контекст)",
    handle: (ctx) => resetConversation(ctx, NEW_CHAT_TEXT),
  },
  {
    command: "start",
    description: "Начать работу с ботом",
    handle: (ctx) => resetConversation(ctx, `Привет! ${HELP_TEXT}`),
  },
  {
    command: "help",
    description: "Справка по работе с ботом",
    async handle({ chatId, telegramClient }) {
      await sendSafely(telegramClient, chatId, HELP_TEXT);
    },
  },
];

/**
 * Список команд в формате Telegram Bot API для `setMyCommands`.
 * @returns {Array<{ command: string, description: string }>}
 */
export function commandMenu() {
  return commands.map(({ command, description }) => ({ command, description }));
}

/**
 * Разбирает текст сообщения как команду бота. Учитывает суффикс с именем
 * бота (`/new@MyBot`, добавляется Telegram в группах) и регистр.
 * Возвращает `undefined`, если это обычное сообщение или неизвестная команда.
 *
 * @param {string} text
 * @returns {BotCommand|undefined}
 */
export function findCommand(text) {
  const firstWord = text.trim().split(/\s+/)[0] || "";
  if (!firstWord.startsWith("/")) return undefined;

  const name = firstWord.slice(1).split("@")[0].toLowerCase();
  return commands.find((command) => command.command === name);
}
