#!/usr/bin/env node
/**
 * Бенчмарк токенов и стоимости на реальной модели: прогоняет фиксированный
 * набор сессий через полный конвейер Core (DialogService — Router, Theory,
 * Planner, PlanExecutor на настоящей бирже, Summary) с телемитрией,
 * включённой так же, как в app.js, и печатает те же агрегаты, что дашборд.
 *
 * В отличие от scripts/measure-context-savings.mjs (сравнивает промпт "до"
 * и "после" без обращения к модели, но не может измерить completion-токены
 * и стоимость), этот скрипт даёт настоящие числа ценой того, что нужен живой
 * LM Studio/Ollama — как и router-eval.mjs/task-eval.mjs, к которым он
 * идёт в комплекте: "до" — прогон на коммите перед оптимизациями, "после" —
 * на текущем. Числа обоих прогонов — в docs/token-optimization-results.md.
 *
 * Запуск (проект развёрнут в Docker — значит, внутри контейнера Core: там
 * уже есть и node_modules, и Python с TA-Lib, и адреса моделей из .env):
 *   docker compose exec core node scripts/token-benchmark.mjs
 *   docker compose exec core node scripts/token-benchmark.mjs --label=база --runs=3 --json=/app/data/base.json
 *   # …правки…
 *   docker compose exec core node scripts/token-benchmark.mjs --label=после --runs=3 --compare=/app/data/base.json
 *
 * Без Docker — из каталога core после `npm install`:
 *   node scripts/token-benchmark.mjs
 *   node scripts/token-benchmark.mjs --provider=ollama --model=qwen3:8b
 *
 * Флаги:
 *   --provider=ollama|lmstudio  раннер (по умолчанию LLM_PROVIDER из .env)
 *   --model=…      модель (по умолчанию из .env)
 *   --base-url=…   адрес сервера модели (по умолчанию из .env)
 *   --label=…      подпись прогона в выводе (например "до"/"после")
 *   --runs=N       прогонов всего набора (по умолчанию 1)
 *   --json=path    сохранить замер машиночитаемо (для --compare)
 *   --compare=path сравнить с ранее сохранённым замером
 *
 * `--runs` нужен потому, что температура у отвечающих агентов не нулевая:
 * длина их ответов гуляет от прогона к прогону, а в многоходовых сессиях
 * попадает в историю и тянет за собой input-токены следующих ходов. Один
 * прогон показывает порядок величины, три — разницу, которой можно верить.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { config } from "../src/config.js";
import { resolveRsi } from "../src/app.js";
import { OllamaRunner } from "../src/llm/OllamaRunner.js";
import { LmStudioRunner } from "../src/llm/LmStudioRunner.js";
import { createDatabase } from "../src/db/database.js";
import { ChatRepository } from "../src/db/chatRepository.js";
import { DialogService, PROGRESS_STAGE } from "../src/domain/DialogService.js";
import { PlanExecutor } from "../src/domain/PlanExecutor.js";
import { RouterAgent } from "../src/agents/RouterAgent.js";
import { TheoryAgent } from "../src/agents/TheoryAgent.js";
import { PlannerAgent } from "../src/agents/PlannerAgent.js";
import { SummaryAgent } from "../src/agents/SummaryAgent.js";
import { BinanceClient } from "../src/tools/BinanceClient.js";
import { CoinGeckoClient } from "../src/tools/CoinGeckoClient.js";
import { createTools } from "../src/tools/index.js";
import { loadSkills } from "../src/skills/index.js";
import { initTelemetry } from "../src/telemetry/recorder.js";
import { InstrumentedLlmRunner } from "../src/telemetry/InstrumentedLlmRunner.js";
import { runInJob } from "../src/telemetry/context.js";
import { LLM_ERROR } from "../src/llm/LlmRunner.js";

/**
 * Сессии-сценарии.
 *
 * Набор подобран не «побольше запросов», а по тому, что тратит токены
 * по-разному:
 *
 *   - **все четыре ветки маршрутизатора.** У теории это два вызова модели
 *     (Router и ответ), у уточнения и отказа по скоупу — один: дальше
 *     маршрутизатора они не идут вовсе, и в среднем по заданию это заметно;
 *   - **все инструменты реестра.** Размер их вывода различается на порядки:
 *     котировка — десяток чисел, свечи и скринер — сотни, и именно они
 *     определяют длину брифа сводящего агента (см. `compactForPrompt`).
 *     Мерить токены на одних котировках значит не увидеть самого дорогого;
 *   - **отказ инструмента** (`unsupported_asset`): его причина уходит модели
 *     вместе с неудавшимся шагом и тоже стоит токенов;
 *   - **многоходовые диалоги.** История копится и уходит Router и Planner
 *     дважды за одно задание — это тот самый источник, ради которого заведена
 *     оптимизация 1, и без многоходовых сессий её эффект не измерить.
 */
const SESSIONS = [
  // Теория: маршрутизатор плюс один отвечающий вызов.
  ["Что такое funding rate?"],
  ["Чем лимитный ордер отличается от рыночного?"],

  // Уточнение и отказ по скоупу: конвейер дальше маршрутизатора не идёт.
  ["Покажи объем"],
  ["Напиши стих про осень"],

  // По задаче на инструмент.
  ["Какая сейчас цена BTC?"],
  ["Покажи почасовые свечи ETH за последние сутки"],
  ["Найди топ-10 пар к USDT по суточному объёму торгов"],
  ["Покажи топ монет по рыночной капитализации"],
  ["Посчитай RSI по BTC на дневных свечах"],
  // Отказ инструмента: RSI считается только для BTC и ETH.
  ["Посчитай RSI по DOGE"],

  // Многоходовые: история копится и попадает в промпт классификаторов.
  [
    "Покажи цену и суточную статистику BTC",
    "А что по ETH?",
    "Сравни их волатильность за сутки",
  ],
  ["Посмотри стакан по SOLUSDT, есть ли крупные стенки", "А по BTCUSDT?"],
];

/**
 * Отпечаток набора запросов. Печатается и попадает в JSON, а `--compare`
 * по нему проверяет, что сравнивают одно и то же: правка SESSIONS меняет
 * числа сильнее любой оптимизации, и молча приписать себе эту разницу — самая
 * лёгкая из ошибок такого замера.
 */
const SET_HASH = createHash("sha256").update(JSON.stringify(SESSIONS)).digest("hex").slice(0, 8);

function parseArgs(argv) {
  const args = { label: null, runs: 1 };
  for (const arg of argv) {
    const [rawKey, value] = arg.replace(/^--/, "").split("=");
    // base-url → baseUrl: флаги пишут через дефис, читаются они как поля.
    // Пока приведения не было, документированный --base-url молча не работал.
    const key = rawKey.replace(/-([a-z])/g, (_m, letter) => letter.toUpperCase());
    args[key] = value ?? true;
  }

  args.runs = Number(args.runs);
  if (!Number.isInteger(args.runs) || args.runs < 1) {
    throw new Error("--runs: целое ≥ 1");
  }
  return args;
}

function buildRunner(args) {
  const provider = args.provider ?? config.llmProvider;
  const providerConfig = config[provider];
  const model = args.model ?? providerConfig.model;
  const baseUrl = args.baseUrl ?? providerConfig.baseUrl;

  const inner =
    provider === "ollama"
      ? new OllamaRunner({ baseUrl, model, timeoutMs: providerConfig.timeoutMs, numCtx: config.contextWindowTokens })
      : new LmStudioRunner({ baseUrl, model, timeoutMs: providerConfig.timeoutMs });

  return { inner, provider, model, baseUrl };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { inner, provider, model, baseUrl } = buildRunner(args);

  const db = createDatabase(":memory:");
  initTelemetry(db, { pricing: config.telemetry.pricing });
  const chatRepository = new ChatRepository(db);

  const instrumented = (agentId, stage) =>
    new InstrumentedLlmRunner(inner, { agentId, stage, provider, model });

  // Реестр собирается ровно как в app.js, включая RSI: иначе бенчмарк мерил
  // бы промпт планировщика, которого в эксплуатации не бывает — навык
  // crypto-rsi в него попадает всегда (loadSkills ниже), а сам инструмент до
  // этой правки не попадал никогда, и правила навыка ссылались на то, чего
  // в списке нет.
  const tools = createTools({
    binance: new BinanceClient({ baseUrl: config.tools.binanceBaseUrl, timeoutMs: config.tools.timeoutMs }),
    coingecko: new CoinGeckoClient({ baseUrl: config.tools.coingeckoBaseUrl, timeoutMs: config.tools.timeoutMs }),
    rsi: resolveRsi(config.tools.rsi),
  });

  const dialogService = new DialogService({
    chatRepository,
    routerAgent: new RouterAgent({ llmRunner: instrumented("router", PROGRESS_STAGE.routing) }),
    theoryAgent: new TheoryAgent({ llmRunner: instrumented("theory", PROGRESS_STAGE.answering) }),
    plannerAgent: new PlannerAgent({
      llmRunner: instrumented("planner", PROGRESS_STAGE.planning),
      tools,
      skills: loadSkills(config.skillsDir),
    }),
    planExecutor: new PlanExecutor({ tools }),
    summaryAgent: new SummaryAgent({ llmRunner: instrumented("summary", PROGRESS_STAGE.summarizing) }),
    contextWindowTokens: config.contextWindowTokens,
  });

  const jobsPerRun = SESSIONS.flat().length;
  console.log(`Модель: ${provider}/${model}  ${baseUrl}`);
  if (args.label) console.log(`Прогон: ${args.label}`);
  // Состав реестра — часть условий замера: он задаёт длину промпта
  // планировщика, а RSI попадает в него не на всякой машине (нужен Python с
  // TA-Lib). Без этой строки два прогона нельзя честно сравнить между собой.
  console.log(`Инструменты (${Object.keys(tools).length}): ${Object.keys(tools).join(", ")}`);
  console.log(
    `Сессий: ${SESSIONS.length}, заданий за прогон: ${jobsPerRun}, ` +
      `прогонов: ${args.runs}, всего заданий: ${jobsPerRun * args.runs}`,
  );
  console.log(`Набор запросов: ${SET_HASH} (сравнивать можно только замеры с тем же отпечатком)\n`);

  // Исход каждого задания: статус и ветка. В телеметрию они не пишутся (там
  // вызовы, а не задания), а без них не видно, что прогон вообще прошёл теми
  // же ветками, — а значит и сравнивать нечего.
  const outcomes = [];

  for (let run = 1; run <= args.runs; run += 1) {
    if (args.runs > 1) console.log(`— прогон ${run} из ${args.runs} —`);

    let sessionNumber = 0;
    for (const session of SESSIONS) {
      sessionNumber += 1;
      // Номер прогона в ключе диалога: иначе повторный прогон продолжил бы
      // историю предыдущего и мерил бы совсем другие промпты.
      const conversation = chatRepository.getOrCreateConversation(
        "benchmark",
        `run-${run}-session-${sessionNumber}`,
      );
      let turnNumber = 0;
      for (const text of session) {
        turnNumber += 1;
        const jobId = `bench-${run}-${sessionNumber}-${turnNumber}`;

        const outcome = await runInJob({ jobId, conversationId: conversation.id, db }, () =>
          dialogService.process({ conversationId: conversation.id, text }),
        );

        if (outcome.historyEntry) {
          const { sessionId, userText, assistantText, totalTokens } = outcome.historyEntry;
          chatRepository.appendExchange(sessionId, userText, assistantText, totalTokens);
        }

        outcomes.push({ status: outcome.status, intent: outcome.intent, reason: outcome.reason });
        console.log(`  [${jobId}] "${text.slice(0, 40)}" → ${outcome.status} (${outcome.reason ?? outcome.intent ?? ""})`);

        // Дальше мерить нечего: без модели все задания отвалятся одинаково, а
        // итог выйдет из нулей и будет выглядеть как состоявшийся замер.
        // Чаще всего в Docker это именно адрес: `localhost` внутри контейнера
        // — сам контейнер, а не машина, где запущен LM Studio.
        if (outcome.reason === LLM_ERROR.unavailable) {
          console.error(
            `\nМодель недоступна по адресу ${baseUrl} — замер прерван.\n` +
              "Если Core запущен в контейнере, адрес хоста — не localhost: пропишите\n" +
              "LMSTUDIO_BASE_URL=http://host.docker.internal:1234 (или OLLAMA_BASE_URL=...:11434)\n" +
              "в core/.env и перезапустите compose. Проверить снаружи:\n" +
              "  curl http://localhost:1234/v1/models",
          );
          process.exit(1);
        }
      }
    }
  }

  const summary = collectSummary(db, { outcomes, label: args.label, provider, model, baseUrl, tools, runs: args.runs });
  printSummary(summary);

  if (args.json) {
    writeFileSync(args.json, `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`\nЗамер сохранён: ${args.json}`);
  }

  if (args.compare) {
    printComparison(JSON.parse(readFileSync(args.compare, "utf8")), summary);
  }
}

/**
 * Все метрики, которые пишет телеметрия, — по колонкам обеих таблиц.
 *
 * Ничего не пропущено намеренно: колонка, которую пишут, но не смотрят, рано
 * или поздно оказывается той самой, которой не хватило. Отдельно стоит
 * отметить три, которых в выводе не было вовсе: успешность вызовов (`ok`,
 * `error_code`) — прогон с отвалившимися вызовами по токенам выглядит как
 * удачный; длительность инструментов (`duration_ms`) — она копится наравне с
 * задержкой модели; и размеры их вывода в байтах (`input_size`,
 * `output_size`), из которых видно, что именно раздувает бриф.
 */
function collectSummary(db, { outcomes, label, provider, model, baseUrl, tools, runs }) {
  const one = (sql) => db.prepare(sql).get();
  const all = (sql) => db.prepare(sql).all();

  const llm = one(`
    SELECT COUNT(*) AS calls,
           SUM(ok) AS ok,
           COALESCE(SUM(prompt_tokens), 0) AS input,
           COALESCE(SUM(completion_tokens), 0) AS output,
           COALESCE(SUM(reasoning_tokens), 0) AS reasoning,
           COALESCE(SUM(repeated_prompt_tokens_estimate), 0) AS repeated,
           COALESCE(SUM(estimated_cost_usd), 0) AS cost,
           COALESCE(AVG(latency_ms), 0) AS avgLatency,
           COALESCE(MAX(latency_ms), 0) AS maxLatency
    FROM llm_calls`);

  const tool = one(`
    SELECT COUNT(*) AS calls,
           SUM(ok) AS ok,
           COALESCE(SUM(input_size), 0) AS inputBytes,
           COALESCE(SUM(output_size), 0) AS outputBytes,
           COALESCE(SUM(output_tokens_estimate), 0) AS outputTokens,
           COALESCE(AVG(duration_ms), 0) AS avgDuration,
           COALESCE(MAX(duration_ms), 0) AS maxDuration
    FROM tool_calls`);

  const jobs = one(`SELECT COUNT(DISTINCT job_id) AS n FROM llm_calls WHERE job_id IS NOT NULL`).n;
  const per = (value) => (jobs ? round(value / jobs, 1) : 0);

  return {
    label: label ?? null,
    recordedAt: new Date().toISOString(),
    // Условия замера. Сравнивать имеет смысл только прогоны, у которых они
    // совпали: другой набор запросов, другая модель или другой состав
    // инструментов — это другие числа, а не улучшение.
    conditions: {
      provider,
      model,
      baseUrl,
      runs,
      sessions: SESSIONS.length,
      jobsPerRun: SESSIONS.flat().length,
      tools: Object.keys(tools),
      setHash: SET_HASH,
    },
    jobs: {
      total: jobs,
      byStatus: tally(outcomes.map((o) => o.status)),
      byIntent: tally(outcomes.map((o) => o.intent ?? o.reason ?? "—")),
      llmCallsPerJob: per(llm.calls),
      toolCallsPerJob: per(tool.calls),
      inputPerJob: per(llm.input),
      outputPerJob: per(llm.output),
      costPerJob: jobs ? round(llm.cost / jobs, 6) : 0,
    },
    llm: {
      ...llm,
      failed: llm.calls - (llm.ok ?? 0),
      avgLatency: Math.round(llm.avgLatency),
      cost: round(llm.cost, 6),
      repeatRate: llm.input ? round(llm.repeated / llm.input, 4) : 0,
      errors: tally(all(`SELECT error_code AS v FROM llm_calls WHERE ok = 0`).map((r) => r.v ?? "—")),
      byAgent: all(`
        SELECT agent_id AS agent, COUNT(*) AS calls, SUM(ok) AS ok,
               COALESCE(SUM(prompt_tokens), 0) AS input,
               COALESCE(SUM(completion_tokens), 0) AS output,
               COALESCE(SUM(reasoning_tokens), 0) AS reasoning,
               COALESCE(SUM(repeated_prompt_tokens_estimate), 0) AS repeated,
               COALESCE(SUM(estimated_cost_usd), 0) AS cost,
               COALESCE(AVG(latency_ms), 0) AS avgLatency
        FROM llm_calls GROUP BY agent_id ORDER BY input DESC`).map(normaliseAgent),
      byStage: all(`
        SELECT stage, COUNT(*) AS calls,
               COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tokens
        FROM llm_calls GROUP BY stage ORDER BY tokens DESC`),
    },
    tools: {
      ...tool,
      failed: tool.calls - (tool.ok ?? 0),
      avgDuration: Math.round(tool.avgDuration),
      errors: tally(all(`SELECT error_code AS v FROM tool_calls WHERE ok = 0`).map((r) => r.v ?? "—")),
      byTool: all(`
        SELECT tool_name AS tool, COUNT(*) AS calls, SUM(ok) AS ok,
               COALESCE(SUM(input_size), 0) AS inputBytes,
               COALESCE(SUM(output_size), 0) AS outputBytes,
               COALESCE(SUM(output_tokens_estimate), 0) AS tokens,
               COALESCE(AVG(duration_ms), 0) AS avgDuration
        FROM tool_calls GROUP BY tool_name ORDER BY tokens DESC`)
        .map((r) => ({ ...r, failed: r.calls - (r.ok ?? 0), avgDuration: Math.round(r.avgDuration) })),
    },
  };
}

function normaliseAgent(row) {
  return {
    ...row,
    failed: row.calls - (row.ok ?? 0),
    cost: round(row.cost, 6),
    avgLatency: Math.round(row.avgLatency),
  };
}

/** Счётчик значений: {completed: 12, rejected: 2}. */
function tally(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round((value ?? 0) * factor) / factor;
}

function printSummary(s) {
  const line = (name, value) => console.log(`  ${name.padEnd(26)} ${value}`);

  console.log("\n──────────────────────────────────────────");
  if (s.label) console.log(`Замер: ${s.label}`);
  console.log(`Набор: ${s.conditions.setHash}  (${s.conditions.sessions} сессий × ${s.conditions.runs} прогонов)\n`);

  console.log("ЗАДАНИЯ");
  line("всего", s.jobs.total);
  line("по статусам", format(s.jobs.byStatus));
  line("по веткам", format(s.jobs.byIntent));
  line("вызовов модели на задание", s.jobs.llmCallsPerJob);
  line("вызовов инструментов", s.jobs.toolCallsPerJob);
  line("input на задание", s.jobs.inputPerJob);
  line("output на задание", s.jobs.outputPerJob);
  line("стоимость на задание", `$${s.jobs.costPerJob.toFixed(6)}`);

  console.log("\nМОДЕЛЬ");
  line("вызовов", `${s.llm.calls} (успешных ${s.llm.ok}, неудачных ${s.llm.failed})`);
  if (s.llm.failed > 0) line("причины отказов", format(s.llm.errors));
  line("input токенов", s.llm.input);
  line("output токенов", s.llm.output);
  line("reasoning токенов", s.llm.reasoning);
  line("repeated токенов", `${s.llm.repeated} (${round(s.llm.repeatRate * 100, 1)}% от input)`);
  line("условная стоимость", `$${s.llm.cost.toFixed(4)}`);
  line("задержка, мс", `средняя ${s.llm.avgLatency}, максимум ${s.llm.maxLatency}`);

  console.log("\nИНСТРУМЕНТЫ");
  line("вызовов", `${s.tools.calls} (успешных ${s.tools.ok ?? 0}, неудачных ${s.tools.failed})`);
  if (s.tools.failed > 0) line("причины отказов", format(s.tools.errors));
  line("вход / выход, байт", `${s.tools.inputBytes} / ${s.tools.outputBytes}`);
  line("выход, ~токенов", s.tools.outputTokens);
  line("длительность, мс", `средняя ${s.tools.avgDuration}, максимум ${s.tools.maxDuration}`);

  console.log("\nПО АГЕНТАМ");
  for (const a of s.llm.byAgent) {
    console.log(
      `  ${a.agent.padEnd(16)} вызовов=${a.calls}${a.failed ? `(-${a.failed})` : ""}  ` +
        `input=${a.input}  output=${a.output}  reasoning=${a.reasoning}  ` +
        `repeated=${a.repeated}  ${a.avgLatency} мс  $${a.cost.toFixed(4)}`,
    );
  }

  console.log("\nПО СТАДИЯМ");
  for (const st of s.llm.byStage) {
    console.log(`  ${st.stage.padEnd(16)} вызовов=${st.calls}  токенов=${st.tokens}`);
  }

  if (s.tools.byTool.length > 0) {
    console.log("\nПО ИНСТРУМЕНТАМ");
    for (const t of s.tools.byTool) {
      console.log(
        `  ${t.tool.padEnd(30)} вызовов=${t.calls}${t.failed ? `(-${t.failed})` : ""}  ` +
          `выход=${t.outputBytes}б (~${t.tokens} ток.)  ${t.avgDuration} мс`,
      );
    }
  }
}

function format(counts) {
  const parts = Object.entries(counts).map(([key, n]) => `${key}=${n}`);
  return parts.length > 0 ? parts.join(", ") : "—";
}

/**
 * Сравнение двух замеров.
 *
 * Смысл имеет только на одном и том же наборе запросов, поэтому сверяем
 * `setHash` и условия: сравнить замер до правки с замером после правки, между
 * которыми поменялся ещё и набор, — верный способ приписать себе чужую
 * экономию (или чужую регрессию).
 */
function printComparison(before, after) {
  console.log("\n══════════════════════════════════════════");
  console.log(`Сравнение: ${before.label ?? "?"} → ${after.label ?? "?"}`);

  const warn = [];
  if (before.conditions.setHash !== after.conditions.setHash) {
    warn.push("НАБОР ЗАПРОСОВ РАЗНЫЙ — числа несопоставимы");
  }
  if (before.conditions.model !== after.conditions.model) warn.push("разные модели");
  if (before.conditions.runs !== after.conditions.runs) warn.push("разное число прогонов");
  if (before.conditions.tools.join() !== after.conditions.tools.join()) {
    warn.push("разный состав инструментов — промпт планировщика отличается");
  }
  for (const message of warn) console.log(`  ⚠ ${message}`);
  console.log();

  const rows = [
    ["input на задание", before.jobs.inputPerJob, after.jobs.inputPerJob],
    ["output на задание", before.jobs.outputPerJob, after.jobs.outputPerJob],
    ["вызовов модели на задание", before.jobs.llmCallsPerJob, after.jobs.llmCallsPerJob],
    ["input всего", before.llm.input, after.llm.input],
    ["output всего", before.llm.output, after.llm.output],
    ["reasoning", before.llm.reasoning, after.llm.reasoning],
    ["repeated", before.llm.repeated, after.llm.repeated],
    // Доля — с десятыми: округление до целого превращало 1.4% → 1 и 1.6% → 2,
    // и строка разницы объявляла «+100%» там, где сам repeated изменился на 2%,
    // а доля выросла только потому, что сократился знаменатель.
    ["repeated, % от input", round(before.llm.repeatRate * 100, 1), round(after.llm.repeatRate * 100, 1)],
    ["стоимость, $", round(before.llm.cost, 4), round(after.llm.cost, 4)],
    ["задержка модели, мс", before.llm.avgLatency, after.llm.avgLatency],
    ["неудачных вызовов", before.llm.failed, after.llm.failed],
    ["вывод инструментов, ~ток.", before.tools.outputTokens, after.tools.outputTokens],
    ["длительность инстр., мс", before.tools.avgDuration, after.tools.avgDuration],
  ];

  console.log(`  ${"метрика".padEnd(28)}${"до".padStart(12)}${"после".padStart(12)}${"разница".padStart(18)}`);
  for (const [name, was, now] of rows) {
    const delta = round(now - was, 4);
    const percent = was ? ` (${delta > 0 ? "+" : ""}${Math.round((delta / was) * 100)}%)` : "";
    const sign = delta > 0 ? "+" : "";
    console.log(
      `  ${name.padEnd(28)}${String(was).padStart(12)}${String(now).padStart(12)}` +
        `${`${sign}${delta}${percent}`.padStart(18)}`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
