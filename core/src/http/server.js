import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { HttpError, unauthorized } from "./errors.js";
import { logError } from "../logger.js";

const METHODS_WITH_BODY = new Set(["POST", "PUT", "PATCH"]);

/** Заголовок с общим секретом между Core и адаптерами. */
export const AUTH_HEADER = "x-core-token";

/**
 * Сравнение общего секрета за постоянное время.
 *
 * Обычное `!==` останавливается на первом несовпавшем байте, и время ответа
 * тем самым зависит от того, сколько знаков угадано. По одному запросу этого
 * не измерить, но секрет здесь длинный и живёт долго, а подобрать его так
 * можно за линейное число попыток вместо перебора.
 *
 * Длина при этом не тайна: `timingSafeEqual` требует одинаковых буферов и на
 * разной длине бросает, поэтому её сверяем заранее и обычным сравнением.
 *
 * @param {unknown} provided что прислали в заголовке
 * @param {string} expected что настроено у нас
 */
export function secretMatches(provided, expected) {
  if (typeof provided !== "string") return false;

  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * HTTP-сервер оркестратора на встроенном `node:http` — без внешних
 * зависимостей, как и в адаптере. Занимается только транспортом: разбор тела,
 * маршрутизация, единый формат ошибок. Доменной логики здесь нет.
 *
 * @param {{
 *   router: ReturnType<typeof import("./router.js").createRouter>,
 *   maxBodyBytes?: number,
 *   authToken?: string,
 * }} params `authToken` — общий секрет; если не задан, проверка выключена
 *   (удобно для локальной разработки, но в compose его стоит задать).
 */
export function createServer({ router, maxBodyBytes = 64 * 1024, authToken }) {
  return http.createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, "http://core.local");

      // /health намеренно открыт: он нужен healthcheck'у контейнера,
      // а секретов не раскрывает.
      if (authToken && pathname.startsWith("/v1/") && !secretMatches(req.headers[AUTH_HEADER], authToken)) {
        throw unauthorized("Неверный или отсутствующий заголовок X-Core-Token.");
      }

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
        // Дальше не читаем: копить мы перестали и так, но без паузы остаток
        // тела продолжал бы литься в сокет и вычитываться в никуда. Пауза
        // включает встречное давление TCP — отправитель упрётся сам. Рвать
        // соединение здесь нельзя: ответ 413 уходит по нему же, и клиент
        // увидел бы обрыв вместо внятного кода.
        req.pause();
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
