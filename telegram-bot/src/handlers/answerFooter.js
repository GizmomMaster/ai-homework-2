/**
 * Подпись под ответом: сколько ждали, во сколько токенов обошёлся ответ и
 * сколько их осталось в контексте диалога.
 *
 * Живёт в адаптере, а не в Core, по той же причине, что и формулировки
 * отказов: Core присылает числа, а как их назвать и показывать ли вообще —
 * свойство канала. В Telegram это строка курсивом под ответом; веб-адаптеру
 * уместнее было бы отдельное поле в интерфейсе.
 *
 * Считать остаток здесь, а не в Core, тоже осознанно: `contextLimit` и
 * `totalTokens` уже приезжают, и вычитание одного из другого — не та
 * логика, ради которой стоит расширять контракт.
 *
 * **Два числа в подписи измеряют разное, и подписаны они поэтому явно.**
 * «На ответ» — вся работа модели по заданию: маршрутизатор, планировщик и
 * отвечающий агент, каждый со своим промптом. «В контексте осталось» — про
 * окно диалога, а туда попадает лишь отвечающий вызов: промпт маршрутизатора
 * живёт ровно один запрос и к истории отношения не имеет (см. разбор двух
 * величин в `core/src/domain/DialogService.js`).
 *
 * Отсюда «2 015 токенов» рядом с «осталось 15 003 из 16 000»: разница между
 * лимитом и остатком — это 997 токенов отвечающего вызова, а остальные 1 018
 * ушли на маршрутизацию и в окно не попали. Вычитать одно из другого нельзя,
 * и подписи должны это показывать, иначе цифры выглядят несходящимися.
 */

/**
 * @param {{
 *   promptTokens?: number,
 *   completionTokens?: number,
 *   totalTokens?: number,
 *   contextLimit?: number,
 *   durationMs?: number,
 * }} [usage]
 * @returns {string} строка markdown или пустая строка, если показывать нечего
 */
export function answerFooter(usage) {
  if (!usage) return "";

  const parts = [];

  if (typeof usage.durationMs === "number") parts.push(`⏱ ${duration(usage.durationMs)}`);

  // Стоимость ответа — сумма по всем обращениям к модели за это задание:
  // маршрутизатор, планировщик и сводящий агент работали каждый за свои
  // токены, и показывать только последнего значило бы занижать цифру.
  const spent = (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
  if (spent > 0) parts.push(`на ответ ${number(spent)} ${tokenWord(spent)}`);

  const left = remaining(usage);
  if (left !== undefined) {
    parts.push(`в контексте осталось ${number(left)} из ${number(usage.contextLimit)}`);
  }

  return parts.length > 0 ? `_${parts.join(" · ")}_` : "";
}

/**
 * Остаток контекста. Отрицательным не бывает: превышение лимита означает,
 * что следующий запрос отклонят, а не что у диалога «минус тысяча токенов».
 */
function remaining({ totalTokens, contextLimit }) {
  if (typeof totalTokens !== "number" || typeof contextLimit !== "number") return undefined;
  return Math.max(0, contextLimit - totalTokens);
}

/**
 * Миллисекунды читаются плохо: «81 мс» ещё понятно, а «94318 мс» уже нет.
 * До секунды показываем как есть, дальше — в секундах и минутах.
 */
function duration(ms) {
  if (ms < 1000) return `${ms} мс`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} с`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} мин ${Math.round(seconds - minutes * 60)} с`;
}

/** Узкий неразрывный пробел между разрядами: 14 760 читается быстрее 14760. */
function number(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/**
 * Согласование «токен» с числом. Подпись висит под каждым ответом, и «81
 * токенов» мозолило бы глаза в каждом из них.
 *
 * Второй десяток — исключение из общего правила: 11–14 требуют «токенов»,
 * хотя оканчиваются на 1–4.
 */
function tokenWord(count) {
  const hundred = count % 100;
  if (hundred >= 11 && hundred <= 14) return "токенов";

  const ten = count % 10;
  if (ten === 1) return "токен";
  if (ten >= 2 && ten <= 4) return "токена";
  return "токенов";
}
