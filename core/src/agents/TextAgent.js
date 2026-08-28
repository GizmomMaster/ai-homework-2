/**
 * Каркас агента, от которого нужен текст для пользователя, а не разбор
 * запроса. Парный к {@link import("./JsonAgent.js").JsonAgent}, и отличия от
 * него ровно те, что диктует задача:
 *
 * * **Ответ не ограничен схемой.** Здесь нужна связная речь, и грамматика
 *   JSON ей только мешала бы.
 * * **Температура не нулевая.** Ноль хорош для классификатора, но делает
 *   прозу однообразной и склонной к повторам.
 *
 * Общее с JsonAgent одно, и оно важно: системное сообщение подставляется
 * перед каждым обращением и в историю диалога не попадает — иначе модель
 * увидела бы собственную инструкцию как реплику и начала бы ей подражать.
 */
export class TextAgent {
  /**
   * @param {{
   *   llmRunner: import("../llm/LlmRunner.js").LlmRunner,
   *   systemPrompt: string,
   *   temperature?: number,
   * }} deps
   */
  constructor({ llmRunner, systemPrompt, temperature }) {
    this.llmRunner = llmRunner;
    this.systemPrompt = systemPrompt;
    this.temperature = temperature;
  }

  /**
   * @param {Array<{ role: string, content: string }>} messages реплики без
   *   системного сообщения — оно добавляется здесь.
   * @returns {Promise<import("../llm/LlmRunner.js").ChatResult>}
   */
  async answer(messages) {
    return this.llmRunner.chat([{ role: "system", content: this.systemPrompt }, ...messages], {
      temperature: this.temperature,
    });
  }
}
