import { badRequest } from "./errors.js";

/**
 * Маленький маршрутизатор для шаблонов вида
 * `/v1/conversations/:adapter/:externalId/messages`.
 *
 * Отличает «такого пути нет» (404) от «путь есть, но метод другой» (405) —
 * без этого клиент не поймёт, ошибся он адресом или глаголом.
 */
export function createRouter() {
  const routes = [];

  return {
    /**
     * @param {string} method
     * @param {string} pattern сегменты, начинающиеся с `:`, становятся параметрами
     * @param {(ctx: { params: Record<string,string>, body: unknown, req: import("node:http").IncomingMessage }) => Promise<{status:number, json:unknown}>} handler
     */
    add(method, pattern, handler) {
      routes.push({ method, segments: splitPattern(pattern), handler });
      return this;
    },

    /**
     * @param {string} method
     * @param {string} pathname
     * @returns {{ found: true, handler: Function, params: Record<string,string> }
     *          | { found: false, pathMatched: boolean }}
     */
    match(method, pathname) {
      const parts = splitPath(pathname);
      let pathMatched = false;

      for (const route of routes) {
        const params = matchSegments(route.segments, parts);
        if (!params) continue;

        pathMatched = true;
        if (route.method === method) {
          return { found: true, handler: route.handler, params };
        }
      }

      return { found: false, pathMatched };
    },
  };
}

function splitPattern(pattern) {
  return pattern.split("/").filter(Boolean);
}

function splitPath(pathname) {
  return pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        // %ZZ и подобное — это ошибка клиента, а не повод уронить процесс
        throw badRequest("Некорректная процентная кодировка в пути запроса.");
      }
    });
}

function matchSegments(segments, parts) {
  if (segments.length !== parts.length) return null;

  const params = {};
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (segment.startsWith(":")) {
      params[segment.slice(1)] = parts[i];
      continue;
    }
    if (segment !== parts[i]) return null;
  }
  return params;
}
