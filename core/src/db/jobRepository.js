import { randomUUID } from "node:crypto";

/** Статусы задания. `queued`/`running` — рабочие, остальные терминальные. */
export const JOB_STATUS = {
  queued: "queued",
  running: "running",
  completed: "completed",
  rejected: "rejected",
  failed: "failed",
};

const TERMINAL_STATUSES = [JOB_STATUS.completed, JOB_STATUS.rejected, JOB_STATUS.failed];

/**
 * Хранилище заданий. Задание создаётся при приёме сообщения и живёт до
 * подтверждённой доставки ответа адаптеру — это и даёт устойчивость к
 * перезапуску Core.
 */
export class JobRepository {
  /**
   * @param {import("better-sqlite3").Database} db
   */
  constructor(db) {
    this.db = db;
    this.stmts = {
      insert: db.prepare(
        `INSERT INTO jobs (id, conversation_id, idempotency_key, status, request_text, created_at, updated_at)
         VALUES (@id, @conversationId, @idempotencyKey, @status, @requestText, @now, @now)`,
      ),
      findById: db.prepare(`SELECT * FROM jobs WHERE id = ?`),
      findByKey: db.prepare(`SELECT * FROM jobs WHERE idempotency_key = ?`),
      // Сортируем по rowid, а не по created_at + id: у заданий, созданных
      // в одну миллисекунду, created_at совпадает, а id — случайный UUID,
      // и очередь переставала быть FIFO. rowid — это порядок вставки.
      nextQueued: db.prepare(
        `SELECT * FROM jobs WHERE status = '${JOB_STATUS.queued}' ORDER BY rowid ASC LIMIT 1`,
      ),
      markRunning: db.prepare(
        `UPDATE jobs SET status = '${JOB_STATUS.running}', updated_at = ? WHERE id = ?`,
      ),
      finish: db.prepare(
        `UPDATE jobs
         SET status = @status, reply_text = @replyText, reason = @reason,
             usage_json = @usageJson, next_attempt_at = @now, updated_at = @now
         WHERE id = @id`,
      ),
      requeueStale: db.prepare(
        `UPDATE jobs SET status = '${JOB_STATUS.queued}', updated_at = ?
         WHERE status = '${JOB_STATUS.running}'`,
      ),
      pendingDelivery: db.prepare(
        `SELECT * FROM jobs
         WHERE delivered_at IS NULL
           AND status IN ('${TERMINAL_STATUSES.join("','")}')
           AND delivery_attempts < @maxAttempts
           AND (next_attempt_at IS NULL OR next_attempt_at <= @now)
         ORDER BY next_attempt_at ASC, rowid ASC
         LIMIT @limit`,
      ),
      markDelivered: db.prepare(
        `UPDATE jobs SET delivered_at = ?, delivery_attempts = delivery_attempts + 1, updated_at = ?
         WHERE id = ?`,
      ),
      markDeliveryFailed: db.prepare(
        `UPDATE jobs SET delivery_attempts = delivery_attempts + 1, next_attempt_at = ?, updated_at = ?
         WHERE id = ?`,
      ),
    };
  }

  /**
   * Создаёт задание либо возвращает уже существующее с тем же ключом
   * идемпотентности — повторная доставка апдейта Telegram не должна
   * порождать второй запрос к модели.
   *
   * @param {{ conversationId: number, idempotencyKey: string, requestText: string }} input
   * @returns {{ job: object, created: boolean }}
   */
  createOrGet({ conversationId, idempotencyKey, requestText }) {
    const existing = this.stmts.findByKey.get(idempotencyKey);
    if (existing) return { job: toJob(existing), created: false };

    const job = {
      id: `j_${randomUUID().replace(/-/g, "")}`,
      conversationId,
      idempotencyKey,
      status: JOB_STATUS.queued,
      requestText,
      now: Date.now(),
    };

    try {
      this.stmts.insert.run(job);
    } catch (error) {
      // Гонка двух одновременных запросов с одним ключом: UNIQUE не дал
      // вставить второй раз — значит задание уже есть, отдаём его.
      if (String(error.code).includes("SQLITE_CONSTRAINT")) {
        return { job: toJob(this.stmts.findByKey.get(idempotencyKey)), created: false };
      }
      throw error;
    }

    return { job: toJob(this.stmts.findById.get(job.id)), created: true };
  }

  /** @param {string} jobId */
  findById(jobId) {
    const row = this.stmts.findById.get(jobId);
    return row ? toJob(row) : undefined;
  }

  /** Следующее задание в очереди или `undefined`. */
  nextQueued() {
    const row = this.stmts.nextQueued.get();
    return row ? toJob(row) : undefined;
  }

  /** @param {string} jobId */
  markRunning(jobId) {
    this.stmts.markRunning.run(Date.now(), jobId);
  }

  /**
   * Переводит задание в терминальный статус.
   * @param {string} jobId
   * @param {{ status: string, replyText?: string, reason?: string, usage?: object }} result
   */
  finish(jobId, { status, replyText = null, reason = null, usage = null }) {
    this.stmts.finish.run({
      id: jobId,
      status,
      replyText,
      reason,
      usageJson: usage ? JSON.stringify(usage) : null,
      now: Date.now(),
    });
  }

  /**
   * Возвращает в очередь задания, застрявшие в `running` после падения
   * процесса. Безопасно: смена статуса на терминальный и запись обмена в
   * историю идут одной транзакцией, поэтому `running` означает, что не
   * закоммичено ничего.
   * @returns {number} сколько заданий вернулось в очередь
   */
  requeueStale() {
    return this.stmts.requeueStale.run(Date.now()).changes;
  }

  /**
   * Задания с готовым результатом, который ещё не доставлен адаптеру и
   * которым пора делать следующую попытку.
   * @param {{ maxAttempts: number, limit?: number, now?: number }} params
   */
  pendingDelivery({ maxAttempts, limit = 20, now = Date.now() }) {
    return this.stmts.pendingDelivery.all({ maxAttempts, limit, now }).map(toJob);
  }

  /** @param {string} jobId */
  markDelivered(jobId) {
    const now = Date.now();
    this.stmts.markDelivered.run(now, now, jobId);
  }

  /**
   * @param {string} jobId
   * @param {number} nextAttemptAt когда пробовать снова
   */
  markDeliveryFailed(jobId, nextAttemptAt) {
    this.stmts.markDeliveryFailed.run(nextAttemptAt, Date.now(), jobId);
  }
}

/** Строка БД → объект в терминах приложения. */
function toJob(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    requestText: row.request_text,
    replyText: row.reply_text ?? undefined,
    reason: row.reason ?? undefined,
    usage: row.usage_json ? JSON.parse(row.usage_json) : undefined,
    deliveryAttempts: row.delivery_attempts,
    nextAttemptAt: row.next_attempt_at ?? undefined,
    deliveredAt: row.delivered_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
