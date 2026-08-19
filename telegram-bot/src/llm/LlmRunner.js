/**
 * Контракт для интеграций с локальными LLM-раннерами (Ollama, LM Studio и т.д.).
 * Каждый вызов generate() независим — раннер не хранит историю сообщений.
 *
 * @typedef {Object} LlmRunner
 * @property {(prompt: string) => Promise<string>} generate
 *   Отправляет prompt в LLM и возвращает текст ответа модели.
 */
