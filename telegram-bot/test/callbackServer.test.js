import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createCallbackServer } from "../src/http/callbackServer.js";
import { muteConsole } from "./helpers.js";

const CALLBACK_PATH = "/callbacks/replies";

const completedPayload = {
  jobId: "j_1",
  adapter: "telegram",
  externalId: "8123",
  status: "completed",
  reply: { text: "ответ" },
};

/** Поднимает callback-сервер и даёт функцию отправки в него запроса. */
async function startServer(onReply = async () => {}) {
  const received = [];
  const server = createCallbackServer({
    path: CALLBACK_PATH,
    onReply: async (payload) => {
      received.push(payload);
      await onReply(payload);
    },
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  return {
    received,
    async post(payload, { path = CALLBACK_PATH, rawBody, method = "POST" } = {}) {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: rawBody !== undefined ? rawBody : JSON.stringify(payload),
      });
      return { status: response.status, json: await response.json().catch(() => undefined) };
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

describe("callbackServer", () => {
  let server;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  describe("приём ответа", () => {
    it("принимает результат и подтверждает доставку", async () => {
      server = await startServer();

      const response = await server.post(completedPayload);

      assert.equal(response.status, 200);
      assert.deepEqual(response.json, { received: true });
      assert.deepEqual(server.received[0], completedPayload);
    });

    it("подтверждает только после того, как сообщение обработано", async () => {
      const order = [];
      server = await startServer(async () => {
        await new Promise((r) => setTimeout(r, 20));
        order.push("обработано");
      });

      await server.post(completedPayload);
      order.push("ответ отправлен Core");

      assert.deepEqual(order, ["обработано", "ответ отправлен Core"]);
    });
  });

  describe("повторная доставка", () => {
    it("не отправляет сообщение дважды при повторе того же jobId", async () => {
      server = await startServer();

      await server.post(completedPayload);
      const repeat = await server.post(completedPayload);

      assert.equal(repeat.status, 200, "повтор подтверждаем, чтобы Core перестал пытаться");
      assert.equal(repeat.json.duplicate, true);
      assert.equal(server.received.length, 1, "обработали ровно один раз");
    });

    it("разные задания обрабатываются независимо", async () => {
      server = await startServer();

      await server.post(completedPayload);
      await server.post({ ...completedPayload, jobId: "j_2" });

      assert.equal(server.received.length, 2);
    });
  });

  describe("ошибки", () => {
    it("отвечает 500, если сообщение не удалось отправить — Core повторит", async (t) => {
      muteConsole(t);
      server = await startServer(async () => {
        throw new Error("Telegram недоступен");
      });

      const response = await server.post(completedPayload);

      assert.equal(response.status, 500);
    });

    it("не запоминает задание, если обработка провалилась", async (t) => {
      muteConsole(t);
      let shouldFail = true;
      server = await startServer(async () => {
        if (shouldFail) throw new Error("Telegram недоступен");
      });

      await server.post(completedPayload);
      shouldFail = false;
      const retry = await server.post(completedPayload);

      assert.equal(retry.status, 200);
      assert.equal(server.received.length, 2, "повтор после неудачи должен обрабатываться заново");
    });

    it("отвечает 400 на некорректный payload — повторять бессмысленно", async () => {
      server = await startServer();

      const response = await server.post({ status: "completed" });

      assert.equal(response.status, 400);
      assert.equal(server.received.length, 0);
    });

    it("отвечает 400 на невалидный JSON", async () => {
      server = await startServer();

      const response = await server.post(undefined, { rawBody: "{не json" });

      assert.equal(response.status, 400);
    });
  });

  describe("маршрутизация", () => {
    it("отвечает 404 на другой путь", async () => {
      server = await startServer();

      const response = await server.post(completedPayload, { path: "/nope" });

      assert.equal(response.status, 404);
      assert.equal(server.received.length, 0);
    });

    it("отвечает 404 на другой метод", async () => {
      server = await startServer();

      const response = await server.post(completedPayload, { method: "PUT" });

      assert.equal(response.status, 404);
    });
  });
});
