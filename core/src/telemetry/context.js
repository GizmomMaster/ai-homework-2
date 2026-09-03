import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Контекст задания для телеметрии: job_id и монотонный счётчик turn_number,
 * доступные из InstrumentedLlmRunner и PlanExecutor без изменения их
 * сигнатур — оба вызываются глубоко внутри DialogService.process(), которая
 * сама jobId не знает (см. JobRunner). AsyncLocalStorage несёт эти значения
 * через весь стек вызовов одного задания так же, как это уже делает
 * core/src/logger.js для логов — без DI через конструкторы.
 */
const storage = new AsyncLocalStorage();

/**
 * Оборачивает обработку одного задания: внутри fn текущий job_id, счётчик
 * turn_number и набор уже отправленных модели строк живут в одном месте.
 *
 * @param {{ jobId: string, conversationId: number, db?: import("better-sqlite3").Database }} job
 *   `db` — куда писать телеметрию этого задания. Нужна потому, что recorder
 *   работает без инициализации на месте вызова (как logger.js), а приложений
 *   в одном процессе может оказаться несколько: без явной базы записи ушли бы
 *   в ту, чей `initTelemetry` был последним.
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
export function runInJob({ jobId, conversationId, db }, fn) {
  return storage.run({ jobId, conversationId, db, turn: 0, seen: new Set() }, fn);
}

/** База текущего задания, если оно есть. @returns {object|undefined} */
export function currentDb() {
  return storage.getStore()?.db;
}

/** Следующий номер события (LLM- или tool-вызов) в текущем задании. */
export function nextTurn() {
  const store = storage.getStore();
  if (!store) return 0;
  store.turn += 1;
  return store.turn;
}

/** @returns {string|undefined} job_id текущего задания, если он есть */
export function currentJobId() {
  return storage.getStore()?.jobId;
}

/**
 * Отмечает текст сообщения увиденным в рамках задания и сообщает, видела ли
 * модель его раньше в этом же задании. Так измеряется повторно отправляемый
 * контекст (см. §telemetry в плане реализации) без привязки к полю API,
 * которого у Ollama и LM Studio нет.
 *
 * Область действия — одно задание, а не вся сессия: этого достаточно, чтобы
 * поймать главный найденный источник дублирования (Router и Planner шлют
 * один и тот же срез истории дважды за одно задание), и не требует держать
 * неограниченно растущий набор строк на диалог.
 *
 * @param {string} content
 * @returns {boolean} было ли это сообщение уже отправлено в этом задании
 */
export function markSeen(content) {
  const store = storage.getStore();
  if (!store) return false;
  const alreadySeen = store.seen.has(content);
  store.seen.add(content);
  return alreadySeen;
}
