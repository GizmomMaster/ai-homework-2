import { logError } from "../logger.js";

/**
 * Доставка готового результата обратно адаптеру.
 *
 * Одна попытка на вызов: повторы и паузы между ними планирует JobRunner,
 * опираясь на счётчик в БД. Так расписание переживает перезапуск Core —
 * в отличие от повторов, зашитых внутрь одного вызова.
 */
export class CallbackDelivery {
  /**
   * @param {{
   *   callbackUrls: Record<string, string>,
   *   timeoutMs?: number,
   *   fetchImpl?: typeof fetch,
   * }} params `callbackUrls` — адрес callback-эндпоинта по имени адаптера.
   */
  constructor({ callbackUrls, timeoutMs = 10000, fetchImpl = fetch }) {
    this.callbackUrls = callbackUrls;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  /**
   * @param {object} job
   * @param {{ adapter: string, externalId: string }} conversation
   * @returns {Promise<boolean>} доставлено ли
   */
  async deliver(job, conversation) {
    const url = this.callbackUrls[conversation.adapter];
    if (!url) {
      logError(
        `[job ${job.id}] Некуда доставлять ответ: не задан callback-адрес для адаптера "${conversation.adapter}".`,
        new Error("callback url not configured"),
      );
      return false;
    }

    const payload = {
      jobId: job.id,
      adapter: conversation.adapter,
      externalId: conversation.externalId,
      status: job.status,
      ...(job.replyText !== undefined ? { reply: { text: job.replyText } } : {}),
      ...(job.reason !== undefined ? { reason: job.reason } : {}),
      ...(job.usage !== undefined ? { usage: job.usage } : {}),
    };

    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        logError(
          `[job ${job.id}] Адаптер ответил ${response.status} на доставку результата.`,
          new Error(`HTTP ${response.status}`),
        );
        return false;
      }

      return true;
    } catch (error) {
      logError(`[job ${job.id}] Не удалось доставить результат адаптеру:`, error);
      return false;
    }
  }
}
