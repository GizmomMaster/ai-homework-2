/**
 * Хранилище диалогов и истории переписки.
 *
 * Модель данных: внешний чат (`conversations`, пара адаптер + внешний id)
 * содержит одну или несколько «сессий» (`chat_sessions`). Активной считается
 * последняя созданная — новая появляется при первом сообщении или при сбросе
 * контекста. Сообщения (`chat_messages`) принадлежат сессии и уходят в LLM
 * как история диалога.
 */
export class ChatRepository {
  /**
   * @param {import("better-sqlite3").Database} db
   */
  constructor(db) {
    this.db = db;
    this.stmts = {
      findConversation: db.prepare(
        `SELECT id, adapter, external_id AS externalId
         FROM conversations WHERE adapter = ? AND external_id = ?`,
      ),
      findConversationById: db.prepare(
        `SELECT id, adapter, external_id AS externalId FROM conversations WHERE id = ?`,
      ),
      insertConversation: db.prepare(
        `INSERT INTO conversations (adapter, external_id, created_at) VALUES (?, ?, ?)`,
      ),
      findLatestSession: db.prepare(
        `SELECT id, total_tokens AS totalTokens
         FROM chat_sessions WHERE conversation_id = ? ORDER BY id DESC LIMIT 1`,
      ),
      insertSession: db.prepare(
        `INSERT INTO chat_sessions (conversation_id, total_tokens, created_at) VALUES (?, 0, ?)`,
      ),
      insertMessage: db.prepare(
        `INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)`,
      ),
      selectMessages: db.prepare(
        `SELECT role, content FROM chat_messages WHERE session_id = ? ORDER BY id ASC`,
      ),
      updateSessionTokens: db.prepare(
        `UPDATE chat_sessions SET total_tokens = ? WHERE id = ?`,
      ),
    };
  }

  /**
   * Находит диалог по паре «адаптер + внешний id», создавая при отсутствии.
   * @param {string} adapter
   * @param {string|number} externalId
   * @returns {{ id: number, adapter: string, externalId: string }}
   */
  getOrCreateConversation(adapter, externalId) {
    const key = String(externalId);
    const existing = this.stmts.findConversation.get(adapter, key);
    if (existing) return existing;

    this.stmts.insertConversation.run(adapter, key, Date.now());
    return this.stmts.findConversation.get(adapter, key);
  }

  /**
   * @param {number} conversationId
   * @returns {{ id: number, adapter: string, externalId: string }|undefined}
   */
  findConversationById(conversationId) {
    return this.stmts.findConversationById.get(conversationId);
  }

  /**
   * Активная сессия диалога; создаётся, если её ещё нет.
   * @param {number} conversationId
   * @returns {{ id: number, totalTokens: number }}
   */
  getOrCreateActiveSession(conversationId) {
    const existing = this.stmts.findLatestSession.get(conversationId);
    if (existing) return existing;
    return this.createSession(conversationId);
  }

  /**
   * Создаёт новую сессию (сброс контекста). Предыдущая история остаётся
   * в БД, но больше не передаётся модели.
   * @param {number} conversationId
   * @returns {{ id: number, totalTokens: number }}
   */
  createSession(conversationId) {
    const { lastInsertRowid } = this.stmts.insertSession.run(conversationId, Date.now());
    return { id: Number(lastInsertRowid), totalTokens: 0 };
  }

  /**
   * @param {number} sessionId
   * @returns {Array<{ role: string, content: string }>}
   */
  getMessages(sessionId) {
    return this.stmts.selectMessages.all(sessionId);
  }

  /**
   * @param {number} sessionId
   * @param {number} totalTokens
   */
  setSessionTokens(sessionId, totalTokens) {
    this.stmts.updateSessionTokens.run(totalTokens, sessionId);
  }

  /**
   * Добавляет пару «вопрос + ответ» и обновляет счётчик токенов.
   * Не транзакция сама по себе — вызывается внутри транзакции JobRunner'а
   * вместе со сменой статуса задания, чтобы падение между этими шагами не
   * оставляло вопрос без ответа и задание в вечном `running`.
   *
   * @param {number} sessionId
   * @param {string} userText
   * @param {string} assistantText
   * @param {number} totalTokens
   */
  appendExchange(sessionId, userText, assistantText, totalTokens) {
    const now = Date.now();
    this.stmts.insertMessage.run(sessionId, "user", userText, now);
    this.stmts.insertMessage.run(sessionId, "assistant", assistantText, now);
    this.stmts.updateSessionTokens.run(totalTokens, sessionId);
  }
}
