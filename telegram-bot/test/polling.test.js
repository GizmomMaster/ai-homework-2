import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { startPolling } from "../src/telegram/polling.js";
import {
  createFakeLlmRunner,
  createFakeTelegramClient,
  createTestRepository,
  muteConsole,
  waitFor,
} from "./helpers.js";

/**
 * Запускает polling поверх заглушки Telegram, отдающей заранее заданные
 * обновления. Возвращает управление тестом: подкладывание сообщений,
 * ожидание отправок и остановку цикла.
 */
function startTestBot({
  updates = [],
  maxMessageLength = 1000,
  contextWindowTokens = 1000,
  reply,
  retryDelayMs = 10,
} = {}) {
  const chatRepository = createTestRepository();
  const telegramClient = createFakeTelegramClient();
  const llmRunner = createFakeLlmRunner(reply);
  const queue = [...updates];
  let nextUpdateId = 1;

  telegramClient.getUpdates = async ({ signal }) => {
    if (queue.length > 0) return queue.splice(0, queue.length);
    // Имитируем long polling: ждём новых сообщений или остановки бота
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 20);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
    return [];
  };

  const controller = new AbortController();
  const finished = startPolling({
    telegramClient,
    llmRunner,
    chatRepository,
    maxMessageLength,
    contextWindowTokens,
    signal: controller.signal,
    retryDelayMs,
  });

  return {
    telegramClient,
    llmRunner,
    chatRepository,
    push(message) {
      queue.push({ update_id: nextUpdateId++, message });
    },
    pushText(text, chatId = 1) {
      this.push({ chat: { id: chatId }, text });
    },
    async stop() {
      controller.abort();
      await finished;
    },
  };
}

describe("startPolling", () => {
  it("передаёт обычное сообщение в LLM и отвечает пользователю", async (t) => {
    muteConsole(t);
    const bot = startTestBot({ reply: { content: "ответ", promptTokens: 5, completionTokens: 5 } });
    t.after(() => bot.stop());

    bot.pushText("привет");
    await waitFor(() => bot.telegramClient.sent.length === 1, { label: "ответ отправлен" });

    assert.deepEqual(bot.llmRunner.calls[0], [{ role: "user", content: "привет" }]);
    assert.equal(bot.telegramClient.sent[0].text, "ответ");
  });

  it("предупреждает про не-текстовое сообщение, не обращаясь к LLM", async (t) => {
    muteConsole(t);
    const bot = startTestBot();
    t.after(() => bot.stop());

    bot.push({ chat: { id: 1 }, photo: [{ file_id: "abc" }] });
    await waitFor(() => bot.telegramClient.sent.length === 1, { label: "предупреждение" });

    assert.match(bot.telegramClient.lastText(), /только текстовые сообщения/i);
    assert.equal(bot.llmRunner.calls.length, 0);
  });

  it("отклоняет слишком длинное сообщение до обращения к LLM", async (t) => {
    muteConsole(t);
    const bot = startTestBot({ maxMessageLength: 10 });
    t.after(() => bot.stop());

    bot.pushText("это сообщение заведомо длиннее лимита");
    await waitFor(() => bot.telegramClient.sent.length === 1, { label: "предупреждение" });

    assert.match(bot.telegramClient.lastText(), /слишком длинное/i);
    assert.equal(bot.llmRunner.calls.length, 0);
  });

  it("пропускает обновления без чата", async (t) => {
    muteConsole(t);
    const bot = startTestBot({ reply: { content: "ответ", promptTokens: 5, completionTokens: 5 } });
    t.after(() => bot.stop());

    bot.push({ text: "без чата" });
    bot.pushText("нормальное");
    await waitFor(() => bot.telegramClient.sent.length === 1, { label: "обработано валидное" });

    assert.equal(bot.llmRunner.calls.length, 1, "в LLM ушло только валидное сообщение");
  });

  describe("команды", () => {
    it("выполняет /new и не отправляет её в LLM", async (t) => {
      muteConsole(t);
      const bot = startTestBot({ reply: { content: "ответ", promptTokens: 5, completionTokens: 5 } });
      t.after(() => bot.stop());

      bot.pushText("первый");
      await waitFor(() => bot.telegramClient.sent.length === 1, { label: "первый ответ" });
      const sessionBefore = bot.chatRepository.getOrCreateActiveSession(1);

      bot.pushText("/new");
      await waitFor(() => bot.telegramClient.sent.length === 2, { label: "ответ на /new" });

      assert.equal(bot.llmRunner.calls.length, 1, "/new не уходит в LLM");
      assert.notEqual(bot.chatRepository.getOrCreateActiveSession(1).id, sessionBefore.id);
      assert.match(bot.telegramClient.lastText(), /новый диалог/i);
    });

    it("после /new история не попадает в следующий запрос", async (t) => {
      muteConsole(t);
      const bot = startTestBot({ reply: { content: "ответ", promptTokens: 5, completionTokens: 5 } });
      t.after(() => bot.stop());

      bot.pushText("первый");
      await waitFor(() => bot.telegramClient.sent.length === 1, { label: "первый ответ" });
      bot.pushText("/new");
      await waitFor(() => bot.telegramClient.sent.length === 2, { label: "ответ на /new" });
      bot.pushText("второй");
      await waitFor(() => bot.telegramClient.sent.length === 3, { label: "второй ответ" });

      assert.deepEqual(bot.llmRunner.calls.at(-1), [{ role: "user", content: "второй" }]);
    });

    it("не считает командой длинное сообщение, начинающееся со слэша", async (t) => {
      muteConsole(t);
      const bot = startTestBot({ maxMessageLength: 10 });
      t.after(() => bot.stop());

      bot.pushText("/unknown команда длиннее лимита");
      await waitFor(() => bot.telegramClient.sent.length === 1, { label: "предупреждение" });

      assert.match(bot.telegramClient.lastText(), /слишком длинное/i);
    });

    it("обрабатывает /help", async (t) => {
      muteConsole(t);
      const bot = startTestBot();
      t.after(() => bot.stop());

      bot.pushText("/help");
      await waitFor(() => bot.telegramClient.sent.length === 1, { label: "справка" });

      assert.match(bot.telegramClient.lastText(), /\/new/);
      assert.equal(bot.llmRunner.calls.length, 0);
    });
  });

  describe("устойчивость", () => {
    it("продолжает работу после ошибки getUpdates", async (t) => {
      muteConsole(t);
      const bot = startTestBot({ reply: { content: "ответ", promptTokens: 5, completionTokens: 5 } });
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
      await waitFor(() => bot.telegramClient.sent.length === 1, {
        label: "бот восстановился после сетевой ошибки",
      });

      assert.equal(bot.telegramClient.sent[0].text, "ответ");
    });

    it("не падает, если LLM возвращает ошибку", async (t) => {
      muteConsole(t);
      const bot = startTestBot({ reply: new Error("Ollama недоступна") });
      t.after(() => bot.stop());

      bot.pushText("привет");
      await waitFor(() => bot.telegramClient.sent.length === 1, { label: "сообщение об ошибке" });

      assert.match(bot.telegramClient.lastText(), /ошибка при обращении к модели/i);
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
      const bot = startTestBot({ reply: { content: "ответ", promptTokens: 5, completionTokens: 5 } });

      await bot.stop();
      bot.pushText("после остановки");
      await new Promise((r) => setTimeout(r, 60));

      assert.equal(bot.llmRunner.calls.length, 0);
    });
  });
});
