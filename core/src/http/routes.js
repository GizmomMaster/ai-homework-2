import { createRouter } from "./router.js";
import { requireString } from "./errors.js";

/** Предел длины одного сообщения; отсекается до попадания в очередь. */
export const MAX_TEXT_LENGTH = 8000;

/**
 * Таблица маршрутов и валидация контракта. Обработчики передаются снаружи,
 * поэтому этот файл не меняется при замене заглушек на настоящую доменную
 * логику — меняется только то, что подставили в `handlers`.
 *
 * @param {{
 *   health: () => Promise<object>,
 *   enqueueMessage: (input: { adapter: string, externalId: string, text: string, idempotencyKey: string }) => Promise<{status:number, json:object}>,
 *   resetConversation: (input: { adapter: string, externalId: string }) => Promise<{status:number, json:object}>,
 *   getJob: (input: { jobId: string }) => Promise<{status:number, json:object}>,
 *   marketOverview: (input: { limit?: number }) => Promise<{status:number, json:object}>,
 * }} handlers
 */
export function createRoutes(handlers) {
  const router = createRouter();

  router.add("GET", "/health", async () => ({
    status: 200,
    json: await handlers.health(),
  }));

  // Без параметров: состав обзора задан командой адаптера, а не запросом, и
  // размер десятки — часть этого решения. Маршрутизатор к тому же разбирает
  // только путь, так что передать limit было бы негде, кроме тела GET-запроса.
  router.add("GET", "/v1/market/overview", async () => handlers.marketOverview({}));

  router.add(
    "POST",
    "/v1/conversations/:adapter/:externalId/messages",
    async ({ params, body }) =>
      handlers.enqueueMessage({
        adapter: requireString(params.adapter, "adapter"),
        externalId: requireString(params.externalId, "externalId"),
        text: requireString(body.text, "text", { maxLength: MAX_TEXT_LENGTH }),
        idempotencyKey: requireString(body.idempotencyKey, "idempotencyKey"),
      }),
  );

  router.add(
    "POST",
    "/v1/conversations/:adapter/:externalId/reset",
    async ({ params }) =>
      handlers.resetConversation({
        adapter: requireString(params.adapter, "adapter"),
        externalId: requireString(params.externalId, "externalId"),
      }),
  );

  router.add("GET", "/v1/jobs/:jobId", async ({ params }) =>
    handlers.getJob({ jobId: requireString(params.jobId, "jobId") }),
  );

  return router;
}
