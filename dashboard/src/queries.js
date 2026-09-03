/**
 * Агрегаты поверх телеметрии Core (llm_calls, tool_calls, jobs) — та же БД,
 * что core/src/db/database.js, дашборд открывает её только на чтение (см.
 * index.js). Схема — источник правды в core/src/db/database.js; здесь только
 * запросы, ни одна таблица дашбордом не создаётся и не пишется.
 */

/** Общая сводка: тот же набор чисел, что показывает главная страница. */
export function summary(db) {
  const jobs = db.prepare(`SELECT COUNT(*) AS total, SUM(status = 'completed') AS completed FROM jobs`).get();

  const tokens = db
    .prepare(
      `SELECT COUNT(*) AS calls,
              COALESCE(SUM(prompt_tokens), 0) AS input,
              COALESCE(SUM(completion_tokens), 0) AS output,
              COALESCE(SUM(reasoning_tokens), 0) AS reasoning,
              COALESCE(SUM(repeated_prompt_tokens_estimate), 0) AS repeated,
              COALESCE(SUM(estimated_cost_usd), 0) AS cost
       FROM llm_calls`,
    )
    .get();

  const perJob = db
    .prepare(
      `SELECT job_id, MAX(turn_number) AS turns, SUM(prompt_tokens + completion_tokens) AS tokens
       FROM llm_calls WHERE job_id IS NOT NULL GROUP BY job_id`,
    )
    .all();
  const toolCallsPerJob = db
    .prepare(`SELECT job_id, COUNT(*) AS n FROM tool_calls WHERE job_id IS NOT NULL GROUP BY job_id`)
    .all();

  const tools = db
    .prepare(
      `SELECT tool_name, COUNT(*) AS calls, COALESCE(SUM(output_tokens_estimate), 0) AS tokens
       FROM tool_calls GROUP BY tool_name ORDER BY tokens DESC`,
    )
    .all();
  const totalToolTokens = tools.reduce((sum, t) => sum + t.tokens, 0);

  return {
    tasksCompleted: jobs.completed ?? 0,
    tasksTotal: jobs.total ?? 0,
    tokens,
    avgTokensPerTask: avg(perJob, (r) => r.tokens ?? 0),
    avgTurnsPerTask: avg(perJob, (r) => r.turns ?? 0),
    avgToolCallsPerTask: avg(toolCallsPerJob, (r) => r.n),
    repeatRate: tokens.input > 0 ? tokens.repeated / tokens.input : 0,
    mostExpensiveTools: tools.map((t) => ({
      ...t,
      share: totalToolTokens > 0 ? t.tokens / totalToolTokens : 0,
    })),
  };
}

/** Последние задания — для списка на главной странице (ссылки на timeline). */
export function recentJobs(db, limit = 30) {
  return db
    .prepare(
      `SELECT job_id AS jobId, MIN(created_at) AS startedAt, COUNT(*) AS calls,
              SUM(prompt_tokens + completion_tokens) AS tokens
       FROM llm_calls WHERE job_id IS NOT NULL
       GROUP BY job_id ORDER BY startedAt DESC LIMIT ?`,
    )
    .all(limit);
}

/** События одного задания (LLM- и tool-вызовы вперемешку), в порядке turn_number. */
export function jobTimeline(db, jobId) {
  const llmCalls = db.prepare(`SELECT * FROM llm_calls WHERE job_id = ?`).all(jobId);
  const toolCalls = db.prepare(`SELECT * FROM tool_calls WHERE job_id = ?`).all(jobId);
  const job = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(jobId);

  const events = [
    ...llmCalls.map((row) => ({ type: "llm", ...row })),
    ...toolCalls.map((row) => ({ type: "tool", ...row })),
  ].sort((a, b) => a.turn_number - b.turn_number);

  return { job, events };
}

function avg(rows, select) {
  if (rows.length === 0) return 0;
  return rows.reduce((sum, row) => sum + select(row), 0) / rows.length;
}
