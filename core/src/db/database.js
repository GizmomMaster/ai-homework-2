import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Открывает (или создаёт) файл базы данных SQLite и применяет схему.
 * Каталог с файлом БД создаётся автоматически — важно при первом запуске
 * в Docker с примонтированным volume.
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
    -- Диалог в терминах внешнего канала. Пара (adapter, external_id)
    -- уникальна: chat_id Telegram сам по себе ключом уже не является,
    -- как только адаптеров может стать больше одного.
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      adapter TEXT NOT NULL,
      external_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (adapter, external_id)
    );

    CREATE TABLE IF NOT EXISTS chat_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES conversations (id),
      total_tokens INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chat_sessions_conversation
      ON chat_sessions (conversation_id, id);

    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES chat_sessions (id),
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chat_messages_session
      ON chat_messages (session_id, id);

    -- Задание живёт здесь от приёма сообщения до подтверждённой доставки
    -- ответа адаптеру. Это точка восстановления после перезапуска Core.
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES conversations (id),
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      request_text TEXT NOT NULL,
      reply_text TEXT,
      reason TEXT,
      usage_json TEXT,
      delivery_attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER,
      delivered_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status, id);
    CREATE INDEX IF NOT EXISTS idx_jobs_delivery
      ON jobs (delivered_at, next_attempt_at);
  `);

  return db;
}
