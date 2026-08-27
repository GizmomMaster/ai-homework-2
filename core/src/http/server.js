import http from "node:http";
import { HttpError } from "./errors.js";
import { logError } from "../logger.js";

const METHODS_WITH_BODY = new Set(["POST", "PUT", "PATCH"]);

/**
 * HTTP-сервер оркестратора на встроенном `node:http` — без внешних
 * зависимостей, как и в адаптере. Занимается только транспортом: разбор тела,
 * маршрутизация, единый формат ошибок. Доменной логики здесь нет.
 *
 * @param {{
 *   router: ReturnType<typeof import("./router.js").createRouter>,
 *   maxBodyBytes?: number,
 * }} params
 */
export function createServer({ router, maxBodyBytes = 64 * 1024 }) {
  return http.createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, "http://core.local");
      const route = router.match(req.method, pathname);

      if (!route.found) {
        throw route.pathMatched
          ? new HttpError(405, "method_not_allowed", `Метод ${req.method} не поддерживается для этого пути.`)
          : new HttpError(404, "not_found", "Неизвестный маршрут.");
      }

      const body = METHODS_WITH_BODY.has(req.method)
        ? await readJsonBody(req, maxBodyBytes)
        : {};

      const { status, json } = await route.handler({ params: route.params, body, req });
      sendJson(res, status, json);
    } catch (error) {
      sendError(res, error);
    }
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload ?? {});
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, error) {
  if (res.headersSent) {
    res.end();
    return;
  }

  if (error instanceof HttpError) {
    sendJson(res, error.status, { error: { code: error.code, message: error.message } });
    return;
  }

  // Наружу не отдаём ни стек, ни текст: это может быть что угодно вплоть до
  // деталей подключения к БД. В лог — полностью.
  logError("Необработанная ошибка при обработке запроса:", error);
  sendJson(res, 500, {
    error: { code: "internal_error", message: "Внутренняя ошибка сервиса." },
  });
}

/**
 * Читает тело запроса как JSON. Пустое тело считается пустым объектом —
 * так эндпоинты без полей (например, reset) не требуют слать `{}` руками.
 */
function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        reject(new HttpError(413, "payload_too_large", `Тело запроса больше ${maxBytes} байт.`));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (settled) return;
      settled = true;

      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (raw.length === 0) {
        resolve({});
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        reject(new HttpError(400, "invalid_request", "Тело запроса — не валидный JSON."));
        return;
      }

      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        reject(new HttpError(400, "invalid_request", "Тело запроса должно быть JSON-объектом."));
        return;
      }

      resolve(parsed);
    });

    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}
