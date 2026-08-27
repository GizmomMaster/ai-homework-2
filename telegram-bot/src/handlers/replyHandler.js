import { markdownToTelegramHtml } from "../telegram/markdown.js";
import { log } from "../logger.js";

/**
 * Формулировки для пользователя живут здесь, а не в Core: Core присылает
 * машиночитаемый код причины, а как это назвать — забота канала. Веб-адаптеру
 * фраза про «команду /new» не подошла бы.
 *
 * @param {{ reason?: string, usage?: object }} payload
 */
function rejectionText({ reason, usage }) {
  if (reason === "context_limit") {
    const filled = usage ? ` (${usage.totalTokens}/${usage.contextLimit} токенов)` : "";
    return (
      `Контекстное окно диалога заполнено${filled}. ` +
      `Начните новый диалог командой /new, чтобы продолжить общение.`
    );
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
 * }} params
 */
export async function handleReply({ payload, telegramClient }) {
  const chatId = payload.externalId;

  if (payload.status === "completed") {
    await telegramClient.sendMessage({
      chatId,
      text: markdownToTelegramHtml(payload.reply.text),
      parseMode: "HTML",
    });
    log(`[job ${payload.jobId}] Ответ доставлен в чат ${chatId}.`);

    // Ответ прошёл, но контекст заполнился — предупреждаем сразу, чтобы
    // следующий вопрос не упёрся в отказ без объяснений.
    if (isContextFull(payload.usage)) {
      const { totalTokens, contextLimit } = payload.usage;
      await telegramClient.sendMessage({
        chatId,
        text:
          `Контекстное окно диалога заполнено (${totalTokens}/${contextLimit} токенов). ` +
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
