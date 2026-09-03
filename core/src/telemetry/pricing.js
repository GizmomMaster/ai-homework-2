/**
 * Оценка стоимости вызова модели в долларах.
 *
 * Условна по существу, а не по недосмотру: модель локальная (LM Studio или
 * Ollama на собственной видеокарте) и в эксплуатации бесплатна — здесь не
 * счёт, а ориентир «во что вылилась бы такая нагрузка на сопоставимом
 * облачном API». Цены задаются конфигом (TELEMETRY_PRICE_INPUT_PER_1M /
 * TELEMETRY_PRICE_OUTPUT_PER_1M), а не зашиты здесь, — так дашборд и отчёт
 * остаются верны, даже если ориентир придётся поменять.
 *
 * @param {{
 *   promptTokens: number,
 *   completionTokens: number,
 *   pricing: { inputPerMillion: number, outputPerMillion: number },
 * }} input
 * @returns {number}
 */
export function estimateCostUsd({ promptTokens, completionTokens, pricing }) {
  const inputCost = (promptTokens / 1_000_000) * pricing.inputPerMillion;
  const outputCost = (completionTokens / 1_000_000) * pricing.outputPerMillion;
  return inputCost + outputCost;
}
