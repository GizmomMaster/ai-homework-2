import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DialogService, FAILURE_REASON, REJECT_REASON } from "../src/domain/DialogService.js";
import { LLM_ERROR, LlmError } from "../src/llm/LlmRunner.js";
import {
  createFakeRouter,
  createFakeTheoryAgent,
  createTestRepositories,
  muteConsole,
} from "./helpers.js";
import { ROUTER_INTENT } from "../src/agents/RouterAgent.js";

function setup({ reply, verdict, contextWindowTokens = 1000 } = {}) {
  const { chatRepository } = createTestRepositories();
  const theoryAgent = createFakeTheoryAgent(reply);
  const routerAgent = createFakeRouter(verdict);
  const service = new DialogService({
    chatRepository,
    routerAgent,
    theoryAgent,
    contextWindowTokens,
  });
  const conversation = chatRepository.getOrCreateConversation("telegram", 8123);

  return {
    chatRepository,
    // Тесты обращаются к нему как к «модели»: агент — тонкая обёртка над ней.
    llmRunner: theoryAgent,
    routerAgent,
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
      // promptTokens/completionTokens — работа по заданию, то есть маршрутизатор
      // (20 + 8 у заглушки) плюс отвечающий вызов. totalTokens — размер диалога,
      // измеренный отвечающим вызовом: служебные обращения в него не входят.
      assert.deepEqual(outcome.usage, {
        promptTokens: 60,
        completionTokens: 20,
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

  describe("ветки маршрутизатора", () => {
    it("вне компетенции — отказ без обращения к модели и без записи в историю", async () => {
      const ctx = setup({ verdict: { intent: ROUTER_INTENT.outOfScope } });

      const outcome = await ctx.process("напиши стих про осень");

      assert.equal(outcome.status, "rejected");
      assert.equal(outcome.reason, REJECT_REASON.outOfScope);
      assert.equal(outcome.historyEntry, undefined);
      assert.equal(ctx.llmRunner.calls.length, 0);
    });

    it("вне компетенции — размер диалога не меняется, но токены роутера учтены", async () => {
      const ctx = setup({ verdict: { intent: ROUTER_INTENT.outOfScope } });

      const outcome = await ctx.process("напиши стих");

      assert.deepEqual(outcome.usage, {
        promptTokens: 20,
        completionTokens: 8,
        totalTokens: 0,
        contextLimit: 1000,
      });
    });

    it("уточнение — вопрос модели уходит пользователя как обычная реплика", async () => {
      const ctx = setup({
        verdict: {
          intent: ROUTER_INTENT.clarificationNeeded,
          clarificationQuestion: "О какой монете идёт речь?",
        },
      });

      const outcome = await ctx.process("какая цена?");

      assert.equal(outcome.status, "completed");
      assert.equal(outcome.replyText, "О какой монете идёт речь?");
      assert.equal(ctx.llmRunner.calls.length, 0);
    });

    it("уточнение попадает в историю — иначе ответ «BTC» повиснет без опоры", async () => {
      const ctx = setup({
        verdict: {
          intent: ROUTER_INTENT.clarificationNeeded,
          clarificationQuestion: "О какой монете идёт речь?",
        },
      });

      const outcome = await ctx.process("какая цена?");
      ctx.commit(outcome);

      assert.deepEqual(
        ctx.chatRepository.getMessages(outcome.historyEntry.sessionId).map((m) => m.content),
        ["какая цена?", "О какой монете идёт речь?"],
      );
    });

    it("уточнение без вопроса — отдаём код, формулировку напишет адаптер", async () => {
      const ctx = setup({
        verdict: { intent: ROUTER_INTENT.clarificationNeeded, clarificationQuestion: null },
      });

      const outcome = await ctx.process("какая цена?");

      assert.equal(outcome.status, "rejected");
      assert.equal(outcome.reason, REJECT_REASON.clarificationNeeded);
      assert.equal(outcome.historyEntry, undefined);
    });

    it("пустой вопрос считается отсутствующим", async () => {
      const ctx = setup({
        verdict: { intent: ROUTER_INTENT.clarificationNeeded, clarificationQuestion: "   " },
      });

      assert.equal((await ctx.process("какая цена?")).reason, REJECT_REASON.clarificationNeeded);
    });

    it("теоретический вопрос уходит теоретическому агенту", async () => {
      const ctx = setup({ verdict: { intent: ROUTER_INTENT.theoryQuestion } });

      const outcome = await ctx.process("что такое funding rate?");

      assert.equal(outcome.status, "completed");
      assert.equal(outcome.intent, ROUTER_INTENT.theoryQuestion);
      assert.equal(ctx.llmRunner.calls.length, 1);
    });

    it("задача отклоняется, а не отвечается выдуманными числами", async () => {
      const ctx = setup({ verdict: { intent: ROUTER_INTENT.taskRequest } });

      const outcome = await ctx.process("сравни объёмы SOL и BTC");

      assert.equal(outcome.status, "rejected");
      assert.equal(outcome.reason, REJECT_REASON.taskUnsupported);
      // Главное здесь: модель не спрашивали. Рыночных данных у неё нет, и
      // правдоподобные цифры в ответе были бы хуже отказа.
      assert.equal(ctx.llmRunner.calls.length, 0);
      assert.equal(outcome.historyEntry, undefined);
    });

    it("маршрутизатор не видит системных сообщений в истории диалога", async () => {
      const ctx = setup({ verdict: { intent: ROUTER_INTENT.theoryQuestion } });

      const first = await ctx.process("первый вопрос");
      ctx.commit(first);
      await ctx.process("второй вопрос");

      assert.deepEqual(ctx.routerAgent.calls.at(-1).history.map((m) => m.role), [
        "user",
        "assistant",
      ]);
    });
  });

  describe("отказ маршрутизатора", () => {
    it("неразбираемый ответ не роняет диалог — отвечаем без классификации", async (t) => {
      muteConsole(t);
      const ctx = setup({
        verdict: new LlmError(LLM_ERROR.badResponse, "не разобрался"),
      });

      const outcome = await ctx.process("вопрос");

      assert.equal(outcome.status, "completed");
      assert.equal(outcome.intent, undefined);
      assert.equal(ctx.llmRunner.calls.length, 1);
    });

    it("недоступная модель роняет задание — второй вызов всё равно не пройдёт", async () => {
      const ctx = setup({
        verdict: new LlmError(LLM_ERROR.unavailable, "нет соединения"),
      });

      const outcome = await ctx.process("вопрос");

      assert.equal(outcome.status, "failed");
      assert.equal(outcome.reason, LLM_ERROR.unavailable);
      assert.equal(ctx.llmRunner.calls.length, 0);
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

    it("ошибку без кода LLM отличает от сбоя модели", async () => {
      // Иначе баг в нашем коде выглядел бы в логах как «Ollama недоступна».
      const ctx = setup({ reply: new Error("что-то пошло не так") });

      const outcome = await ctx.process("вопрос");

      assert.equal(outcome.status, "failed");
      assert.equal(outcome.reason, FAILURE_REASON.internal);
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
