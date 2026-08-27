// Символы из Private Use Area — практически не встречаются в реальном тексте,
// поэтому безопасны как маркеры для временного "изъятия" фрагментов (код,
// ссылки) из текста на время применения остальных regex-преобразований.
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
 * поддерживает в HTML-режиме) — как обычный текст с `-`/`*`/`>` они и так
 * читаемы.
 *
 * @param {string} markdown
 * @returns {string}
 */
export function markdownToTelegramHtml(markdown) {
  const placeholders = [];
  /** Прячет готовый HTML за плейсхолдер, чтобы его не задели другие regex. */
  function stash(html) {
    const token = `${PLACEHOLDER_OPEN}${placeholders.length}${PLACEHOLDER_CLOSE}`;
    placeholders.push(html);
    return token;
  }

  let text = markdown;

  // Код-блоки ```lang\n...\n``` — раньше всего остального, чтобы разметка
  // внутри кода (**, _ и т.п.) осталась нетронутой.
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

  // Ссылки [текст](url). Прячем только сами теги <a ...> и </a>, оставляя
  // текст ссылки в потоке — так URL защищён от последующих замен (например,
  // подчёркиваний в адресе), а подпись всё ещё может содержать **жирный**.
  text = text.replace(
    /\[([^\]]+)\]\((\S+?)\)/g,
    (_match, label, url) =>
      `${stash(`<a href="${url.replace(/"/g, "&quot;")}">`)}${label}${stash("</a>")}`,
  );

  // Заголовки → жирная строка (Telegram не поддерживает <h1>-<h6>)
  text = text.replace(/^#{1,6} +(.+)$/gm, (_match, content) => `<b>${content}</b>`);

  // Жирный: **text** / __text__.
  // (?!\s) и (?<!\s) — маркер должен вплотную прилегать к тексту: это
  // отсекает случаи вроде "2 ** 3" и рваную разметку.
  text = text.replace(/\*\*(?!\s)([\s\S]+?)(?<!\s)\*\*/g, (_match, inner) => `<b>${inner}</b>`);
  text = text.replace(
    /(?<![\p{L}\p{N}_])__(?!\s)([\s\S]+?)(?<!\s)__(?![\p{L}\p{N}_])/gu,
    (_match, inner) => `<b>${inner}</b>`,
  );

  // Курсив: *text* / _text_.
  // Кроме прилегания маркера запрещаем перенос строки внутри — иначе
  // маркированный список ("* пункт\n* пункт") склеивается в один курсив,
  // а "2 * 3 * 4" превращается в разметку.
  text = text.replace(/\*(?!\s)([^*\n]+?)(?<!\s)\*/g, (_match, inner) => `<i>${inner}</i>`);
  text = text.replace(
    /(?<![\p{L}\p{N}_])_(?!\s)([^_\n]+?)(?<!\s)_(?![\p{L}\p{N}_])/gu,
    (_match, inner) => `<i>${inner}</i>`,
  );

  // Зачёркнутый: ~~text~~
  text = text.replace(/~~(?!\s)([\s\S]+?)(?<!\s)~~/g, (_match, inner) => `<s>${inner}</s>`);

  // Возвращаем спрятанные фрагменты на место
  text = text.replace(
    new RegExp(`${PLACEHOLDER_OPEN}(\\d+)${PLACEHOLDER_CLOSE}`, "g"),
    (_match, index) => placeholders[Number(index)],
  );

  return text;
}
