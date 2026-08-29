import { logError } from "../logger.js";

/**
 * Уведомляет адаптер о промежуточном статусе задания (см. `PROGRESS_STAGE`
 * в DialogService) — «что делает агент прямо сейчас», пока пользователь ждёт
 * ответ.
 *
 * В отличие от {@link import("./CallbackDelivery.js").CallbackDelivery},
 * это разовая best-effort попытка без ретраев и без учёта в БД: пропавший
 * статус — не повод задерживать или проваливать задание, следующий статус
 * (или итоговый ответ) всё равно придёт следом.
 */
export class ProgressNotifier {
  /**
   * @param {{
   *   callbackUrls: Record<string, string>,
   *   timeoutMs?: number,
   *   authToken?: string,
   *   fetchImpl?: typeof fetch,
   * }} params `callbackUrls` — тот же адрес по имени адаптера, что и у
   *   доставки финального ответа: с точки зрения адаптера это один канал
   *   событий по заданию, только с разными статусами в теле.
   */
  constructor({ callbackUrls, timeoutMs = 5000, authToken, fetchImpl = fetch }) {
    this.callbackUrls = callbackUrls;
    this.timeoutMs = timeoutMs;
    this.authToken = authToken;
    this.fetchImpl = fetchImpl;
  }

  /**
   * @param {{ id: string }} job
   * @param {{ adapter: string, externalId: string }} conversation
   * @param {{ stage: string, [key: string]: unknown }} progress
   */
  notify(job, conversation, progress) {
    const url = this.callbackUrls[conversation.adapter];
    if (!url) return; // некуда доставлять — финальный ответ столкнётся с тем же и залогирует это сам

    const payload = {
      jobId: job.id,
      adapter: conversation.adapter,
      externalId: conversation.externalId,
      status: "progress",
      progress,
    };

    // Не await: статус не должен задерживать обработку задания, а неудачу
    // некому и незачем повторять — гасим её здесь же.
    this.fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.authToken ? { "X-Core-Token": this.authToken } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.timeoutMs),
    }).catch((error) => {
      logError(`[job ${job.id}] Не удалось отправить статус прогресса адаптеру:`, error);
    });
  }
}
