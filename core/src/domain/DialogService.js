import { JOB_STATUS } from "../db/jobRepository.js";
import { LLM_ERROR } from "../llm/LlmRunner.js";

/** Причина отказа, не являющаяся ошибкой: контекст диалога заполнен. */
export const REJECT_REASON = { contextLimit: "context_limit" };

/**
 * Доменная логика диалога: контекстное окно, история, обращение к модели.
 * Ничего не знает ни про Telegram, ни про HTTP, ни про задания — на входе
 * текст, на выходе исход.
 *
 * Намеренно **не пишет** результат в БД: запись истории должна произойти в
 * одной транзакции со сменой статуса задания, иначе падение между этими
 * шагами либо потеряет реплику, либо заставит переспросить модель и записать
 * обмен дважды. Что именно записать, сервис возвращает в `historyEntry`,
 * а транзакцией владеет JobRunner.
 */
export class DialogService {
  /**
   * @param {{
   *   chatRepository: import("../db/chatRepository.js").ChatRepository,
   *   llmRunner: import("../llm/LlmRunner.js").LlmRunner,
   *   contextWindowTokens: number,
   * }} deps
   */
  constructor({ chatRepository, llmRunner, contextWindowTokens }) {
    this.chatRepository = chatRepository;
    this.llmRunner = llmRunner;
    this.contextWindowTokens = contextWindowTokens;
  }

  /**
   * @param {{ conversationId: number, text: string }} input
   * @returns {Promise<{
   *   status: string,
   *   replyText?: string,
   *   reason?: string,
   *   usage?: object,
   *   historyEntry?: { sessionId: number, userText: string, assistantText: string, totalTokens: number },
   * }>}
   */
  async process({ conversationId, text }) {
    const session = this.chatRepository.getOrCreateActiveSession(conversationId);

    if (session.totalTokens >= this.contextWindowTokens) {
      return {
        status: JOB_STATUS.rejected,
        reason: REJECT_REASON.contextLimit,
        usage: this.#usage(session.totalTokens),
      };
    }

    const messages = [
      ...this.chatRepository.getMessages(session.id),
      { role: "user", content: text },
    ];

    let result;
    try {
      result = await this.llmRunner.chat(messages);
    } catch (error) {
      return {
        status: JOB_STATUS.failed,
        reason: error.code ?? LLM_ERROR.unavailable,
        // Текст ошибки нужен только для лога Core; наружу уходит код причины.
        errorMessage: error.message,
      };
    }

    const totalTokens = result.promptTokens + result.completionTokens;

    return {
      status: JOB_STATUS.completed,
      replyText: result.content,
      usage: {
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        ...this.#usage(totalTokens),
      },
      historyEntry: {
        sessionId: session.id,
        userText: text,
        assistantText: result.content,
        totalTokens,
      },
    };
  }

  /**
   * Сбрасывает контекст: заводит новую сессию. Прежняя история остаётся
   * в БД, но модели больше не показывается.
   * @param {number} conversationId
   */
  reset(conversationId) {
    return this.chatRepository.createSession(conversationId);
  }

  #usage(totalTokens) {
    return { totalTokens, contextLimit: this.contextWindowTokens };
  }
}
