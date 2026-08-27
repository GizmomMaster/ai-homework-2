import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Открывает (или создаёт) файл базы данных SQLite и применяет схему.
 * Каталог с файлом БД создаётся автоматически, если ещё не существует —
 * это важно при первом запуске в Docker с примонтированным volume.
 *
 * @param {string} dbPath
 * @returns {import("better-sqlite3").Database}
 */
export function createDatabase(dbPath) {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  // По умолчанию SQLite не проверяет внешние ключи — включаем, чтобы
  // сообщение не могло сослаться на несуществующую сессию.
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chat_sessions_chat_id
      ON chat_sessions (chat_id, id);

    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES chat_sessions (id),
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chat_messages_session_id
      ON chat_messages (session_id, id);
  `);

  return db;
}
