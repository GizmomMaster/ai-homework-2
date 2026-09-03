import { markdownToTelegramHtml } from "../telegram/markdown.js";
import { answerFooter } from "./answerFooter.js";
import { log } from "../logger.js";

/**
 * Приписывает к ответу строку с временем и токенами.
 *
 * Пустой отступ перед ней — не косметика: без пустой строки markdown склеит
 * подпись с последним абзацем ответа, и она перестанет читаться как служебная.
 */
function withFooter(text, usage) {
  const footer = answerFooter(usage);
  return footer ? `${text}\n\n${footer}` : text;
}

/**
 * Формулировки для пользователя живут здесь, а не в Core: Core присылает
 * машиночитаемый код причины, а как это назвать — забота канала. Веб-адаптеру
 * фраза про «команду /new» не подошла бы.
 *
 * @param {{ reason?: string, usage?: object }} payload
 */
function rejectionText({ reason }) {
  if (reason === "context_limit") {
    return (
      `Контекстное окно диалога заполнено. ` +
      `Начните новый диалог командой /new, чтобы продолжить общение.`
    );
  }

  // Общий отказ по скоупу (§5.2 спецификации). Отдельные формулировки для
  // торговых действий и недоступных источников появятся вместе с
  // планировщиком: сейчас их некому отличить от прочей некрипты.
  if (reason === "out_of_scope") {
    return (
      "Я специализированный ассистент для криптотрейдеров. В текущей версии " +
      "поддерживаются только сбор и анализ рыночных данных по криптовалютам: " +
      "котировки, объёмы, история торгов, стаканы. Я пока не могу выполнить этот запрос."
    );
  }

  // Задачу понял, но выполнить нечем, а объяснить своими словами планировщик
  // не смог: обычно он присылает объяснение, и тогда оно уходит репликой.
  if (reason === "task_unsupported") {
    return (
      "Такую задачу я выполнить не могу. Мне доступны только рыночные данные " +
      "с биржи: котировки, суточные объёмы, свечи и стаканы."
    );
  }

  // Сюда попадаем, только если модель не сформулировала уточняющий вопрос:
  // когда он есть, Core присылает его обычной репликой.
  if (reason === "clarification_needed") {
    return "Уточните, пожалуйста, о какой монете и какой метрике идёт речь.";
  }

  return "Запрос отклонён. Начните новый диалог командой /new.";
}

/** @param {{ totalTokens?: number, contextLimit?: number }} [usage] */
function isContextFull(usage) {
  return (
    typeof usage?.totalTokens === "number" &&
    typeof usage?.contextLimit === "number" &&
    usage.totalTokens >= usage.contextLimit
  );
}

/** @param {{ reason?: string }} payload */
function failureText({ reason }) {
  if (reason === "llm_timeout") {
    return "Модель не успела ответить за отведённое время. Попробуйте повторить вопрос или сформулировать его короче.";
  }

  // Инструмент отказал: актив вне его списка. Ограничение наше, а не биржи, —
  // и сказать об этом нужно так же прямо. Сейчас такой инструмент один:
  // расчёт RSI, поддерживающий только BTC и ETH.
  if (reason === "unsupported_asset") {
    return (
      "Пока этот расчёт поддерживается только для BTC и ETH. Для остальных монет " +
      "доступны цена, суточные объёмы, свечи и стакан."
    );
  }

  if (reason === "computation_failed") {
    return "Не удалось выполнить расчёт показателя. Попробуйте ещё раз позже.";
  }

  return "Произошла ошибка при обращении к модели. Попробуйте ещё раз позже.";
}

/**
 * Превращает результат обработки, присланный Core, в сообщение Telegram.
 *
 * Ошибки отправки намеренно **не** гасятся: callback-сервер вернёт Core
 * ошибку, и тот повторит доставку. Иначе ответ, сгенерированный за 20 секунд
 * работы модели, потерялся бы из-за одной сетевой неудачи.
 *
 * @param {{
 *   payload: object,
 *   telegramClient: import("../telegram/client.js").TelegramClient,
 *   progressTracker?: ReturnType<typeof import("./progressHandler.js").createProgressTracker>,
 * }} params
 *   `progressTracker` — убирает статусное сообщение обработки, если оно
 *   было показано пользователю (см. progressHandler.js).
 */
export async function handleReply({ payload, telegramClient, progressTracker }) {
  // Пришёл окончательный исход — статусное сообщение («Строю план...» и
  // т.п.), если оно есть, больше не нужно.
  await progressTracker?.finish(payload.jobId);

  const chatId = payload.externalId;

  if (payload.status === "completed") {
    await telegramClient.sendMessage({
      chatId,
      text: markdownToTelegramHtml(withFooter(payload.reply.text, payload.usage)),
      parseMode: "HTML",
    });
    log(`[job ${payload.jobId}] Ответ доставлен в чат ${chatId}.`);

    // Ответ прошёл, но контекст заполнился — предупреждаем сразу, чтобы
    // следующий вопрос не упёрся в отказ без объяснений.
    if (isContextFull(payload.usage)) {
      await telegramClient.sendMessage({
        chatId,
        text:
          `Контекстное окно диалога заполнено. ` +
          `Для продолжения общения начните новый диалог командой /new.`,
      });
    }
    return;
  }

  const text =
    payload.status === "rejected" ? rejectionText(payload) : failureText(payload);

  await telegramClient.sendMessage({ chatId, text });
  log(
    `[job ${payload.jobId}] В чат ${chatId} отправлено уведомление ` +
      `(${payload.status}: ${payload.reason ?? "без причины"}).`,
  );
}
