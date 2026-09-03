/**
 * Обрезка исторических сообщений для агентов-классификаторов (Router,
 * Planner). Обоим нужна история — разрешить отсылки вроде «сравни их» или
 * «а что по ETH», — но не её полный текст: прошлые ответы SummaryAgent
 * бывают на несколько абзацев с числами, и это раздувает не только сам
 * промпт, а ещё и телеметрию по повторному контексту (§telemetry) — Router
 * и Planner сейчас получают ровно один и тот же срез истории дважды за одно
 * задание. TheoryAgent (обычный диалог) и SummaryAgent (историю вообще не
 * видит) этой обрезкой не затрагиваются: им нужна полная связность текста.
 *
 * Обрезается только ПРОШЛОЕ. Текущий вопрос пользователя, который агент
 * классифицирует или планирует прямо сейчас, через эту функцию не проходит —
 * его обрезка стоила бы точности классификации, а не токенов.
 */
const DEFAULT_MAX_CHARS = 300;

/**
 * @param {Array<{ role: string, content: string }>} history
 * @param {{ maxChars?: number }} [options]
 * @returns {Array<{ role: string, content: string }>}
 */
export function truncateForClassifier(history, { maxChars = DEFAULT_MAX_CHARS } = {}) {
  return history.map((message) => {
    if (message.content.length <= maxChars) return message;
    return { ...message, content: `${message.content.slice(0, maxChars)}…` };
  });
}
