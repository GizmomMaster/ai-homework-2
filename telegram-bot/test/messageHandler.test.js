import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleMessage } from "../src/handlers/messageHandler.js";
import {
  createFakeLlmRunner,
  createFakeTelegramClient,
  createTestRepository,
  muteConsole,
} from "./helpers.js";

/** Собирает handleMessage с заглушками и разумными значениями по умолчанию. */
function setup({ reply, contextWindowTokens = 1000, failSendMessage = false } = {}) {
  const chatRepository = createTestRepository();
  const telegramClient = createFakeTelegramClient({ failSendMessage });
  const llmRunner = createFakeLlmRunner(reply);
  const chatId = 1;

  return {
    chatRepository,
    telegramClient,
    llmRunner,
    chatId,
    run: (text) =>
      handleMessage({
        chatId,
        text,
        telegramClient,
        llmRunner,
        chatRepository,
        contextWindowTokens,
      }),
  };
}

describe("handleMessage", () => {
  describe("успешный обмен", () => {
    it("отправляет ответ модели в HTML-формате Telegram", async (t) => {
      muteConsole(t);
      const ctx = setup({
        reply: { content: "**жирный** ответ", promptTokens: 10, completionTokens: 5 },
      });

      await ctx.run("привет");

      assert.equal(ctx.telegramClient.sent.length, 1);
      assert.deepEqual(ctx.telegramClient.sent[0], {
        chatId: 1,
        text: "<b>жирный</b> ответ",
        parseMode: "HTML",
      });
    });

    it("сохраняет вопрос и ответ в истории", async (t) => {
      muteConsole(t);
      const ctx = setup({ reply: { content: "ответ", promptTokens: 10, completionTokens: 5 } });

      await ctx.run("вопрос");

      const session = ctx.chatRepository.getOrCreateActiveSession(ctx.chatId);
      assert.deepEqual(ctx.chatRepository.getMessages(session.id), [
        { role: "user", content: "вопрос" },
        { role: "assistant", content: "ответ" },
      ]);
    });

    it("передаёт модели всю историю диалога вместе с новым вопросом", async (t) => {
      muteConsole(t);
      const ctx = setup({ reply: { content: "ответ", promptTokens: 10, completionTokens: 5 } });

      await ctx.run("первый");
      await ctx.run("второй");

      assert.deepEqual(ctx.llmRunner.calls[0], [{ role: "user", content: "первый" }]);
      assert.deepEqual(ctx.llmRunner.calls[1], [
        { role: "user", content: "первый" },
        { role: "assistant", content: "ответ" },
        { role: "user", content: "второй" },
      ]);
    });

    it("записывает в сессию сумму токенов промпта и ответа", async (t) => {
      muteConsole(t);
      const ctx = setup({ reply: { content: "ответ", promptTokens: 40, completionTokens: 12 } });

      await ctx.run("вопрос");

      assert.equal(ctx.chatRepository.getOrCreateActiveSession(ctx.chatId).totalTokens, 52);
    });
  });

  describe("лимит контекстного окна", () => {
    it("предупреждает про /new, когда лимит достигнут по итогам обмена", async (t) => {
      muteConsole(t);
      const ctx = setup({
        reply: { content: "ответ", promptTokens: 30, completionTokens: 20 },
        contextWindowTokens: 40,
      });

      await ctx.run("вопрос");

      assert.equal(ctx.telegramClient.sent.length, 2, "ответ модели + предупреждение");
      assert.match(ctx.telegramClient.lastText(), /\/new/);
      assert.match(ctx.telegramClient.lastText(), /50\/40/);
    });

    it("не обращается к модели, если лимит уже исчерпан", async (t) => {
      muteConsole(t);
      const ctx = setup({
        reply: { content: "ответ", promptTokens: 30, completionTokens: 20 },
        contextWindowTokens: 40,
      });

      await ctx.run("первый");
      const callsAfterFirst = ctx.llmRunner.calls.length;
      await ctx.run("второй");

      assert.equal(ctx.llmRunner.calls.length, callsAfterFirst, "второй запрос не ушёл в LLM");
      assert.match(ctx.telegramClient.lastText(), /\/new/);
    });

    it("не сохраняет отклонённое по лимиту сообщение в историю", async (t) => {
      muteConsole(t);
      const ctx = setup({
        reply: { content: "ответ", promptTokens: 30, completionTokens: 20 },
        contextWindowTokens: 40,
      });

      await ctx.run("первый");
      await ctx.run("отклонённый");

      const session = ctx.chatRepository.getOrCreateActiveSession(ctx.chatId);
      const contents = ctx.chatRepository.getMessages(session.id).map((m) => m.content);
      assert.ok(!contents.includes("отклонённый"));
    });

    it("после /new диалог продолжается с чистым контекстом", async (t) => {
      muteConsole(t);
      const ctx = setup({
        reply: { content: "ответ", promptTokens: 30, completionTokens: 20 },
        contextWindowTokens: 40,
      });

      await ctx.run("первый");
      ctx.chatRepository.createSession(ctx.chatId);
      await ctx.run("после сброса");

      assert.deepEqual(
        ctx.llmRunner.calls.at(-1),
        [{ role: "user", content: "после сброса" }],
        "в модель ушёл только новый вопрос",
      );
    });
  });

  describe("ошибка обращения к модели", () => {
    it("сообщает пользователю об ошибке", async (t) => {
      muteConsole(t);
      const ctx = setup({ reply: new Error("Ollama недоступна") });

      await ctx.run("вопрос");

      assert.equal(ctx.telegramClient.sent.length, 1);
      assert.match(ctx.telegramClient.lastText(), /ошибка при обращении к модели/i);
    });

    it("не оставляет вопрос без ответа в истории (регрессия)", async (t) => {
      muteConsole(t);
      const ctx = setup({ reply: new Error("Ollama недоступна") });

      await ctx.run("потерянный вопрос");

      const session = ctx.chatRepository.getOrCreateActiveSession(ctx.chatId);
      assert.deepEqual(
        ctx.chatRepository.getMessages(session.id),
        [],
        "неудачный запрос не должен попадать в контекст",
      );
    });

    it("не засчитывает токены за неудачный запрос", async (t) => {
      muteConsole(t);
      const ctx = setup({ reply: new Error("Ollama недоступна") });

      await ctx.run("вопрос");

      assert.equal(ctx.chatRepository.getOrCreateActiveSession(ctx.chatId).totalTokens, 0);
    });

    it("следующий успешный запрос не тащит за собой неудачный", async (t) => {
      muteConsole(t);
      const chatRepository = createTestRepository();
      const telegramClient = createFakeTelegramClient();
      let shouldFail = true;
      const llmRunner = {
        calls: [],
        async chat(messages) {
          this.calls.push(messages);
          if (shouldFail) throw new Error("Ollama недоступна");
          return { content: "ответ", promptTokens: 10, completionTokens: 5 };
        },
      };
      const run = (text) =>
        handleMessage({
          chatId: 1,
          text,
          telegramClient,
          llmRunner,
          chatRepository,
          contextWindowTokens: 1000,
        });

      await run("упавший вопрос");
      shouldFail = false;
      await run("новый вопрос");

      assert.deepEqual(llmRunner.calls.at(-1), [{ role: "user", content: "новый вопрос" }]);
    });
  });

  describe("устойчивость к сбоям Telegram", () => {
    it("не бросает исключение, если отправка не удалась", async (t) => {
      muteConsole(t);
      const ctx = setup({
        reply: { content: "ответ", promptTokens: 10, completionTokens: 5 },
        failSendMessage: true,
      });

      await assert.doesNotReject(() => ctx.run("вопрос"));
    });

    it("сохраняет обмен в историю, даже если ответ не доставлен", async (t) => {
      muteConsole(t);
      const ctx = setup({
        reply: { content: "ответ", promptTokens: 10, completionTokens: 5 },
        failSendMessage: true,
      });

      await ctx.run("вопрос");

      const session = ctx.chatRepository.getOrCreateActiveSession(ctx.chatId);
      assert.equal(ctx.chatRepository.getMessages(session.id).length, 2);
    });
  });
});
