/**
 * Обрабатывает одно входящее текстовое сообщение: отправляет его в LLM
 * и пересылает ответ обратно в чат. Никакого состояния между вызовами
 * не хранится — каждое сообщение обрабатывается независимо.
 *
 * @param {{
 *   chatId: number|string,
 *   text: string,
 *   telegramClient: import("../telegram/client.js").TelegramClient,
 *   llmRunner: import("../llm/LlmRunner.js").LlmRunner,
 * }} params
 */
export async function handleMessage({ chatId, text, telegramClient, llmRunner }) {
  const startedAt = Date.now();
  console.log(
    `[${new Date(startedAt).toISOString()}] [chat ${chatId}] Новый запрос получен (${text.length} симв.), обращаюсь к LLM...`,
  );

  try {
    const reply = await llmRunner.generate(text);
    await telegramClient.sendMessage({ chatId, text: reply });
    console.log(
      `[${new Date().toISOString()}] [chat ${chatId}] Запрос успешно обработан за ${Date.now() - startedAt} мс.`,
    );
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] [chat ${chatId}] Ошибка обработки запроса за ${Date.now() - startedAt} мс:`,
      error,
    );
    await telegramClient
      .sendMessage({
        chatId,
        text: "Произошла ошибка при обращении к модели. Попробуйте ещё раз позже.",
      })
      .catch((sendError) => {
        console.error(
          `[${new Date().toISOString()}] [chat ${chatId}] Не удалось отправить сообщение об ошибке пользователю:`,
          sendError,
        );
      });
  }
}
