import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { commandMenu, commands, findCommand } from "../src/handlers/commands.js";
import { createFakeCoreClient, createFakeTelegramClient, muteConsole } from "./helpers.js";

function context(coreOptions) {
  const telegramClient = createFakeTelegramClient();
  const coreClient = createFakeCoreClient(coreOptions);
  return { chatId: 8123, telegramClient, coreClient };
}

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
    it("просит Core сбросить контекст и подтверждает пользователю", async (t) => {
      muteConsole(t);
      const ctx = context();

      await findCommand("/new").handle(ctx);

      assert.deepEqual(ctx.coreClient.resets, [{ chatId: 8123 }]);
      assert.match(ctx.telegramClient.lastText(), /новый диалог/i);
    });

    it("сообщает о недоступности сервиса и не подтверждает сброс", async (t) => {
      muteConsole(t);
      const ctx = context({ failReset: true });

      await findCommand("/new").handle(ctx);

      assert.match(ctx.telegramClient.lastText(), /недоступен/i);
      assert.equal(ctx.coreClient.resets.length, 0);
    });

    it("не отправляет команду в модель как обычный текст", async (t) => {
      muteConsole(t);
      const ctx = context();

      await findCommand("/new").handle(ctx);

      assert.equal(ctx.coreClient.sentMessages.length, 0);
    });
  });

  describe("/help", () => {
    it("присылает справку и не трогает Core", async (t) => {
      muteConsole(t);
      const ctx = context();

      await findCommand("/help").handle(ctx);

      assert.match(ctx.telegramClient.lastText(), /\/new/);
      assert.equal(ctx.coreClient.resets.length, 0);
      assert.equal(ctx.coreClient.sentMessages.length, 0);
    });

    it("описывает, для кого проект и что он умеет и не умеет", async (t) => {
      muteConsole(t);
      const ctx = context();

      await findCommand("/help").handle(ctx);

      const text = ctx.telegramClient.lastText();
      assert.match(text, /криптотрейдер/i, "для кого — сказано явно");
      assert.match(text, /умею/i, "что умеет — раздел есть");
      assert.match(text, /не умею|не торгую/i, "ограничения — раздел есть");
    });

    it("отправляет HTML-разметку, а не сырой markdown", async (t) => {
      muteConsole(t);
      const ctx = context();

      await findCommand("/help").handle(ctx);

      assert.equal(ctx.telegramClient.sent[0].parseMode, "HTML");
      assert.doesNotMatch(ctx.telegramClient.lastText(), /\*\*/, "** не должно остаться в тексте");
    });
  });

  describe("/start", () => {
    it("приветствует и начинает чистый диалог", async (t) => {
      muteConsole(t);
      const ctx = context();

      await findCommand("/start").handle(ctx);

      assert.match(ctx.telegramClient.lastText(), /привет/i);
      assert.deepEqual(ctx.coreClient.resets, [{ chatId: 8123 }]);
    });

    it("содержит примеры запросов, которые можно отправить", async (t) => {
      muteConsole(t);
      const ctx = context();

      await findCommand("/start").handle(ctx);

      const text = ctx.telegramClient.lastText();
      // Хотя бы один пример — реальный вопрос с вопросительным знаком,
      // а не просто перечисление возможностей.
      assert.match(text, /\?/);
      assert.match(text, /BTC|ETH|SOL/i, "пример называет конкретный актив");
    });
  });
});
