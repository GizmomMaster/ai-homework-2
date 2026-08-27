import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestRepositories } from "./helpers.js";

const repo = () => createTestRepositories().chatRepository;

describe("ChatRepository", () => {
  describe("диалоги", () => {
    it("создаёт диалог по паре адаптер + внешний id", () => {
      const chats = repo();

      const conversation = chats.getOrCreateConversation("telegram", 8123);

      assert.ok(conversation.id);
      assert.equal(conversation.adapter, "telegram");
      assert.equal(conversation.externalId, "8123");
    });

    it("возвращает тот же диалог при повторном обращении", () => {
      const chats = repo();

      const first = chats.getOrCreateConversation("telegram", 8123);
      const second = chats.getOrCreateConversation("telegram", "8123");

      assert.equal(second.id, first.id, "числовой и строковый id — один диалог");
    });

    it("разводит одинаковый внешний id разных адаптеров", () => {
      const chats = repo();

      const telegram = chats.getOrCreateConversation("telegram", "42");
      const web = chats.getOrCreateConversation("web", "42");

      assert.notEqual(web.id, telegram.id);
    });

    it("находит диалог по внутреннему id", () => {
      const chats = repo();
      const created = chats.getOrCreateConversation("telegram", 8123);

      assert.deepEqual(chats.findConversationById(created.id), created);
    });

    it("возвращает undefined для неизвестного диалога", () => {
      assert.equal(repo().findConversationById(999), undefined);
    });
  });

  describe("сессии", () => {
    it("создаёт сессию при первом обращении", () => {
      const chats = repo();
      const conversation = chats.getOrCreateConversation("telegram", 1);

      const session = chats.getOrCreateActiveSession(conversation.id);

      assert.ok(session.id);
      assert.equal(session.totalTokens, 0);
    });

    it("возвращает ту же сессию повторно", () => {
      const chats = repo();
      const conversation = chats.getOrCreateConversation("telegram", 1);

      const first = chats.getOrCreateActiveSession(conversation.id);
      const second = chats.getOrCreateActiveSession(conversation.id);

      assert.equal(second.id, first.id);
    });

    it("createSession делает активной новую сессию", () => {
      const chats = repo();
      const conversation = chats.getOrCreateConversation("telegram", 1);
      const first = chats.getOrCreateActiveSession(conversation.id);

      const created = chats.createSession(conversation.id);
      const active = chats.getOrCreateActiveSession(conversation.id);

      assert.notEqual(created.id, first.id);
      assert.equal(active.id, created.id);
      assert.equal(active.totalTokens, 0);
    });

    it("изолирует сессии разных диалогов", () => {
      const chats = repo();
      const a = chats.getOrCreateConversation("telegram", 1);
      const b = chats.getOrCreateConversation("telegram", 2);
      const sessionA = chats.getOrCreateActiveSession(a.id);

      chats.appendExchange(sessionA.id, "вопрос", "ответ", 10);

      const sessionB = chats.getOrCreateActiveSession(b.id);
      assert.equal(chats.getMessages(sessionB.id).length, 0);
      assert.equal(chats.getMessages(sessionA.id).length, 2);
    });
  });

  describe("история", () => {
    it("возвращает сообщения в порядке добавления", () => {
      const chats = repo();
      const conversation = chats.getOrCreateConversation("telegram", 1);
      const { id } = chats.getOrCreateActiveSession(conversation.id);

      chats.appendExchange(id, "первый", "ответ 1", 10);
      chats.appendExchange(id, "второй", "ответ 2", 20);

      assert.deepEqual(chats.getMessages(id), [
        { role: "user", content: "первый" },
        { role: "assistant", content: "ответ 1" },
        { role: "user", content: "второй" },
        { role: "assistant", content: "ответ 2" },
      ]);
    });

    it("appendExchange обновляет счётчик токенов сессии", () => {
      const chats = repo();
      const conversation = chats.getOrCreateConversation("telegram", 1);
      const { id } = chats.getOrCreateActiveSession(conversation.id);

      chats.appendExchange(id, "вопрос", "ответ", 123);

      assert.equal(chats.getOrCreateActiveSession(conversation.id).totalTokens, 123);
    });

    it("история прошлой сессии переживает сброс контекста", () => {
      const chats = repo();
      const conversation = chats.getOrCreateConversation("telegram", 1);
      const old = chats.getOrCreateActiveSession(conversation.id);
      chats.appendExchange(old.id, "вопрос", "ответ", 10);

      const fresh = chats.createSession(conversation.id);

      assert.equal(chats.getMessages(old.id).length, 2, "старая история осталась в БД");
      assert.equal(chats.getMessages(fresh.id).length, 0, "новая сессия пустая");
    });

    it("не даёт записать сообщение в несуществующую сессию", () => {
      const chats = repo();

      assert.throws(() => chats.appendExchange(999, "вопрос", "ответ", 10), /FOREIGN KEY/i);
    });
  });
});
