/**
 * Контракт для интеграций с локальными LLM-раннерами (Ollama, LM Studio и т.д.).
 * Раннер не хранит историю — её передаёт вызывающий код при каждом обращении,
 * чтобы модель видела контекст диалога.
 *
 * @typedef {Object} ChatMessage
 * @property {"system"|"user"|"assistant"} role
 *   `system` — инструкция агенту (маршрутизатор, планировщик и т.д.). В историю
 *   диалога системные сообщения не пишутся: их подставляет вызывающий код перед
 *   каждым обращением.
 * @property {string} content
 *
 * @typedef {Object} ChatOptions
 * @property {"json"|object} [format]
 *   Требование к формату ответа. `"json"` просит произвольный валидный JSON,
 *   объект трактуется как JSON Schema и ограничивает генерацию грамматикой —
 *   структурно неверный ответ становится невозможным, а не маловероятным.
 *   Для небольших моделей это единственный надёжный способ получить JSON.
 * @property {number} [temperature]
 *   Температура сэмплирования. Для агентов, от которых нужен разбор запроса —
 *   маршрутизатор, планировщик, — это 0: один вход обязан давать один и тот же
 *   ответ, иначе один и тот же вопрос пользователя будет то и дело попадать
 *   в разные ветки. Для генерации текста ответа ноль, наоборот, вреден.
 *   Не задана — раннер не трогает настройку и остаётся значение модели.
 * @property {boolean|"omit"} [think]
 *   Режим «размышления» для гибридных reasoning-моделей (Qwen3 и подобные).
 *   `false` — отключить, `true` — включить, `"omit"` — не передавать поле вовсе
 *   (нужно для моделей, которые размышление не поддерживают и отвергают запрос
 *   с этим параметром).
 *
 * @typedef {Object} ChatResult
 * @property {string} content Текст ответа модели.
 * @property {number} promptTokens Число токенов истории/промпта (по данным модели).
 * @property {number} completionTokens Число токенов сгенерированного ответа.
 * @property {number} [reasoningTokens]
 *   Оценка длины вырезанного блока `<think>…</think>` в токенах (см.
 *   `stripThinking`). Ни Ollama, ни LM Studio не отдают reasoning-токены
 *   отдельным полем `usage`, поэтому это оценка по длине текста, а не точное
 *   значение модели, — используется только телеметрией (core/src/telemetry).
 *
 * @typedef {Object} LlmRunner
 * @property {(messages: ChatMessage[], options?: ChatOptions) => Promise<ChatResult>} chat
 *   Отправляет историю сообщений в LLM и возвращает текст ответа вместе со
 *   статистикой использованных токенов (для отслеживания контекстного окна).
 *   При неудаче бросает {@link LlmError} с машиночитаемым кодом.
 */

/** Коды ошибок LLM, попадающие в поле `reason` задания и дальше к адаптеру. */
export const LLM_ERROR = {
  unavailable: "llm_unavailable",
  timeout: "llm_timeout",
  badResponse: "llm_bad_response",
};

/** Значение `think`, при котором поле не отправляется раннеру вообще. */
export const THINK_OMIT = "omit";

/**
 * Ошибка обращения к модели с кодом, который переживает границу сервисов:
 * адаптер по нему решает, что показать пользователю.
 */
export class LlmError extends Error {
  /**
   * @param {string} code один из {@link LLM_ERROR}
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "LlmError";
    this.code = code;
  }
}
