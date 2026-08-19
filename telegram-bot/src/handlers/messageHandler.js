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
  try {
    const reply = await llmRunner.generate(text);
    await telegramClient.sendMessage({ chatId, text: reply });
  } catch (error) {
    console.error(`Ошибка обработки сообщения от чата ${chatId}:`, error);
    await telegramClient
      .sendMessage({
        chatId,
        text: "Произошла ошибка при обращении к модели. Попробуйте ещё раз позже.",
      })
      .catch((sendError) => {
        console.error("Не удалось отправить сообщение об ошибке пользователю:", sendError);
      });
  }
}
