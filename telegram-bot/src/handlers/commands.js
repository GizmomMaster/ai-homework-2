import { log, logError } from "../logger.js";
import { sendSafely } from "../telegram/send.js";
import { markdownToTelegramHtml } from "../telegram/markdown.js";

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

/**
 * Приветствие с примерами запросов — задача /start дать человеку с пустым
 * чатом что напечатать, а не пересказать возможности целиком (это /help).
 */
const START_TEXT =
  "Привет! Я — ассистент для криптотрейдеров: собираю рыночные данные с Binance " +
  "и отвечаю на вопросы по трейдингу.\n\n" +
  "Например, можно спросить:\n" +
  "• Какая сейчас цена BTC?\n" +
  "• Сравни суточные объёмы торгов SOL, ETH и BTC\n" +
  "• Покажи свечи ETHUSDT за последние сутки по часу\n" +
  "• Посмотри стакан по SOLUSDT, есть ли крупные стенки\n" +
  "• Найди топ-10 монет по суточному объёму торгов\n" +
  "• Что такое funding rate?\n" +
  "• В чём разница между спотом и фьючерсом?\n\n" +
  "Диалог ведётся с учётом истории — можно задавать уточняющие вопросы. " +
  "Подробнее о возможностях и ограничениях — /help.";

const HELP_TEXT =
  "**О проекте**\n" +
  "Я — ассистент для криптотрейдеров на локальной языковой модели: помогаю " +
  "разобраться в теории трейдинга и получать рыночные данные по криптовалютам.\n\n" +
  "**Для кого**\n" +
  "Для трейдеров и всех, кто интересуется криптовалютным рынком и хочет быстро " +
  "свериться с котировками или разобраться в термине, не открывая биржу и не гугля.\n\n" +
  "**Что умею**\n" +
  "• Отвечать на теоретические вопросы: индикаторы, ордера, риск-менеджмент, терминология.\n" +
  "• Собирать рыночные данные с Binance: текущие цены, суточные объёмы, исторические " +
  "свечи, стакан заявок, топ монет по объёму.\n" +
  "• Помнить контекст диалога — можно уточнять и продолжать разговор.\n\n" +
  "**Чего не умею**\n" +
  "• Не торгую и не выставляю ордера — только читаю открытые данные.\n" +
  "• Не работаю с вашими кошельками и биржевыми аккаунтами.\n" +
  "• Не анализирую новости и соцсети, не даю индивидуальных инвестиционных рекомендаций.\n" +
  "• Не покрываю рынки за пределами криптовалют (акции, форекс и т.п.).\n\n" +
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
    handle: (ctx) => resetConversation(ctx, START_TEXT),
  },
  {
    command: "help",
    description: "Справка по работе с ботом",
    async handle({ chatId, telegramClient }) {
      await sendSafely(telegramClient, chatId, markdownToTelegramHtml(HELP_TEXT), {
        parseMode: "HTML",
      });
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
