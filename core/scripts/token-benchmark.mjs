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
 * Запуск:
 *   node scripts/token-benchmark.mjs
 *   node scripts/token-benchmark.mjs --provider=ollama --model=qwen3:8b
 *   node scripts/token-benchmark.mjs --label=после-оптимизаций
 *
 * Флаги:
 *   --provider=ollama|lmstudio  раннер (по умолчанию LLM_PROVIDER из .env)
 *   --model=…      модель (по умолчанию из .env)
 *   --base-url=…   адрес сервера модели (по умолчанию из .env)
 *   --label=…      подпись прогона в выводе (например "до"/"после")
 */
import { config } from "../src/config.js";
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

/**
 * Сессии-сценарии. Однократные вопросы покрывают все четыре ветки
 * маршрутизатора (как в router-eval.mjs), многоходовые — накопление истории
 * в рамках одного диалога, как у настоящего пользователя.
 */
const SESSIONS = [
  ["Что такое funding rate?"],
  ["Какая сейчас цена BTC?"],
  ["Покажи объем"],
  ["Напиши стих про осень"],
  [
    "Покажи цену и суточную статистику BTC",
    "А что по ETH?",
    "Сравни их волатильность за сутки",
  ],
  ["Посмотри стакан по SOLUSDT, есть ли крупные стенки", "А по BTCUSDT?"],
];

function parseArgs(argv) {
  const args = { label: null };
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    args[key] = value ?? true;
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

  const tools = createTools({
    binance: new BinanceClient({ baseUrl: config.tools.binanceBaseUrl, timeoutMs: config.tools.timeoutMs }),
    coingecko: new CoinGeckoClient({ baseUrl: config.tools.coingeckoBaseUrl, timeoutMs: config.tools.timeoutMs }),
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

  console.log(`Модель: ${provider}/${model}  ${baseUrl}`);
  console.log(`Сессий: ${SESSIONS.length}, заданий: ${SESSIONS.flat().length}\n`);

  let sessionNumber = 0;
  for (const session of SESSIONS) {
    sessionNumber += 1;
    const conversation = chatRepository.getOrCreateConversation("benchmark", `session-${sessionNumber}`);
    let turnNumber = 0;
    for (const text of session) {
      turnNumber += 1;
      const jobId = `bench-${sessionNumber}-${turnNumber}`;

      const outcome = await runInJob({ jobId, conversationId: conversation.id }, () =>
        dialogService.process({ conversationId: conversation.id, text }),
      );

      if (outcome.historyEntry) {
        const { sessionId, userText, assistantText, totalTokens } = outcome.historyEntry;
        chatRepository.appendExchange(sessionId, userText, assistantText, totalTokens);
      }

      console.log(`  [${jobId}] "${text.slice(0, 40)}" → ${outcome.status} (${outcome.reason ?? outcome.intent ?? ""})`);
    }
  }

  printSummary(db);
}

function printSummary(db) {
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS calls, SUM(prompt_tokens) AS input, SUM(completion_tokens) AS output,
              SUM(reasoning_tokens) AS reasoning, SUM(repeated_prompt_tokens_estimate) AS repeated,
              SUM(estimated_cost_usd) AS cost, AVG(latency_ms) AS avgLatency
       FROM llm_calls`,
    )
    .get();
  const toolTotals = db
    .prepare(`SELECT COUNT(*) AS calls, SUM(output_tokens_estimate) AS outputTokens FROM tool_calls`)
    .get();
  const jobs = db.prepare(`SELECT COUNT(DISTINCT job_id) AS n FROM llm_calls WHERE job_id IS NOT NULL`).get();
  const byAgent = db
    .prepare(
      `SELECT agent_id, COUNT(*) AS calls, SUM(prompt_tokens) AS input, SUM(completion_tokens) AS output,
              SUM(repeated_prompt_tokens_estimate) AS repeated
       FROM llm_calls GROUP BY agent_id ORDER BY input DESC`,
    )
    .all();
  const byTool = db
    .prepare(
      `SELECT tool_name, COUNT(*) AS calls, SUM(output_tokens_estimate) AS tokens
       FROM tool_calls GROUP BY tool_name ORDER BY tokens DESC`,
    )
    .all();

  console.log("\n──────────────────────────────────────────");
  console.log(`Заданий:            ${jobs.n}`);
  console.log(`Вызовов модели:     ${totals.calls}`);
  console.log(
    `Токены  input=${totals.input ?? 0}  output=${totals.output ?? 0}  ` +
      `reasoning=${totals.reasoning ?? 0}  repeated=${totals.repeated ?? 0}` +
      (totals.input ? `  (${Math.round(((totals.repeated ?? 0) / totals.input) * 100)}% input повторно)` : ""),
  );
  console.log(`Средняя задержка вызова: ${Math.round(totals.avgLatency ?? 0)} мс`);
  console.log(`Условная стоимость:      $${(totals.cost ?? 0).toFixed(4)}`);
  console.log(`Вызовов инструментов:    ${toolTotals.calls ?? 0} (~${toolTotals.outputTokens ?? 0} токенов вывода)`);

  console.log("\nПо агентам:");
  for (const row of byAgent) {
    console.log(
      `  ${row.agent_id.padEnd(10)} вызовов=${row.calls}  input=${row.input}  output=${row.output}  repeated=${row.repeated}`,
    );
  }

  if (byTool.length > 0) {
    console.log("\nПо инструментам:");
    for (const row of byTool) {
      console.log(`  ${row.tool_name.padEnd(28)} вызовов=${row.calls}  ~токенов=${row.tokens}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
