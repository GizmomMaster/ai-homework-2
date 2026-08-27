import { log, logError } from "../logger.js";

/**
 * Обрабатывает задания и доставляет результаты адаптерам.
 *
 * Владеет долговечностью: запись обмена в историю и перевод задания в
 * терминальный статус идут одной транзакцией, поэтому падение процесса
 * не может ни потерять реплику, ни заставить переспросить модель дважды.
 * Задания, застрявшие в `running`, при старте возвращаются в очередь —
 * это безопасно ровно потому, что `running` означает «не закоммичено ничего».
 */
export class JobRunner {
  #stopped = true;
  #loopPromise = null;
  #wake = null;
  #timer = null;

  /**
   * @param {{
   *   db: import("better-sqlite3").Database,
   *   chatRepository: import("../db/chatRepository.js").ChatRepository,
   *   jobRepository: import("../db/jobRepository.js").JobRepository,
   *   dialogService: import("../domain/DialogService.js").DialogService,
   *   callbackDelivery: import("./CallbackDelivery.js").CallbackDelivery,
   *   pollIntervalMs?: number,
   *   deliveryMaxAttempts?: number,
   *   deliveryBackoffMs?: number,
   * }} deps
   */
  constructor({
    db,
    chatRepository,
    jobRepository,
    dialogService,
    callbackDelivery,
    pollIntervalMs = 500,
    deliveryMaxAttempts = 6,
    deliveryBackoffMs = 2000,
  }) {
    this.db = db;
    this.chatRepository = chatRepository;
    this.jobRepository = jobRepository;
    this.dialogService = dialogService;
    this.callbackDelivery = callbackDelivery;
    this.pollIntervalMs = pollIntervalMs;
    this.deliveryMaxAttempts = deliveryMaxAttempts;
    this.deliveryBackoffMs = deliveryBackoffMs;

    // Запись истории + смена статуса задания как одно целое.
    this.commitOutcome = db.transaction((job, outcome) => {
      if (outcome.historyEntry) {
        const { sessionId, userText, assistantText, totalTokens } = outcome.historyEntry;
        this.chatRepository.appendExchange(sessionId, userText, assistantText, totalTokens);
      }
      this.jobRepository.finish(job.id, outcome);
    });
  }

  /** Восстанавливает незавершённое после прошлого запуска и запускает цикл. */
  start() {
    if (!this.#stopped) return;
    this.#stopped = false;

    const requeued = this.jobRepository.requeueStale();
    if (requeued > 0) {
      log(`Возвращено в очередь после перезапуска: ${requeued} заданий.`);
    }

    this.#loopPromise = this.#loop();
  }

  /** Досматривает текущую итерацию и останавливается. */
  async stop() {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#wakeUp();
    await this.#loopPromise;
    this.#loopPromise = null;
  }

  /** Сообщает, что появилась работа, — чтобы не ждать конца паузы. */
  wake() {
    this.#wakeUp();
  }

  async #loop() {
    while (!this.#stopped) {
      let worked = false;
      try {
        worked = await this.#tick();
      } catch (error) {
        logError("Ошибка в цикле обработки заданий:", error);
      }
      if (!worked && !this.#stopped) {
        await this.#sleep(this.pollIntervalMs);
      }
    }
  }

  /** @returns {Promise<boolean>} была ли сделана работа */
  async #tick() {
    let worked = false;

    const job = this.jobRepository.nextQueued();
    if (job) {
      await this.#processJob(job);
      worked = true;
    }

    if (await this.#deliverPending()) worked = true;

    return worked;
  }

  async #processJob(job) {
    const startedAt = Date.now();
    this.jobRepository.markRunning(job.id);

    const outcome = await this.dialogService.process({
      conversationId: job.conversationId,
      text: job.requestText,
    });

    this.commitOutcome(job, outcome);

    const took = Date.now() - startedAt;
    if (outcome.status === "completed") {
      log(
        `[job ${job.id}] Готово за ${took} мс ` +
          `(контекст: ${outcome.usage.totalTokens}/${outcome.usage.contextLimit} токенов).`,
      );
    } else {
      log(`[job ${job.id}] Завершено за ${took} мс со статусом ${outcome.status}: ${outcome.reason}.`);
      if (outcome.errorMessage) {
        logError(`[job ${job.id}] Причина:`, new Error(outcome.errorMessage));
      }
    }
  }

  /** @returns {Promise<boolean>} была ли попытка доставки */
  async #deliverPending() {
    const pending = this.jobRepository.pendingDelivery({
      maxAttempts: this.deliveryMaxAttempts,
    });
    if (pending.length === 0) return false;

    for (const job of pending) {
      if (this.#stopped) break;

      const conversation = this.chatRepository.findConversationById(job.conversationId);
      if (!conversation) {
        logError(
          `[job ${job.id}] Диалог ${job.conversationId} не найден, доставка невозможна.`,
          new Error("conversation not found"),
        );
        this.jobRepository.markDeliveryFailed(job.id, Date.now() + this.deliveryBackoffMs);
        continue;
      }

      const delivered = await this.callbackDelivery.deliver(job, conversation);
      if (delivered) {
        this.jobRepository.markDelivered(job.id);
        log(`[job ${job.id}] Результат доставлен адаптеру ${conversation.adapter}.`);
        continue;
      }

      // Экспоненциальная пауза: 2с, 4с, 8с… Хранится в БД, поэтому
      // переживает перезапуск и не требует таймеров в памяти.
      const delay = this.deliveryBackoffMs * 2 ** job.deliveryAttempts;
      this.jobRepository.markDeliveryFailed(job.id, Date.now() + delay);
    }

    return true;
  }

  #sleep(ms) {
    return new Promise((resolve) => {
      this.#wake = resolve;
      this.#timer = setTimeout(() => {
        this.#wake = null;
        this.#timer = null;
        resolve();
      }, ms);
    });
  }

  #wakeUp() {
    if (!this.#wake) return;
    clearTimeout(this.#timer);
    const resolve = this.#wake;
    this.#wake = null;
    this.#timer = null;
    resolve();
  }
}
