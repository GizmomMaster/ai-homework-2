import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DialogService, FAILURE_REASON, REJECT_REASON } from "../src/domain/DialogService.js";
import { LLM_ERROR, LlmError } from "../src/llm/LlmRunner.js";
import {
  createFakeExecutor,
  createFakePlanner,
  createFakeSummaryAgent,
  createFakeRouter,
  createFakeTheoryAgent,
  createTestRepositories,
  muteConsole,
} from "./helpers.js";
import { ROUTER_INTENT } from "../src/agents/RouterAgent.js";

function setup({ reply, verdict, plan, execution, summary, contextWindowTokens = 1000 } = {}) {
  const { chatRepository } = createTestRepositories();
  const theoryAgent = createFakeTheoryAgent(reply);
  const routerAgent = createFakeRouter(verdict);
  const plannerAgent = createFakePlanner(plan);
  const planExecutor = createFakeExecutor(execution);
  const summaryAgent = summary === null ? undefined : createFakeSummaryAgent(summary);
  const service = new DialogService({
    chatRepository,
    routerAgent,
    theoryAgent,
    plannerAgent,
    planExecutor,
    summaryAgent,
    contextWindowTokens,
  });
  const conversation = chatRepository.getOrCreateConversation("telegram", 8123);

  return {
    chatRepository,
    // Тесты обращаются к нему как к «модели»: агент — тонкая обёртка над ней.
    llmRunner: theoryAgent,
    routerAgent,
    plannerAgent,
    planExecutor,
    summaryAgent,
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

    it("задача уходит планировщику, а не теоретическому агенту", async () => {
      const ctx = setup({
        verdict: { intent: ROUTER_INTENT.taskRequest },
        plan: { canExecute: true, plan: [{ action: "Цена BTC", toolToUse: "t" }] },
      });

      const outcome = await ctx.process("какая цена BTC?");

      assert.equal(outcome.status, "completed");
      assert.equal(ctx.plannerAgent.calls.length, 1);
      // Теоретический агент не должен придумывать рыночные данные.
      assert.equal(ctx.llmRunner.calls.length, 0);
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

  describe("ветка задачи", () => {
    const onePlan = { canExecute: true, taskSummary: "Цена BTC", plan: [{ action: "Цена", toolToUse: "get_crypto_current_price", parameters: { symbol: "BTCUSDT" } }] };

    function task(options) {
      const ctx = setup({ verdict: { intent: ROUTER_INTENT.taskRequest }, ...options });
      return ctx;
    }

    it("выполнимый план исполняется, отчёт сводит модель", async () => {
      const ctx = task({
        plan: onePlan,
        execution: () => ({ ok: true, value: { price: 79363.81 } }),
        summary: { content: "Биткоин стоит 79 363.81 USDT.", promptTokens: 500, completionTokens: 60 },
      });

      const outcome = await ctx.process("цена BTC?");

      assert.equal(outcome.status, "completed");
      assert.equal(outcome.replyText, "Биткоин стоит 79 363.81 USDT.");
      assert.equal(ctx.planExecutor.calls[0], onePlan.plan);
    });

    it("сводящему агенту достаются вопрос, задача и результаты шагов", async () => {
      const ctx = task({ plan: onePlan, execution: () => ({ ok: true, value: { price: 1 } }) });

      await ctx.process("цена BTC?");

      const brief = ctx.summaryAgent.calls[0];
      assert.equal(brief.question, "цена BTC?");
      assert.equal(brief.taskSummary, "Цена BTC");
      assert.equal(brief.steps.length, 1);
    });

    it("отказ сводящего агента не теряет уже собранные данные", async (t) => {
      muteConsole(t);
      // Запросы к бирже уже сделаны: показать числа шаблоном лучше, чем
      // потерять всё из-за сбоя на последнем шаге.
      const ctx = task({
        plan: onePlan,
        execution: () => ({ ok: true, value: { price: 79363.81 } }),
        summary: new LlmError(LLM_ERROR.timeout, "долго"),
      });

      const outcome = await ctx.process("цена BTC?");

      assert.equal(outcome.status, "completed");
      assert.match(outcome.replyText, /79 363\.81/);
    });

    it("пустая сводка тоже откатывается на шаблон", async (t) => {
      muteConsole(t);
      const ctx = task({
        plan: onePlan,
        execution: () => ({ ok: true, value: { price: 79363.81 } }),
        summary: { content: "   ", promptTokens: 10, completionTokens: 1 },
      });

      assert.match((await ctx.process("цена BTC?")).replyText, /79 363\.81/);
    });

    it("токены сводки попадают в стоимость задания", async () => {
      const ctx = task({ plan: onePlan });

      const outcome = await ctx.process("цена BTC?");

      // Маршрутизатор 20+8, планировщик 300+40, сводка 500+60.
      assert.equal(outcome.usage.promptTokens, 820);
      assert.equal(outcome.usage.completionTokens, 108);
    });

    it("отчёт попадает в историю — следующий вопрос опирается на показанное", async () => {
      const ctx = task({ plan: onePlan });

      const outcome = await ctx.process("цена BTC?");
      ctx.commit(outcome);

      const messages = ctx.chatRepository.getMessages(outcome.historyEntry.sessionId);
      assert.deepEqual(messages.map((m) => m.role), ["user", "assistant"]);
      assert.equal(messages[0].content, "цена BTC?");
    });

    it("невыполнимая задача: объяснение планировщика уходит как ответ", async () => {
      const ctx = task({
        plan: { canExecute: false, fallbackMessage: "Торговые операции не поддерживаются." },
      });

      const outcome = await ctx.process("купи 1 BTC");

      assert.equal(outcome.status, "completed");
      assert.equal(outcome.replyText, "Торговые операции не поддерживаются.");
      assert.equal(ctx.planExecutor.calls.length, 0);
    });

    it("невыполнимая задача без объяснения: код для адаптера", async () => {
      const ctx = task({ plan: { canExecute: false, fallbackMessage: null } });

      const outcome = await ctx.process("купи 1 BTC");

      assert.equal(outcome.status, "rejected");
      assert.equal(outcome.reason, REJECT_REASON.taskUnsupported);
    });

    it("пустой план считается невыполнимой задачей", async () => {
      const ctx = task({ plan: { canExecute: true, plan: [], fallbackMessage: "нечего делать" } });

      const outcome = await ctx.process("сделай что-нибудь");

      assert.equal(outcome.replyText, "нечего делать");
      assert.equal(ctx.planExecutor.calls.length, 0);
    });

    it("часть шагов упала — отчёт собирается из удавшихся с оговоркой", async () => {
      const ctx = task({
        plan: {
          canExecute: true,
          taskSummary: "Сравнение",
          plan: [
            { action: "Объём BTC", toolToUse: "t" },
            { action: "Объём NOSUCH", toolToUse: "t" },
          ],
        },
        execution: (step) =>
          step.action === "Объём BTC"
            ? { ok: true, value: { quoteVolume: 1000 } }
            : { ok: false, error: { code: "unknown_symbol" } },
      });

      const outcome = await ctx.process("сравни");

      assert.equal(outcome.status, "completed");
      // Модель должна знать, чего не хватило, иначе оговорки в отчёте не будет.
      const brief = ctx.summaryAgent.calls[0];
      assert.equal(brief.steps.filter((s) => !s.ok).length, 1);
    });

    it("без сводящего агента отчёт собирается шаблоном", async () => {
      const ctx = task({
        plan: { canExecute: true, taskSummary: "Сравнение", plan: [{ action: "Объём BTC", toolToUse: "t" }] },
        execution: () => ({ ok: true, value: { quoteVolume: 1000 } }),
        summary: null,
      });

      const outcome = await ctx.process("сравни");

      assert.match(outcome.replyText, /\*\*Сравнение\*\*/);
      assert.match(outcome.replyText, /объём, USDT: 1 000/);
    });

    it("все шаги упали — это отказ, а не пустой отчёт", async () => {
      const ctx = task({
        plan: onePlan,
        execution: () => ({ ok: false, error: { code: "rate_limited" } }),
      });

      const outcome = await ctx.process("цена BTC?");

      assert.equal(outcome.status, "failed");
      assert.equal(outcome.reason, "rate_limited");
      assert.equal(outcome.historyEntry, undefined);
    });

    it("обрезка плана отмечается и поверх сводки модели", async () => {
      const ctx = task({ plan: { ...onePlan, truncated: true } });

      assert.match((await ctx.process("много")).replyText, /План был длиннее/);
    });

    it("отказ планировщика роняет задание: отвечать нечем", async () => {
      const ctx = task({ plan: new LlmError(LLM_ERROR.timeout, "долго") });

      const outcome = await ctx.process("цена BTC?");

      assert.equal(outcome.status, "failed");
      assert.equal(outcome.reason, LLM_ERROR.timeout);
    });

    it("планировщик видит историю диалога", async () => {
      const ctx = task({ plan: onePlan });

      const first = await ctx.process("цена BTC?");
      ctx.commit(first);
      await ctx.process("а ETH?");

      assert.equal(ctx.plannerAgent.calls.at(-1).history.length, 2);
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
