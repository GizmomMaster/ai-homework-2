import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { OllamaRunner } from "../src/llm/OllamaRunner.js";
import { startTestServer } from "./helpers.js";

const chatResponse = {
  json: {
    message: { role: "assistant", content: "ответ модели" },
    prompt_eval_count: 120,
    eval_count: 30,
  },
};

const messages = [{ role: "user", content: "привет" }];

describe("OllamaRunner", () => {
  let server;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  /** Раннер, направленный на локальный тестовый сервер вместо Ollama. */
  async function connectRunner(handler, options = {}) {
    server = await startTestServer(handler);
    return new OllamaRunner({ baseUrl: server.baseUrl, model: "test-model", ...options });
  }

  describe("формирование запроса", () => {
    it("обращается к /api/chat без стриминга", async () => {
      const runner = await connectRunner(() => chatResponse);

      await runner.chat(messages);

      assert.equal(server.requests[0].url, "/api/chat");
      assert.equal(server.requests[0].payload.model, "test-model");
      assert.equal(server.requests[0].payload.stream, false);
    });

    it("передаёт историю сообщений целиком", async () => {
      const runner = await connectRunner(() => chatResponse);
      const history = [
        { role: "user", content: "первый" },
        { role: "assistant", content: "ответ" },
        { role: "user", content: "второй" },
      ];

      await runner.chat(history);

      assert.deepEqual(server.requests[0].payload.messages, history);
    });

    it("передаёт num_ctx, когда задан размер контекста (регрессия)", async () => {
      const runner = await connectRunner(() => chatResponse, { numCtx: 50000 });

      await runner.chat(messages);

      assert.deepEqual(server.requests[0].payload.options, { num_ctx: 50000 });
    });

    it("не передаёт options, когда размер контекста не задан", async () => {
      const runner = await connectRunner(() => chatResponse);

      await runner.chat(messages);

      assert.equal(server.requests[0].payload.options, undefined);
    });

    it("не дублирует слэш в базовом URL", async () => {
      server = await startTestServer(() => chatResponse);
      const runner = new OllamaRunner({ baseUrl: `${server.baseUrl}///`, model: "test-model" });

      await runner.chat(messages);

      assert.equal(server.requests[0].url, "/api/chat");
    });
  });

  describe("разбор ответа", () => {
    it("возвращает текст и счётчики токенов", async () => {
      const runner = await connectRunner(() => chatResponse);

      assert.deepEqual(await runner.chat(messages), {
        content: "ответ модели",
        promptTokens: 120,
        completionTokens: 30,
      });
    });

    it("подставляет нули, если Ollama не прислала счётчики", async () => {
      const runner = await connectRunner(() => ({
        json: { message: { role: "assistant", content: "ответ" } },
      }));

      assert.deepEqual(await runner.chat(messages), {
        content: "ответ",
        promptTokens: 0,
        completionTokens: 0,
      });
    });
  });

  describe("обработка ошибок", () => {
    it("сообщает об HTTP-ошибке Ollama", async () => {
      const runner = await connectRunner(() => ({
        status: 404,
        json: { error: 'model "test-model" not found' },
      }));

      await assert.rejects(() => runner.chat(messages), /404/);
    });

    it("сообщает о некорректном формате ответа", async () => {
      const runner = await connectRunner(() => ({ json: { unexpected: true } }));

      await assert.rejects(() => runner.chat(messages), /Некорректный формат ответа/);
    });

    it("подсказывает проверить запуск Ollama, если сервер недоступен", async () => {
      // Порт, на котором заведомо никто не слушает
      const runner = new OllamaRunner({ baseUrl: "http://127.0.0.1:1", model: "test-model" });

      await assert.rejects(() => runner.chat(messages), /Убедитесь, что Ollama запущена/);
    });

    it("обрывает запрос по таймауту и объясняет причину", async () => {
      const runner = await connectRunner(() => ({ ...chatResponse, delayMs: 300 }), {
        timeoutMs: 50,
      });

      await assert.rejects(() => runner.chat(messages), /не ответила за 50 мс/);
    });

    it("успевает ответить, если укладывается в таймаут", async () => {
      const runner = await connectRunner(() => chatResponse, { timeoutMs: 5000 });

      const result = await runner.chat(messages);

      assert.equal(result.content, "ответ модели");
    });
  });
});
