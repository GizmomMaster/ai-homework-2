import { estimateExchangeTokens } from "../domain/estimateTokens.js";

/**
 * Блок размышлений гибридных reasoning-моделей (Qwen3, DeepSeek-R1 и
 * подобных). Раннеры локальных LLM (Ollama, LM Studio) не гарантируют, что
 * размышление придёт отдельным полем ответа, а не прямо в тексте — старая
 * версия сервера, отключение через шаблон чата, усечённая генерация.
 * Вырезаем сами, чтобы размышления не ушли пользователю и не попали в
 * историю диалога, независимо от раннера и от того, включено ли оно вообще
 * у конкретной модели.
 */
const THINK_BLOCK = /<think>[\s\S]*?<\/think>/gi;
/** Незакрытый блок: генерация оборвалась на середине размышления. */
const UNCLOSED_THINK = /<think>[\s\S]*$/i;

/**
 * Убирает блоки размышления из текста ответа модели и заодно оценивает их
 * длину в токенах: ни Ollama, ни LM Studio не отдают reasoning_tokens
 * отдельным полем usage, а вырезанный здесь текст — единственное, что от
 * размышления вообще остаётся к моменту, когда раннер строит ChatResult.
 *
 * @param {string} content
 * @returns {{ content: string, reasoningTokens: number }}
 */
export function stripThinking(content) {
  // Оба регэкспа матчатся независимо друг от друга: закрытый блок начинается
  // тем же "<think>", что ищет и UNCLOSED_THINK, — если считать их совпадения
  // порознь, закрытый блок посчитается дважды, а второй матч ещё и заберёт
  // весь текст после него. Поэтому длина размышления — это разница длин до и
  // после обеих замен, а не сумма отдельных совпадений.
  const withoutThinking = content.replace(THINK_BLOCK, "").replace(UNCLOSED_THINK, "");
  const removedChars = content.length - withoutThinking.length;

  return {
    content: withoutThinking.trim(),
    // estimateExchangeTokens считает по длине текста, а не по содержимому,
    // поэтому вырезанный текст незачем хранить отдельно — хватает его длины.
    reasoningTokens: removedChars > 0 ? estimateExchangeTokens("x".repeat(removedChars)) : 0,
  };
}
