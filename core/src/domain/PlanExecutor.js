import { executeTool } from "../tools/index.js";
import { log } from "../logger.js";

/**
 * Сколько шагов выполнять одновременно.
 *
 * Шаги независимы — ни один инструмент не принимает результат другого, — так
 * что запускать их по очереди значило бы складывать задержки сети без нужды.
 * Но и все разом отправлять не стоит: квота биржи считается на адрес, и план
 * из восьми шагов, ушедший одним залпом, — верный способ получить 429.
 */
const CONCURRENCY = 3;

/**
 * Исполнитель плана: вызывает инструменты и собирает результаты.
 *
 * Отказ шага не прерывает исполнение (решение 04 плана реализации). Модель
 * ошибётся с парой, биржа ответит 429 — отчёт из остальных шагов с честной
 * пометкой полезнее, чем «произошла ошибка» на весь запрос.
 */
export class PlanExecutor {
  /**
   * @param {{ tools: ReturnType<typeof import("../tools/index.js").createTools> }} deps
   */
  constructor({ tools }) {
    this.tools = tools;
  }

  /**
   * @param {Array<{ action?: string, toolToUse: string, parameters?: object }>} plan
   * @param {{
   *   onStep?: (step: {
   *     stepNumber: number,
   *     totalSteps: number,
   *     action: string,
   *     ok: boolean,
   *     completedCount: number,
   *   }) => void,
   * }} [options] `onStep` — промежуточный статус: вызывается по завершении
   *   каждого шага, в порядке их фактического завершения (не порядке плана —
   *   шаги идут параллельно). Не должен бросать: статус — не гарантия задания.
   * @returns {Promise<{
   *   steps: Array<{
   *     stepNumber: number,
   *     action: string,
   *     tool: string,
   *     ok: boolean,
   *     value?: object,
   *     error?: { code: string, message: string },
   *   }>,
   *   succeeded: number,
   *   failed: number,
   * }>}
   */
  async run(plan, { onStep } = {}) {
    const startedAt = Date.now();
    let completedCount = 0;

    const steps = await mapWithConcurrency(plan, CONCURRENCY, async (step, index) => {
      const stepStartedAt = Date.now();
      const outcome = await executeTool(this.tools, step.toolToUse, step.parameters ?? {});
      const took = Date.now() - stepStartedAt;

      log(
        `[шаг ${index + 1}] ${step.toolToUse}: ` +
          `${outcome.ok ? "готово" : `отказ (${outcome.error.code})`} за ${took} мс.`,
      );

      const result = {
        stepNumber: index + 1,
        action: step.action ?? step.toolToUse,
        tool: step.toolToUse,
        ...(outcome.ok ? { ok: true, value: outcome.value } : { ok: false, error: outcome.error }),
      };

      completedCount += 1;
      onStep?.({
        stepNumber: result.stepNumber,
        totalSteps: plan.length,
        action: result.action,
        ok: result.ok,
        completedCount,
      });

      return result;
    });

    const succeeded = steps.filter((s) => s.ok).length;
    log(
      `План выполнен за ${Date.now() - startedAt} мс: ` +
        `${succeeded} из ${steps.length} шагов удались.`,
    );

    return { steps, succeeded, failed: steps.length - succeeded };
  }
}

/**
 * Выполняет задачи не более `limit` одновременно, сохраняя порядок результатов.
 * Порядок важен: в отчёте шаги должны идти так же, как в плане, иначе текст
 * перестанет соответствовать тому, что просил пользователь.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;

  const lane = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}
