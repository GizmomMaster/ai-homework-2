import { JsonAgent } from "./JsonAgent.js";

/** Категории запроса из §2 спецификации. */
export const ROUTER_INTENT = {
  theoryQuestion: "THEORY_QUESTION",
  taskRequest: "TASK_REQUEST",
  clarificationNeeded: "CLARIFICATION_NEEDED",
  outOfScope: "OUT_OF_SCOPE",
};

const INTENTS = Object.values(ROUTER_INTENT);

/**
 * Сколько последних реплик показывать маршрутизатору. Спецификация (§2.1)
 * говорит про 3–5 реплик контекста; берём три обмена. Вся история ему не
 * нужна и только замедляла бы разбор: решение принимается по последнему
 * сообщению, а контекст нужен лишь чтобы понять отсылки вроде «сравни их».
 */
export const ROUTER_CONTEXT_MESSAGES = 6;

/**
 * Схема ответа из §2. Уходит в раннер и ограничивает генерацию грамматикой:
 * `intent` вне перечисления сгенерировать невозможно.
 */
export const ROUTER_SCHEMA = {
  type: "object",
  properties: {
    intent: { type: "string", enum: INTENTS },
    isCryptoRelated: { type: "boolean" },
    confidence: { type: "number" },
    topicSummary: { type: "string" },
    reasoning: { type: "string" },
    clarificationQuestion: { type: ["string", "null"] },
    outOfScopeReason: { type: ["string", "null"] },
  },
  required: ["intent", "isCryptoRelated", "confidence", "topicSummary"],
};

/**
 * Системный промпт маршрутизатора: текст §2 спецификации плюс блок
 * уточняющих правил.
 *
 * Правила добавлены по результатам замера (docs/router-eval-results.md): на
 * промпте из спецификации почти все ошибки обеих моделей легли на одну
 * границу — TASK_REQUEST против CLARIFICATION_NEEDED, причём в обе стороны.
 * Спецификация разделяет эти интенты примерами, и модель подгоняла запрос под
 * ближайший пример вместо применения критерия; увеличение модели ошибку не
 * убирало, а переносило. Одна фраза о том, что границу определяет наличие
 * названного актива, подняла обе модели на 9 пунктов.
 *
 * Скрипт замера импортирует эту же строку, чтобы боевой промпт и измеренный
 * не разъехались.
 */
export const ROUTER_PROMPT = `Ты — Агент-Маршрутизатор (Router & Intent Classifier) в AI-системе для криптотрейдеров.
Твоя задача: на основе сообщения пользователя и контекста переписки классифицировать запрос строго в одну из категорий и вернуть ответ в валидном формате JSON.

КАТЕГОРИИ ИНТЕНТОВ:
1. "THEORY_QUESTION" — Пользователь задает теоретический, справочный или концептуальный вопрос о трейдинге, криптовалютах, индикаторах, терминологии, риск-менеджменте. (Например: "Что такое funding rate?", "Как работает книга ордеров?", "В чем разница между спотом и фьючерсом?").
2. "TASK_REQUEST" — Пользователь дает конкретное задание, задачу на сбор/анализ данных, расчет, построение отчета или мониторинг.
   * ВАЖНОЕ ПРАВИЛО: Наша система специализируется ТОЛЬКО на криптовалютах.
   * Если задание связано с криптовалютами (сбор текущих цен, объемов, истории, OHLCV, стаканов), это "TASK_REQUEST" с флагом isCryptoRelated=true.
   * Если задание НЕ связано с криптовалютами (написать код на C++, написать стих, составить план диеты, анализ акций Газпрома), пометь intent="OUT_OF_SCOPE" или isCryptoRelated=false.
3. "CLARIFICATION_NEEDED" — Запрос слишком неполный, размытый или неоднозначный, и невозможно понять, какую монету или метрику имеет в виду пользователь (Например: "Какая цена?", "Сделай анализ графика", "Покажи объем").
4. "OUT_OF_SCOPE" — Запрос вообще не относится к финансовой/криптовалютной тематике и не может быть обработан нашими инструментами.

ФОРМАТ ВЫХОДА (СТРОГО JSON):
{
  "intent": "THEORY_QUESTION" | "TASK_REQUEST" | "CLARIFICATION_NEEDED" | "OUT_OF_SCOPE",
  "isCryptoRelated": true | false,
  "confidence": 0.0 - 1.0,
  "topicSummary": "Краткая суть темы (до 10 слов)",
  "reasoning": "Краткое обоснование выбора категории",
  "clarificationQuestion": "Вопрос для уточнения (только если intent == CLARIFICATION_NEEDED, иначе null)",
  "outOfScopeReason": "Причина отказа (только если intent == OUT_OF_SCOPE, иначе null)"
}

УТОЧНЯЮЩИЕ ПРАВИЛА (имеют приоритет над примерами выше):
* Границу между "TASK_REQUEST" и "CLARIFICATION_NEEDED" определяет ровно одно: назван ли в запросе конкретный актив — тикер, символ пары или название монеты.
  - Актив назван → "TASK_REQUEST", даже если запрос очень короткий. "Какая цена BTC?" — это "TASK_REQUEST".
  - Актив не назван и не следует из предыдущих реплик → "CLARIFICATION_NEEDED", даже если в запросе есть глагол действия. "Проверь стакан", "Сравни их за неделю" — это "CLARIFICATION_NEEDED".
* Глагол действия над данными (сравни, покажи, найди, посмотри, посчитай) вместе с названным активом — это "TASK_REQUEST", а не "THEORY_QUESTION". Теоретический вопрос спрашивает, что это такое или как устроено, а не какие сейчас значения.`;

/** Проверка обязательных полей — на случай раннера без поддержки схемы. */
export function isRouterVerdict(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if (!INTENTS.includes(value.intent)) return false;
  if (typeof value.isCryptoRelated !== "boolean") return false;
  if (typeof value.confidence !== "number") return false;
  return typeof value.topicSummary === "string";
}

/**
 * Агент-Маршрутизатор: раскладывает входящее сообщение по четырём веткам,
 * чтобы не тратить планирование там, где нужен обычный текстовый ответ.
 */
export class RouterAgent {
  /** @param {{ llmRunner: import("../llm/LlmRunner.js").LlmRunner }} deps */
  constructor({ llmRunner }) {
    this.agent = new JsonAgent({
      llmRunner,
      systemPrompt: ROUTER_PROMPT,
      schema: ROUTER_SCHEMA,
      validate: isRouterVerdict,
    });
  }

  /**
   * @param {{ history: Array<{ role: string, content: string }>, text: string }} input
   * @returns {Promise<{
   *   intent: string,
   *   isCryptoRelated: boolean,
   *   confidence: number,
   *   topicSummary: string,
   *   clarificationQuestion?: string|null,
   *   outOfScopeReason?: string|null,
   *   usage: { promptTokens: number, completionTokens: number },
   * }>}
   * @throws {import("../llm/LlmRunner.js").LlmError}
   */
  async classify({ history, text }) {
    const { value, usage } = await this.agent.run([
      ...history.slice(-ROUTER_CONTEXT_MESSAGES),
      { role: "user", content: text },
    ]);
    return { ...value, usage };
  }
}
