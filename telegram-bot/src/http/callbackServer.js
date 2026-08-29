import http from "node:http";
import { logError } from "../logger.js";

const MAX_BODY_BYTES = 256 * 1024;
/** Сколько jobId помним, чтобы отсеивать повторные доставки. */
const SEEN_JOBS_LIMIT = 1000;

/**
 * Приёмник готовых ответов от Core.
 *
 * Отвечает 200 только если сообщение действительно ушло пользователю: на
 * ошибку Core повторит доставку. Поэтому здесь важно не глотать исключения.
 *
 * @param {{
 *   path: string,
 *   onReply: (payload: object) => Promise<void>,
 *   authToken?: string,
 * }} params `authToken` — общий с Core секрет; если не задан, проверка выключена.
 */
export function createCallbackServer({ path, onReply, authToken }) {
  /** @type {Set<string>} обработанные задания — защита от повторной доставки */
  const seenJobs = new Set();

  return http.createServer((req, res) => {
    if (req.method !== "POST" || new URL(req.url, "http://adapter.local").pathname !== path) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    // «Ответ модели» может прислать кто угодно, кто дотянулся до порта, —
    // без секрета бот отправил бы это пользователю от своего имени.
    if (authToken && req.headers["x-core-token"] !== authToken) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    readBody(req)
      .then(async (payload) => {
        if (typeof payload?.jobId !== "string" || typeof payload?.externalId !== "string") {
          sendJson(res, 400, { error: "invalid_payload" });
          return;
        }

        // Промежуточный статус ("прогресс") по одному jobId приходит много
        // раз подряд — это не повторная доставка, а разные события. Защита
        // от дублей нужна только терминальным статусам (доставка ответа
        // повторяется Core при сбое, и вот её как раз нельзя проиграть дважды).
        const isProgress = payload.status === "progress";

        if (!isProgress && seenJobs.has(payload.jobId)) {
          sendJson(res, 200, { received: true, duplicate: true });
          return;
        }

        await onReply(payload);

        if (!isProgress) remember(seenJobs, payload.jobId);
        sendJson(res, 200, { received: true });
      })
      .catch((error) => {
        if (error.badRequest) {
          // Повтор такого запроса ничего не изменит — не просим Core пытаться снова.
          sendJson(res, 400, { error: "invalid_payload" });
          return;
        }
        logError("Не удалось обработать ответ от Core:", error);
        // 5xx — просим Core повторить доставку позже.
        sendJson(res, 500, { error: "delivery_failed" });
      });
  });
}

/** Множество с ограниченным размером: выбрасываем самые старые записи. */
function remember(set, value) {
  set.add(value);
  if (set.size > SEEN_JOBS_LIMIT) {
    const oldest = set.values().next().value;
    set.delete(oldest);
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        reject(badRequest("Тело запроса слишком большое."));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(badRequest("Тело запроса — не валидный JSON."));
      }
    });

    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

/** Ошибка в самом запросе: повторять его бессмысленно, отвечаем 400. */
function badRequest(message) {
  const error = new Error(message);
  error.badRequest = true;
  return error;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}
