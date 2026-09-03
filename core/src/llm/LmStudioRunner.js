import { LLM_ERROR, LlmError } from "./LlmRunner.js";
import { badResponseMessage } from "./badResponse.js";
import { stripThinking } from "./stripThinking.js";

/** @typedef {import("./LlmRunner.js").LlmRunner} LlmRunner */
/** @typedef {import("./LlmRunner.js").ChatMessage} ChatMessage */
/** @typedef {import("./LlmRunner.js").ChatOptions} ChatOptions */
/** @typedef {import("./LlmRunner.js").ChatResult} ChatResult */

/**
 * Реализация LlmRunner поверх локального сервера LM Studio — он говорит
 * OpenAI-совместимым HTTP API (эндпоинт `/v1/chat/completions`), поэтому
 * формат запроса и ответа отличается от Ollama:
 *
 * - счётчики токенов приезжают в `usage.prompt_tokens`/`usage.completion_tokens`,
 *   а не в `prompt_eval_count`/`eval_count`;
 * - температура — поле верхнего уровня, а не вложенный объект `options`;
 * - JSON Schema передаётся как `response_format: { type: "json_schema", ... }`
 *   (структурный вывод), а не отдельным полем `format`.
 *
 * У LM Studio нет запроса-уровневого аналога `num_ctx`: длина контекста
 * модели задаётся при её загрузке (вкладка Developer в приложении или
 * `lms load --context-length`), поэтому раннер её не принимает — см.
 * LMSTUDIO_* в core/.env.example.
 *
 * `think` тоже не принимается: в OpenAI-совместимом API LM Studio нет
 * стандартизованного поля для переключения размышления (в отличие от
 * Ollama-специфичного `think`). Если модель размышляющая и пишет блок
 * `<think>…</think>` в текст ответа, {@link stripThinking} вырежет его так
 * же, как для Ollama, — независимо от того, включено размышление или нет.
 * @implements {LlmRunner}
 */
export class LmStudioRunner {
  /**
   * @param {{ baseUrl: string, model: string, timeoutMs?: number }} options
   */
  constructor({ baseUrl, model, timeoutMs }) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  /**
   * @param {ChatMessage[]} messages
   * @param {ChatOptions} [options]
   * @returns {Promise<ChatResult>}
   */
  async chat(messages, { format, temperature } = {}) {
    let response;
    try {
      response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: false,
          ...(temperature === undefined ? {} : { temperature }),
          ...(format ? { response_format: toResponseFormat(format) } : {}),
        }),
        // Без таймаута зависший запрос держал бы задание в работе бессрочно.
        signal: this.timeoutMs ? AbortSignal.timeout(this.timeoutMs) : undefined,
      });
    } catch (error) {
      if (error.name === "TimeoutError" || error.name === "AbortError") {
        throw new LlmError(
          LLM_ERROR.timeout,
          `LM Studio не ответила за ${this.timeoutMs} мс. Возможно, модель слишком тяжёлая ` +
            `для этой машины или значение LMSTUDIO_TIMEOUT_MS слишком мало.`,
        );
      }
      throw new LlmError(
        LLM_ERROR.unavailable,
        `Не удалось подключиться к LM Studio по адресу ${this.baseUrl}. ` +
          `Убедитесь, что в LM Studio запущен локальный сервер (вкладка Developer → ` +
          `Status: Running). Причина: ${error.message}`,
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new LlmError(
        LLM_ERROR.unavailable,
        `LM Studio вернула ошибку ${response.status} ${response.statusText}: ${text}`,
      );
    }

    const data = await response.json();
    const message = data.choices?.[0]?.message;
    if (!message || typeof message.content !== "string") {
      throw new LlmError(
        LLM_ERROR.badResponse,
        badResponseMessage({
          vendor: "LM Studio",
          hint: diagnoseLmStudio(data),
          data,
          messages,
          format,
        }),
      );
    }

    const { content, reasoningTokens } = stripThinking(message.content);
    if (!content) {
      // Пустой ответ ничем не поможет ни пользователю, ни планировщику: чаще
      // всего это значит, что модель израсходовала всю генерацию на
      // размышление и не дошла до ответа.
      throw new LlmError(
        LLM_ERROR.badResponse,
        badResponseMessage({
          vendor: "LM Studio",
          hint:
            "Модель вернула пустой ответ — возможно, генерация ушла целиком в блок " +
            `размышления. Сгенерировано токенов: ${data.usage?.completion_tokens ?? "неизвестно"}.`,
          data,
          messages,
          format,
        }),
      );
    }

    return {
      content,
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      reasoningTokens,
    };
  }
}

/**
 * Догадка о причине нечитаемого ответа. Именно догадка — тело ответа и
 * размер запроса едут рядом, см. {@link badResponseMessage}.
 *
 * @param {unknown} data разобранное тело ответа
 */
export function diagnoseLmStudio(data) {
  // LM Studio умеет ответить 200 с телом-ошибкой: до проверки response.ok
  // дело в таком случае не доходит, и HTTP-код ничего не подсказывает.
  if (data?.error !== undefined) {
    return "LM Studio вернула ошибку в теле ответа при статусе 200.";
  }

  if (Array.isArray(data?.choices) && data.choices.length === 0) {
    return (
      "Пустой список choices — генерация не началась. Стоит проверить длину " +
      "контекста, заданную при загрузке модели: промпт длиннее неё не " +
      "поместится, а запросом эту длину не переопределить."
    );
  }

  const message = data?.choices?.[0]?.message;
  if (message && typeof message.reasoning_content === "string") {
    return (
      "Модель отдала размышление отдельным полем reasoning_content, а content " +
      "пуст — вся генерация ушла в рассуждение."
    );
  }

  return "В ответе нет choices[0].message.content.";
}

/**
 * `format` в контракте LlmRunner — это либо строка "json" (произвольный
 * JSON), либо объект JSON Schema (ограничивает генерацию грамматикой).
 * OpenAI-совместимый API LM Studio ожидает то же самое, но обёрнутым в
 * `response_format`.
 */
function toResponseFormat(format) {
  if (format === "json") return { type: "json_object" };
  return { type: "json_schema", json_schema: { name: "response", strict: true, schema: format } };
}
