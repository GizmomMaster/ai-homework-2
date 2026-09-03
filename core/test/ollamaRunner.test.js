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
      const { status = 200, json = chatResponse, raw, delayMs = 0 } = (await handler()) ?? {};
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      res.writeHead(status, { "Content-Type": "application/json" });
      // `raw` — тело как есть: так отвечает прокси или туннель, вклинившийся
      // перед провайдером, и статус при этом остаётся 200.
      res.end(raw ?? JSON.stringify(json));
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

    it("передаёт температуру в options", async () => {
      const runner = await connect(() => ({}), { numCtx: 4096 });

      await runner.chat(messages, { temperature: 0 });

      assert.deepEqual(ollama.requests[0].payload.options, { num_ctx: 4096, temperature: 0 });
    });

    it("температура работает и без размера контекста", async () => {
      const runner = await connect();

      await runner.chat(messages, { temperature: 0.7 });

      assert.deepEqual(ollama.requests[0].payload.options, { temperature: 0.7 });
    });

    it("без температуры настройка модели не трогается", async () => {
      const runner = await connect(() => ({}), { numCtx: 4096 });

      await runner.chat(messages);

      assert.equal("temperature" in ollama.requests[0].payload.options, false);
    });

    it("не передаёт options без размера контекста", async () => {
      const runner = await connect();

      await runner.chat(messages);

      assert.equal(ollama.requests[0].payload.options, undefined);
    });

    it("передаёт системное сообщение вместе с историей", async () => {
      const runner = await connect();
      const withSystem = [
        { role: "system", content: "ты маршрутизатор" },
        { role: "user", content: "привет" },
      ];

      await runner.chat(withSystem);

      assert.deepEqual(ollama.requests[0].payload.messages, withSystem);
    });

    it("передаёт JSON Schema в поле format", async () => {
      const runner = await connect();
      const schema = { type: "object", properties: { intent: { type: "string" } } };

      await runner.chat(messages, { format: schema });

      assert.deepEqual(ollama.requests[0].payload.format, schema);
    });

    it("не передаёт format, когда он не запрошен", async () => {
      const runner = await connect();

      await runner.chat(messages);

      assert.equal(ollama.requests[0].payload.format, undefined);
    });

    it("по умолчанию отключает размышление", async () => {
      const runner = await connect();

      await runner.chat(messages);

      assert.equal(ollama.requests[0].payload.think, false);
    });

    it("вызов может переопределить режим размышления", async () => {
      const runner = await connect();

      await runner.chat(messages, { think: true });

      assert.equal(ollama.requests[0].payload.think, true);
    });

    it("при think=omit поле не отправляется совсем", async () => {
      const runner = await connect(() => ({}), { think: "omit" });

      await runner.chat(messages);

      assert.equal("think" in ollama.requests[0].payload, false);
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
        reasoningTokens: 0,
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
        reasoningTokens: 0,
      });
    });
  });

  describe("блок размышления", () => {
    it("вырезается из ответа модели", async () => {
      const runner = await connect(() => ({
        json: {
          message: { role: "assistant", content: "<think>прикидываю</think>\n\nОтвет" },
          eval_count: 40,
        },
      }));

      assert.equal((await runner.chat(messages)).content, "Ответ");
    });

    it("вырезается и незакрытый блок при обрыве генерации", async () => {
      const runner = await connect(() => ({
        json: { message: { role: "assistant", content: "Ответ\n<think>не дописал" } },
      }));

      assert.equal((await runner.chat(messages)).content, "Ответ");
    });

    it("ответ целиком из размышления → код llm_bad_response", async () => {
      const runner = await connect(() => ({
        json: { message: { role: "assistant", content: "<think>только думал</think>" } },
      }));

      await assert.rejects(() => runner.chat(messages), (error) => {
        assert.equal(error.code, LLM_ERROR.badResponse);
        assert.match(error.message, /пустой ответ/);
        return true;
      });
    });

    it("счётчики токенов не теряются при вырезании", async () => {
      const runner = await connect(() => ({
        json: {
          message: { role: "assistant", content: "<think>ага</think>Ответ" },
          prompt_eval_count: 11,
          eval_count: 22,
        },
      }));

      assert.deepEqual(await runner.chat(messages), {
        content: "Ответ",
        promptTokens: 11,
        completionTokens: 22,
        reasoningTokens: 10,
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

    // Тело, которое вообще не JSON, — это ответ прокси или туннеля перед
    // провайдером, и приходит он со статусом 200. Пока его читал голый
    // response.json(), наружу летел SyntaxError: DialogService такой код не
    // опознаёт и записывал задание как internal_error — «баг у нас» вместо
    // «провайдер ответил не тем».
    it("не-JSON при статусе 200 → код llm_bad_response, а не внутренняя ошибка", async () => {
      const runner = await connect(() => ({ raw: "<html><body>502 Bad Gateway</body></html>" }));

      await assert.rejects(() => runner.chat(messages), (error) => {
        assert.equal(error.name, "LlmError");
        assert.equal(error.code, LLM_ERROR.badResponse);
        assert.match(error.message, /не JSON/);
        // Тело прикладывается: догадка о причине без него бесполезна.
        assert.match(error.message, /502 Bad Gateway/);
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

    describe("подробности в сообщении", () => {
      it("прикладывает тело ответа и размер запроса", async () => {
        const runner = await connect(() => ({ json: { unexpected: "нечто" } }));

        await assert.rejects(() => runner.chat(messages), (error) => {
          assert.match(error.message, /"unexpected":"нечто"/);
          assert.match(error.message, /знаков/);
          return true;
        });
      });

      it("узнаёт обрыв по длине контекста", async () => {
        const runner = await connect(() => ({ json: { done_reason: "length" } }));

        await assert.rejects(() => runner.chat(messages), (error) => {
          assert.match(error.message, /done_reason=length/);
          assert.match(error.message, /num_ctx/);
          return true;
        });
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
