import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { LmStudioRunner } from "../src/llm/LmStudioRunner.js";
import { LLM_ERROR } from "../src/llm/LlmRunner.js";

const chatResponse = {
  choices: [{ message: { role: "assistant", content: "ответ модели" } }],
  usage: { prompt_tokens: 120, completion_tokens: 30 },
};

const messages = [{ role: "user", content: "привет" }];

/** Локальный сервер вместо LM Studio: копит запросы, отвечает чем сказано. */
async function startFakeLmStudio(handler) {
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

describe("LmStudioRunner", () => {
  let lmStudio;
  afterEach(async () => {
    await lmStudio?.close();
    lmStudio = undefined;
  });

  async function connect(handler = () => ({}), options = {}) {
    lmStudio = await startFakeLmStudio(handler);
    return new LmStudioRunner({ baseUrl: lmStudio.baseUrl, model: "test-model", ...options });
  }

  describe("формирование запроса", () => {
    it("обращается к /v1/chat/completions без стриминга", async () => {
      const runner = await connect();

      await runner.chat(messages);

      assert.equal(lmStudio.requests[0].url, "/v1/chat/completions");
      assert.equal(lmStudio.requests[0].payload.model, "test-model");
      assert.equal(lmStudio.requests[0].payload.stream, false);
    });

    it("передаёт историю сообщений целиком", async () => {
      const runner = await connect();
      const history = [
        { role: "user", content: "первый" },
        { role: "assistant", content: "ответ" },
        { role: "user", content: "второй" },
      ];

      await runner.chat(history);

      assert.deepEqual(lmStudio.requests[0].payload.messages, history);
    });

    it("передаёт температуру полем верхнего уровня", async () => {
      const runner = await connect();

      await runner.chat(messages, { temperature: 0 });

      assert.equal(lmStudio.requests[0].payload.temperature, 0);
    });

    it("без температуры настройка модели не трогается", async () => {
      const runner = await connect();

      await runner.chat(messages);

      assert.equal("temperature" in lmStudio.requests[0].payload, false);
    });

    it("передаёт системное сообщение вместе с историей", async () => {
      const runner = await connect();
      const withSystem = [
        { role: "system", content: "ты маршрутизатор" },
        { role: "user", content: "привет" },
      ];

      await runner.chat(withSystem);

      assert.deepEqual(lmStudio.requests[0].payload.messages, withSystem);
    });

    it("оборачивает JSON Schema в response_format", async () => {
      const runner = await connect();
      const schema = { type: "object", properties: { intent: { type: "string" } } };

      await runner.chat(messages, { format: schema });

      assert.deepEqual(lmStudio.requests[0].payload.response_format, {
        type: "json_schema",
        json_schema: { name: "response", strict: true, schema },
      });
    });

    it('формат "json" оборачивается в json_object', async () => {
      const runner = await connect();

      await runner.chat(messages, { format: "json" });

      assert.deepEqual(lmStudio.requests[0].payload.response_format, { type: "json_object" });
    });

    it("не передаёт response_format, когда формат не запрошен", async () => {
      const runner = await connect();

      await runner.chat(messages);

      assert.equal(lmStudio.requests[0].payload.response_format, undefined);
    });

    it("не дублирует слэш в базовом URL", async () => {
      lmStudio = await startFakeLmStudio(() => ({}));
      const runner = new LmStudioRunner({ baseUrl: `${lmStudio.baseUrl}///`, model: "test-model" });

      await runner.chat(messages);

      assert.equal(lmStudio.requests[0].url, "/v1/chat/completions");
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
        json: { choices: [{ message: { role: "assistant", content: "ответ" } }] },
      }));

      assert.deepEqual(await runner.chat(messages), {
        content: "ответ",
        promptTokens: 0,
        completionTokens: 0,
      });
    });
  });

  describe("блок размышления", () => {
    it("вырезается из ответа модели", async () => {
      const runner = await connect(() => ({
        json: {
          choices: [{ message: { role: "assistant", content: "<think>прикидываю</think>\n\nОтвет" } }],
          usage: { prompt_tokens: 10, completion_tokens: 40 },
        },
      }));

      assert.equal((await runner.chat(messages)).content, "Ответ");
    });

    it("ответ целиком из размышления → код llm_bad_response", async () => {
      const runner = await connect(() => ({
        json: { choices: [{ message: { role: "assistant", content: "<think>только думал</think>" } }] },
      }));

      await assert.rejects(() => runner.chat(messages), (error) => {
        assert.equal(error.code, LLM_ERROR.badResponse);
        assert.match(error.message, /пустой ответ/);
        return true;
      });
    });
  });

  describe("ошибки", () => {
    it("HTTP-ошибка LM Studio → код llm_unavailable", async () => {
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
      const runner = new LmStudioRunner({ baseUrl: "http://127.0.0.1:1", model: "test-model" });

      await assert.rejects(() => runner.chat(messages), (error) => {
        assert.equal(error.code, LLM_ERROR.unavailable);
        assert.match(error.message, /Убедитесь, что в LM Studio запущен локальный сервер/);
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
