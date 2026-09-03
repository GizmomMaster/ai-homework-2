#!/usr/bin/env node
/**
 * Замер экономии входных токенов от оптимизаций 1 и 2 без обращения к
 * модели: сравнивает промпт "до" (обрезка/дедуп выключены) и "после" (как в
 * боевом коде) на одних и тех же фикстурах — точное, а не приблизительное
 * число, потому что источник и там, и там один и тот же код, а не два
 * похожих замера в разное время.
 *
 * Оптимизация 3 (схема маршрутизатора) сюда не входит: она экономит
 * completion-токены, которые без реального вызова модели не измерить —
 * оценка для неё в docs/token-optimization-results.md помечена как расчётная,
 * а не замеренная.
 *
 * Запуск: node scripts/measure-context-savings.mjs
 */
import { estimateExchangeTokens } from "../src/domain/estimateTokens.js";
import { truncateForClassifier } from "../src/domain/classifierContext.js";
import { dedupeStepValues, buildBrief } from "../src/agents/SummaryAgent.js";
import { ROUTER_CONTEXT_MESSAGES } from "../src/agents/RouterAgent.js";
import { PLANNER_CONTEXT_MESSAGES } from "../src/agents/PlannerAgent.js";

/** Правдоподобный многоходовой диалог: два предыдущих отчёта — то, что реально копится в истории. */
const REPORT_1 =
  "По BTCUSDT: текущая цена 65 120 USDT, рост за сутки 1.8%. Объём торгов составил " +
  "42 300 BTC (около 2.75 млрд USDT). Диапазон дня — от 63 900 до 65 800 USDT. " +
  "Книга ордеров сбалансирована, явного перевеса покупателей или продавцов не видно: " +
  "суммарный объём заявок на покупку и продажу в срезе стакана отличается меньше чем " +
  "на пару процентов, а среди крупных уровней ликвидности нет явного лидера ни с одной " +
  "из сторон.";
const REPORT_2 =
  "По ETHUSDT: цена 3 180 USDT, снижение за сутки на 0.6%. Объём торгов — 210 000 ETH " +
  "(около 668 млн USDT). Волатильность за последние сутки заметно ниже, чем у BTC: " +
  "размах между максимумом и минимумом — около 2.1% к цене закрытия. Свечи за последние " +
  "часы показывают постепенное затухание движения без резких скачков в ту или иную сторону, " +
  "что обычно предшествует консолидации, а не продолжению тренда.";

const history = [
  { role: "user", content: "покажи цену и объём BTC" },
  { role: "assistant", content: REPORT_1 },
  { role: "user", content: "а теперь по ETH" },
  { role: "assistant", content: REPORT_2 },
];
const currentQuestion = "а что там по SOL, тоже в плюсе?";

function messageTokens(messages) {
  return estimateExchangeTokens(...messages.map((m) => m.content));
}

function reportContextSavings() {
  const beforeRouter = [...truncateForClassifier(history.slice(-ROUTER_CONTEXT_MESSAGES), { maxChars: Infinity })];
  const afterRouter = [...truncateForClassifier(history.slice(-ROUTER_CONTEXT_MESSAGES))];
  const beforePlanner = [...truncateForClassifier(history.slice(-PLANNER_CONTEXT_MESSAGES), { maxChars: Infinity })];
  const afterPlanner = [...truncateForClassifier(history.slice(-PLANNER_CONTEXT_MESSAGES))];

  const beforeRouterTokens = messageTokens(beforeRouter);
  const afterRouterTokens = messageTokens(afterRouter);
  const beforePlannerTokens = messageTokens(beforePlanner);
  const afterPlannerTokens = messageTokens(afterPlanner);

  console.log("Оптимизация 1 — обрезка истории для Router/Planner");
  console.log("  фикстура: 2 обмена, 2 «отчёта» реалистичной длины (~%d и ~%d знаков)", REPORT_1.length, REPORT_2.length);
  console.log(`  Router:   ${beforeRouterTokens} → ${afterRouterTokens} токенов истории (−${beforeRouterTokens - afterRouterTokens}, ${pct(beforeRouterTokens, afterRouterTokens)})`);
  console.log(`  Planner:  ${beforePlannerTokens} → ${afterPlannerTokens} токенов истории (−${beforePlannerTokens - afterPlannerTokens}, ${pct(beforePlannerTokens, afterPlannerTokens)})`);
  console.log(
    `  Итого за одно TASK_REQUEST-задание (Router + Planner получают один и тот же срез дважды): ` +
      `${beforeRouterTokens + beforePlannerTokens} → ${afterRouterTokens + afterPlannerTokens} токенов ` +
      `(−${beforeRouterTokens + beforePlannerTokens - (afterRouterTokens + afterPlannerTokens)})`,
  );
  console.log();
}

function reportDedupSavings() {
  const steps = [
    {
      // Форма ответа get_crypto_current_price (core/src/tools/index.js).
      action: "текущая цена SOL",
      ok: true,
      value: { symbol: "SOLUSDT", price: 142.5, bid: 142.4, ask: 142.6, spreadPercent: 0.07, priceChangePercent24h: 3.2, high24h: 145.1, low24h: 137.9 },
    },
    {
      // Форма ответа get_crypto_24h_ticker_stats — те же 4 факта другими именами.
      action: "суточная статистика SOL",
      ok: true,
      value: { symbol: "SOLUSDT", lastPrice: 142.5, priceChangePercent: 3.2, weightedAvgPrice: 141.1, volume: 5_200_000, quoteVolume: 740_000_000, trades: 812_300, high: 145.1, low: 137.9 },
    },
  ];

  const before = steps
    .filter((s) => s.ok)
    .map((s) => `${s.action}:\n${JSON.stringify(s.value, null, 1)}`)
    .join("\n\n");
  const after = steps
    .filter((s) => s.ok)
    .map((s, i) => `${s.action}:\n${JSON.stringify(dedupeStepValues(steps)[i].value, null, 1)}`)
    .join("\n\n");

  const beforeTokens = estimateExchangeTokens(before);
  const afterTokens = estimateExchangeTokens(after);

  console.log("Оптимизация 2 — дедуп пересекающихся полей инструментов перед сведением отчёта");
  console.log("  фикстура: get_crypto_current_price + get_crypto_24h_ticker_stats по одному символу (SOLUSDT)");
  console.log(`  ${beforeTokens} → ${afterTokens} токенов данных шагов (−${beforeTokens - afterTokens}, ${pct(beforeTokens, afterTokens)})`);

  const brief = buildBrief({ question: "как дела у SOL?", taskSummary: "Проверка SOL", steps });
  console.log(`  buildBrief() целиком: ${estimateExchangeTokens(brief)} токенов`);
  console.log();
}

function pct(before, after) {
  if (before === 0) return "0%";
  return `${Math.round(((before - after) / before) * 100)}%`;
}

reportContextSavings();
reportDedupSavings();
