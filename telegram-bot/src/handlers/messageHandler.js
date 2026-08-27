import { log, logError } from "../logger.js";
import { markdownToTelegramHtml } from "../telegram/markdown.js";
import { sendSafely } from "../telegram/send.js";

/**
 * Обрабатывает одно входящее текстовое сообщение в рамках текущей сессии
 * диалога чата: передаёт модели историю сессии вместе с новым вопросом,
 * сохраняет обмен репликами в SQLite и отслеживает размер контекстного окна
 * (в токенах, по данным Ollama).
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
    await sendSafely(
      telegramClient,
      chatId,
      `Контекстное окно текущего диалога заполнено (${contextWindowTokens} токенов). ` +
        `Начните новый диалог командой /new, чтобы продолжить общение.`,
    );
    return;
  }

  log(`[chat ${chatId}] Новый запрос получен (${text.length} симв.), обращаюсь к LLM...`);

  let result;
  try {
    // Новое сообщение пока НЕ пишем в БД: если запрос к модели упадёт,
    // вопрос без ответа останется в истории и уедет в следующий запрос.
    const messages = [...chatRepository.getMessages(session.id), { role: "user", content: text }];
    result = await llmRunner.chat(messages);
  } catch (error) {
    logError(`[chat ${chatId}] Ошибка обращения к LLM за ${Date.now() - startedAt} мс:`, error);
    await sendSafely(
      telegramClient,
      chatId,
      "Произошла ошибка при обращении к модели. Попробуйте ещё раз позже.",
    );
    return;
  }

  const totalTokens = result.promptTokens + result.completionTokens;
  chatRepository.appendExchange(session.id, text, result.content, totalTokens);

  await sendSafely(telegramClient, chatId, markdownToTelegramHtml(result.content), {
    parseMode: "HTML",
  });
  log(
    `[chat ${chatId}] Запрос успешно обработан за ${Date.now() - startedAt} мс ` +
      `(контекст: ${totalTokens}/${contextWindowTokens} токенов).`,
  );

  if (totalTokens >= contextWindowTokens) {
    await sendSafely(
      telegramClient,
      chatId,
      `Контекстное окно диалога заполнено (${totalTokens}/${contextWindowTokens} токенов). ` +
        `Для продолжения общения начните новый диалог командой /new.`,
    );
  }
}
