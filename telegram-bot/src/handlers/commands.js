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
 * Приветствие. Примеров запросов здесь больше нет: они приезжают следом
 * вместе со сводкой по рынку и там привязаны к сегодняшним цифрам — «почему
 * ZEC вырос на 6%» полезнее выдуманного заранее образца.
 */
const START_TEXT =
  "Привет! Я — ассистент для криптотрейдеров: собираю рыночные данные с бирж " +
  "и отвечаю на вопросы по трейдингу.\n\n" +
  "Сейчас покажу, что было на рынке за прошедшие сутки. " +
  "Диалог ведётся с учётом истории — можно задавать уточняющие вопросы. " +
  "Подробнее о возможностях и ограничениях — /help.";

/**
 * Сводка не собралась. Это не повод обрывать знакомство с ботом: приветствие
 * уже ушло, и человеку нужно знать, что делать дальше, а не увидеть ошибку.
 */
const OVERVIEW_UNAVAILABLE_TEXT =
  "Сводку по рынку сейчас собрать не удалось — биржа или источник рейтинга не " +
  "ответили. Спрашивайте напрямую, например: «Какая сейчас цена BTC?» или " +
  "«Найди топ-10 пар по суточному объёму торгов». Сводку можно запросить " +
  "позже ещё раз командой /start.";

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

/** Статус на время сбора: минута тишины после приветствия выглядит поломкой. */
const OVERVIEW_PENDING_TEXT = "Собираю сводку по рынку…";

/**
 * Сводка по рынку вторым сообщением после приветствия.
 *
 * Отдельным сообщением, а не приклеенной к приветствию строкой, по двум
 * причинам: собирается она долго — два внешних API и вызов модели, которая
 * пишет текст, — и приветствие не должно этого ждать; а её отказ не должен
 * утащить за собой приветствие.
 *
 * Пока идёт сбор, висит статусное сообщение, и удаляется оно перед отправкой
 * результата — тем же приёмом, что и статус обработки задания (см.
 * `progressHandler`), чтобы в чате не оставалось следов ожидания.
 *
 * Текст приходит из Core в markdown — с таблицами внутри блоков кода. Это не
 * прихоть оформления: таблиц Telegram не поддерживает ни в markdown, ни в
 * HTML, и колонки держатся только на моноширинном шрифте блока `<pre>`,
 * в который `markdownToTelegramHtml` превращает ```-блок.
 */
async function sendMarketOverview({ chatId, telegramClient, coreClient }) {
  const pending = await sendPending(telegramClient, chatId);

  let overview;
  try {
    overview = await coreClient.marketOverview();
  } catch (error) {
    logError(`[chat ${chatId}] Не удалось получить сводку по рынку:`, error);
    await removePending(telegramClient, pending);
    await sendSafely(telegramClient, chatId, OVERVIEW_UNAVAILABLE_TEXT);
    return;
  }

  await removePending(telegramClient, pending);

  const text = overview?.text?.trim();
  if (!text) {
    logError(`[chat ${chatId}] Core вернул пустую сводку по рынку.`);
    await sendSafely(telegramClient, chatId, OVERVIEW_UNAVAILABLE_TEXT);
    return;
  }

  await sendSafely(telegramClient, chatId, markdownToTelegramHtml(text), { parseMode: "HTML" });
}

/**
 * Статусное сообщение — вещь необязательная: если оно не отправилось, сводку
 * это отменять не должно. Поэтому отказ гасится, а не поднимается наверх.
 */
async function sendPending(telegramClient, chatId) {
  try {
    const sent = await telegramClient.sendMessage({ chatId, text: OVERVIEW_PENDING_TEXT });
    // Идентификатор чата берём свой, а не из ответа Telegram, — как это
    // делает progressHandler: в ответе он вложен, и форма ответа тут менее
    // надёжная опора, чем то, что мы и так знаем.
    return sent?.message_id ? { chatId, messageId: sent.message_id } : undefined;
  } catch (error) {
    logError(`[chat ${chatId}] Не удалось показать статус сбора сводки:`, error);
    return undefined;
  }
}

async function removePending(telegramClient, pending) {
  if (!pending) return;
  try {
    await telegramClient.deleteMessage(pending);
  } catch (error) {
    // Не удалилось — не беда: лишняя строка в чате лучше потерянной сводки.
    logError(`[chat ${pending.chatId}] Не удалось убрать статус сбора сводки:`, error);
  }
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
    description: "Начать работу и показать сводку по рынку",
    async handle(ctx) {
      await resetConversation(ctx, START_TEXT);
      await sendMarketOverview(ctx);
    },
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
