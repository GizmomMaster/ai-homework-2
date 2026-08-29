import { MARKET_OVERVIEW_TOOL, executeTool } from "../tools/index.js";
import { renderMarketOverview } from "./renderMarketOverview.js";
import { logError, log } from "../logger.js";

/**
 * Сводка по рынку для приветственного экрана адаптера.
 *
 * Работа поделена по способностям: **таблицы собирает код, текст пишет
 * модель**. Деление далось опытом, а не вкусом. Сначала всю сводку писала
 * модель — и раз за разом промахивалась мимо формата: то ставила
 * markdown-таблицу, которую Telegram не рисует вовсе, то клала в блок кода
 * заголовок и фразу вместо таблицы. Каждый промах стоил всей сводки: показать
 * пользователю поехавшие колонки нельзя, и в ход шёл шаблон целиком — вместе
 * с тем выводом о рынке, который модель сделала правильно.
 *
 * Теперь ломаться нечему. Выравнивание держится на подсчёте пробелов, а это
 * работа для кода; увидеть в цифрах картину и сказать о ней словами — работа
 * для модели. Отказ модели больше не отменяет сводку: пропадает один абзац,
 * а таблицы, за которые уже заплачено запросами к двум внешним API,
 * доезжают до пользователя в любом случае.
 */
export class MarketOverviewService {
  /**
   * @param {{
   *   tools: ReturnType<typeof import("../tools/index.js").createTools>,
   *   overviewAgent?: import("../agents/MarketOverviewAgent.js").MarketOverviewAgent,
   * }} deps
   *   Без `overviewAgent` сводка выходит без комментария — так поднимаются
   *   тесты, которым модель не нужна.
   */
  constructor({ tools, overviewAgent }) {
    this.tools = tools;
    this.overviewAgent = overviewAgent;
  }

  /**
   * @param {{ limit?: number }} [input]
   * @returns {Promise<{ ok: true, text: string, commentary: "model"|"none", usage: object }
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

    const written = await this.#comment(collected.value);

    return {
      ok: true,
      text: renderMarketOverview(collected.value, { commentary: written.text }),
      commentary: written.text ? "model" : "none",
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

  /** @returns {Promise<{ text?: string, promptTokens?: number, completionTokens?: number }>} */
  async #comment(overview) {
    if (!this.overviewAgent) return {};

    try {
      const result = await this.overviewAgent.comment(overview);
      const text = result.content.trim();

      const complaint = unusableCommentary(text);
      if (complaint) {
        logError(`Комментарий модели непригоден (${complaint}), показываем сводку без него.`);
        return {};
      }

      log(
        `Комментарий к сводке написан моделью (${result.promptTokens ?? 0}+${result.completionTokens ?? 0} токенов).`,
      );
      return { text, promptTokens: result.promptTokens, completionTokens: result.completionTokens };
    } catch (error) {
      logError("Модель не написала комментарий к сводке, показываем её без него:", error);
      return {};
    }
  }
}

/** Дальше этого комментарий перестаёт быть комментарием и лезет на таблицу. */
const MAX_COMMENTARY_LENGTH = 700;

/**
 * Проверка комментария на пригодность.
 *
 * Требований мало, и это следствие деления работы: испортить абзац текста
 * можно только одним способом — перестать быть абзацем текста. Разметка,
 * которая раньше ломала всю сводку, теперь просто не должна сюда попадать.
 *
 * @param {string} text
 * @returns {string|undefined} причина непригодности или `undefined`
 */
export function unusableCommentary(text) {
  if (!text) return "пустой ответ";
  if (text.length > MAX_COMMENTARY_LENGTH) return `${text.length} знаков вместо пары фраз`;
  if (text.includes("```")) return "блок кода вместо текста";
  // Палки в двух и более местах строки — попытка нарисовать таблицу, хотя её
  // рисуют без модели. Одиночная палка в тексте безобидна.
  if (/^.*\|.*\|.*$/m.test(text)) return "таблица вместо текста";
  return undefined;
}
