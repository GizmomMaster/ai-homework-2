#!/usr/bin/env node
// Переносит историю переписки из старой базы telegram-bot в схему Core.
//
// В старой схеме сессия принадлежала напрямую chat_id Telegram; в новой
// между ними появился диалог (conversations), потому что Core должен
// различать чаты разных адаптеров.
//
// Запуск:
//   node scripts/migrate-from-adapter.mjs ../telegram-bot/data/bot.db [./data/core.db]

import Database from "better-sqlite3";
import { pathToFileURL } from "node:url";
import { createDatabase } from "../src/db/database.js";
import { ChatRepository } from "../src/db/chatRepository.js";

/**
 * @param {{
 *   sourcePath: string,
 *   targetPath: string,
 *   adapter?: string,
 * }} params
 * @returns {{ conversations: number, sessions: number, messages: number, skipped: number }}
 */
export function migrate({ sourcePath, targetPath, adapter = "telegram" }) {
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  const target = createDatabase(targetPath);

  try {
    // Служебная таблица самой миграции: помнит, какие сессии уже перенесены,
    // поэтому повторный запуск не создаёт дублей.
    target.exec(`
      CREATE TABLE IF NOT EXISTS migrated_sessions (
        source_session_id INTEGER PRIMARY KEY,
        target_session_id INTEGER NOT NULL,
        migrated_at INTEGER NOT NULL
      );
    `);

    const chats = new ChatRepository(target);
    const stmts = {
      sourceSessions: source.prepare(
        `SELECT id, chat_id AS chatId, total_tokens AS totalTokens, created_at AS createdAt
         FROM chat_sessions ORDER BY id ASC`,
      ),
      sourceMessages: source.prepare(
        `SELECT role, content, created_at AS createdAt
         FROM chat_messages WHERE session_id = ? ORDER BY id ASC`,
      ),
      alreadyMigrated: target.prepare(
        `SELECT target_session_id FROM migrated_sessions WHERE source_session_id = ?`,
      ),
      remember: target.prepare(
        `INSERT INTO migrated_sessions (source_session_id, target_session_id, migrated_at)
         VALUES (?, ?, ?)`,
      ),
      insertSession: target.prepare(
        `INSERT INTO chat_sessions (conversation_id, total_tokens, created_at) VALUES (?, ?, ?)`,
      ),
      insertMessage: target.prepare(
        `INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)`,
      ),
      countConversations: target.prepare(`SELECT COUNT(*) AS n FROM conversations`),
    };

    const stats = { conversations: 0, sessions: 0, messages: 0, skipped: 0 };
    const conversationsBefore = stmts.countConversations.get().n;

    // Всё или ничего: прерванная на середине миграция не оставит половину
    // истории без второй половины.
    const run = target.transaction(() => {
      for (const session of stmts.sourceSessions.all()) {
        if (stmts.alreadyMigrated.get(session.id)) {
          stats.skipped += 1;
          continue;
        }

        const conversation = chats.getOrCreateConversation(adapter, session.chatId);
        const { lastInsertRowid } = stmts.insertSession.run(
          conversation.id,
          session.totalTokens,
          session.createdAt,
        );
        const targetSessionId = Number(lastInsertRowid);

        for (const message of stmts.sourceMessages.all(session.id)) {
          stmts.insertMessage.run(
            targetSessionId,
            message.role,
            message.content,
            message.createdAt,
          );
          stats.messages += 1;
        }

        stmts.remember.run(session.id, targetSessionId, Date.now());
        stats.sessions += 1;
      }
    });
    run();

    stats.conversations = stmts.countConversations.get().n - conversationsBefore;
    return stats;
  } finally {
    source.close();
    target.close();
  }
}

// --- CLI --------------------------------------------------------------------

const isRunDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isRunDirectly) {
  const [sourcePath, targetPathArg] = process.argv.slice(2);

  if (!sourcePath) {
    console.error(
      "Укажите путь к базе адаптера:\n" +
        "  node scripts/migrate-from-adapter.mjs ../telegram-bot/data/bot.db [./data/core.db]",
    );
    process.exit(1);
  }

  const { config } = await import("../src/config.js");
  const targetPath = targetPathArg || config.sqlitePath;

  try {
    const stats = migrate({ sourcePath, targetPath });
    console.log(
      `Перенесено: диалогов ${stats.conversations}, сессий ${stats.sessions}, ` +
        `сообщений ${stats.messages}. Пропущено как уже перенесённое: ${stats.skipped}.`,
    );
    console.log(`Целевая база: ${targetPath}`);
  } catch (error) {
    if (error.code === "SQLITE_CANTOPEN") {
      console.error(`Не удалось открыть базу адаптера: ${sourcePath}`);
    } else {
      console.error(`Миграция не выполнена: ${error.message}`);
    }
    process.exit(1);
  }
}
