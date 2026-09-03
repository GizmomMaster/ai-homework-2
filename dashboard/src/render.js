/**
 * HTML-рендер дашборда. Инлайновые CSS/JS, без внешних зависимостей — тот же
 * минимализм, что у core/telegram-bot.
 */

const STYLE = `
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, "Segoe UI", sans-serif; margin: 0; padding: 2rem;
         background: #0f1115; color: #e6e8eb; }
  h1 { font-size: 1.4rem; margin: 0 0 0.25rem; }
  .sub { color: #9aa4b2; margin: 0 0 2rem; font-size: 0.9rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
  .card { background: #171a21; border: 1px solid #262b35; border-radius: 10px; padding: 1rem 1.25rem; }
  .card h2 { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: #9aa4b2; margin: 0 0 0.5rem; }
  .card .value { font-size: 1.6rem; font-weight: 600; }
  .card .row { display: flex; justify-content: space-between; font-size: 0.9rem; padding: 0.15rem 0; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  th, td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid #262b35; }
  th { color: #9aa4b2; font-weight: 500; }
  a { color: #7aa2ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .bar { height: 6px; border-radius: 3px; background: #262b35; overflow: hidden; margin-top: 0.3rem; }
  .bar > span { display: block; height: 100%; background: #7aa2ff; }
  .badge { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 999px; font-size: 0.75rem; }
  .badge.ok { background: #163a1f; color: #6ee787; }
  .badge.fail { background: #3a1616; color: #ff8383; }
  .timeline { border-left: 2px solid #262b35; margin-left: 0.6rem; padding-left: 1.2rem; }
  .event { margin-bottom: 1rem; position: relative; }
  .event::before { content: ""; position: absolute; left: -1.5rem; top: 0.3rem; width: 8px; height: 8px;
                    border-radius: 50%; background: #7aa2ff; }
  .event .meta { color: #9aa4b2; font-size: 0.8rem; }
  .note { color: #9aa4b2; font-size: 0.85rem; margin-top: 2rem; }
`;

function page(title, body) {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
${body}
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtInt(n) {
  return Math.round(n ?? 0).toLocaleString("ru-RU");
}
function fmtUsd(n) {
  return `$${(n ?? 0).toFixed(4)}`;
}
function fmtPct(n) {
  return `${Math.round((n ?? 0) * 100)}%`;
}

export function renderSummaryPage({ summary, jobs, pricing }) {
  const toolsRows = summary.mostExpensiveTools
    .map(
      (t) => `<tr><td>${escapeHtml(t.tool_name)}</td><td>${t.calls}</td><td>${fmtInt(t.tokens)}</td>
        <td><div class="bar"><span style="width:${Math.round(t.share * 100)}%"></span></div>${fmtPct(t.share)}</td></tr>`,
    )
    .join("");

  const jobsRows = jobs
    .map(
      (j) => `<tr>
        <td><a href="/jobs/${encodeURIComponent(j.jobId)}">${escapeHtml(j.jobId)}</a></td>
        <td>${new Date(j.startedAt).toLocaleString("ru-RU")}</td>
        <td>${j.calls}</td>
        <td>${fmtInt(j.tokens)}</td>
      </tr>`,
    )
    .join("");

  return page(
    "AI AGENT — дашборд",
    `
<h1>AI AGENT — токены и стоимость</h1>
<p class="sub">Телеметрия Core Orchestrator, read-only поверх core/data/core.db. Цена условна
  ($${pricing.inputPerMillion}/1M input, $${pricing.outputPerMillion}/1M output) — модель локальная и бесплатная,
  это ориентир «во что вылилась бы такая нагрузка на сопоставимом облачном API».</p>

<div class="grid">
  <div class="card"><h2>Заданий выполнено</h2><div class="value">${fmtInt(summary.tasksCompleted)}</div>
    <div class="row"><span>всего заданий</span><span>${fmtInt(summary.tasksTotal)}</span></div></div>

  <div class="card"><h2>Токены</h2>
    <div class="row"><span>Input</span><span>${fmtInt(summary.tokens.input)}</span></div>
    <div class="row"><span>Output</span><span>${fmtInt(summary.tokens.output)}</span></div>
    <div class="row"><span>Reasoning</span><span>${fmtInt(summary.tokens.reasoning)}</span></div>
    <div class="row"><span>Repeated (повтор)</span><span>${fmtInt(summary.tokens.repeated)}</span></div>
  </div>

  <div class="card"><h2>Условная стоимость</h2><div class="value">${fmtUsd(summary.tokens.cost)}</div></div>

  <div class="card"><h2>Среднее задание</h2>
    <div class="row"><span>Токенов</span><span>${fmtInt(summary.avgTokensPerTask)}</span></div>
    <div class="row"><span>Turn'ов</span><span>${summary.avgTurnsPerTask.toFixed(1)}</span></div>
    <div class="row"><span>Вызовов инструментов</span><span>${summary.avgToolCallsPerTask.toFixed(1)}</span></div>
  </div>

  <div class="card"><h2>Повторный контекст</h2><div class="value">${fmtPct(summary.repeatRate)}</div>
    <div class="row"><span>от входных токенов</span><span>уже отправлялись в этом же задании</span></div></div>
</div>

<div class="grid">
  <div class="card" style="grid-column: span 2;">
    <h2>Самые дорогие инструменты</h2>
    <table><thead><tr><th>Инструмент</th><th>Вызовов</th><th>Токенов вывода</th><th>Доля</th></tr></thead>
    <tbody>${toolsRows || '<tr><td colspan="4">данных пока нет</td></tr>'}</tbody></table>
  </div>
</div>

<h2 style="font-size:1rem;">Последние задания</h2>
<table><thead><tr><th>Job</th><th>Начато</th><th>Вызовов модели</th><th>Токенов</th></tr></thead>
<tbody>${jobsRows || '<tr><td colspan="4">данных пока нет</td></tr>'}</tbody></table>

<p class="note">cached_tokens у Ollama/LM Studio нет — «Repeated» здесь означает
  измеренное совпадение текста сообщений с уже отправленными в этом же задании,
  а не попадание в KV-кеш провайдера.</p>
`,
  );
}

export function renderJobPage(jobId, { job, events }) {
  const rows = events
    .map((e) => {
      if (e.type === "llm") {
        return `<div class="event">
          <div class="meta">turn ${e.turn_number} · ${escapeHtml(e.stage)} · ${escapeHtml(e.agent_id)} ·
            <span class="badge ${e.ok ? "ok" : "fail"}">${e.ok ? "ok" : escapeHtml(e.error_code ?? "fail")}</span></div>
          <strong>LLM</strong> ${escapeHtml(e.model)} —
          input ${fmtInt(e.prompt_tokens)}, output ${fmtInt(e.completion_tokens)},
          reasoning ${fmtInt(e.reasoning_tokens)}, repeated ${fmtInt(e.repeated_prompt_tokens_estimate)},
          ${fmtInt(e.latency_ms)} мс, ${fmtUsd(e.estimated_cost_usd)}
        </div>`;
      }
      return `<div class="event">
        <div class="meta">turn ${e.turn_number} · шаг ${e.step_number ?? "—"} ·
          <span class="badge ${e.ok ? "ok" : "fail"}">${e.ok ? "ok" : escapeHtml(e.error_code ?? "fail")}</span></div>
        <strong>Tool</strong> ${escapeHtml(e.tool_name)} —
        вход ${fmtInt(e.input_size)} байт, выход ${fmtInt(e.output_size)} байт
        (~${fmtInt(e.output_tokens_estimate)} токенов), ${fmtInt(e.duration_ms)} мс
      </div>`;
    })
    .join("");

  return page(
    `Task ${jobId}`,
    `
<p class="sub"><a href="/">&larr; ко всем заданиям</a></p>
<h1>Task ${escapeHtml(jobId)}</h1>
<p class="sub">${job ? `${escapeHtml(job.status)} · ${escapeHtml(job.request_text ?? "")}` : "запись задания в jobs не найдена (например, прогон token-benchmark.mjs)"}</p>
<div class="timeline">${rows || "<p>событий не найдено</p>"}</div>
`,
  );
}

export function renderNotFound(jobId) {
  return page("Не найдено", `<p class="sub"><a href="/">&larr; ко всем заданиям</a></p><h1>Задание ${escapeHtml(jobId)} не найдено</h1>`);
}
