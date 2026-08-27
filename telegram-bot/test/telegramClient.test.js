import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { TelegramClient, splitIntoChunks } from "../src/telegram/client.js";
import { muteConsole, startTestServer } from "./helpers.js";

/** Клиент, направленный на локальный тестовый сервер вместо api.telegram.org. */
async function connectClient(handler) {
  const server = await startTestServer(handler);
  const client = new TelegramClient("TEST_TOKEN");
  client.apiBase = `${server.baseUrl}/botTEST_TOKEN`;
  return { server, client };
}

const okResponse = { json: { ok: true, result: {} } };

describe("splitIntoChunks", () => {
  it("не режет текст в пределах лимита", () => {
    assert.deepEqual(splitIntoChunks("короткий", 4096), ["короткий"]);
  });

  it("режет по границам строк, когда это возможно", () => {
    const chunks = splitIntoChunks("строка1\nстрока2\nстрока3", 16);

    assert.ok(chunks.length > 1);
    assert.equal(chunks.join(""), "строка1\nстрока2\nстрока3", "текст не потерян");
    assert.ok(
      chunks.slice(0, -1).every((chunk) => chunk.endsWith("\n")),
      "все части кроме последней заканчиваются переносом",
    );
  });

  it("жёстко режет строку без переносов", () => {
    const chunks = splitIntoChunks("a".repeat(25), 10);

    assert.deepEqual(chunks, ["a".repeat(10), "a".repeat(10), "a".repeat(5)]);
  });

  it("соблюдает лимит для каждой части", () => {
    const text = Array.from({ length: 200 }, (_, i) => `строка номер ${i}`).join("\n");
    for (const chunk of splitIntoChunks(text, 100)) {
      assert.ok(chunk.length <= 100, `часть длиннее лимита: ${chunk.length}`);
    }
  });
});

describe("TelegramClient", () => {
  let ctx;
  afterEach(async () => {
    await ctx?.server.close();
    ctx = undefined;
  });

  describe("sendMessage", () => {
    it("отправляет обычный текст без parse_mode", async () => {
      ctx = await connectClient(() => okResponse);

      await ctx.client.sendMessage({ chatId: 5, text: "привет" });

      assert.equal(ctx.server.requests.length, 1);
      assert.deepEqual(ctx.server.requests[0].payload, { chat_id: 5, text: "привет" });
    });

    it("передаёт parse_mode, когда он указан", async () => {
      ctx = await connectClient(() => okResponse);

      await ctx.client.sendMessage({ chatId: 5, text: "<b>привет</b>", parseMode: "HTML" });

      assert.equal(ctx.server.requests[0].payload.parse_mode, "HTML");
    });

    it("разбивает длинный текст на несколько сообщений", async () => {
      ctx = await connectClient(() => okResponse);

      await ctx.client.sendMessage({ chatId: 5, text: "a".repeat(9000) });

      assert.equal(ctx.server.requests.length, 3);
      const total = ctx.server.requests.reduce((sum, r) => sum + r.payload.text.length, 0);
      assert.equal(total, 9000, "текст доставлен целиком");
    });

    it("при ошибке разметки повторяет отправку обычным текстом", async (t) => {
      muteConsole(t);
      ctx = await connectClient((payload) =>
        payload.parse_mode
          ? { json: { ok: false, description: "Bad Request: can't parse entities" } }
          : okResponse,
      );

      await ctx.client.sendMessage({ chatId: 5, text: "<b>битая", parseMode: "HTML" });

      assert.equal(ctx.server.requests.length, 2, "повторная отправка выполнена");
      assert.equal(ctx.server.requests[0].payload.parse_mode, "HTML");
      assert.equal(ctx.server.requests[1].payload.parse_mode, undefined);
      assert.equal(ctx.server.requests[1].payload.text, "<b>битая");
    });

    it("пробрасывает ошибку, если и обычная отправка не удалась", async (t) => {
      muteConsole(t);
      ctx = await connectClient(() => ({ json: { ok: false, description: "chat not found" } }));

      await assert.rejects(
        () => ctx.client.sendMessage({ chatId: 5, text: "текст", parseMode: "HTML" }),
        /chat not found/,
      );
    });

    it("пробрасывает ошибку API при отправке без parse_mode", async () => {
      ctx = await connectClient(() => ({ json: { ok: false, description: "bot was blocked" } }));

      await assert.rejects(
        () => ctx.client.sendMessage({ chatId: 5, text: "текст" }),
        /bot was blocked/,
      );
    });
  });

  describe("getUpdates", () => {
    it("передаёт offset и таймаут long polling", async () => {
      ctx = await connectClient(() => ({ json: { ok: true, result: [] } }));

      await ctx.client.getUpdates({ offset: 42 });

      assert.equal(ctx.server.requests[0].url, "/botTEST_TOKEN/getUpdates");
      assert.equal(ctx.server.requests[0].payload.offset, 42);
      assert.equal(ctx.server.requests[0].payload.timeout, 30);
    });

    it("возвращает список обновлений", async () => {
      const updates = [{ update_id: 1, message: { chat: { id: 1 }, text: "привет" } }];
      ctx = await connectClient(() => ({ json: { ok: true, result: updates } }));

      assert.deepEqual(await ctx.client.getUpdates({}), updates);
    });

    it("прерывается по сигналу остановки", async () => {
      ctx = await connectClient(() => ({ json: { ok: true, result: [] }, delayMs: 300 }));
      const controller = new AbortController();

      const pending = ctx.client.getUpdates({ signal: controller.signal });
      controller.abort();

      await assert.rejects(() => pending);
    });
  });

  describe("setMyCommands", () => {
    it("регистрирует список команд", async () => {
      ctx = await connectClient(() => ({ json: { ok: true, result: true } }));
      const menu = [{ command: "new", description: "Новый диалог" }];

      await ctx.client.setMyCommands(menu);

      assert.equal(ctx.server.requests[0].url, "/botTEST_TOKEN/setMyCommands");
      assert.deepEqual(ctx.server.requests[0].payload, { commands: menu });
    });
  });
});
