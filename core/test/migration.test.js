import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../scripts/migrate-from-adapter.mjs";

/** Воссоздаёт старую схему адаптера: сессии висели прямо на chat_id. */
function createLegacyDatabase(path) {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE chat_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES chat_sessions (id),
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

  const insertSession = db.prepare(
    `INSERT INTO chat_sessions (chat_id, total_tokens, created_at) VALUES (?, ?, ?)`,
  );
  const insertMessage = db.prepare(
    `INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)`,
  );

  return {
    db,
    addSession(chatId, totalTokens = 0, createdAt = 1000) {
      return Number(insertSession.run(String(chatId), totalTokens, createdAt).lastInsertRowid);
    },
    addExchange(sessionId, userText, assistantText, createdAt = 1000) {
      insertMessage.run(sessionId, "user", userText, createdAt);
      insertMessage.run(sessionId, "assistant", assistantText, createdAt + 1);
    },
    close: () => db.close(),
  };
}

/** Читает результат миграции из целевой базы. */
function inspect(path) {
  const db = new Database(path, { readonly: true });
  const conversations = db
    .prepare(`SELECT id, adapter, external_id AS externalId FROM conversations ORDER BY id`)
    .all();
  const sessions = db
    .prepare(
      `SELECT id, conversation_id AS conversationId, total_tokens AS totalTokens, created_at AS createdAt
       FROM chat_sessions ORDER BY id`,
    )
    .all();
  const messages = db
    .prepare(
      `SELECT session_id AS sessionId, role, content FROM chat_messages ORDER BY session_id, id`,
    )
    .all();
  db.close();
  return { conversations, sessions, messages };
}

describe("миграция из базы адаптера", () => {
  let dir;
  let sourcePath;
  let targetPath;
  let legacy;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "migration-test-"));
    sourcePath = join(dir, "bot.db");
    targetPath = join(dir, "core.db");
    legacy = createLegacyDatabase(sourcePath);
  });

  afterEach(() => {
    legacy.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const run = () => migrate({ sourcePath, targetPath });

  it("заводит диалог на каждый чат из старой базы", () => {
    legacy.addSession(8123);
    legacy.addSession(9999);
    legacy.close();

    const stats = run();

    const { conversations } = inspect(targetPath);
    assert.equal(stats.conversations, 2);
    assert.deepEqual(
      conversations.map((c) => ({ adapter: c.adapter, externalId: c.externalId })),
      [
        { adapter: "telegram", externalId: "8123" },
        { adapter: "telegram", externalId: "9999" },
      ],
    );
  });

  it("сохраняет несколько сессий одного чата под общим диалогом", () => {
    legacy.addSession(8123, 100, 1000);
    legacy.addSession(8123, 250, 2000);
    legacy.close();

    run();

    const { conversations, sessions } = inspect(targetPath);
    assert.equal(conversations.length, 1, "один чат — один диалог");
    assert.equal(sessions.length, 2);
    assert.ok(sessions.every((s) => s.conversationId === conversations[0].id));
  });

  it("переносит сообщения в исходном порядке", () => {
    const session = legacy.addSession(8123);
    legacy.addExchange(session, "первый вопрос", "первый ответ");
    legacy.addExchange(session, "второй вопрос", "второй ответ", 2000);
    legacy.close();

    const stats = run();

    const { messages } = inspect(targetPath);
    assert.equal(stats.messages, 4);
    assert.deepEqual(
      messages.map((m) => `${m.role}:${m.content}`),
      [
        "user:первый вопрос",
        "assistant:первый ответ",
        "user:второй вопрос",
        "assistant:второй ответ",
      ],
    );
  });

  it("сохраняет счётчик токенов и время создания сессии", () => {
    legacy.addSession(8123, 4952, 1700000000000);
    legacy.close();

    run();

    const { sessions } = inspect(targetPath);
    assert.equal(sessions[0].totalTokens, 4952);
    assert.equal(sessions[0].createdAt, 1700000000000);
  });

  describe("повторный запуск", () => {
    it("ничего не дублирует", () => {
      const session = legacy.addSession(8123, 100);
      legacy.addExchange(session, "вопрос", "ответ");
      legacy.close();

      const first = run();
      const second = run();

      const { conversations, sessions, messages } = inspect(targetPath);
      assert.equal(first.sessions, 1);
      assert.equal(second.sessions, 0, "во второй раз переносить нечего");
      assert.equal(second.skipped, 1);
      assert.equal(conversations.length, 1);
      assert.equal(sessions.length, 1);
      assert.equal(messages.length, 2);
    });

    it("переносит только то, что появилось после прошлого запуска", () => {
      legacy.addSession(8123, 100);
      run();

      const fresh = legacy.addSession(8123, 200);
      legacy.addExchange(fresh, "новый вопрос", "новый ответ");
      legacy.close();

      const stats = run();

      assert.equal(stats.sessions, 1);
      assert.equal(stats.skipped, 1);
      assert.equal(inspect(targetPath).sessions.length, 2);
    });
  });

  describe("сосуществование с рабочей базой", () => {
    it("не трогает диалоги, уже заведённые Core", async () => {
      const { createDatabase } = await import("../src/db/database.js");
      const { ChatRepository } = await import("../src/db/chatRepository.js");
      const existing = createDatabase(targetPath);
      const chats = new ChatRepository(existing);
      const conversation = chats.getOrCreateConversation("telegram", "8123");
      const session = chats.getOrCreateActiveSession(conversation.id);
      chats.appendExchange(session.id, "живой вопрос", "живой ответ", 42);
      existing.close();

      legacy.addSession(8123, 100);
      legacy.close();

      const stats = run();

      const { conversations, messages } = inspect(targetPath);
      assert.equal(stats.conversations, 0, "диалог для этого чата уже был");
      assert.equal(conversations.length, 1, "второй диалог для того же чата не создан");
      assert.ok(
        messages.some((m) => m.content === "живой вопрос"),
        "существующая история не пострадала",
      );
    });
  });

  describe("ошибки", () => {
    it("сообщает, если базы адаптера нет", () => {
      legacy.close();

      assert.throws(
        () => migrate({ sourcePath: join(dir, "нет-такого.db"), targetPath }),
        /SQLITE_CANTOPEN|unable to open/i,
      );
    });

    it("на пустой базе отрабатывает без ошибок", () => {
      legacy.close();

      const stats = run();

      assert.deepEqual(stats, { conversations: 0, sessions: 0, messages: 0, skipped: 0 });
    });
  });
});
