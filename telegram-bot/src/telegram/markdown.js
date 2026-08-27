const PLACEHOLDER_OPEN = "";
const PLACEHOLDER_CLOSE = "";

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Конвертирует Markdown, который обычно отдают LLM (жирный, курсив,
 * зачёркнутый, инлайн-код, код-блоки, ссылки, заголовки), в HTML-подмножество,
 * которое понимает Telegram при `parse_mode=HTML` (только теги
 * b/i/s/code/pre/a — https://core.telegram.org/bots/api#html-style).
 *
 * Списки и цитаты отдельными тегами не оформляются (Telegram их не
 * поддерживает в HTML-режиме) — как обычный текст с `-`/`>` они и так
 * читаемы.
 *
 * @param {string} markdown
 * @returns {string}
 */
export function markdownToTelegramHtml(markdown) {
  const placeholders = [];
  function stash(html) {
    const token = `${PLACEHOLDER_OPEN}${placeholders.length}${PLACEHOLDER_CLOSE}`;
    placeholders.push(html);
    return token;
  }

  let text = markdown;

  // Код-блоки ```lang\n...\n``` — обрабатываем раньше всего остального,
  // чтобы форматирование внутри кода (**, _ и т.п.) не трогалось.
  text = text.replace(/```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g, (_match, lang, code) => {
    const escaped = escapeHtml(code.replace(/\n$/, ""));
    const openTag = lang ? `<pre><code class="language-${lang}">` : "<pre><code>";
    return stash(`${openTag}${escaped}</code></pre>`);
  });

  // Инлайн-код `...`
  text = text.replace(/`([^`\n]+)`/g, (_match, code) => stash(`<code>${escapeHtml(code)}</code>`));

  // Экранируем оставшийся текст под HTML — после этого шага в тексте нет
  // "живых" <, >, & (кроме тех, что мы сами добавим ниже как теги).
  text = escapeHtml(text);

  // Заголовки → просто жирная строка (Telegram не поддерживает <h1>-<h6>)
  text = text.replace(/^#{1,6} +(.+)$/gm, (_match, content) => `<b>${content}</b>`);

  // Жирный: **text** / __text__
  text = text.replace(/\*\*([\s\S]+?)\*\*/g, (_match, inner) => `<b>${inner}</b>`);
  text = text.replace(/__([\s\S]+?)__/g, (_match, inner) => `<b>${inner}</b>`);

  // Курсив: *text* / _text_ (одиночное подчёркивание — не внутри слова,
  // чтобы не портить snake_case из обычного текста вне код-блоков)
  text = text.replace(/\*([\s\S]+?)\*/g, (_match, inner) => `<i>${inner}</i>`);
  text = text.replace(
    /(?<![\p{L}\p{N}])_([\s\S]+?)_(?![\p{L}\p{N}])/gu,
    (_match, inner) => `<i>${inner}</i>`,
  );

  // Зачёркнутый: ~~text~~
  text = text.replace(/~~([\s\S]+?)~~/g, (_match, inner) => `<s>${inner}</s>`);

  // Ссылки: [текст](url)
  text = text.replace(
    /\[([^\]]+)\]\((\S+?)\)/g,
    (_match, label, url) => `<a href="${url.replace(/"/g, "&quot;")}">${label}</a>`,
  );

  // Возвращаем код-блоки/инлайн-код на место
  text = text.replace(
    new RegExp(`${PLACEHOLDER_OPEN}(\\d+)${PLACEHOLDER_CLOSE}`, "g"),
    (_match, index) => placeholders[Number(index)],
  );

  return text;
}
