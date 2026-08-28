import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleReply } from "../src/handlers/replyHandler.js";
import { createFakeTelegramClient, muteConsole } from "./helpers.js";

const basePayload = { jobId: "j_1", adapter: "telegram", externalId: "8123" };

function deliver(payload, options) {
  const telegramClient = createFakeTelegramClient(options);
  return {
    telegramClient,
    run: () => handleReply({ payload: { ...basePayload, ...payload }, telegramClient }),
  };
}

describe("handleReply", () => {
  describe("успешный ответ", () => {
    it("отправляет ответ модели в HTML-разметке Telegram", async (t) => {
      muteConsole(t);
      const ctx = deliver({ status: "completed", reply: { text: "**жирный** ответ" } });

      await ctx.run();

      assert.deepEqual(ctx.telegramClient.sent[0], {
        chatId: "8123",
        text: "<b>жирный</b> ответ",
        parseMode: "HTML",
      });
    });

    it("предупреждает, если этот ответ заполнил контекст", async (t) => {
      muteConsole(t);
      const ctx = deliver({
        status: "completed",
        reply: { text: "ответ" },
        usage: { totalTokens: 130, contextLimit: 120 },
      });

      await ctx.run();

      assert.equal(ctx.telegramClient.sent.length, 2, "ответ модели + предупреждение");
      assert.match(ctx.telegramClient.lastText(), /\/new/);
      assert.match(ctx.telegramClient.lastText(), /130\/120/);
    });

    it("не предупреждает, пока контекст не заполнен", async (t) => {
      muteConsole(t);
      const ctx = deliver({
        status: "completed",
        reply: { text: "ответ" },
        usage: { totalTokens: 50, contextLimit: 120 },
      });

      await ctx.run();

      assert.equal(ctx.telegramClient.sent.length, 1);
    });

    it("не падает, если Core не прислал статистику", async (t) => {
      muteConsole(t);
      const ctx = deliver({ status: "completed", reply: { text: "ответ" } });

      await ctx.run();

      assert.equal(ctx.telegramClient.sent.length, 1);
    });

    it("отправляет в тот чат, который указал Core", async (t) => {
      muteConsole(t);
      const ctx = deliver({ status: "completed", reply: { text: "ответ" }, externalId: "999" });

      await ctx.run();

      assert.equal(ctx.telegramClient.sent[0].chatId, "999");
    });
  });

  describe("отказ по лимиту контекста", () => {
    it("просит начать новый диалог и показывает заполнение", async (t) => {
      muteConsole(t);
      const ctx = deliver({
        status: "rejected",
        reason: "context_limit",
        usage: { totalTokens: 4952, contextLimit: 5000 },
      });

      await ctx.run();

      const text = ctx.telegramClient.lastText();
      assert.match(text, /\/new/);
      assert.match(text, /4952\/5000/);
    });

    it("обходится без цифр, если статистики нет", async (t) => {
      muteConsole(t);
      const ctx = deliver({ status: "rejected", reason: "context_limit" });

      await ctx.run();

      assert.match(ctx.telegramClient.lastText(), /\/new/);
    });

    it("отправляет отказ обычным текстом, без разметки", async (t) => {
      muteConsole(t);
      const ctx = deliver({ status: "rejected", reason: "context_limit" });

      await ctx.run();

      assert.equal(ctx.telegramClient.sent[0].parseMode, undefined);
    });
  });

  describe("отказ по скоупу", () => {
    it("объясняет, чем система занимается, и не предлагает /new", async (t) => {
      muteConsole(t);
      const ctx = deliver({ status: "rejected", reason: "out_of_scope" });

      await ctx.run();

      const text = ctx.telegramClient.lastText();
      assert.match(text, /криптотрейдер/i);
      // Новый диалог тут ни при чём: контекст не переполнен, запрос просто
      // не наш — предложение сбросить историю сбивало бы с толку.
      assert.doesNotMatch(text, /\/new/);
    });

    it("просит уточнить, когда модель не сформулировала вопрос сама", async (t) => {
      muteConsole(t);
      const ctx = deliver({ status: "rejected", reason: "clarification_needed" });

      await ctx.run();

      assert.match(ctx.telegramClient.lastText(), /уточните/i);
    });

    it("оба отказа уходят обычным текстом, без разметки", async (t) => {
      muteConsole(t);
      for (const reason of ["out_of_scope", "clarification_needed"]) {
        const ctx = deliver({ status: "rejected", reason });
        await ctx.run();
        assert.equal(ctx.telegramClient.sent[0].parseMode, undefined, reason);
      }
    });
  });

  describe("ошибки модели", () => {
    it("для таймаута объясняет, что модель не успела", async (t) => {
      muteConsole(t);
      const ctx = deliver({ status: "failed", reason: "llm_timeout" });

      await ctx.run();

      assert.match(ctx.telegramClient.lastText(), /не успела ответить/i);
    });

    it("для недоступности показывает общее сообщение об ошибке", async (t) => {
      muteConsole(t);
      const ctx = deliver({ status: "failed", reason: "llm_unavailable" });

      await ctx.run();

      assert.match(ctx.telegramClient.lastText(), /ошибка при обращении к модели/i);
    });

    it("для незнакомой причины не падает, а сообщает об ошибке", async (t) => {
      muteConsole(t);
      const ctx = deliver({ status: "failed", reason: "что-то новое" });

      await ctx.run();

      assert.match(ctx.telegramClient.lastText(), /ошибк/i);
    });
  });

  describe("доставка в Telegram не удалась", () => {
    it("пробрасывает ошибку, чтобы Core повторил доставку", async (t) => {
      muteConsole(t);
      const ctx = deliver(
        { status: "completed", reply: { text: "ответ" } },
        { failSendMessage: true },
      );

      await assert.rejects(
        () => ctx.run(),
        /Telegram недоступен/,
        "ответ, добытый за секунды работы модели, не должен теряться молча",
      );
    });
  });
});
