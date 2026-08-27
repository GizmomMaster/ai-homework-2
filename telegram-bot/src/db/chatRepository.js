/**
 * Хранилище истории переписки на базе SQLite.
 *
 * Модель данных: у каждого Telegram-чата (`chatId`) может быть несколько
 * "сессий" диалога (`chat_sessions`). Активной считается последняя созданная
 * сессия — новая сессия создаётся при первом сообщении в чате или по
 * команде /new. Сообщения (`chat_messages`) принадлежат сессии и передаются
 * в LLM как история для поддержания полноценного диалога.
 */
export class ChatRepository {
  /**
   * @param {import("better-sqlite3").Database} db
   */
  constructor(db) {
    this.db = db;
    this.stmts = {
      findLatestSession: db.prepare(
        `SELECT id, total_tokens AS totalTokens
         FROM chat_sessions WHERE chat_id = ? ORDER BY id DESC LIMIT 1`,
      ),
      insertSession: db.prepare(
        `INSERT INTO chat_sessions (chat_id, total_tokens, created_at) VALUES (?, 0, ?)`,
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

    // Обмен репликами пишется одной транзакцией: либо в истории появляются
    // и вопрос, и ответ, либо не появляется ничего. Иначе неудачный запрос
    // к LLM оставил бы в контексте вопрос без ответа, и он бы уехал в
    // следующий запрос как лишний "user"-месседж.
    this.appendExchangeTx = db.transaction((sessionId, userText, assistantText, totalTokens) => {
      const now = Date.now();
      this.stmts.insertMessage.run(sessionId, "user", userText, now);
      this.stmts.insertMessage.run(sessionId, "assistant", assistantText, now);
      this.stmts.updateSessionTokens.run(totalTokens, sessionId);
    });
  }

  /**
   * Возвращает текущую активную сессию чата, создавая её при отсутствии.
   * @param {number|string} chatId
   * @returns {{ id: number, totalTokens: number }}
   */
  getOrCreateActiveSession(chatId) {
    const existing = this.stmts.findLatestSession.get(String(chatId));
    if (existing) return existing;
    return this.createSession(chatId);
  }

  /**
   * Создаёт новую сессию диалога (используется для первого сообщения в чате
   * и для команды /new). Предыдущая история остаётся в БД, но больше не
   * передаётся модели как контекст.
   * @param {number|string} chatId
   * @returns {{ id: number, totalTokens: number }}
   */
  createSession(chatId) {
    const { lastInsertRowid } = this.stmts.insertSession.run(String(chatId), Date.now());
    return { id: Number(lastInsertRowid), totalTokens: 0 };
  }

  /**
   * @param {number} sessionId
   * @param {"user"|"assistant"} role
   * @param {string} content
   */
  addMessage(sessionId, role, content) {
    this.stmts.insertMessage.run(sessionId, role, content, Date.now());
  }

  /**
   * Атомарно добавляет в историю пару "вопрос пользователя + ответ модели"
   * и обновляет счётчик токенов сессии. Вызывается только после успешного
   * ответа LLM, поэтому в истории не остаётся вопросов без ответов.
   *
   * @param {number} sessionId
   * @param {string} userText
   * @param {string} assistantText
   * @param {number} totalTokens
   */
  appendExchange(sessionId, userText, assistantText, totalTokens) {
    this.appendExchangeTx(sessionId, userText, assistantText, totalTokens);
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
}
