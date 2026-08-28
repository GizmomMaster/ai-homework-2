import { LLM_ERROR, LlmError } from "../llm/LlmRunner.js";

/**
 * Каркас агента, от которого нужен разбор запроса, а не текст ответа:
 * маршрутизатор, планировщик и всё, что придёт следом.
 *
 * Три решения зашиты здесь, а не в каждом агенте:
 *
 * 1. **Ответ ограничен JSON Schema.** Схема уходит в раннер и ограничивает
 *    генерацию грамматикой, поэтому структурно неверный ответ и значение вне
 *    перечисления становятся невозможны, а не маловероятны. На замере
 *    маршрутизатора (docs/router-eval-results.md) это дало 84 разбираемых
 *    ответа из 84 на двух моделях — поэтому повтора при невалидном JSON тут
 *    нет: он прикрывал бы случай, которого схема не допускает.
 * 2. **Температура 0.** Один и тот же вопрос обязан попадать в одну и ту же
 *    ветку. Для генерации текста ответа ноль, наоборот, вреден — там свой
 *    агент со своими настройками.
 * 3. **Системное сообщение не хранится.** Оно подставляется перед каждым
 *    обращением, в историю диалога не попадает и модели в следующих репликах
 *    не показывается.
 */
export class JsonAgent {
  /**
   * @param {{
   *   llmRunner: import("../llm/LlmRunner.js").LlmRunner,
   *   systemPrompt: string,
   *   schema: object,
   *   validate?: (value: unknown) => boolean,
   *   temperature?: number,
   * }} deps `validate` — проверка обязательных полей поверх схемы: она
   *   защищает от раннера, который схему не поддерживает.
   */
  constructor({ llmRunner, systemPrompt, schema, validate, temperature = 0 }) {
    this.llmRunner = llmRunner;
    this.systemPrompt = systemPrompt;
    this.schema = schema;
    this.validate = validate;
    this.temperature = temperature;
  }

  /**
   * @param {Array<{ role: string, content: string }>} messages реплики без
   *   системного сообщения — оно добавляется здесь.
   * @returns {Promise<{ value: object, usage: { promptTokens: number, completionTokens: number } }>}
   * @throws {LlmError} `llm_bad_response`, если ответ не разобрался.
   */
  async run(messages) {
    const result = await this.llmRunner.chat(
      [{ role: "system", content: this.systemPrompt }, ...messages],
      { format: this.schema, temperature: this.temperature },
    );

    let value;
    try {
      value = JSON.parse(result.content);
    } catch {
      throw new LlmError(
        LLM_ERROR.badResponse,
        `Ответ агента не разобрался как JSON: ${preview(result.content)}`,
      );
    }

    if (this.validate && !this.validate(value)) {
      throw new LlmError(
        LLM_ERROR.badResponse,
        `Ответ агента не содержит обязательных полей: ${preview(result.content)}`,
      );
    }

    return {
      value,
      usage: {
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
      },
    };
  }
}

/** Обрезка для сообщения об ошибке: целиком ответ в лог тащить незачем. */
function preview(content, limit = 200) {
  return content.length > limit ? `${content.slice(0, limit)}…` : content;
}
