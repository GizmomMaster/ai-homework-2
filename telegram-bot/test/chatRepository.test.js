import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestRepository } from "./helpers.js";

describe("ChatRepository", () => {
  describe("сессии", () => {
    it("создаёт сессию при первом обращении к чату", () => {
      const repo = createTestRepository();
      const session = repo.getOrCreateActiveSession(1);

      assert.ok(session.id);
      assert.equal(session.totalTokens, 0);
    });

    it("возвращает ту же сессию при повторном обращении", () => {
      const repo = createTestRepository();
      const first = repo.getOrCreateActiveSession(1);
      const second = repo.getOrCreateActiveSession(1);

      assert.equal(second.id, first.id);
    });

    it("createSession делает активной новую сессию", () => {
      const repo = createTestRepository();
      const first = repo.getOrCreateActiveSession(1);
      const created = repo.createSession(1);
      const active = repo.getOrCreateActiveSession(1);

      assert.notEqual(created.id, first.id);
      assert.equal(active.id, created.id);
      assert.equal(active.totalTokens, 0);
    });

    it("изолирует сессии разных чатов", () => {
      const repo = createTestRepository();
      const a = repo.getOrCreateActiveSession(1);
      const b = repo.getOrCreateActiveSession(2);

      repo.appendExchange(a.id, "вопрос A", "ответ A", 10);

      assert.notEqual(a.id, b.id);
      assert.equal(repo.getMessages(b.id).length, 0);
      assert.equal(repo.getMessages(a.id).length, 2);
    });

    it("одинаково трактует числовой и строковый chatId", () => {
      const repo = createTestRepository();
      const fromNumber = repo.getOrCreateActiveSession(42);
      const fromString = repo.getOrCreateActiveSession("42");

      assert.equal(fromString.id, fromNumber.id);
    });
  });

  describe("сообщения", () => {
    it("возвращает сообщения в порядке добавления", () => {
      const repo = createTestRepository();
      const { id } = repo.getOrCreateActiveSession(1);

      repo.appendExchange(id, "первый", "ответ 1", 10);
      repo.appendExchange(id, "второй", "ответ 2", 20);

      assert.deepEqual(
        repo.getMessages(id),
        [
          { role: "user", content: "первый" },
          { role: "assistant", content: "ответ 1" },
          { role: "user", content: "второй" },
          { role: "assistant", content: "ответ 2" },
        ],
      );
    });

    it("сохраняет историю прошлой сессии после создания новой", () => {
      const repo = createTestRepository();
      const old = repo.getOrCreateActiveSession(1);
      repo.appendExchange(old.id, "вопрос", "ответ", 10);

      const fresh = repo.createSession(1);

      assert.equal(repo.getMessages(old.id).length, 2, "старая история осталась в БД");
      assert.equal(repo.getMessages(fresh.id).length, 0, "новая сессия пустая");
    });
  });

  describe("appendExchange", () => {
    it("пишет пару реплик и обновляет счётчик токенов", () => {
      const repo = createTestRepository();
      const { id } = repo.getOrCreateActiveSession(1);

      repo.appendExchange(id, "вопрос", "ответ", 123);

      assert.equal(repo.getOrCreateActiveSession(1).totalTokens, 123);
      assert.deepEqual(repo.getMessages(id), [
        { role: "user", content: "вопрос" },
        { role: "assistant", content: "ответ" },
      ]);
    });

    it("атомарен: при сбое не остаётся частично записанного обмена", () => {
      const repo = createTestRepository();
      const { id } = repo.getOrCreateActiveSession(1);

      // null нарушает NOT NULL на content — запись должна откатиться целиком
      assert.throws(() => repo.appendExchange(id, "вопрос", null, 50));

      assert.equal(repo.getMessages(id).length, 0, "вопрос без ответа не сохранён");
      assert.equal(repo.getOrCreateActiveSession(1).totalTokens, 0, "токены не обновлены");
    });
  });

  describe("setSessionTokens", () => {
    it("обновляет счётчик токенов сессии", () => {
      const repo = createTestRepository();
      const { id } = repo.getOrCreateActiveSession(1);

      repo.setSessionTokens(id, 777);

      assert.equal(repo.getOrCreateActiveSession(1).totalTokens, 777);
    });
  });
});
