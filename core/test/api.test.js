import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { MAX_TEXT_LENGTH } from "../src/http/routes.js";
import { muteConsole, startCore, throwingHandlers } from "./helpers.js";

const messagesPath = "/v1/conversations/telegram/8123/messages";
const validMessage = { text: "привет", idempotencyKey: "tg:8123:4471" };

describe("HTTP-контракт Core", () => {
  let core;
  afterEach(async () => {
    await core?.close();
    core = undefined;
  });

  describe("GET /health", () => {
    it("отвечает 200 и статусом ok", async () => {
      core = await startCore();

      const response = await core.request("GET", "/health");

      assert.equal(response.status, 200);
      assert.equal(response.json.status, "ok");
    });

    it("отдаёт JSON с корректным content-type", async () => {
      core = await startCore();

      const response = await core.request("GET", "/health");

      assert.match(response.headers.get("content-type"), /application\/json/);
    });
  });

  describe("POST …/messages", () => {
    it("принимает сообщение и возвращает 202 с jobId", async () => {
      core = await startCore();

      const response = await core.request("POST", messagesPath, { body: validMessage });

      assert.equal(response.status, 202);
      assert.equal(response.json.status, "queued");
      assert.match(response.json.jobId, /^j_[0-9a-f]{32}$/);
    });

    it("на повтор idempotencyKey отдаёт то же задание и 200, а не 202", async () => {
      core = await startCore();

      const first = await core.request("POST", messagesPath, { body: validMessage });
      const second = await core.request("POST", messagesPath, { body: validMessage });

      assert.equal(first.status, 202, "первый запрос создал задание");
      assert.equal(second.status, 200, "второй ничего не создал");
      assert.equal(second.json.jobId, first.json.jobId);
    });

    it("разные ключи идемпотентности дают разные задания", async () => {
      core = await startCore();

      const first = await core.request("POST", messagesPath, { body: validMessage });
      const second = await core.request("POST", messagesPath, {
        body: { ...validMessage, idempotencyKey: "tg:8123:4472" },
      });

      assert.notEqual(second.json.jobId, first.json.jobId);
    });

    it("принимает externalId в процентной кодировке", async () => {
      core = await startCore();

      const response = await core.request(
        "POST",
        "/v1/conversations/telegram/%D1%87%D0%B0%D1%82/messages",
        { body: validMessage },
      );

      assert.equal(response.status, 202);
    });

    describe("валидация", () => {
      const invalidBodies = [
        ["без text", { idempotencyKey: "k" }, "text"],
        ["с пустым text", { text: "   ", idempotencyKey: "k" }, "text"],
        ["с нестроковым text", { text: 42, idempotencyKey: "k" }, "text"],
        ["без idempotencyKey", { text: "привет" }, "idempotencyKey"],
        ["с пустым idempotencyKey", { text: "привет", idempotencyKey: "" }, "idempotencyKey"],
      ];

      for (const [name, body, field] of invalidBodies) {
        it(`отклоняет запрос ${name}`, async () => {
          core = await startCore();

          const response = await core.request("POST", messagesPath, { body });

          assert.equal(response.status, 400);
          assert.equal(response.json.error.code, "invalid_request");
          assert.match(response.json.error.message, new RegExp(field));
        });
      }

      it("отклоняет слишком длинный text", async () => {
        core = await startCore();

        const response = await core.request("POST", messagesPath, {
          body: { text: "я".repeat(MAX_TEXT_LENGTH + 1), idempotencyKey: "k" },
        });

        assert.equal(response.status, 400);
        assert.equal(response.json.error.code, "invalid_request");
      });

      it("отклоняет невалидный JSON", async () => {
        core = await startCore();

        const response = await core.request("POST", messagesPath, { rawBody: "{не json" });

        assert.equal(response.status, 400);
        assert.match(response.json.error.message, /JSON/);
      });

      it("отклоняет тело-массив вместо объекта", async () => {
        core = await startCore();

        const response = await core.request("POST", messagesPath, { rawBody: "[1,2,3]" });

        assert.equal(response.status, 400);
        assert.match(response.json.error.message, /объект/i);
      });

      it("отклоняет слишком большое тело", async () => {
        core = await startCore({ maxBodyBytes: 256 });

        const response = await core.request("POST", messagesPath, {
          body: { text: "я".repeat(5000), idempotencyKey: "k" },
        });

        assert.equal(response.status, 413);
        assert.equal(response.json.error.code, "payload_too_large");
      });
    });
  });

  describe("POST …/reset", () => {
    it("отвечает 200", async () => {
      core = await startCore();

      const response = await core.request("POST", "/v1/conversations/telegram/8123/reset");

      assert.equal(response.status, 200);
    });

    it("не требует тела запроса", async () => {
      core = await startCore();

      const response = await core.request("POST", "/v1/conversations/telegram/8123/reset", {
        rawBody: "",
      });

      assert.equal(response.status, 200);
    });
  });

  describe("GET /v1/jobs/:jobId", () => {
    it("возвращает созданное задание", async () => {
      core = await startCore();
      const created = await core.request("POST", messagesPath, { body: validMessage });

      const response = await core.request("GET", `/v1/jobs/${created.json.jobId}`);

      assert.equal(response.status, 200);
      assert.equal(response.json.jobId, created.json.jobId);
      assert.equal(response.json.status, "queued");
    });

    it("отвечает 404 на неизвестный jobId", async () => {
      core = await startCore();

      const response = await core.request("GET", "/v1/jobs/j_нет-такого");

      assert.equal(response.status, 404);
      assert.equal(response.json.error.code, "not_found");
    });
  });

  describe("ошибки маршрутизации", () => {
    it("404 на неизвестный путь", async () => {
      core = await startCore();

      const response = await core.request("GET", "/v1/unknown");

      assert.equal(response.status, 404);
      assert.equal(response.json.error.code, "not_found");
    });

    it("405, когда путь есть, а метод другой", async () => {
      core = await startCore();

      const response = await core.request("GET", messagesPath);

      assert.equal(response.status, 405);
      assert.equal(response.json.error.code, "method_not_allowed");
    });
  });

  describe("внутренние ошибки", () => {
    it("отдаёт 500 без подробностей наружу", async (t) => {
      muteConsole(t);
      core = await startCore({ handlers: throwingHandlers(new Error("секрет в тексте ошибки")) });

      const response = await core.request("GET", "/health");

      assert.equal(response.status, 500);
      assert.equal(response.json.error.code, "internal_error");
      assert.ok(
        !response.text.includes("секрет"),
        "детали внутренней ошибки не должны утекать клиенту",
      );
    });
  });
});
