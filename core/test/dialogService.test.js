import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DialogService, REJECT_REASON } from "../src/domain/DialogService.js";
import { LLM_ERROR, LlmError } from "../src/llm/LlmRunner.js";
import { createFakeLlmRunner, createTestRepositories } from "./helpers.js";

function setup({ reply, contextWindowTokens = 1000 } = {}) {
  const { chatRepository } = createTestRepositories();
  const llmRunner = createFakeLlmRunner(reply);
  const service = new DialogService({ chatRepository, llmRunner, contextWindowTokens });
  const conversation = chatRepository.getOrCreateConversation("telegram", 8123);

  return {
    chatRepository,
    llmRunner,
    service,
    conversationId: conversation.id,
    process: (text) => service.process({ conversationId: conversation.id, text }),
    /** Записывает исход в историю так же, как это делает JobRunner. */
    commit(outcome) {
      if (!outcome.historyEntry) return;
      const { sessionId, userText, assistantText, totalTokens } = outcome.historyEntry;
      chatRepository.appendExchange(sessionId, userText, assistantText, totalTokens);
    },
  };
}

describe("DialogService", () => {
  describe("успешный обмен", () => {
    it("возвращает ответ модели и статистику токенов", async () => {
      const ctx = setup({ reply: { content: "ответ", promptTokens: 40, completionTokens: 12 } });

      const outcome = await ctx.process("вопрос");

      assert.equal(outcome.status, "completed");
      assert.equal(outcome.replyText, "ответ");
      assert.deepEqual(outcome.usage, {
        promptTokens: 40,
        completionTokens: 12,
        totalTokens: 52,
        contextLimit: 1000,
      });
    });

    it("сам ничего не пишет в историю", async () => {
      const ctx = setup();

      const outcome = await ctx.process("вопрос");

      const session = ctx.chatRepository.getOrCreateActiveSession(ctx.conversationId);
      assert.equal(
        ctx.chatRepository.getMessages(session.id).length,
        0,
        "запись — забота JobRunner'а, внутри его транзакции",
      );
      assert.ok(outcome.historyEntry, "но говорит, что именно записать");
    });

    it("отдаёт в historyEntry вопрос, ответ и итог по токенам", async () => {
      const ctx = setup({ reply: { content: "ответ", promptTokens: 40, completionTokens: 12 } });

      const outcome = await ctx.process("вопрос");

      assert.equal(outcome.historyEntry.userText, "вопрос");
      assert.equal(outcome.historyEntry.assistantText, "ответ");
      assert.equal(outcome.historyEntry.totalTokens, 52);
    });

    it("передаёт модели историю диалога вместе с новым вопросом", async () => {
      const ctx = setup();

      ctx.commit(await ctx.process("первый"));
      await ctx.process("второй");

      assert.deepEqual(ctx.llmRunner.calls[0], [{ role: "user", content: "первый" }]);
      assert.deepEqual(ctx.llmRunner.calls[1], [
        { role: "user", content: "первый" },
        { role: "assistant", content: "ответ" },
        { role: "user", content: "второй" },
      ]);
    });
  });

  describe("лимит контекста", () => {
    it("отклоняет запрос, когда контекст заполнен", async () => {
      const ctx = setup({
        reply: { content: "ответ", promptTokens: 30, completionTokens: 20 },
        contextWindowTokens: 40,
      });
      ctx.commit(await ctx.process("первый"));

      const outcome = await ctx.process("второй");

      assert.equal(outcome.status, "rejected");
      assert.equal(outcome.reason, REJECT_REASON.contextLimit);
    });

    it("не обращается к модели при заполненном контексте", async () => {
      const ctx = setup({
        reply: { content: "ответ", promptTokens: 30, completionTokens: 20 },
        contextWindowTokens: 40,
      });
      ctx.commit(await ctx.process("первый"));

      await ctx.process("второй");

      assert.equal(ctx.llmRunner.calls.length, 1);
    });

    it("сообщает текущее заполнение, чтобы адаптер мог его показать", async () => {
      const ctx = setup({
        reply: { content: "ответ", promptTokens: 30, completionTokens: 20 },
        contextWindowTokens: 40,
      });
      ctx.commit(await ctx.process("первый"));

      const outcome = await ctx.process("второй");

      assert.deepEqual(outcome.usage, { totalTokens: 50, contextLimit: 40 });
    });

    it("после сброса контекста снова принимает сообщения", async () => {
      const ctx = setup({
        reply: { content: "ответ", promptTokens: 30, completionTokens: 20 },
        contextWindowTokens: 40,
      });
      ctx.commit(await ctx.process("первый"));

      ctx.service.reset(ctx.conversationId);
      const outcome = await ctx.process("после сброса");

      assert.equal(outcome.status, "completed");
      assert.deepEqual(
        ctx.llmRunner.calls.at(-1),
        [{ role: "user", content: "после сброса" }],
        "старая история не подмешивается",
      );
    });
  });

  describe("ошибки модели", () => {
    it("превращает таймаут в failed с кодом llm_timeout", async () => {
      const ctx = setup({ reply: new LlmError(LLM_ERROR.timeout, "слишком долго") });

      const outcome = await ctx.process("вопрос");

      assert.equal(outcome.status, "failed");
      assert.equal(outcome.reason, LLM_ERROR.timeout);
    });

    it("превращает недоступность в failed с кодом llm_unavailable", async () => {
      const ctx = setup({ reply: new LlmError(LLM_ERROR.unavailable, "нет соединения") });

      assert.equal((await ctx.process("вопрос")).reason, LLM_ERROR.unavailable);
    });

    it("для ошибки без кода подставляет llm_unavailable", async () => {
      const ctx = setup({ reply: new Error("что-то пошло не так") });

      assert.equal((await ctx.process("вопрос")).reason, LLM_ERROR.unavailable);
    });

    it("не оставляет вопрос без ответа в истории", async () => {
      const ctx = setup({ reply: new LlmError(LLM_ERROR.unavailable, "нет соединения") });

      const outcome = await ctx.process("потерянный вопрос");
      ctx.commit(outcome);

      const session = ctx.chatRepository.getOrCreateActiveSession(ctx.conversationId);
      assert.equal(ctx.chatRepository.getMessages(session.id).length, 0);
    });

    it("не засчитывает токены за неудачный запрос", async () => {
      const ctx = setup({ reply: new LlmError(LLM_ERROR.unavailable, "нет соединения") });

      ctx.commit(await ctx.process("вопрос"));

      assert.equal(
        ctx.chatRepository.getOrCreateActiveSession(ctx.conversationId).totalTokens,
        0,
      );
    });
  });

  describe("reset", () => {
    it("создаёт новую сессию, сохраняя прежнюю историю", async () => {
      const ctx = setup();
      ctx.commit(await ctx.process("вопрос"));
      const before = ctx.chatRepository.getOrCreateActiveSession(ctx.conversationId);

      const fresh = ctx.service.reset(ctx.conversationId);

      assert.notEqual(fresh.id, before.id);
      assert.equal(ctx.chatRepository.getMessages(before.id).length, 2);
      assert.equal(ctx.chatRepository.getMessages(fresh.id).length, 0);
    });
  });
});
