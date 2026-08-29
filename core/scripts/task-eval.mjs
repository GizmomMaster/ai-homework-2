#!/usr/bin/env node
/**
 * Замер качества Агента-Планировщика на локальной модели.
 *
 * Отвечает на вопрос, который был главным риском всей спецификации: строит ли
 * модель такого размера пригодный план из вложенного JSON. Проверяет четыре
 * вещи по каждой задаче:
 *   1. Разобрался ли ответ и прошёл ли схему.
 *   2. Верно ли решено, выполнима ли задача вообще.
 *   3. Те ли инструменты выбраны.
 *   4. **Годятся ли параметры** — прогоняются настоящими валидаторами из
 *      `src/tools/params.js`, теми же, что защищают боевой код.
 *
 * К бирже по умолчанию не ходит: проверка параметров не требует сети, а сеть
 * добавила бы в замер чужие отказы. Флаг --execute включает реальные вызовы.
 *
 * Запуск:
 *   node scripts/task-eval.mjs
 *   node scripts/task-eval.mjs --model=qwen3:1.7b --verbose
 *   node scripts/task-eval.mjs --execute
 *
 * Флаги:
 *   --provider=ollama|lmstudio  раннер (по умолчанию LLM_PROVIDER из .env)
 *   --model=…      модель (по умолчанию из .env)
 *   --base-url=…   адрес сервера модели (по умолчанию из .env)
 *   --runs=N       прогонов каждой задачи (по умолчанию 1)
 *   --execute      ещё и выполнить планы на настоящей бирже
 *   --verbose      печатать план целиком по каждому промаху
 */
import { config } from "../src/config.js";
import { OllamaRunner } from "../src/llm/OllamaRunner.js";
import { LmStudioRunner } from "../src/llm/LmStudioRunner.js";
import { LLM_ERROR } from "../src/llm/LlmRunner.js";
import { PlannerAgent } from "../src/agents/PlannerAgent.js";
import { PlanExecutor } from "../src/domain/PlanExecutor.js";
import { BinanceClient } from "../src/tools/BinanceClient.js";
import { createTools } from "../src/tools/index.js";

/**
 * Набор задач. `tools` — инструменты, которых ждём в плане (порядок и
 * повторы не важны); `steps` — допустимый разброс числа шагов.
 */
const CASES = [
  {
    text: "Какая сейчас цена BTC?",
    canExecute: true,
    tools: ["get_crypto_current_price"],
    steps: [1, 1],
  },
  {
    text: "Сравни суточные объемы торгов между SOL, ETH и BTC",
    canExecute: true,
    tools: ["get_crypto_24h_ticker_stats"],
    steps: [3, 3],
    note: "по шагу на монету",
  },
  {
    text: "Покажи свечи ETHUSDT за последние сутки по часу",
    canExecute: true,
    tools: ["get_crypto_historical_klines"],
    steps: [1, 1],
  },
  {
    text: "Посмотри стакан по SOLUSDT, есть ли крупные стенки",
    canExecute: true,
    tools: ["get_crypto_orderbook_depth"],
    steps: [1, 1],
  },
  {
    text: "Найди топ-10 монет по суточному объему торгов",
    canExecute: true,
    tools: ["get_crypto_top_by_volume"],
    steps: [1, 1],
  },
  {
    text: "Насколько BTC волатильнее ETH за последние сутки?",
    canExecute: true,
    tools: ["get_crypto_historical_klines", "get_crypto_24h_ticker_stats"],
    steps: [2, 4],
    note: "любой источник разброса цены годится",
  },
  {
    text: "Какой спред у SOLUSDT и сколько там ликвидности в стакане?",
    canExecute: true,
    tools: ["get_crypto_current_price", "get_crypto_orderbook_depth"],
    steps: [1, 3],
  },
  { text: "Купи мне 1 BTC на бирже", canExecute: false },
  { text: "Собери твиты Илона Маска про Dogecoin", canExecute: false },
  { text: "Проанализируй отчётность Apple за квартал", canExecute: false },
  { text: "Выведи мои средства на кошелёк", canExecute: false },
];

function parseArgs(argv) {
  const args = { runs: 1, execute: false, verbose: false };
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    if (key === "verbose") args.verbose = true;
    else if (key === "execute") args.execute = true;
    else if (key === "runs") args.runs = Number(value);
    else if (key === "base-url") args.baseUrl = value;
    else args[key] = value;
  }
  if (args.provider && !["ollama", "lmstudio"].includes(args.provider)) {
    throw new Error("--provider: ожидается ollama или lmstudio");
  }
  if (!Number.isInteger(args.runs) || args.runs < 1) throw new Error("--runs: целое ≥ 1");
  return args;
}

/**
 * Проверяет параметры шага теми же валидаторами, что и боевой код, не
 * обращаясь к сети: инструмент вызывается с подменённым клиентом.
 */
async function checkParams(step, offlineTools) {
  const tool = offlineTools[step.toolToUse];
  if (!tool) return `нет инструмента ${step.toolToUse}`;
  try {
    await tool.run(step.parameters ?? {});
    return null;
  } catch (error) {
    // Отказ сети означает, что проверка параметров пройдена.
    return error.code === "invalid_params" ? error.message : null;
  }
}

function pct(part, total) {
  return total === 0 ? "—" : `${((part / total) * 100).toFixed(0)}%`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const provider = args.provider ?? config.llmProvider;
  const providerConfig = config[provider];
  const model = args.model ?? providerConfig.model;
  const baseUrl = args.baseUrl ?? providerConfig.baseUrl;

  const llmRunner =
    provider === "ollama"
      ? new OllamaRunner({
          baseUrl,
          model,
          timeoutMs: providerConfig.timeoutMs,
          think: providerConfig.think,
          numCtx: 8192,
        })
      : new LmStudioRunner({ baseUrl, model, timeoutMs: providerConfig.timeoutMs });

  // Два реестра: один с настоящим клиентом для --execute, другой с заведомо
  // недоступным адресом — по нему проверяются только параметры.
  const tools = createTools({
    binance: new BinanceClient({ baseUrl: config.tools.binanceBaseUrl, timeoutMs: 15000 }),
  });
  const offlineTools = createTools({
    binance: new BinanceClient({ baseUrl: "http://127.0.0.1:1", timeoutMs: 50 }),
  });

  const planner = new PlannerAgent({ llmRunner, tools });
  const executor = new PlanExecutor({ tools });

  console.log(
    `Модель: ${model}   ${provider}: ${baseUrl}\n` +
      `Задач: ${CASES.length}, прогонов: ${args.runs}` +
      `${args.execute ? ", с выполнением на бирже" : ""}\n`,
  );

  const stats = {
    total: 0,
    parsed: 0,
    verdict: 0,
    toolsOk: 0,
    paramsOk: 0,
    stepsOk: 0,
    executed: 0,
    executedOk: 0,
    latencies: [],
  };

  for (const testCase of CASES) {
    for (let run = 0; run < args.runs; run += 1) {
      stats.total += 1;
      const problems = [];
      const startedAt = Date.now();

      let plan;
      try {
        plan = await planner.plan({ history: [], text: testCase.text });
        stats.parsed += 1;
      } catch (error) {
        if (error.code === LLM_ERROR.unavailable) throw error;
        console.log(`MISS ${JSON.stringify(testCase.text)}\n       → не разобрался: ${error.code}`);
        continue;
      }
      stats.latencies.push(Date.now() - startedAt);

      if (plan.canExecute === testCase.canExecute) stats.verdict += 1;
      else problems.push(`canExecute=${plan.canExecute}, ожидался ${testCase.canExecute}`);

      if (testCase.canExecute) {
        const used = [...new Set(plan.plan.map((s) => s.toolToUse))];
        const expected = new Set(testCase.tools);
        if (used.length > 0 && used.every((t) => expected.has(t))) stats.toolsOk += 1;
        else problems.push(`инструменты: ${used.join(", ") || "нет"}`);

        const [min, max] = testCase.steps;
        if (plan.plan.length >= min && plan.plan.length <= max) stats.stepsOk += 1;
        else problems.push(`шагов ${plan.plan.length}, ожидалось ${min}–${max}`);

        const paramProblems = (
          await Promise.all(plan.plan.map((s) => checkParams(s, offlineTools)))
        ).filter(Boolean);
        if (paramProblems.length === 0) stats.paramsOk += 1;
        else problems.push(`параметры: ${paramProblems.join("; ")}`);

        if (args.execute && plan.plan.length > 0) {
          const execution = await executor.run(plan.plan);
          stats.executed += 1;
          if (execution.failed === 0) stats.executedOk += 1;
          else problems.push(`на бирже упало шагов: ${execution.failed}`);
        }
      } else if (!plan.fallbackMessage) {
        problems.push("отказ без объяснения");
      }

      const mark = problems.length === 0 ? "  ok " : "MISS ";
      console.log(`${mark} ${JSON.stringify(testCase.text)}`);
      if (problems.length > 0) {
        console.log(`       → ${problems.join("; ")}`);
        if (testCase.note) console.log(`       (${testCase.note})`);
        if (args.verbose) console.log(`       ${JSON.stringify(plan.plan)}`);
      }
    }
  }

  const planned = CASES.filter((c) => c.canExecute).length * args.runs;
  const sorted = [...stats.latencies].sort((a, b) => a - b);

  console.log(`\n${"─".repeat(64)}`);
  console.log(`Задач                    ${stats.total}`);
  console.log(`План разобрался          ${stats.parsed}/${stats.total}  ${pct(stats.parsed, stats.total)}`);
  console.log(`Выполнимость определена  ${stats.verdict}/${stats.total}  ${pct(stats.verdict, stats.total)}`);
  console.log(`Инструменты верные       ${stats.toolsOk}/${planned}  ${pct(stats.toolsOk, planned)}`);
  console.log(`Параметры проходят       ${stats.paramsOk}/${planned}  ${pct(stats.paramsOk, planned)}`);
  console.log(`Число шагов разумное     ${stats.stepsOk}/${planned}  ${pct(stats.stepsOk, planned)}`);
  if (stats.executed > 0) {
    console.log(`Выполнено на бирже без отказов  ${stats.executedOk}/${stats.executed}  ${pct(stats.executedOk, stats.executed)}`);
  }
  console.log(`Медиана планирования     ${sorted[Math.floor(sorted.length / 2)] ?? 0} мс`);
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
