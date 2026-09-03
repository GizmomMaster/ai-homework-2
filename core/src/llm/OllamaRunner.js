import { LLM_ERROR, LlmError, THINK_OMIT } from "./LlmRunner.js";
import { badResponseMessage } from "./badResponse.js";
import { stripThinking } from "./stripThinking.js";

/**
 * Догадка о причине нечитаемого ответа Ollama. Тело ответа и размер запроса
 * едут рядом, см. {@link badResponseMessage}.
 */
export function diagnoseOllama(data) {
  if (data?.error !== undefined) {
    return "Ollama вернула ошибку в теле ответа при статусе 200.";
  }
  // Ollama сообщает причину остановки отдельным полем, и «length» здесь
  // означает, что генерация упёрлась в предел, а не завершилась сама.
  if (data?.done_reason === "length") {
    return "Генерация оборвана по длине (done_reason=length) — промпт или ответ не помещаются в num_ctx.";
  }
  if (data?.message && data.message.content === null) {
    return "Поле message.content пустое (null).";
  }
  return "В ответе нет message.content.";
}

/** @typedef {import("./LlmRunner.js").LlmRunner} LlmRunner */
/** @typedef {import("./LlmRunner.js").ChatMessage} ChatMessage */
/** @typedef {import("./LlmRunner.js").ChatOptions} ChatOptions */
/** @typedef {import("./LlmRunner.js").ChatResult} ChatResult */

/**
 * Реализация LlmRunner поверх Ollama HTTP API (эндпоинт /api/chat).
 * Используется /api/chat, а не /api/generate: позволяет передать модели
 * полную историю сессии и получить честную статистику по токенам
 * (`prompt_eval_count`/`eval_count`) для отслеживания контекстного окна.
 * @implements {LlmRunner}
 */
export class OllamaRunner {
  /**
   * @param {{
   *   baseUrl: string,
   *   model: string,
   *   numCtx?: number,
   *   timeoutMs?: number,
   *   think?: boolean|"omit",
   * }} options
   *   `think` задаёт режим размышления по умолчанию для всех вызовов;
   *   отдельный вызов может его переопределить.
   */
  constructor({ baseUrl, model, numCtx, timeoutMs, think = false }) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.model = model;
    this.numCtx = numCtx;
    this.timeoutMs = timeoutMs;
    this.think = think;
  }

  /**
   * @param {ChatMessage[]} messages
   * @param {ChatOptions} [options]
   * @returns {Promise<ChatResult>}
   */
  async chat(messages, { format, think = this.think, temperature } = {}) {
    // Ollama складывает настройки генерации в один объект options; собираем
    // его из того, что задано, чтобы не отправлять пустой.
    const options = {
      ...(this.numCtx ? { num_ctx: this.numCtx } : {}),
      ...(temperature === undefined ? {} : { temperature }),
    };

    let response;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: false,
          // Строка "json" — просто просьба вернуть JSON, объект — JSON Schema,
          // которая ограничивает генерацию грамматикой.
          ...(format ? { format } : {}),
          // Модели без поддержки размышления отвергают запрос с этим полем,
          // поэтому его можно полностью убрать значением "omit".
          ...(think === THINK_OMIT ? {} : { think }),
          // Без явного num_ctx Ollama берёт контекст модели по умолчанию
          // (часто заметно меньше нашего лимита) и молча обрезает старые
          // сообщения истории — счётчик токенов тогда не растёт до лимита,
          // а колеблется. Задаём num_ctx = наш лимит.
          ...(Object.keys(options).length > 0 ? { options } : {}),
        }),
        // Без таймаута зависший запрос держал бы задание в работе бессрочно.
        signal: this.timeoutMs ? AbortSignal.timeout(this.timeoutMs) : undefined,
      });
    } catch (error) {
      if (error.name === "TimeoutError" || error.name === "AbortError") {
        throw new LlmError(
          LLM_ERROR.timeout,
          `Ollama не ответила за ${this.timeoutMs} мс. Возможно, модель слишком тяжёлая ` +
            `для этой машины или значение OLLAMA_TIMEOUT_MS слишком мало.`,
        );
      }
      throw new LlmError(
        LLM_ERROR.unavailable,
        `Не удалось подключиться к Ollama по адресу ${this.baseUrl}. ` +
          `Убедитесь, что Ollama запущена. Причина: ${error.message}`,
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new LlmError(
        LLM_ERROR.unavailable,
        `Ollama вернула ошибку ${response.status} ${response.statusText}: ${text}`,
      );
    }

    const data = await response.json();
    if (!data.message || typeof data.message.content !== "string") {
      throw new LlmError(
        LLM_ERROR.badResponse,
        badResponseMessage({
          vendor: "Ollama",
          hint: diagnoseOllama(data),
          data,
          messages,
          format,
        }),
      );
    }

    const { content, reasoningTokens } = stripThinking(data.message.content);
    if (!content) {
      // Пустой ответ ничем не поможет ни пользователю, ни планировщику: чаще
      // всего это значит, что модель израсходовала всю генерацию на
      // размышление и не дошла до ответа.
      throw new LlmError(
        LLM_ERROR.badResponse,
        badResponseMessage({
          vendor: "Ollama",
          hint:
            "Модель вернула пустой ответ — возможно, генерация ушла целиком в блок " +
            `размышления. Сгенерировано токенов: ${data.eval_count ?? "неизвестно"}.`,
          data,
          messages,
          format,
        }),
      );
    }

    return {
      content,
      promptTokens: data.prompt_eval_count ?? 0,
      completionTokens: data.eval_count ?? 0,
      reasoningTokens,
    };
  }
}
