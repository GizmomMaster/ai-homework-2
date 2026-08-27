import { createRoutes } from "../src/http/routes.js";
import { createStubHandlers } from "../src/http/stubHandlers.js";
import { createServer } from "../src/http/server.js";

/**
 * Поднимает Core на случайном порту и отдаёт удобный `request`.
 * Тесты работают через настоящий HTTP, а не в обход сервера, — иначе разбор
 * тела, коды ответов и заголовки остались бы непроверенными.
 *
 * @param {{ handlers?: object, maxBodyBytes?: number }} [options]
 */
export async function startCore({ handlers, maxBodyBytes } = {}) {
  const router = createRoutes(handlers ?? createStubHandlers());
  const server = createServer({ router, maxBodyBytes });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,

    /**
     * @param {string} method
     * @param {string} path
     * @param {{ body?: unknown, rawBody?: string }} [options]
     */
    async request(method, path, { body, rawBody } = {}) {
      const hasBody = rawBody !== undefined || body !== undefined;
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: hasBody ? { "Content-Type": "application/json" } : undefined,
        body: rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined,
      });

      const text = await response.text();
      let json;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }

      return { status: response.status, json, text, headers: response.headers };
    },

    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Заглушка, всегда роняющая обработчик, — для проверки ответа 500. */
export function throwingHandlers(error = new Error("boom")) {
  const fail = async () => {
    throw error;
  };
  return { health: fail, enqueueMessage: fail, resetConversation: fail, getJob: fail };
}

/** Глушит вывод логгера на время теста, чтобы не засорять отчёт. */
export function muteConsole(t) {
  const originalError = console.error;
  const originalLog = console.log;
  console.error = () => {};
  console.log = () => {};
  t.after(() => {
    console.error = originalError;
    console.log = originalLog;
  });
}
