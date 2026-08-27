import { log, logError } from "../logger.js";
import { markdownToTelegramHtml } from "../telegram/markdown.js";

/**
 * Обрабатывает одно входящее текстовое сообщение в рамках текущей сессии
 * диалога чата: сохраняет сообщение пользователя в SQLite, передаёт модели
 * всю историю сообщений сессии, сохраняет ответ и отслеживает размер
 * контекстного окна (в токенах, по данным Ollama).
 *
 * @param {{
 *   chatId: number|string,
 *   text: string,
 *   telegramClient: import("../telegram/client.js").TelegramClient,
 *   llmRunner: import("../llm/LlmRunner.js").LlmRunner,
 *   chatRepository: import("../db/chatRepository.js").ChatRepository,
 *   contextWindowTokens: number,
 * }} params
 */
export async function handleMessage({
  chatId,
  text,
  telegramClient,
  llmRunner,
  chatRepository,
  contextWindowTokens,
}) {
  const startedAt = Date.now();
  const session = chatRepository.getOrCreateActiveSession(chatId);

  if (session.totalTokens >= contextWindowTokens) {
    log(
      `[chat ${chatId}] Лимит контекстного окна уже достигнут ` +
        `(${session.totalTokens}/${contextWindowTokens} токенов) — запрос отклонён.`,
    );
    await sendWarning(
      telegramClient,
      chatId,
      `Контекстное окно текущего диалога заполнено (${contextWindowTokens} токенов). ` +
        `Начните новый диалог командой /new, чтобы продолжить общение.`,
    );
    return;
  }

  log(`[chat ${chatId}] Новый запрос получен (${text.length} симв.), обращаюсь к LLM...`);
  chatRepository.addMessage(session.id, "user", text);

  try {
    const messages = chatRepository.getMessages(session.id);
    const { content, promptTokens, completionTokens } = await llmRunner.chat(messages);
    const totalTokens = promptTokens + completionTokens;

    chatRepository.addMessage(session.id, "assistant", content);
    chatRepository.setSessionTokens(session.id, totalTokens);

    await telegramClient.sendMessage({
      chatId,
      text: markdownToTelegramHtml(content),
      parseMode: "HTML",
    });
    log(
      `[chat ${chatId}] Запрос успешно обработан за ${Date.now() - startedAt} мс ` +
        `(контекст: ${totalTokens}/${contextWindowTokens} токенов).`,
    );

    if (totalTokens >= contextWindowTokens) {
      await sendWarning(
        telegramClient,
        chatId,
        `Контекстное окно диалога заполнено (${totalTokens}/${contextWindowTokens} токенов). ` +
          `Для продолжения общения начните новый диалог командой /new.`,
      );
    }
  } catch (error) {
    logError(`[chat ${chatId}] Ошибка обработки запроса за ${Date.now() - startedAt} мс:`, error);
    await sendWarning(
      telegramClient,
      chatId,
      "Произошла ошибка при обращении к модели. Попробуйте ещё раз позже.",
    );
  }
}

async function sendWarning(telegramClient, chatId, text) {
  await telegramClient.sendMessage({ chatId, text }).catch((error) => {
    logError(`[chat ${chatId}] Не удалось отправить сообщение пользователю:`, error);
  });
}
