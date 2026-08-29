import { MARKET_OVERVIEW_TOOL, executeTool } from "../tools/index.js";
import { renderMarketOverview } from "./renderMarketOverview.js";
import { logError, log } from "../logger.js";

/**
 * Сводка по рынку для приветственного экрана адаптера.
 *
 * Собирает её модель — она видит цифры целиком и может сказать про них
 * что-то осмысленное, чего шаблон не скажет никогда. Но отрисовка кодом
 * никуда не делась: она осталась **откатом**, как `renderReport` при
 * `SummaryAgent`. Причина та же, что и в конвейере задач: данные к этому
 * моменту уже получены и оплачены запросами к двум внешним API, и потерять
 * их из-за сбоя на последнем шаге — худший из возможных исходов.
 *
 * Отличие от `SummaryAgent` одно, и оно про формат. Отчёт по задаче — проза,
 * и испортить её модель может только по смыслу. Сводка — таблица, и у неё
 * есть способ сломаться молча: markdown-таблица вместо блока кода выглядит
 * в ответе модели совершенно нормально, а до пользователя доезжает месивом
 * из палок. Поэтому ответ модели здесь ещё и проверяется — см. {@link
 * looksUnusable}.
 */
export class MarketOverviewService {
  /**
   * @param {{
   *   tools: ReturnType<typeof import("../tools/index.js").createTools>,
   *   overviewAgent?: import("../agents/MarketOverviewAgent.js").MarketOverviewAgent,
   * }} deps
   *   Без `overviewAgent` сводка собирается откатом — так поднимаются тесты,
   *   которым модель не нужна.
   */
  constructor({ tools, overviewAgent }) {
    this.tools = tools;
    this.overviewAgent = overviewAgent;
  }

  /**
   * @param {{ limit?: number }} [input]
   * @returns {Promise<{ ok: true, text: string, composedBy: "model"|"fallback", usage: object }
   *          | { ok: false, error: { code: string } }>}
   */
  async compose({ limit } = {}) {
    const startedAt = Date.now();
    const collected = await executeTool(this.tools, MARKET_OVERVIEW_TOOL, { limit });

    if (!collected.ok) {
      logError(
        `Не удалось собрать данные для обзора рынка: ${collected.error.code} — ${collected.error.message}`,
      );
      return { ok: false, error: { code: collected.error.code } };
    }

    const written = await this.#write(collected.value);

    return {
      ok: true,
      text: written.text,
      composedBy: written.composedBy,
      // Меряем всю сборку, а не один вызов модели: пользователь ждал и
      // походов на биржу тоже. Контекстного окна у сводки нет — она не часть
      // диалога, — поэтому в usage только стоимость и время.
      usage: {
        promptTokens: written.promptTokens ?? 0,
        completionTokens: written.completionTokens ?? 0,
        durationMs: Date.now() - startedAt,
      },
    };
  }

  async #write(overview) {
    const fallback = () => ({ text: renderMarketOverview(overview), composedBy: "fallback" });

    if (!this.overviewAgent) return fallback();

    try {
      const result = await this.overviewAgent.compose(overview);
      const text = result.content.trim();

      const complaint = looksUnusable(text);
      if (complaint) {
        // Не ошибка модели в привычном смысле: ответ есть, он связный, но в
        // мессенджере развалится. Показать вместо него ровную таблицу честнее,
        // чем отправить пользователю то, что он не сможет прочесть.
        logError(`Сводка от модели непригодна (${complaint}), показываем таблицу как есть.`);
        return fallback();
      }

      log(
        `Сводка по рынку собрана моделью (${result.promptTokens ?? 0}+${result.completionTokens ?? 0} токенов).`,
      );
      return {
        text,
        composedBy: "model",
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
      };
    } catch (error) {
      logError("Модель не собрала сводку по рынку, показываем таблицу как есть:", error);
      return fallback();
    }
  }
}

/**
 * Проверка ответа модели на пригодность к отправке.
 *
 * Не оценивает содержание — только то, переживёт ли ответ дорогу до экрана.
 * Возвращает причину непригодности или `undefined`, если всё в порядке.
 *
 * @param {string} text
 */
export function looksUnusable(text) {
  if (!text) return "пустой ответ";

  const fences = (text.match(/```/g) ?? []).length;
  if (fences < 2) return "нет блока кода с таблицей";
  // Нечётное число ограничителей означает незакрытый блок: всё, что после
  // него, слипнется в один моноширинный кусок.
  if (fences % 2 !== 0) return "незакрытый блок кода";

  // Палки за пределами блоков кода — это markdown-таблица, которую Telegram
  // не нарисует. Внутри блока они допустимы: там это просто символы.
  const outside = text.replace(/```[\s\S]*?```/g, "");
  if (/^.*\|.*\|.*$/m.test(outside)) return "markdown-таблица вне блока кода";

  // Блок кода нужен ровно ради моноширинного шрифта под колонки. Если модель
  // положила туда заголовок и пару фраз — а это её любимая ошибка, — читателю
  // достанется проза, набранная как код, и ни одной таблицы.
  for (const block of text.match(/```[\s\S]*?```/g) ?? []) {
    if (!looksLikeTable(block.replace(/```/g, ""))) return "в блоке кода не таблица, а текст";
  }

  return undefined;
}

/**
 * Похоже ли содержимое блока на таблицу.
 *
 * Опора — не числа и не ключевые слова, а форма: у таблицы несколько строк с
 * одинаковым числом колонок. Проза этого не даёт, сколько бы процентов в ней
 * ни стояло, а таблица даёт по построению — и та, что рисует откат, и любая,
 * которую модель выровняет сама.
 *
 * @param {string} block
 */
function looksLikeTable(block) {
  const lines = block.split("\n").filter((line) => line.trim() !== "");
  // Заголовок и хотя бы две монеты: на меньшем колонок не разглядеть.
  if (lines.length < 3) return false;

  const counts = lines.map((line) => line.trim().split(/\s+/).length);
  const modal = counts
    .slice()
    .sort((a, b) => counts.filter((c) => c === b).length - counts.filter((c) => c === a).length)[0];

  if (modal < 2) return false;

  // Одну выбивающуюся строку прощаем: модель могла подписать колонку иначе.
  const aligned = counts.filter((count) => count === modal).length;
  return aligned / counts.length >= 0.8;
}
