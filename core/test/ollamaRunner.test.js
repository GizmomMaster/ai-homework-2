import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { OllamaRunner } from "../src/llm/OllamaRunner.js";
import { LLM_ERROR } from "../src/llm/LlmRunner.js";

const chatResponse = {
  message: { role: "assistant", content: "ответ модели" },
  prompt_eval_count: 120,
  eval_count: 30,
};

const messages = [{ role: "user", content: "привет" }];

/** Локальный сервер вместо Ollama: копит запросы, отвечает чем сказано. */
async function startFakeOllama(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      requests.push({ url: req.url, payload: JSON.parse(body) });
      const { status = 200, json = chatResponse, delayMs = 0 } = (await handler()) ?? {};
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(json));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    requests,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

describe("OllamaRunner", () => {
  let ollama;
  afterEach(async () => {
    await ollama?.close();
    ollama = undefined;
  });

  async function connect(handler = () => ({}), options = {}) {
    ollama = await startFakeOllama(handler);
    return new OllamaRunner({ baseUrl: ollama.baseUrl, model: "test-model", ...options });
  }

  describe("формирование запроса", () => {
    it("обращается к /api/chat без стриминга", async () => {
      const runner = await connect();

      await runner.chat(messages);

      assert.equal(ollama.requests[0].url, "/api/chat");
      assert.equal(ollama.requests[0].payload.model, "test-model");
      assert.equal(ollama.requests[0].payload.stream, false);
    });

    it("передаёт историю сообщений целиком", async () => {
      const runner = await connect();
      const history = [
        { role: "user", content: "первый" },
        { role: "assistant", content: "ответ" },
        { role: "user", content: "второй" },
      ];

      await runner.chat(history);

      assert.deepEqual(ollama.requests[0].payload.messages, history);
    });

    it("передаёт num_ctx, когда задан размер контекста", async () => {
      const runner = await connect(() => ({}), { numCtx: 50000 });

      await runner.chat(messages);

      assert.deepEqual(ollama.requests[0].payload.options, { num_ctx: 50000 });
    });

    it("не передаёт options без размера контекста", async () => {
      const runner = await connect();

      await runner.chat(messages);

      assert.equal(ollama.requests[0].payload.options, undefined);
    });

    it("не дублирует слэш в базовом URL", async () => {
      ollama = await startFakeOllama(() => ({}));
      const runner = new OllamaRunner({ baseUrl: `${ollama.baseUrl}///`, model: "test-model" });

      await runner.chat(messages);

      assert.equal(ollama.requests[0].url, "/api/chat");
    });
  });

  describe("разбор ответа", () => {
    it("возвращает текст и счётчики токенов", async () => {
      const runner = await connect();

      assert.deepEqual(await runner.chat(messages), {
        content: "ответ модели",
        promptTokens: 120,
        completionTokens: 30,
      });
    });

    it("подставляет нули, если счётчиков нет", async () => {
      const runner = await connect(() => ({
        json: { message: { role: "assistant", content: "ответ" } },
      }));

      assert.deepEqual(await runner.chat(messages), {
        content: "ответ",
        promptTokens: 0,
        completionTokens: 0,
      });
    });
  });

  describe("ошибки", () => {
    it("HTTP-ошибка Ollama → код llm_unavailable", async () => {
      const runner = await connect(() => ({ status: 404, json: { error: "model not found" } }));

      await assert.rejects(() => runner.chat(messages), (error) => {
        assert.equal(error.code, LLM_ERROR.unavailable);
        assert.match(error.message, /404/);
        return true;
      });
    });

    it("некорректный формат ответа → код llm_bad_response", async () => {
      const runner = await connect(() => ({ json: { unexpected: true } }));

      await assert.rejects(() => runner.chat(messages), (error) => {
        assert.equal(error.code, LLM_ERROR.badResponse);
        return true;
      });
    });

    it("недоступный сервер → код llm_unavailable с подсказкой", async () => {
      const runner = new OllamaRunner({ baseUrl: "http://127.0.0.1:1", model: "test-model" });

      await assert.rejects(() => runner.chat(messages), (error) => {
        assert.equal(error.code, LLM_ERROR.unavailable);
        assert.match(error.message, /Убедитесь, что Ollama запущена/);
        return true;
      });
    });

    it("превышение таймаута → код llm_timeout", async () => {
      const runner = await connect(() => ({ delayMs: 300 }), { timeoutMs: 50 });

      await assert.rejects(() => runner.chat(messages), (error) => {
        assert.equal(error.code, LLM_ERROR.timeout);
        assert.match(error.message, /не ответила за 50 мс/);
        return true;
      });
    });

    it("укладывается в таймаут — отвечает нормально", async () => {
      const runner = await connect(() => ({}), { timeoutMs: 5000 });

      assert.equal((await runner.chat(messages)).content, "ответ модели");
    });
  });
});
