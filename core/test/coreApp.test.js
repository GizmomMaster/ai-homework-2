import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { LLM_ERROR, LlmError } from "../src/llm/LlmRunner.js";
import {
  createFakeCallbackTransport,
  createFakeLlmRunner,
  muteConsole,
  startCoreApp,
  waitFor,
} from "./helpers.js";

const messagesPath = "/v1/conversations/telegram/8123/messages";

/** Отправляет сообщение с уникальным по умолчанию ключом идемпотентности. */
let keyCounter = 0;
const message = (text, idempotencyKey) => ({
  text,
  idempotencyKey: idempotencyKey ?? `tg:8123:${(keyCounter += 1)}`,
});

describe("Core целиком", () => {
  let core;
  afterEach(async () => {
    await core?.close();
    core = undefined;
  });

  describe("обработка сообщения", () => {
    it("принимает сообщение и доставляет ответ адаптеру callback'ом", async (t) => {
      muteConsole(t);
      core = await startCoreApp({
        llmRunner: createFakeLlmRunner({
          content: "ответ модели",
          promptTokens: 40,
          completionTokens: 12,
        }),
      });

      const accepted = await core.request("POST", messagesPath, { body: message("привет") });
      assert.equal(accepted.status, 202);

      await waitFor(() => core.delivered.length === 1, { label: "callback доставлен" });

      assert.deepEqual(core.delivered[0].payload, {
        jobId: accepted.json.jobId,
        adapter: "telegram",
        externalId: "8123",
        status: "completed",
        reply: { text: "ответ модели" },
        usage: { promptTokens: 40, completionTokens: 12, totalTokens: 52, contextLimit: 1000 },
      });
    });

    it("шлёт callback на адрес, заданный для адаптера", async (t) => {
      muteConsole(t);
      core = await startCoreApp();

      await core.request("POST", messagesPath, { body: message("привет") });
      await waitFor(() => core.delivered.length === 1, { label: "callback доставлен" });

      assert.equal(core.delivered[0].url, "http://adapter.test/callbacks/replies");
    });

    it("после обработки задание доступно по GET со статусом completed", async (t) => {
      muteConsole(t);
      core = await startCoreApp();

      const accepted = await core.request("POST", messagesPath, { body: message("привет") });
      await waitFor(() => core.delivered.length === 1, { label: "callback доставлен" });

      const job = await core.request("GET", `/v1/jobs/${accepted.json.jobId}`);
      assert.equal(job.json.status, "completed");
      assert.equal(job.json.reply.text, "ответ");
    });

    it("сохраняет обмен в историю и учитывает его в следующем запросе", async (t) => {
      muteConsole(t);
      const llmRunner = createFakeLlmRunner();
      core = await startCoreApp({ llmRunner });

      await core.request("POST", messagesPath, { body: message("первый") });
      await waitFor(() => core.delivered.length === 1, { label: "первый ответ" });
      await core.request("POST", messagesPath, { body: message("второй") });
      await waitFor(() => core.delivered.length === 2, { label: "второй ответ" });

      assert.deepEqual(llmRunner.calls[1], [
        { role: "user", content: "первый" },
        { role: "assistant", content: "ответ" },
        { role: "user", content: "второй" },
      ]);
    });

    it("повтор ключа идемпотентности не порождает второй запрос к модели", async (t) => {
      muteConsole(t);
      const llmRunner = createFakeLlmRunner();
      core = await startCoreApp({ llmRunner });
      const body = message("привет", "tg:8123:fixed");

      const first = await core.request("POST", messagesPath, { body });
      await waitFor(() => core.delivered.length === 1, { label: "первый ответ" });
      const second = await core.request("POST", messagesPath, { body });

      assert.equal(second.status, 200);
      assert.equal(second.json.jobId, first.json.jobId);
      assert.equal(llmRunner.calls.length, 1, "модель опрошена один раз");
    });
  });

  describe("сброс контекста", () => {
    it("после reset история не подмешивается в запрос", async (t) => {
      muteConsole(t);
      const llmRunner = createFakeLlmRunner();
      core = await startCoreApp({ llmRunner });

      await core.request("POST", messagesPath, { body: message("первый") });
      await waitFor(() => core.delivered.length === 1, { label: "первый ответ" });

      const reset = await core.request("POST", "/v1/conversations/telegram/8123/reset");
      assert.equal(reset.status, 200);
      assert.ok(reset.json.sessionId);

      await core.request("POST", messagesPath, { body: message("после сброса") });
      await waitFor(() => core.delivered.length === 2, { label: "ответ после сброса" });

      assert.deepEqual(llmRunner.calls.at(-1), [{ role: "user", content: "после сброса" }]);
    });
  });

  describe("исходы, отличные от успеха", () => {
    it("при заполненном контексте доставляет rejected с причиной", async (t) => {
      muteConsole(t);
      core = await startCoreApp({
        llmRunner: createFakeLlmRunner({
          content: "ответ",
          promptTokens: 30,
          completionTokens: 20,
        }),
        config: { contextWindowTokens: 40 },
      });

      await core.request("POST", messagesPath, { body: message("первый") });
      await waitFor(() => core.delivered.length === 1, { label: "первый ответ" });
      await core.request("POST", messagesPath, { body: message("второй") });
      await waitFor(() => core.delivered.length === 2, { label: "отказ доставлен" });

      const rejection = core.delivered[1].payload;
      assert.equal(rejection.status, "rejected");
      assert.equal(rejection.reason, "context_limit");
      assert.deepEqual(rejection.usage, { totalTokens: 50, contextLimit: 40 });
      assert.equal(rejection.reply, undefined, "текста ответа при отказе нет");
    });

    it("при недоступной модели доставляет failed с кодом причины", async (t) => {
      muteConsole(t);
      core = await startCoreApp({
        llmRunner: createFakeLlmRunner(new LlmError(LLM_ERROR.timeout, "слишком долго")),
      });

      await core.request("POST", messagesPath, { body: message("привет") });
      await waitFor(() => core.delivered.length === 1, { label: "ошибка доставлена" });

      assert.equal(core.delivered[0].payload.status, "failed");
      assert.equal(core.delivered[0].payload.reason, LLM_ERROR.timeout);
    });

    it("текст внутренней ошибки модели не утекает адаптеру", async (t) => {
      muteConsole(t);
      core = await startCoreApp({
        llmRunner: createFakeLlmRunner(
          new LlmError(LLM_ERROR.unavailable, "connection refused 10.0.0.5:11434"),
        ),
      });

      await core.request("POST", messagesPath, { body: message("привет") });
      await waitFor(() => core.delivered.length === 1, { label: "ошибка доставлена" });

      assert.ok(!JSON.stringify(core.delivered[0].payload).includes("10.0.0.5"));
    });

    it("неудачный запрос не оставляет следа в контексте", async (t) => {
      muteConsole(t);
      const llmRunner = {
        calls: [],
        shouldFail: true,
        async chat(messages) {
          this.calls.push(messages);
          if (this.shouldFail) throw new LlmError(LLM_ERROR.unavailable, "нет связи");
          return { content: "ответ", promptTokens: 10, completionTokens: 5 };
        },
      };
      core = await startCoreApp({ llmRunner });

      await core.request("POST", messagesPath, { body: message("упавший") });
      await waitFor(() => core.delivered.length === 1, { label: "ошибка доставлена" });

      llmRunner.shouldFail = false;
      await core.request("POST", messagesPath, { body: message("новый") });
      await waitFor(() => core.delivered.length === 2, { label: "успешный ответ" });

      assert.deepEqual(llmRunner.calls.at(-1), [{ role: "user", content: "новый" }]);
    });
  });

  describe("устойчивость доставки", () => {
    it("повторяет доставку, если адаптер был недоступен", async (t) => {
      muteConsole(t);
      const transport = createFakeCallbackTransport({ failTimes: 2 });
      core = await startCoreApp({ transport });

      await core.request("POST", messagesPath, { body: message("привет") });
      await waitFor(() => transport.delivered.length === 1, {
        timeoutMs: 5000,
        label: "доставка удалась после повторов",
      });

      assert.equal(transport.attemptsLeftToFail(), 0, "две попытки провалились, третья прошла");
      assert.equal(transport.delivered[0].payload.status, "completed");
    });

    it("перестаёт пытаться после исчерпания попыток", async (t) => {
      muteConsole(t);
      const transport = createFakeCallbackTransport({ failTimes: 99 });
      core = await startCoreApp({ transport, config: { contextWindowTokens: 1000 } });

      const accepted = await core.request("POST", messagesPath, { body: message("привет") });
      await waitFor(
        async () => {
          const job = await core.request("GET", `/v1/jobs/${accepted.json.jobId}`);
          return job.json.status === "completed";
        },
        { label: "задание обработано" },
      );

      // Ответ сгенерирован и сохранён, но так и не доставлен — задание
      // остаётся в БД для разбора, а не теряется молча.
      const job = await core.request("GET", `/v1/jobs/${accepted.json.jobId}`);
      assert.equal(job.json.status, "completed");
      assert.equal(transport.delivered.length, 0);
    });
  });
});
