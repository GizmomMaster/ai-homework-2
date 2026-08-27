/**
 * Контракт для интеграций с локальными LLM-раннерами (Ollama, LM Studio и т.д.).
 * Раннер сам не хранит историю — вызывающий код (messageHandler) передаёт
 * полную историю сообщений сессии при каждом вызове, чтобы модель видела
 * контекст диалога.
 *
 * @typedef {Object} ChatMessage
 * @property {"user"|"assistant"} role
 * @property {string} content
 *
 * @typedef {Object} ChatResult
 * @property {string} content Текст ответа модели.
 * @property {number} promptTokens Число токенов истории/промпта (по данным модели).
 * @property {number} completionTokens Число токенов сгенерированного ответа.
 *
 * @typedef {Object} LlmRunner
 * @property {(messages: ChatMessage[]) => Promise<ChatResult>} chat
 *   Отправляет историю сообщений в LLM и возвращает текст ответа вместе со
 *   статистикой использованных токенов (для отслеживания контекстного окна).
 */
