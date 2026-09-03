import http from "node:http";
import Database from "better-sqlite3";
import { isAbsolute, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { summary, recentJobs, jobTimeline } from "./queries.js";
import { renderSummaryPage, renderJobPage, renderNotFound } from "./render.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

const port = Number(process.env.DASHBOARD_PORT) || 8090;
const host = process.env.DASHBOARD_HOST || "0.0.0.0";
const dbPathRaw = process.env.DASHBOARD_DB_PATH || "../core/data/core.db";
const dbPath = isAbsolute(dbPathRaw) ? dbPathRaw : resolve(projectRoot, dbPathRaw);

const pricing = {
  inputPerMillion: Number(process.env.TELEMETRY_PRICE_INPUT_PER_1M ?? 3),
  outputPerMillion: Number(process.env.TELEMETRY_PRICE_OUTPUT_PER_1M ?? 15),
};

/**
 * Открывает БД лениво и заново при каждом запросе, если предыдущая попытка
 * провалилась: при первом запуске compose дашборд может стартовать раньше,
 * чем Core создаст файл БД, — сервис не должен падать из-за гонки контейнеров,
 * а должен отвечать понятной страницей и оживать сам, как только файл появится.
 */
let db;
function getDb() {
  if (db) return db;
  db = new Database(dbPath, { readonly: true, fileMustExist: true });
  return db;
}

const server = http.createServer((req, res) => {
  try {
    const { pathname } = new URL(req.url, "http://dashboard.local");

    if (pathname === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname === "/") {
      const database = getDb();
      const html = renderSummaryPage({ summary: summary(database), jobs: recentJobs(database), pricing });
      sendHtml(res, 200, html);
      return;
    }

    if (pathname === "/api/summary") {
      sendJson(res, 200, summary(getDb()));
      return;
    }

    const jobPage = pathname.match(/^\/jobs\/([^/]+)$/);
    if (jobPage) {
      const jobId = decodeURIComponent(jobPage[1]);
      const data = jobTimeline(getDb(), jobId);
      if (data.events.length === 0 && !data.job) {
        sendHtml(res, 404, renderNotFound(jobId));
        return;
      }
      sendHtml(res, 200, renderJobPage(jobId, data));
      return;
    }

    const jobApi = pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if (jobApi) {
      sendJson(res, 200, jobTimeline(getDb(), decodeURIComponent(jobApi[1])));
      return;
    }

    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    if (error.code === "SQLITE_CANTOPEN" || /unable to open database file/i.test(error.message)) {
      db = undefined;
      sendHtml(
        res,
        503,
        `<!doctype html><body style="font-family:sans-serif;padding:2rem;">
          <h1>База данных Core ещё не создана</h1>
          <p>Ожидается файл: <code>${dbPath}</code>. Страница сама заработает, как только Core обработает первое сообщение.</p>
        </body>`,
      );
      return;
    }
    console.error(`[${new Date().toISOString()}] Ошибка обработки запроса:`, error);
    sendJson(res, 500, { error: "internal_error" });
  }
});

function sendHtml(res, status, html) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

server.listen(port, host, () => {
  console.log(`[${new Date().toISOString()}] Дашборд слушает http://${host}:${port} (БД: ${dbPath})`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    server.close(() => {
      db?.close();
      process.exit(0);
    });
  });
}
