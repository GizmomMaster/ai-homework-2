import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { commandMenu, commands, findCommand } from "../src/handlers/commands.js";
import { createFakeTelegramClient, createTestRepository, muteConsole } from "./helpers.js";

describe("реестр команд", () => {
  describe("findCommand", () => {
    it("находит команду по точному совпадению", () => {
      assert.equal(findCommand("/new")?.command, "new");
      assert.equal(findCommand("/help")?.command, "help");
      assert.equal(findCommand("/start")?.command, "start");
    });

    it("игнорирует регистр", () => {
      assert.equal(findCommand("/NEW")?.command, "new");
    });

    it("понимает суффикс с именем бота (группы)", () => {
      assert.equal(findCommand("/new@MyCoolBot")?.command, "new");
    });

    it("игнорирует пробелы вокруг", () => {
      assert.equal(findCommand("  /new  ")?.command, "new");
    });

    it("берёт только первое слово", () => {
      assert.equal(findCommand("/new и ещё текст")?.command, "new");
    });

    it("не срабатывает на похожем слове", () => {
      assert.equal(findCommand("/newsletter"), undefined);
    });

    it("не считает командой обычный текст", () => {
      assert.equal(findCommand("привет"), undefined);
      assert.equal(findCommand("расскажи про /new"), undefined);
    });

    it("возвращает undefined для неизвестной команды", () => {
      assert.equal(findCommand("/unknown"), undefined);
    });

    it("не падает на пустой строке", () => {
      assert.equal(findCommand(""), undefined);
    });
  });

  describe("commandMenu", () => {
    it("отдаёт все команды реестра в формате Telegram API", () => {
      const menu = commandMenu();

      assert.equal(menu.length, commands.length);
      for (const item of menu) {
        assert.deepEqual(Object.keys(item).sort(), ["command", "description"]);
        assert.ok(item.command.length > 0);
        assert.ok(item.description.length > 0);
        assert.ok(!item.command.startsWith("/"), "Telegram ждёт имя без слэша");
      }
    });

    it("содержит /new", () => {
      assert.ok(commandMenu().some((c) => c.command === "new"));
    });
  });

  describe("/new", () => {
    it("создаёт новую сессию и подтверждает пользователю", async (t) => {
      muteConsole(t);
      const chatRepository = createTestRepository();
      const telegramClient = createFakeTelegramClient();
      const before = chatRepository.getOrCreateActiveSession(1);

      await findCommand("/new").handle({ chatId: 1, telegramClient, chatRepository });

      assert.notEqual(chatRepository.getOrCreateActiveSession(1).id, before.id);
      assert.match(telegramClient.lastText(), /новый диалог/i);
    });
  });

  describe("/help", () => {
    it("присылает справку с упоминанием команд и не трогает сессию", async (t) => {
      muteConsole(t);
      const chatRepository = createTestRepository();
      const telegramClient = createFakeTelegramClient();
      const before = chatRepository.getOrCreateActiveSession(1);

      await findCommand("/help").handle({ chatId: 1, telegramClient, chatRepository });

      assert.match(telegramClient.lastText(), /\/new/);
      assert.equal(chatRepository.getOrCreateActiveSession(1).id, before.id);
    });
  });

  describe("/start", () => {
    it("приветствует и начинает чистый диалог", async (t) => {
      muteConsole(t);
      const chatRepository = createTestRepository();
      const telegramClient = createFakeTelegramClient();
      const before = chatRepository.getOrCreateActiveSession(1);

      await findCommand("/start").handle({ chatId: 1, telegramClient, chatRepository });

      assert.match(telegramClient.lastText(), /привет/i);
      assert.notEqual(chatRepository.getOrCreateActiveSession(1).id, before.id);
    });
  });
});
