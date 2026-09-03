import { currentJobId, markSeen, nextTurn } from "./context.js";
import { estimateExchangeTokens } from "../domain/estimateTokens.js";
import { estimateCostUsd } from "./pricing.js";

/**
 * Модуль-синглтон, как core/src/logger.js: до вызова initTelemetry() запись
 * молча не делает ничего. Это то, что позволяет 20+ существующим тестам и
 * скриптам замера (router-eval.mjs, task-eval.mjs) не знать о телеметрии
 * вовсе — они просто никогда не вызывают initTelemetry.
 */
let stmts = null;
let pricing = { inputPerMillion: 0, outputPerMillion: 0 };

/**
 * @param {import("better-sqlite3").Database} db
 * @param {{ pricing?: { inputPerMillion: number, outputPerMillion: number } }} [options]
 */
export function initTelemetry(db, { pricing: priceConfig } = {}) {
  if (priceConfig) pricing = priceConfig;
  stmts = {
    insertLlmCall: db.prepare(
      `INSERT INTO llm_calls (
         job_id, agent_id, stage, turn_number, provider, model,
         prompt_tokens, completion_tokens, reasoning_tokens,
         repeated_prompt_tokens_estimate, latency_ms, estimated_cost_usd,
         ok, error_code, created_at
       ) VALUES (
         @jobId, @agentId, @stage, @turnNumber, @provider, @model,
         @promptTokens, @completionTokens, @reasoningTokens,
         @repeatedPromptTokensEstimate, @latencyMs, @estimatedCostUsd,
         @ok, @errorCode, @now
       )`,
    ),
    insertToolCall: db.prepare(
      `INSERT INTO tool_calls (
         job_id, tool_name, turn_number, step_number, input_size, output_size,
         output_tokens_estimate, duration_ms, ok, error_code, created_at
       ) VALUES (
         @jobId, @toolName, @turnNumber, @stepNumber, @inputSize, @outputSize,
         @outputTokensEstimate, @durationMs, @ok, @errorCode, @now
       )`,
    ),
  };
}

/** Для скриптов, которым важно знать, пишет ли что-то recordLlmCall. */
export function isTelemetryEnabled() {
  return stmts !== null;
}

/**
 * Записывает один вызов LlmRunner.chat(). Помимо переданных счётчиков
 * считает, сколько из отправленных сообщений модель уже видела в этом же
 * задании (см. markSeen в context.js) — это и есть замена cached_tokens,
 * которого у Ollama/LM Studio нет.
 *
 * @param {{
 *   agentId: string, stage: string, provider: string, model: string,
 *   messages: Array<{ role: string, content: string }>,
 *   promptTokens: number, completionTokens: number, reasoningTokens?: number,
 *   latencyMs: number, ok: boolean, errorCode?: string,
 * }} input
 */
export function recordLlmCall({
  agentId,
  stage,
  provider,
  model,
  messages,
  promptTokens,
  completionTokens,
  reasoningTokens = 0,
  latencyMs,
  ok,
  errorCode,
}) {
  if (!stmts) return;

  const repeatedTexts = [];
  for (const message of messages) {
    if (markSeen(`${message.role}:${message.content}`)) repeatedTexts.push(message.content);
  }

  stmts.insertLlmCall.run({
    jobId: currentJobId() ?? null,
    agentId,
    stage,
    turnNumber: nextTurn(),
    provider,
    model,
    promptTokens,
    completionTokens,
    reasoningTokens,
    repeatedPromptTokensEstimate: estimateExchangeTokens(...repeatedTexts),
    latencyMs,
    estimatedCostUsd: estimateCostUsd({ promptTokens, completionTokens, pricing }),
    ok: ok ? 1 : 0,
    errorCode: errorCode ?? null,
    now: Date.now(),
  });
}

/**
 * Записывает один вызов инструмента (executeTool() внутри PlanExecutor).
 *
 * @param {{
 *   toolName: string, stepNumber?: number, inputSize: number, outputSize: number,
 *   outputTokensEstimate: number, durationMs: number, ok: boolean, errorCode?: string,
 * }} input
 */
export function recordToolCall({
  toolName,
  stepNumber,
  inputSize,
  outputSize,
  outputTokensEstimate,
  durationMs,
  ok,
  errorCode,
}) {
  if (!stmts) return;

  stmts.insertToolCall.run({
    jobId: currentJobId() ?? null,
    toolName,
    turnNumber: nextTurn(),
    stepNumber: stepNumber ?? null,
    inputSize,
    outputSize,
    outputTokensEstimate,
    durationMs,
    ok: ok ? 1 : 0,
    errorCode: errorCode ?? null,
    now: Date.now(),
  });
}
