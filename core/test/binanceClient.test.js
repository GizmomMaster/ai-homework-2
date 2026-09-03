import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { BinanceClient } from "../src/tools/BinanceClient.js";
import { CoinGeckoClient } from "../src/tools/CoinGeckoClient.js";
import { TtlCache } from "../src/tools/cache.js";
import { TOOL_ERROR } from "../src/tools/errors.js";

/** Локальный сервер вместо биржи. */
async function startFakeExchange(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    const { status = 200, body = {}, delayMs = 0, raw } = handler(req) ?? {};
    setTimeout(() => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(raw ?? JSON.stringify(body));
    }, delayMs);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    requests,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

describe("BinanceClient", () => {
  let exchange;
  afterEach(async () => {
    await exchange?.close();
    exchange = undefined;
  });

  async function connect(handler = () => ({}), options = {}) {
    exchange = await startFakeExchange(handler);
    return new BinanceClient({ baseUrl: exchange.baseUrl, ...options });
  }

  describe("построение запроса", () => {
    it("складывает путь и параметры", async () => {
      const client = await connect(() => ({ body: { ok: true } }));

      await client.get("/api/v3/ticker/24hr", { symbol: "BTCUSDT" });

      assert.equal(exchange.requests[0], "/api/v3/ticker/24hr?symbol=BTCUSDT");
    });

    it("пропускает незаданные параметры", async () => {
      const client = await connect(() => ({ body: [] }));

      await client.get("/api/v3/klines", { symbol: "BTCUSDT", startTime: undefined });

      assert.equal(exchange.requests[0], "/api/v3/klines?symbol=BTCUSDT");
    });

    it("экранирует значения, а не склеивает строки", async () => {
      // Проверка параметров сюда такое не пропустит, но клиент обязан быть
      // безопасным сам по себе: он последний рубеж перед сетью.
      const client = await connect(() => ({ body: {} }));

      await client.get("/api/v3/ticker/24hr", { symbol: "A&limit=9999" });

      assert.equal(exchange.requests[0], "/api/v3/ticker/24hr?symbol=A%26limit%3D9999");
    });

    it("не дублирует слэш в базовом адресе", async () => {
      exchange = await startFakeExchange(() => ({ body: {} }));
      const client = new BinanceClient({ baseUrl: `${exchange.baseUrl}///` });

      await client.get("/api/v3/ping");

      assert.equal(exchange.requests[0], "/api/v3/ping");
    });
  });

  describe("коды отказа", () => {
    it("429 — rate_limited", async () => {
      const client = await connect(() => ({ status: 429, body: { msg: "too many" } }));

      await assert.rejects(() => client.get("/api/v3/ping"), (error) => {
        assert.equal(error.code, TOOL_ERROR.rateLimited);
        return true;
      });
    });

    it("418 — тоже rate_limited: так биржа отвечает упорным", async () => {
      const client = await connect(() => ({ status: 418, body: {} }));

      await assert.rejects(() => client.get("/api/v3/ping"), (error) => {
        assert.equal(error.code, TOOL_ERROR.rateLimited);
        return true;
      });
    });

    it("код -1121 — unknown_symbol, а не общая ошибка", async () => {
      const client = await connect(() => ({
        status: 400,
        body: { code: -1121, msg: "Invalid symbol." },
      }));

      await assert.rejects(() => client.get("/api/v3/ticker/24hr"), (error) => {
        assert.equal(error.code, TOOL_ERROR.unknownSymbol);
        return true;
      });
    });

    it("прочая ошибка биржи — upstream_error", async () => {
      const client = await connect(() => ({ status: 503, body: {} }));

      await assert.rejects(() => client.get("/api/v3/ping"), (error) => {
        assert.equal(error.code, TOOL_ERROR.upstreamError);
        return true;
      });
    });

    it("тело не JSON — upstream_error", async () => {
      const client = await connect(() => ({ raw: "<html>ошибка шлюза</html>" }));

      await assert.rejects(() => client.get("/api/v3/ping"), (error) => {
        assert.equal(error.code, TOOL_ERROR.upstreamError);
        return true;
      });
    });

    it("превышение таймаута — timeout", async () => {
      const client = await connect(() => ({ delayMs: 300 }), { timeoutMs: 50 });

      await assert.rejects(() => client.get("/api/v3/ping"), (error) => {
        assert.equal(error.code, TOOL_ERROR.timeout);
        return true;
      });
    });

    it("недоступный адрес — unavailable", async () => {
      const client = new BinanceClient({ baseUrl: "http://127.0.0.1:1" });

      await assert.rejects(() => client.get("/api/v3/ping"), (error) => {
        assert.equal(error.code, TOOL_ERROR.unavailable);
        return true;
      });
    });
  });
});

// Механика запроса у обоих клиентов общая (PublicApiClient), своего —
// разбор кодов ответа и род названия в сообщениях. Проверяем и то, и другое:
// «CoinGecko ответила» читалось бы как опечатка, а лимит частоты у него
// штатный исход, а не поломка.
describe("CoinGeckoClient", () => {
  let source;
  afterEach(async () => {
    await source?.close();
    source = undefined;
  });

  async function connect(handler = () => ({}), options = {}) {
    source = await startFakeExchange(handler);
    return new CoinGeckoClient({ baseUrl: source.baseUrl, ...options });
  }

  it("складывает путь и параметры, как и клиент биржи", async () => {
    const client = await connect(() => ({ body: [] }));

    await client.get("/api/v3/coins/markets", { vs_currency: "usd", per_page: 30 });

    assert.equal(source.requests[0], "/api/v3/coins/markets?vs_currency=usd&per_page=30");
  });

  it("пропускает неопределённые параметры", async () => {
    const client = await connect(() => ({ body: [] }));

    await client.get("/api/v3/coins/markets", { vs_currency: "usd", days: undefined });

    assert.equal(source.requests[0], "/api/v3/coins/markets?vs_currency=usd");
  });

  it("429 — rate_limited: на бесплатном тарифе это штатный исход", async () => {
    const client = await connect(() => ({ status: 429, body: {} }));

    await assert.rejects(() => client.get("/api/v3/ping"), (error) => {
      assert.equal(error.code, TOOL_ERROR.rateLimited);
      return true;
    });
  });

  it("прочая ошибка — upstream_error, и в мужском роде", async () => {
    const client = await connect(() => ({ status: 503, body: {} }));

    await assert.rejects(() => client.get("/api/v3/ping"), (error) => {
      assert.equal(error.code, TOOL_ERROR.upstreamError);
      assert.match(error.message, /CoinGecko ответил 503/);
      return true;
    });
  });

  it("тело не JSON — upstream_error", async () => {
    const client = await connect(() => ({ raw: "<html>шлюз</html>" }));

    await assert.rejects(() => client.get("/api/v3/ping"), (error) => {
      assert.equal(error.code, TOOL_ERROR.upstreamError);
      assert.match(error.message, /CoinGecko вернул не JSON/);
      return true;
    });
  });

  it("превышение таймаута — timeout", async () => {
    const client = await connect(() => ({ delayMs: 300 }), { timeoutMs: 50 });

    await assert.rejects(() => client.get("/api/v3/ping"), (error) => {
      assert.equal(error.code, TOOL_ERROR.timeout);
      assert.match(error.message, /CoinGecko не ответил за 50 мс/);
      return true;
    });
  });

  it("недоступный адрес — unavailable", async () => {
    const client = new CoinGeckoClient({ baseUrl: "http://127.0.0.1:1" });

    await assert.rejects(() => client.get("/api/v3/ping"), (error) => {
      assert.equal(error.code, TOOL_ERROR.unavailable);
      return true;
    });
  });
});

describe("TtlCache", () => {
  /** Управляемые часы: полагаться на реальное время в тестах незачем. */
  function clock(start = 1000) {
    let now = start;
    return { now: () => now, advance: (ms) => (now += ms) };
  }

  it("второй запрос за тем же ключом не доходит до источника", async () => {
    const cache = new TtlCache(clock());
    let calls = 0;
    const produce = async () => ++calls;

    assert.equal(await cache.through("k", 1000, produce), 1);
    assert.equal(await cache.through("k", 1000, produce), 1);
    assert.equal(calls, 1);
  });

  // Шаги плана выполняются одновременно (CONCURRENCY в PlanExecutor), и два
  // шага по одной паре начинаются раньше, чем первый успевает дойти до
  // источника. Ради этого случая кеш и заведён — квота биржи считается на
  // адрес, а не на задание.
  it("одновременные запросы за одним ключом опрашивают источник один раз", async () => {
    const cache = new TtlCache(clock());
    let calls = 0;
    const produce = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return "значение";
    };

    const results = await Promise.all([
      cache.through("k", 1000, produce),
      cache.through("k", 1000, produce),
      cache.through("k", 1000, produce),
    ]);

    assert.equal(calls, 1, "источник опрошен один раз");
    assert.deepEqual(results, ["значение", "значение", "значение"]);
  });

  it("одновременный отказ не запоминается: следующий запрос пробует снова", async () => {
    const cache = new TtlCache(clock());
    let calls = 0;
    const produce = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (calls === 1) throw new Error("биржа оборвала соединение");
      return "получилось";
    };

    const outcomes = await Promise.allSettled([
      cache.through("k", 1000, produce),
      cache.through("k", 1000, produce),
    ]);

    // Ждали одного и того же похода — оба получили одну и ту же неудачу.
    assert.deepEqual(outcomes.map((o) => o.status), ["rejected", "rejected"]);
    assert.equal(calls, 1);

    assert.equal(await cache.through("k", 1000, produce), "получилось");
    assert.equal(calls, 2, "отказ не закрепился на время жизни записи");
  });

  it("одновременный undefined не запоминается — договор тот же, что у отказа", async () => {
    const cache = new TtlCache(clock());
    let calls = 0;
    const produce = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return calls === 1 ? undefined : "получилось";
    };

    assert.deepEqual(
      await Promise.all([cache.through("k", 1000, produce), cache.through("k", 1000, produce)]),
      [undefined, undefined],
    );
    assert.equal(cache.size, 0, "пустой ответ не осел в кеше");

    assert.equal(await cache.through("k", 1000, produce), "получилось");
  });

  it("после истечения срока источник опрашивается снова", async () => {
    const time = clock();
    const cache = new TtlCache(time);
    let calls = 0;
    const produce = async () => ++calls;

    await cache.through("k", 1000, produce);
    time.advance(1001);
    await cache.through("k", 1000, produce);

    assert.equal(calls, 2);
  });

  it("разные ключи не смешиваются", async () => {
    const cache = new TtlCache(clock());

    assert.equal(await cache.through("a", 1000, async () => "первый"), "первый");
    assert.equal(await cache.through("b", 1000, async () => "второй"), "второй");
  });

  it("нулевое время жизни отключает кеширование", async () => {
    const cache = new TtlCache(clock());
    let calls = 0;
    const produce = async () => ++calls;

    await cache.through("k", 0, produce);
    await cache.through("k", 0, produce);

    assert.equal(calls, 2);
    assert.equal(cache.size, 0);
  });

  it("не растёт бесконечно", async () => {
    const cache = new TtlCache({ maxEntries: 10, now: () => 1000 });

    for (let i = 0; i < 50; i += 1) {
      await cache.through(`k${i}`, 60_000, async () => i);
    }

    assert.ok(cache.size <= 10, `размер ${cache.size}`);
  });

  it("при переполнении первым выбрасывает просроченное", async () => {
    const time = clock();
    const cache = new TtlCache({ maxEntries: 3, now: time.now });

    await cache.through("короткий", 100, async () => "a");
    await cache.through("долгий-1", 60_000, async () => "b");
    await cache.through("долгий-2", 60_000, async () => "c");
    time.advance(200);
    await cache.through("новый", 60_000, async () => "d");

    // Просроченный ушёл, живые остались.
    let recomputed = false;
    await cache.through("долгий-1", 60_000, async () => {
      recomputed = true;
      return "b2";
    });
    assert.equal(recomputed, false);
  });
});
