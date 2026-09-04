import { JsonAgent } from "./JsonAgent.js";
import { truncateForClassifier } from "../domain/classifierContext.js";

/**
 * Потолок на число шагов. Без него модель способна напланировать два десятка
 * вызовов на один вопрос: каждый — запрос к бирже, а квота там общая на адрес.
 */
export const MAX_PLAN_STEPS = 8;

/** Сколько последних реплик показывать: столько же, сколько маршрутизатору. */
export const PLANNER_CONTEXT_MESSAGES = 6;

/**
 * Схема плана.
 *
 * Три отличия от §3 спецификации, и все — ради надёжности разбора на местной
 * модели:
 *
 * 1. **`toolToUse` — перечисление**, собранное из реестра инструментов.
 *    Выдуманное имя инструмента становится грамматически невозможным, а не
 *    маловероятным. Именно на этом небольшие модели ошибаются чаще всего.
 * 2. **Имена параметров тоже перечислены** — объединение параметров всех
 *    инструментов. Модель не может изобрести ключ; заодно интервал свечей
 *    ограничен грамматикой, а не только проверкой.
 * 3. **Убраны `reasoning`, `expectedOutput` и `executionEstimate`.** На
 *    исполнение они не влияют вовсе, а каждое поле — это лишние десятки
 *    токенов генерации и лишний шанс сорваться на середине.
 *
 * @param {ReturnType<typeof import("../tools/index.js").createTools>} tools
 */
export function buildPlanSchema(tools) {
  const names = Object.keys(tools);

  // Объединение параметров всех инструментов. Требовать их по отдельности для
  // каждого инструмента схема не умеет — это доберёт проверка параметров при
  // исполнении, для которой такой вывод в любом случае недоверенный.
  const properties = {};
  for (const tool of Object.values(tools)) {
    Object.assign(properties, tool.parameters);
  }

  return {
    type: "object",
    properties: {
      canExecute: { type: "boolean" },
      taskSummary: { type: "string" },
      plan: {
        type: "array",
        maxItems: MAX_PLAN_STEPS,
        items: {
          type: "object",
          properties: {
            action: { type: "string" },
            toolToUse: { type: "string", enum: names },
            parameters: { type: "object", properties },
          },
          required: ["action", "toolToUse", "parameters"],
        },
      },
      fallbackMessage: { type: ["string", "null"] },
    },
    required: ["canExecute", "taskSummary"],
  };
}

/**
 * Системный промпт планировщика. Список инструментов не переписан вручную,
 * а собран из реестра: разойтись с настоящим набором он не может.
 *
 * Навыки (файлы SKILL.md в `core/skills`) дописываются разделом в конце.
 * Отдельным — потому что каталог инструментов отвечает на вопрос «что есть»,
 * а навык на вопрос «как этим пользоваться и что делать, когда нельзя»;
 * смешать их значило бы прятать правила в описании параметра. Раздела нет
 * вовсе, если навыков нет: пустой заголовок в промпте — это шум, на который
 * небольшая модель отвлекается.
 *
 * @param {ReturnType<typeof import("../tools/index.js").createTools>} tools
 * @param {Array<{ name: string, description: string, body: string }>} [skills]
 */
export function buildPlannerPrompt(tools, skills = []) {
  // Разметка каталога выбрана по цене: он уходит в промпт на каждом вызове
  // планировщика, а это самый дорогой из промптов системы. Слова
  // «(обязательный)» и «(необязательный)» при четырнадцати параметрах стоили
  // больше двухсот знаков — их заменяет звёздочка, объяснённая в заголовке
  // раздела. Отдельная строка «Параметры:» и отступ в пять пробелов ушли по
  // той же причине: назначение инструмента и его параметры и так разделены
  // тире и переводом строки.
  const catalogue = Object.entries(tools)
    .map(([name, tool], index) => {
      const params = Object.entries(tool.parameters)
        .map(([key, spec]) => `   ${key}${tool.required.includes(key) ? "*" : ""}: ${spec.description}`)
        .join("\n");
      return `${index + 1}. "${name}" — ${tool.description}\n${params || "   без параметров"}`;
    })
    .join("\n");

  // Правила навыка идут последними и потому имеют вес: у инструкций в конце
  // промпта у небольших моделей больше шансов быть применёнными, чем у тех,
  // что утонули в середине перечня.
  const skillRules = skills
    .map((skill) => `### ${skill.name}\n${skill.description}\n\n${skill.body}`)
    .join("\n\n");

  return `Ты — Агент-Планировщик в мультиагентной системе для криптотрейдеров. Тебе достаётся задача пользователя по анализу или сбору данных о криптовалютах. Твоя цель: оценить, выполнима ли она имеющимися инструментами, и построить пошаговый план.

ДОСТУПНЫЕ ИНСТРУМЕНТЫ (других в системе НЕТ; звёздочка у параметра — обязательный):
${catalogue}

ПРАВИЛА:
* Инструменты только читают открытые рыночные данные. Ничего другого система не умеет: ни торговать, ни читать новости и соцсети, ни работать с кошельками пользователя, ни анализировать акции и прочие некриптовые активы.
* Если задача требует того, чего в списке нет, поставь canExecute=false и объясни в fallbackMessage, чего именно не хватает и что система умеет вместо этого. Пиши коротко, вежливо и по делу; не обещай сделать это позже и не отправляй пользователя никуда обращаться.
* Если задача выполнима — canExecute=true и план из шагов. Шаги независимы и выполняются одновременно, поэтому шаг не может опираться на результат другого.
* Шагов должно быть ровно столько, сколько нужно. Спросили про три монеты — три шага. Не добавляй шаги «на всякий случай»: каждый из них стоит запроса к бирже.
* Торговые пары указывай в виде символов Binance: BTCUSDT, ETHUSDT, SOLUSDT. Если пользователь назвал монету без пары, бери пару к USDT.
* В action пиши, что делает шаг, — коротко, по-русски, одной строкой.${
    skillRules ? `\n\nНАВЫКИ (правила по отдельным инструментам, имеют приоритет над общими правилами выше):\n\n${skillRules}` : ""
  }`;
}

/** Проверка обязательных полей — на случай раннера без поддержки схемы. */
export function isPlan(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if (typeof value.canExecute !== "boolean") return false;
  if (typeof value.taskSummary !== "string") return false;
  if (value.plan !== undefined && !Array.isArray(value.plan)) return false;
  return true;
}

/**
 * Агент-Планировщик: превращает задачу пользователя в список вызовов
 * инструментов либо в обоснованный отказ.
 */
export class PlannerAgent {
  /**
   * @param {{
   *   llmRunner: import("../llm/LlmRunner.js").LlmRunner,
   *   tools: ReturnType<typeof import("../tools/index.js").createTools>,
   *   skills?: Array<{ name: string, description: string, body: string }>,
   * }} deps
   */
  constructor({ llmRunner, tools, skills = [] }) {
    this.agent = new JsonAgent({
      llmRunner,
      systemPrompt: buildPlannerPrompt(tools, skills),
      schema: buildPlanSchema(tools),
      validate: isPlan,
    });
  }

  /**
   * @param {{ history: Array<{ role: string, content: string }>, text: string }} input
   * @returns {Promise<{
   *   canExecute: boolean,
   *   taskSummary: string,
   *   plan: Array<{ action: string, toolToUse: string, parameters: object }>,
   *   fallbackMessage?: string|null,
   *   truncated: boolean,
   *   usage: { promptTokens: number, completionTokens: number },
   * }>}
   */
  async plan({ history, text }) {
    const { value, usage } = await this.agent.run([
      ...truncateForClassifier(history.slice(-PLANNER_CONTEXT_MESSAGES)),
      { role: "user", content: text },
    ]);

    const steps = Array.isArray(value.plan) ? value.plan : [];
    // Обрезаем, а не отвергаем: часть данных полезнее, чем ничего, и это та
    // же логика, по которой отчёт собирается из удавшихся шагов. О факте
    // обрезки исполнитель сообщит в отчёте.
    const plan = steps.slice(0, MAX_PLAN_STEPS);

    return {
      canExecute: Boolean(value.canExecute),
      taskSummary: value.taskSummary,
      plan,
      fallbackMessage: value.fallbackMessage ?? null,
      truncated: steps.length > plan.length,
      usage,
    };
  }
}
