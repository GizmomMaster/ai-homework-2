import { JOB_STATUS } from "../db/jobRepository.js";
import { LLM_ERROR } from "../llm/LlmRunner.js";
import { ROUTER_INTENT } from "../agents/RouterAgent.js";
import { logError, log } from "../logger.js";

/**
 * Причины отказа, не являющиеся ошибкой. Наружу уходит только код: как это
 * назвать пользователю, решает адаптер — формулировка зависит от канала.
 */
export const REJECT_REASON = {
  /** Контекст диалога заполнен. */
  contextLimit: "context_limit",
  /** Запрос вне компетенции системы (§5.2). */
  outOfScope: "out_of_scope",
  /** Нужно уточнение, но вопрос сформулировать не удалось. */
  clarificationNeeded: "clarification_needed",
};

/** Причины отказа задания, не относящиеся к модели. */
export const FAILURE_REASON = { internal: "internal_error" };

/**
 * Доменная логика диалога: классификация запроса, контекстное окно, история,
 * обращение к модели. Ничего не знает ни про Telegram, ни про HTTP, ни про
 * задания — на входе текст, на выходе исход.
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
   *   routerAgent: import("../agents/RouterAgent.js").RouterAgent,
   *   llmRunner: import("../llm/LlmRunner.js").LlmRunner,
   *   contextWindowTokens: number,
   * }} deps
   */
  constructor({ chatRepository, routerAgent, llmRunner, contextWindowTokens }) {
    this.chatRepository = chatRepository;
    this.routerAgent = routerAgent;
    this.llmRunner = llmRunner;
    this.contextWindowTokens = contextWindowTokens;
  }

  /**
   * @param {{ conversationId: number, text: string }} input
   * @returns {Promise<{
   *   status: string,
   *   replyText?: string,
   *   reason?: string,
   *   intent?: string,
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

    const history = this.chatRepository.getMessages(session.id);
    /**
     * Две разные величины, которые легко перепутать:
     *
     * `spent` — работа по заданию: сумма токенов по всем обращениям к модели.
     * На одно сообщение пользователя их теперь несколько, и в `usage` должна
     * уходить сумма, иначе стоимость задания видна лишь частично.
     *
     * Размер диалога — другое. Ollama отдаёт в `promptTokens` весь промпт
     * целиком, поэтому размер диалога после обмена это `promptTokens +
     * completionTokens` **отвечающего** вызова, величина абсолютная, а не
     * прибавка. Служебные обращения (маршрутизатор) в неё не входят и входить
     * не должны: их промпт живёт один вызов и к контекстному окну диалога
     * отношения не имеет.
     */
    const spent = { promptTokens: 0, completionTokens: 0 };

    let verdict;
    try {
      verdict = await this.routerAgent.classify({ history, text });
      add(spent, verdict.usage);
    } catch (error) {
      if (error.code === LLM_ERROR.badResponse) {
        // Схема делает такой ответ практически невозможным, но если он всё же
        // случился — отвечать пользователю ошибкой хуже, чем ответить без
        // классификации: маршрутизатор экономит вызовы и отсекает лишнее,
        // а не является условием работы диалога.
        logError("Маршрутизатор вернул неразбираемый ответ, отвечаем без классификации:", error);
      } else {
        return this.#llmFailure(error);
      }
    }

    const intent = verdict?.intent;

    if (intent === ROUTER_INTENT.outOfScope) {
      log(`Запрос вне компетенции: ${verdict.topicSummary}`);
      // Отказ в историю не пишем: показывать модели в следующих репликах
      // отвергнутые запросы незачем, а контекст они занимали бы. Размер
      // диалога поэтому не меняется.
      return {
        status: JOB_STATUS.rejected,
        reason: REJECT_REASON.outOfScope,
        intent,
        usage: this.#usage(session.totalTokens, spent),
      };
    }

    if (intent === ROUTER_INTENT.clarificationNeeded) {
      return this.#clarification({ session, text, verdict, spent });
    }

    // THEORY_QUESTION, TASK_REQUEST и разбор, который не удался.
    const messages = [...history, { role: "user", content: text }];

    let result;
    try {
      result = await this.llmRunner.chat(messages);
    } catch (error) {
      return this.#llmFailure(error);
    }
    add(spent, result);

    const dialogTokens = result.promptTokens + result.completionTokens;

    return {
      status: JOB_STATUS.completed,
      replyText: result.content,
      intent,
      usage: this.#usage(dialogTokens, spent),
      historyEntry: {
        sessionId: session.id,
        userText: text,
        assistantText: result.content,
        totalTokens: dialogTokens,
      },
    };
  }

  /**
   * Уточняющий вопрос — это содержание ответа, а не формулировка канала,
   * поэтому он уходит адаптеру как обычная реплика и попадает в историю:
   * без неё следующее сообщение пользователя («BTC») повиснет без опоры.
   * Если модель вопрос не сформулировала, отдаём код — общую просьбу
   * уточнить адаптер напишет сам.
   */
  #clarification({ session, text, verdict, spent }) {
    const question = verdict.clarificationQuestion?.trim();
    // Диалог вырастет на вопрос и ответ, но модель его не измеряла: размер
    // остаётся прежним до следующего обращения к ней, которое посчитает всё
    // разом. Ошибка в меньшую сторону безопасна — она может только отложить
    // отказ по переполнению, но не вызвать его раньше времени.
    const totalTokens = session.totalTokens;
    const usage = this.#usage(totalTokens, spent);

    if (!question) {
      return {
        status: JOB_STATUS.rejected,
        reason: REJECT_REASON.clarificationNeeded,
        intent: verdict.intent,
        usage,
      };
    }

    return {
      status: JOB_STATUS.completed,
      replyText: question,
      intent: verdict.intent,
      usage,
      historyEntry: {
        sessionId: session.id,
        userText: text,
        assistantText: question,
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

  /**
   * Ошибка обращения к модели. Всё, что не пришло с известным кодом LLM, —
   * это баг в нашем коде, а не сбой модели: возвращаем его отдельной причиной,
   * чтобы он не выглядел в логах как «Ollama недоступна» и чтобы задание всё
   * же завершилось, а не зависло в running до перезапуска.
   */
  #llmFailure(error) {
    const known = Object.values(LLM_ERROR).includes(error.code);
    return {
      status: JOB_STATUS.failed,
      reason: known ? error.code : FAILURE_REASON.internal,
      // Текст ошибки нужен только для лога Core; наружу уходит код причины.
      errorMessage: known ? error.message : `${error.name}: ${error.message}`,
    };
  }

  #usage(totalTokens, spent) {
    return {
      ...(spent ? { promptTokens: spent.promptTokens, completionTokens: spent.completionTokens } : {}),
      totalTokens,
      contextLimit: this.contextWindowTokens,
    };
  }
}

/** @param {{promptTokens:number, completionTokens:number}} tally */
function add(tally, { promptTokens, completionTokens }) {
  tally.promptTokens += promptTokens;
  tally.completionTokens += completionTokens;
}
