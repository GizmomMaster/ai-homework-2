import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { startPolling } from "../src/telegram/polling.js";
import {
  createFakeCoreClient,
  createFakeTelegramClient,
  muteConsole,
  waitFor,
} from "./helpers.js";

/**
 * Запускает polling поверх заглушек Telegram и Core, отдавая управление
 * тестом: подкладывание апдейтов, ожидание и остановку цикла.
 */
function startTestBot({
  maxMessageLength = 1000,
  coreOptions,
  retryDelayMs = 10,
  maxRetryDelayMs,
} = {}) {
  const telegramClient = createFakeTelegramClient();
  const coreClient = createFakeCoreClient(coreOptions);
  const queue = [];
  let nextUpdateId = 1;

  telegramClient.getUpdates = async ({ signal }) => {
    if (queue.length > 0) return queue.splice(0, queue.length);
    // Имитируем long polling: ждём новых сообщений или остановки бота.
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 20);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
    return [];
  };

  const controller = new AbortController();
  const finished = startPolling({
    telegramClient,
    coreClient,
    maxMessageLength,
    signal: controller.signal,
    retryDelayMs,
    maxRetryDelayMs,
  });

  return {
    telegramClient,
    coreClient,
    push(message) {
      queue.push({ update_id: nextUpdateId++, message });
    },
    pushText(text, chatId = 8123) {
      this.push({ chat: { id: chatId }, text });
    },
    async stop() {
      controller.abort();
      await finished;
    },
  };
}

describe("startPolling", () => {
  it("передаёт сообщение в Core и ничего не отвечает сразу", async (t) => {
    muteConsole(t);
    const bot = startTestBot();
    t.after(() => bot.stop());

    bot.pushText("привет");
    await waitFor(() => bot.coreClient.sentMessages.length === 1, { label: "сообщение ушло в Core" });

    assert.equal(bot.coreClient.sentMessages[0].text, "привет");
    assert.equal(bot.coreClient.sentMessages[0].chatId, 8123);
    assert.equal(
      bot.telegramClient.sent.length,
      0,
      "ответ придёт позже через callback, а не сразу",
    );
  });

  it("передаёт update_id для ключа идемпотентности", async (t) => {
    muteConsole(t);
    const bot = startTestBot();
    t.after(() => bot.stop());

    bot.pushText("привет");
    await waitFor(() => bot.coreClient.sentMessages.length === 1, { label: "сообщение ушло" });

    assert.equal(bot.coreClient.sentMessages[0].updateId, 1);
  });

  it("предупреждает про не-текстовое сообщение, не обращаясь к Core", async (t) => {
    muteConsole(t);
    const bot = startTestBot();
    t.after(() => bot.stop());

    bot.push({ chat: { id: 8123 }, photo: [{ file_id: "abc" }] });
    await waitFor(() => bot.telegramClient.sent.length === 1, { label: "предупреждение" });

    assert.match(bot.telegramClient.lastText(), /только текстовые сообщения/i);
    assert.equal(bot.coreClient.sentMessages.length, 0);
  });

  it("отклоняет слишком длинное сообщение до обращения к Core", async (t) => {
    muteConsole(t);
    const bot = startTestBot({ maxMessageLength: 10 });
    t.after(() => bot.stop());

    bot.pushText("это сообщение заведомо длиннее лимита");
    await waitFor(() => bot.telegramClient.sent.length === 1, { label: "предупреждение" });

    assert.match(bot.telegramClient.lastText(), /слишком длинное/i);
    assert.equal(bot.coreClient.sentMessages.length, 0);
  });

  it("пропускает обновления без чата", async (t) => {
    muteConsole(t);
    const bot = startTestBot();
    t.after(() => bot.stop());

    bot.push({ text: "без чата" });
    bot.pushText("нормальное");
    await waitFor(() => bot.coreClient.sentMessages.length === 1, { label: "обработано валидное" });

    assert.equal(bot.coreClient.sentMessages[0].text, "нормальное");
  });

  describe("команды", () => {
    it("выполняет /new через Core и не шлёт её как сообщение", async (t) => {
      muteConsole(t);
      const bot = startTestBot();
      t.after(() => bot.stop());

      bot.pushText("/new");
      await waitFor(() => bot.coreClient.resets.length === 1, { label: "сброс выполнен" });

      assert.equal(bot.coreClient.sentMessages.length, 0);
      assert.match(bot.telegramClient.lastText(), /новый диалог/i);
    });

    it("обрабатывает /help локально, не трогая Core", async (t) => {
      muteConsole(t);
      const bot = startTestBot();
      t.after(() => bot.stop());

      bot.pushText("/help");
      await waitFor(() => bot.telegramClient.sent.length === 1, { label: "справка" });

      assert.match(bot.telegramClient.lastText(), /\/new/);
      assert.equal(bot.coreClient.sentMessages.length, 0);
      assert.equal(bot.coreClient.resets.length, 0);
    });

    it("не считает командой длинное сообщение, начинающееся со слэша", async (t) => {
      muteConsole(t);
      const bot = startTestBot({ maxMessageLength: 10 });
      t.after(() => bot.stop());

      bot.pushText("/unknown команда длиннее лимита");
      await waitFor(() => bot.telegramClient.sent.length === 1, { label: "предупреждение" });

      assert.match(bot.telegramClient.lastText(), /слишком длинное/i);
    });
  });

  describe("устойчивость", () => {
    it("сообщает пользователю, если Core недоступен", async (t) => {
      muteConsole(t);
      const bot = startTestBot({ coreOptions: { failSendMessage: true } });
      t.after(() => bot.stop());

      bot.pushText("привет");
      await waitFor(() => bot.telegramClient.sent.length === 1, { label: "сообщение об ошибке" });

      assert.match(bot.telegramClient.lastText(), /недоступен/i);
    });

    it("продолжает работу после ошибки getUpdates", async (t) => {
      muteConsole(t);
      const bot = startTestBot();
      t.after(() => bot.stop());

      const original = bot.telegramClient.getUpdates;
      let failed = false;
      bot.telegramClient.getUpdates = async (args) => {
        if (!failed) {
          failed = true;
          throw new Error("сеть недоступна");
        }
        return original(args);
      };

      bot.pushText("привет");
      await waitFor(() => bot.coreClient.sentMessages.length === 1, {
        label: "бот восстановился после сетевой ошибки",
      });

      assert.equal(bot.coreClient.sentMessages[0].text, "привет");
    });

    it("не пишет полный стек на каждую попытку, пока Telegram недоступен", async (t) => {
      const errors = [];
      t.mock.method(console, "error", (...args) => errors.push(args.join(" ")));
      t.mock.method(console, "log", () => {});

      // Потолок паузы занижен, чтобы прореживание включилось на третьей
      // попытке, а не на пятой, как с настоящими пятью секундами.
      const bot = startTestBot({ retryDelayMs: 1, maxRetryDelayMs: 4 });
      t.after(() => bot.stop());

      const original = bot.telegramClient.getUpdates;
      let attempts = 0;
      bot.telegramClient.getUpdates = async (args) => {
        attempts += 1;
        if (attempts <= 6) {
          const error = new TypeError("fetch failed");
          error.cause = { code: "ETIMEDOUT" };
          throw error;
        }
        return original(args);
      };

      await waitFor(() => attempts > 6, { label: "бот пережил череду отказов" });

      // Подробности — у первой, дальше короткие отметки: иначе одна и та же
      // ошибка каждые несколько секунд превращает лог в стену.
      assert.ok(errors.length < 6, `записей ${errors.length} на 6 отказов`);
      assert.ok(
        errors.some((line) => line.includes("ETIMEDOUT")),
        "код причины должен попасть в лог, а не одно «fetch failed»",
      );
    });

    it("отмечает возврат связи", async (t) => {
      const logs = [];
      t.mock.method(console, "log", (...args) => logs.push(args.join(" ")));
      t.mock.method(console, "error", () => {});

      const bot = startTestBot({ retryDelayMs: 1 });
      t.after(() => bot.stop());

      const original = bot.telegramClient.getUpdates;
      let failed = false;
      bot.telegramClient.getUpdates = async (args) => {
        if (!failed) {
          failed = true;
          throw new TypeError("fetch failed");
        }
        return original(args);
      };

      // Без этой записи в логе видны только неудачи, и непонятно, кончились
      // они или бот всё ещё лежит.
      await waitFor(() => logs.some((line) => line.includes("восстановлена")), {
        label: "возврат связи отмечен в логе",
      });
    });
  });

  describe("остановка", () => {
    it("завершает цикл по сигналу", async (t) => {
      muteConsole(t);
      const bot = startTestBot();

      await assert.doesNotReject(() => bot.stop());
    });

    it("не обрабатывает сообщения после остановки", async (t) => {
      muteConsole(t);
      const bot = startTestBot();

      await bot.stop();
      bot.pushText("после остановки");
      await new Promise((r) => setTimeout(r, 60));

      assert.equal(bot.coreClient.sentMessages.length, 0);
    });
  });
});
