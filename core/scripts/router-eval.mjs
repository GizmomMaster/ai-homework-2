#!/usr/bin/env node
/**
 * Замер качества Агента-Маршрутизатора на локальной модели.
 *
 * Отвечает на три вопроса, от которых зависит вся спецификация из
 * docs/crypto-orchestrator-spec.md:
 *   1. Возвращает ли модель разбираемый JSON и как на это влияет JSON Schema.
 *   2. Насколько верно она раскладывает запросы по четырём интентам.
 *   3. Что дешевле — русский системный промпт или английский.
 *
 * Скрипт ничего не чинит и не повторяет неудачные попытки: он измеряет сырое
 * поведение модели. Повтор при невалидном JSON — уже часть боевого кода, и
 * добавлять его надо после того, как станет известна база.
 *
 * Запуск:
 *   node scripts/router-eval.mjs
 *   node scripts/router-eval.mjs --lang=en --format=schema
 *   node scripts/router-eval.mjs --format=none --runs=3
 *
 * Флаги:
 *   --lang=ru|en          язык системного промпта (по умолчанию ru)
 *   --format=schema|json|none   как просим JSON (по умолчанию schema)
 *   --runs=N              прогонов каждого случая (по умолчанию 1)
 *   --model=…             модель (по умолчанию из .env / OLLAMA_MODEL)
 *   --base-url=…          адрес Ollama (по умолчанию из .env)
 *   --think=false|true|omit     режим размышления (по умолчанию из .env)
 *   --verbose             печатать сырой ответ модели по каждому промаху
 */
import { config } from "../src/config.js";
import { OllamaRunner } from "../src/llm/OllamaRunner.js";

const INTENTS = ["THEORY_QUESTION", "TASK_REQUEST", "CLARIFICATION_NEEDED", "OUT_OF_SCOPE"];

/**
 * Схема ответа маршрутизатора из §2 спецификации. При `--format=schema`
 * ограничивает генерацию грамматикой: структурно неверный ответ и выдуманное
 * имя интента становятся невозможны.
 */
const ROUTER_SCHEMA = {
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

/** Системный промпт из спецификации, дословно. */
const PROMPT_RU = `Ты — Агент-Маршрутизатор (Router & Intent Classifier) в AI-системе для криптотрейдеров.
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
}`;

/**
 * Тот же промпт по-английски. У небольших моделей следование инструкциям на
 * английском обычно надёжнее; поля, которые видит пользователь, по-прежнему
 * просим заполнять по-русски.
 */
const PROMPT_EN = `You are the Router & Intent Classifier agent in an AI system for crypto traders.
Given the user's message and the conversation context, classify the request into exactly one category and return valid JSON.

INTENT CATEGORIES:
1. "THEORY_QUESTION" — The user asks a theoretical, reference or conceptual question about trading, cryptocurrencies, indicators, terminology or risk management. (e.g. "What is funding rate?", "How does an order book work?", "What is the difference between spot and futures?").
2. "TASK_REQUEST" — The user gives a concrete task: collecting or analysing data, a calculation, a report or monitoring.
   * IMPORTANT RULE: this system covers cryptocurrencies ONLY.
   * If the task is about cryptocurrencies (current prices, volumes, history, OHLCV, order books), it is "TASK_REQUEST" with isCryptoRelated=true.
   * If the task is NOT about cryptocurrencies (write C++ code, write a poem, plan a diet, analyse Gazprom shares), return intent="OUT_OF_SCOPE" with isCryptoRelated=false.
3. "CLARIFICATION_NEEDED" — The request is too incomplete, vague or ambiguous to tell which coin or which metric the user means (e.g. "What is the price?", "Analyse the chart", "Show me the volume").
4. "OUT_OF_SCOPE" — The request has nothing to do with finance or cryptocurrencies and cannot be served by our tools.

OUTPUT FORMAT (STRICT JSON, no other text):
{
  "intent": "THEORY_QUESTION" | "TASK_REQUEST" | "CLARIFICATION_NEEDED" | "OUT_OF_SCOPE",
  "isCryptoRelated": true | false,
  "confidence": 0.0 - 1.0,
  "topicSummary": "short topic summary, up to 10 words",
  "reasoning": "short justification for the chosen category",
  "clarificationQuestion": "follow-up question, only when intent == CLARIFICATION_NEEDED, otherwise null",
  "outOfScopeReason": "reason for refusal, only when intent == OUT_OF_SCOPE, otherwise null"
}

Write topicSummary, reasoning, clarificationQuestion and outOfScopeReason in RUSSIAN — they are shown to the user. Keys and intent values stay exactly as written above.`;

/**
 * Набор случаев. `alsoAcceptable` — категории, которые спека допускает наравне
 * с ожидаемой: по §3.1 и §5.2 отказ по торговым действиям и по недоступным
 * источникам выдаёт Планировщик, то есть Маршрутизатор обязан пропустить их
 * как задачу, — но пользователь в обоих случаях получит отказ, поэтому такой
 * ответ не считается провалом. Итог печатается и строгий, и мягкий.
 */
const CASES = [
  { text: "Что такое ликвидация на изолированной марже?", expected: "THEORY_QUESTION" },
  { text: "Что такое funding rate?", expected: "THEORY_QUESTION" },
  { text: "В чем разница между спотом и фьючерсом?", expected: "THEORY_QUESTION" },
  { text: "Как работает книга ордеров?", expected: "THEORY_QUESTION" },
  { text: "Объясни, что показывает индикатор RSI", expected: "THEORY_QUESTION" },

  { text: "Сравни суточные объемы торгов между SOL, ETH и BTC", expected: "TASK_REQUEST" },
  { text: "Какая сейчас цена BTC?", expected: "TASK_REQUEST" },
  { text: "Покажи свечи ETHUSDT за последние сутки по часу", expected: "TASK_REQUEST" },
  { text: "Посмотри стакан по SOLUSDT, есть ли крупные стенки", expected: "TASK_REQUEST" },
  { text: "Найди топ-10 монет по суточному объему торгов", expected: "TASK_REQUEST" },
  {
    text: "Купи мне 1 BTC на бирже",
    expected: "TASK_REQUEST",
    alsoAcceptable: ["OUT_OF_SCOPE"],
    note: "отказ по торговым действиям — зона Планировщика (§5.2)",
  },
  {
    text: "Собери твиты Илона Маска про Dogecoin",
    expected: "TASK_REQUEST",
    alsoAcceptable: ["OUT_OF_SCOPE"],
    note: "отказ по недоступным источникам — зона Планировщика (§5.2)",
  },

  { text: "Какая сейчас цена?", expected: "CLARIFICATION_NEEDED" },
  { text: "Сделай анализ графика", expected: "CLARIFICATION_NEEDED" },
  { text: "Покажи объем", expected: "CLARIFICATION_NEEDED" },
  { text: "Сравни их за неделю", expected: "CLARIFICATION_NEEDED" },
  { text: "Проверь стакан", expected: "CLARIFICATION_NEEDED" },

  { text: "Напиши код парсера на Python для сбора погоды", expected: "OUT_OF_SCOPE" },
  { text: "Составь план диеты на неделю", expected: "OUT_OF_SCOPE" },
  { text: "Проанализируй акции Газпрома за последний квартал", expected: "OUT_OF_SCOPE" },
  { text: "Напиши стих про осень", expected: "OUT_OF_SCOPE" },
];

function parseArgs(argv) {
  const args = { lang: "ru", format: "schema", runs: 1, verbose: false };
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    if (key === "verbose") args.verbose = true;
    else if (key === "runs") args.runs = Number(value);
    else if (key === "base-url") args.baseUrl = value;
    else args[key] = value;
  }
  if (!["ru", "en"].includes(args.lang)) throw new Error(`--lang: ожидается ru или en`);
  if (!["schema", "json", "none"].includes(args.format)) {
    throw new Error(`--format: ожидается schema, json или none`);
  }
  if (!Number.isInteger(args.runs) || args.runs < 1) throw new Error(`--runs: целое ≥ 1`);
  if (args.think === "true") args.think = true;
  else if (args.think === "false") args.think = false;
  return args;
}

/** Разбирает ответ модели, не полагаясь на то, что в нём только JSON. */
function parseReply(content) {
  try {
    return { ok: true, value: JSON.parse(content) };
  } catch {
    // Без грамматики модель любит обрамлять JSON текстом или ```-блоком.
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return { ok: false, salvaged: false };
    try {
      return { ok: true, salvaged: true, value: JSON.parse(match[0]) };
    } catch {
      return { ok: false, salvaged: false };
    }
  }
}

/** Проверяет обязательные поля из §2 спецификации. */
function validate(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if (!INTENTS.includes(value.intent)) return false;
  if (typeof value.isCryptoRelated !== "boolean") return false;
  if (typeof value.confidence !== "number") return false;
  if (typeof value.topicSummary !== "string") return false;
  return true;
}

function pct(part, total) {
  return total === 0 ? "—" : `${((part / total) * 100).toFixed(0)}%`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const model = args.model ?? config.ollama.model;
  const baseUrl = args.baseUrl ?? config.ollama.baseUrl;
  const think = args.think ?? config.ollama.think;

  const runner = new OllamaRunner({
    baseUrl,
    model,
    timeoutMs: config.ollama.timeoutMs,
    think,
    // Контекст маршрутизатора — системный промпт плюс одна реплика; полное
    // окно диалога здесь только зря занимало бы память.
    numCtx: 4096,
  });

  const format =
    args.format === "schema" ? ROUTER_SCHEMA : args.format === "json" ? "json" : undefined;
  const systemPrompt = args.lang === "en" ? PROMPT_EN : PROMPT_RU;

  console.log(
    `Модель: ${model}   Ollama: ${baseUrl}\n` +
      `Промпт: ${args.lang}   format: ${args.format}   think: ${think}   прогонов: ${args.runs}\n` +
      `Случаев: ${CASES.length}, всего запросов: ${CASES.length * args.runs}\n`,
  );

  const stats = {
    total: 0,
    parsed: 0,
    salvaged: 0,
    valid: 0,
    strict: 0,
    lenient: 0,
    latencies: [],
    completionTokens: [],
    byCategory: new Map(),
    confusion: new Map(),
  };
  for (const intent of INTENTS) stats.byCategory.set(intent, { total: 0, hit: 0 });

  for (const testCase of CASES) {
    const acceptable = new Set([testCase.expected, ...(testCase.alsoAcceptable ?? [])]);
    const outcomes = [];

    for (let run = 0; run < args.runs; run += 1) {
      stats.total += 1;
      const category = stats.byCategory.get(testCase.expected);
      category.total += 1;

      const startedAt = Date.now();
      let content;
      try {
        const result = await runner.chat(
          [
            { role: "system", content: systemPrompt },
            { role: "user", content: testCase.text },
          ],
          { format },
        );
        content = result.content;
        stats.completionTokens.push(result.completionTokens);
      } catch (error) {
        outcomes.push(`ОШИБКА: ${error.code ?? error.name}`);
        if (args.verbose) console.log(`    ${error.message}`);
        continue;
      }
      stats.latencies.push(Date.now() - startedAt);

      const parsed = parseReply(content);
      if (!parsed.ok) {
        outcomes.push("не JSON");
        if (args.verbose) console.log(`    сырой ответ: ${content.slice(0, 300)}`);
        continue;
      }
      stats.parsed += 1;
      if (parsed.salvaged) stats.salvaged += 1;

      if (!validate(parsed.value)) {
        outcomes.push(`схема нарушена (intent=${JSON.stringify(parsed.value.intent)})`);
        if (args.verbose) console.log(`    сырой ответ: ${content.slice(0, 300)}`);
        continue;
      }
      stats.valid += 1;

      const { intent } = parsed.value;
      if (intent === testCase.expected) {
        stats.strict += 1;
        stats.lenient += 1;
        category.hit += 1;
        outcomes.push("верно");
      } else if (acceptable.has(intent)) {
        stats.lenient += 1;
        category.hit += 1;
        outcomes.push(`${intent} (допустимо)`);
      } else {
        const key = `${testCase.expected} → ${intent}`;
        stats.confusion.set(key, (stats.confusion.get(key) ?? 0) + 1);
        outcomes.push(intent);
      }
    }

    const allCorrect = outcomes.every((o) => o === "верно");
    const mark = allCorrect ? "  ok " : "MISS ";
    console.log(`${mark} ${testCase.expected.padEnd(20)} ${JSON.stringify(testCase.text)}`);
    if (!allCorrect) {
      console.log(`       → ${outcomes.join(", ")}`);
      if (testCase.note) console.log(`       (${testCase.note})`);
    }
  }

  const { total, latencies } = stats;
  const sorted = [...latencies].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  const avgTokens = stats.completionTokens.length
    ? Math.round(stats.completionTokens.reduce((a, b) => a + b, 0) / stats.completionTokens.length)
    : 0;

  console.log(`\n${"─".repeat(64)}`);
  console.log(`Запросов                 ${total}`);
  console.log(`Разобрался как JSON      ${stats.parsed}/${total}  ${pct(stats.parsed, total)}` +
    (stats.salvaged ? `  (из них ${stats.salvaged} — только после вырезания текста вокруг)` : ""));
  console.log(`Прошло схему §2          ${stats.valid}/${total}  ${pct(stats.valid, total)}`);
  console.log(`Интент верный (строго)   ${stats.strict}/${total}  ${pct(stats.strict, total)}`);
  console.log(`Интент верный (мягко)    ${stats.lenient}/${total}  ${pct(stats.lenient, total)}`);
  console.log(`Медиана времени ответа   ${median} мс`);
  console.log(`Токенов ответа в среднем ${avgTokens}`);

  console.log(`\nПо категориям:`);
  for (const [intent, { total: t, hit }] of stats.byCategory) {
    console.log(`  ${intent.padEnd(22)} ${hit}/${t}  ${pct(hit, t)}`);
  }

  if (stats.confusion.size > 0) {
    console.log(`\nПутаница:`);
    for (const [pair, count] of [...stats.confusion].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${pair.padEnd(46)} ${count}`);
    }
  }
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
