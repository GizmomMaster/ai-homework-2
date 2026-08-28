import { JOB_STATUS } from "../db/jobRepository.js";
import { LLM_ERROR } from "../llm/LlmRunner.js";
import { ROUTER_INTENT } from "../agents/RouterAgent.js";
import { logError, log } from "../logger.js";
import { renderReport } from "./renderReport.js";

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
  /**
   * Задача понята, но выполнить её имеющимися инструментами нельзя, а своими
   * словами планировщик объяснить не смог. Формулировку напишет адаптер.
   */
  taskUnsupported: "task_unsupported",
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
   *   theoryAgent: import("../agents/TheoryAgent.js").TheoryAgent,
   *   plannerAgent: import("../agents/PlannerAgent.js").PlannerAgent,
   *   planExecutor: import("./PlanExecutor.js").PlanExecutor,
   *   summaryAgent: import("../agents/SummaryAgent.js").SummaryAgent,
   *   contextWindowTokens: number,
   * }} deps
   */
  constructor({
    chatRepository,
    routerAgent,
    theoryAgent,
    plannerAgent,
    planExecutor,
    summaryAgent,
    contextWindowTokens,
  }) {
    this.chatRepository = chatRepository;
    this.routerAgent = routerAgent;
    this.theoryAgent = theoryAgent;
    this.plannerAgent = plannerAgent;
    this.planExecutor = planExecutor;
    this.summaryAgent = summaryAgent;
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
    if (intent) log(`Интент: ${intent} (уверенность ${verdict.confidence}) — ${verdict.topicSummary}`);

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

    if (intent === ROUTER_INTENT.taskRequest) {
      return this.#task({ session, history, text, spent });
    }

    // THEORY_QUESTION и разбор, который не удался: в обоих случаях отвечаем
    // обычным диалогом — теоретический агент и есть ветка общего назначения.
    const messages = [...history, { role: "user", content: text }];

    let result;
    try {
      result = await this.theoryAgent.answer(messages);
    } catch (error) {
      return this.#llmFailure(error);
    }
    add(spent, result);

    // Считается вместе с системным промптом агента, и это верно: в окно
    // модели он попадает каждый ход наравне с историей, поэтому и место в
    // бюджете занимает настоящее. Диалоги теперь наполняются чуть быстрее.
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

    return this.#reply({ session, text, replyText: question, spent, intent: verdict.intent });
  }

  /**
   * Задача: построить план, выполнить его и собрать отчёт.
   *
   * Отчёт — содержание ответа, поэтому уходит адаптеру обычной репликой и
   * попадает в историю: следующий вопрос «а что по ETH» должен опираться на
   * то, что уже показано.
   */
  async #task({ session, history, text, spent }) {
    let plan;
    try {
      plan = await this.plannerAgent.plan({ history, text });
      add(spent, plan.usage);
    } catch (error) {
      // В отличие от маршрутизатора, отвечать без планировщика нечем:
      // выдумать рыночные данные — единственное, что осталось бы модели.
      return this.#llmFailure(error);
    }

    if (!plan.canExecute || plan.plan.length === 0) {
      log(`Задача невыполнима: ${plan.taskSummary}`);
      const message = plan.fallbackMessage?.trim();
      // Планировщик объясняет отказ своими словами — он один знает, чего
      // именно не хватило. Без объяснения отдаём код, текст напишет адаптер.
      return message
        ? this.#reply({ session, text, replyText: message, spent, intent: ROUTER_INTENT.taskRequest })
        : {
            status: JOB_STATUS.rejected,
            reason: REJECT_REASON.taskUnsupported,
            intent: ROUTER_INTENT.taskRequest,
            usage: this.#usage(session.totalTokens, spent),
          };
    }

    const execution = await this.planExecutor.run(plan.plan);

    if (execution.succeeded === 0) {
      // Ни один шаг не удался: показывать пустой отчёт с перечнем причин
      // бессмысленно, это отказ.
      return {
        status: JOB_STATUS.failed,
        reason: execution.steps[0]?.error?.code ?? FAILURE_REASON.internal,
        intent: ROUTER_INTENT.taskRequest,
        usage: this.#usage(session.totalTokens, spent),
      };
    }

    const replyText = await this.#report({ text, plan, execution, spent });

    return this.#reply({
      session,
      text,
      replyText,
      spent,
      intent: ROUTER_INTENT.taskRequest,
    });
  }

  /**
   * Отчёт по собранным данным.
   *
   * Сводит модель — шаблон не сделает вывода и не ответит на заданный вопрос.
   * Но если модель на этом шаге откажет, задание не роняем: данные уже
   * получены и оплачены запросами к бирже, и показать их шаблоном куда лучше,
   * чем потерять всё из-за сбоя на последнем шаге.
   */
  async #report({ text, plan, execution, spent }) {
    const fallback = () =>
      renderReport({
        taskSummary: plan.taskSummary,
        steps: execution.steps,
        truncated: plan.truncated,
      });

    if (!this.summaryAgent) return fallback();

    try {
      const summary = await this.summaryAgent.summarize({
        question: text,
        taskSummary: plan.taskSummary,
        steps: execution.steps,
      });
      add(spent, summary);
      const content = summary.content.trim();
      if (!content) throw new Error("пустая сводка");
      return plan.truncated ? `${content}\n\n_План был длиннее и выполнен частично._` : content;
    } catch (error) {
      logError("Не удалось свести отчёт, показываем данные как есть:", error);
      return fallback();
    }
  }

  /**
   * Ответ, который не измерялся моделью: отчёт и объяснение планировщика
   * собираются у нас, поэтому размер диалога остаётся прежним до следующего
   * обращения к модели за текстом — оно посчитает всё разом.
   */
  #reply({ session, text, replyText, spent, intent }) {
    const totalTokens = session.totalTokens;
    return {
      status: JOB_STATUS.completed,
      replyText,
      intent,
      usage: this.#usage(totalTokens, spent),
      historyEntry: {
        sessionId: session.id,
        userText: text,
        assistantText: replyText,
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
