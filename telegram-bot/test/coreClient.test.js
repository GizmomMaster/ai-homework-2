import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ADAPTER_NAME, CoreClient, CoreUnavailableError } from "../src/core/CoreClient.js";
import { muteConsole, startTestServer } from "./helpers.js";

const accepted = { status: 202, json: { jobId: "j_1", status: "queued" } };

describe("CoreClient", () => {
  let core;
  afterEach(async () => {
    await core?.close();
    core = undefined;
  });

  /** Клиент, направленный на локальный сервер вместо настоящего Core. */
  async function connect(handler, options = {}) {
    core = await startTestServer(handler);
    return new CoreClient({ baseUrl: core.baseUrl, retries: 0, retryDelayMs: 1, ...options });
  }

  describe("sendMessage", () => {
    it("обращается к эндпоинту диалога нужного адаптера", async () => {
      const client = await connect(() => accepted);

      await client.sendMessage({ chatId: 8123, text: "привет", updateId: 4471 });

      assert.equal(core.requests[0].method, "POST");
      assert.equal(core.requests[0].url, `/v1/conversations/${ADAPTER_NAME}/8123/messages`);
    });

    it("строит ключ идемпотентности из update_id Telegram", async () => {
      const client = await connect(() => accepted);

      await client.sendMessage({ chatId: 8123, text: "привет", updateId: 4471 });

      assert.deepEqual(core.requests[0].payload, {
        text: "привет",
        idempotencyKey: "telegram:8123:4471",
      });
    });

    it("возвращает описание задания", async () => {
      const client = await connect(() => accepted);

      const job = await client.sendMessage({ chatId: 1, text: "привет", updateId: 1 });

      assert.deepEqual(job, { jobId: "j_1", status: "queued" });
    });

    it("экранирует небезопасные символы в chatId", async () => {
      const client = await connect(() => accepted);

      await client.sendMessage({ chatId: "a/b", text: "привет", updateId: 1 });

      assert.equal(core.requests[0].url, `/v1/conversations/${ADAPTER_NAME}/a%2Fb/messages`);
    });
  });

  describe("reset", () => {
    it("обращается к эндпоинту сброса без тела", async () => {
      const client = await connect(() => ({ json: { conversationId: 1, sessionId: 2 } }));

      const result = await client.reset({ chatId: 8123 });

      assert.equal(core.requests[0].url, `/v1/conversations/${ADAPTER_NAME}/8123/reset`);
      assert.deepEqual(result, { conversationId: 1, sessionId: 2 });
    });
  });

  describe("недоступность Core", () => {
    it("повторяет попытку и добивается успеха", async (t) => {
      muteConsole(t);
      let attempts = 0;
      const client = await connect(
        () => {
          attempts += 1;
          return attempts < 3 ? { status: 503, json: { error: "unavailable" } } : accepted;
        },
        { retries: 3 },
      );

      const job = await client.sendMessage({ chatId: 1, text: "привет", updateId: 1 });

      assert.equal(attempts, 3, "две неудачи, третья попытка успешна");
      assert.equal(job.jobId, "j_1");
    });

    it("сдаётся после исчерпания попыток", async (t) => {
      muteConsole(t);
      const client = await connect(() => ({ status: 503, json: { error: "unavailable" } }), {
        retries: 2,
      });

      await assert.rejects(
        () => client.sendMessage({ chatId: 1, text: "привет", updateId: 1 }),
        CoreUnavailableError,
      );
    });

    it("сообщает адрес, по которому Core не отвечает", async () => {
      const client = new CoreClient({ baseUrl: "http://127.0.0.1:1", retries: 0 });

      await assert.rejects(
        () => client.sendMessage({ chatId: 1, text: "привет", updateId: 1 }),
        /Core недоступен по адресу http:\/\/127\.0\.0\.1:1/,
      );
    });

    it("обрывает запрос по таймауту", async () => {
      const client = await connect(() => ({ ...accepted, delayMs: 300 }), { timeoutMs: 50 });

      await assert.rejects(
        () => client.sendMessage({ chatId: 1, text: "привет", updateId: 1 }),
        CoreUnavailableError,
      );
    });
  });

  describe("отказ Core", () => {
    it("не повторяет запрос при ошибке 4xx", async () => {
      let attempts = 0;
      const client = await connect(
        () => {
          attempts += 1;
          return {
            status: 400,
            json: { error: { code: "invalid_request", message: 'Поле "text" обязательно.' } },
          };
        },
        { retries: 3 },
      );

      await assert.rejects(
        () => client.sendMessage({ chatId: 1, text: "привет", updateId: 1 }),
        /Поле "text" обязательно/,
      );
      assert.equal(attempts, 1, "повторять неверный запрос бессмысленно");
    });
  });

  describe("обзор рынка", () => {
    it("не повторяет запрос, даже когда повторы включены", async () => {
      let attempts = 0;
      const client = await connect(
        () => {
          attempts += 1;
          return { status: 502, json: {} };
        },
        { retries: 3 },
      );

      await assert.rejects(() => client.marketOverview());
      // Истёкший таймаут здесь значит «модель пишет медленно». Повтор
      // заставил бы её начать генерацию заново и только отдалил бы ответ.
      assert.equal(attempts, 1, "сводку повторять нельзя: это новая генерация");
    });

    it("ждёт дольше обычного запроса", async () => {
      const client = new CoreClient({ baseUrl: "http://core.test", timeoutMs: 10 });
      assert.ok(
        client.overviewTimeoutMs > client.timeoutMs,
        "Core тратит на сводку вызов модели, а не только запрос к бирже",
      );
    });
  });

  describe("нормализация базового URL", () => {
    it("не дублирует слэш", async () => {
      core = await startTestServer(() => accepted);
      const client = new CoreClient({ baseUrl: `${core.baseUrl}///`, retries: 0 });

      await client.sendMessage({ chatId: 1, text: "привет", updateId: 1 });

      assert.equal(core.requests[0].url, `/v1/conversations/${ADAPTER_NAME}/1/messages`);
    });
  });
});
