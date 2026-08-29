import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProgressNotifier } from "../src/jobs/ProgressNotifier.js";
import { muteConsole } from "./helpers.js";

const job = { id: "j_1" };
const conversation = { adapter: "telegram", externalId: "8123" };

/** Заглушка fetch: копит запросы, отвечает или падает по требованию теста. */
function fakeFetch({ fail } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, ...options, payload: JSON.parse(options.body) });
    if (fail) throw new Error("адаптер недоступен");
    return { ok: true, status: 200 };
  };
  return { calls, fetchImpl };
}

/** notify() не await'ится вызывающим кодом — ждём микротаск, чтобы её fetch успел уйти. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("ProgressNotifier", () => {
  it("отправляет статус на callback-адрес адаптера", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const notifier = new ProgressNotifier({
      callbackUrls: { telegram: "http://adapter.test/callbacks/replies" },
      fetchImpl,
    });

    notifier.notify(job, conversation, { stage: "planning" });
    await flush();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://adapter.test/callbacks/replies");
    assert.deepEqual(calls[0].payload, {
      jobId: "j_1",
      adapter: "telegram",
      externalId: "8123",
      status: "progress",
      progress: { stage: "planning" },
    });
  });

  it("подписывает запрос общим секретом, если он задан", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const notifier = new ProgressNotifier({
      callbackUrls: { telegram: "http://adapter.test/callbacks/replies" },
      authToken: "s3cret",
      fetchImpl,
    });

    notifier.notify(job, conversation, { stage: "routing" });
    await flush();

    assert.equal(calls[0].headers["X-Core-Token"], "s3cret");
  });

  it("без адреса адаптера ничего не отправляет", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const notifier = new ProgressNotifier({ callbackUrls: {}, fetchImpl });

    notifier.notify(job, conversation, { stage: "routing" });
    await flush();

    assert.equal(calls.length, 0);
  });

  it("не бросает и не роняет процесс, если доставка не удалась", async (t) => {
    muteConsole(t);
    const { fetchImpl } = fakeFetch({ fail: true });
    const notifier = new ProgressNotifier({
      callbackUrls: { telegram: "http://adapter.test/callbacks/replies" },
      fetchImpl,
    });

    assert.doesNotThrow(() => notifier.notify(job, conversation, { stage: "routing" }));
    await flush();
  });

  it("не await'ится вызывающим кодом — не задерживает обработку задания", async () => {
    let resolveFetch;
    const fetchImpl = () => new Promise((resolve) => (resolveFetch = resolve));
    const notifier = new ProgressNotifier({
      callbackUrls: { telegram: "http://adapter.test/callbacks/replies" },
      fetchImpl,
    });

    const startedAt = Date.now();
    notifier.notify(job, conversation, { stage: "routing" });
    assert.ok(Date.now() - startedAt < 50, "notify() вернулась немедленно");

    resolveFetch({ ok: true, status: 200 });
  });
});
