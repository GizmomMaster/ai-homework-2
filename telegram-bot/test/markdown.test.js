import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { markdownToTelegramHtml } from "../src/telegram/markdown.js";

const convert = markdownToTelegramHtml;

describe("markdownToTelegramHtml", () => {
  describe("базовое форматирование", () => {
    it("конвертирует жирный, курсив и зачёркнутый", () => {
      assert.equal(convert("**жирный**"), "<b>жирный</b>");
      assert.equal(convert("__жирный__"), "<b>жирный</b>");
      assert.equal(convert("*курсив*"), "<i>курсив</i>");
      assert.equal(convert("_курсив_"), "<i>курсив</i>");
      assert.equal(convert("~~зачёркнуто~~"), "<s>зачёркнуто</s>");
    });

    it("конвертирует заголовки любого уровня в жирную строку", () => {
      assert.equal(convert("# Заголовок"), "<b>Заголовок</b>");
      assert.equal(convert("###### Мелкий"), "<b>Мелкий</b>");
      assert.equal(convert("Текст\n## Второй\nЕщё"), "Текст\n<b>Второй</b>\nЕщё");
    });

    it("не трогает решётку без пробела (хештег)", () => {
      assert.equal(convert("#хештег"), "#хештег");
    });

    it("оставляет обычный текст без изменений", () => {
      assert.equal(convert("просто текст"), "просто текст");
    });
  });

  describe("код", () => {
    it("конвертирует инлайн-код", () => {
      assert.equal(convert("вот `код` тут"), "вот <code>код</code> тут");
    });

    it("конвертирует блок кода с указанием языка", () => {
      assert.equal(
        convert("```js\nconst x = 1;\n```"),
        '<pre><code class="language-js">const x = 1;</code></pre>',
      );
    });

    it("конвертирует блок кода без языка", () => {
      assert.equal(convert("```\nплан\n```"), "<pre><code>план</code></pre>");
    });

    it("не применяет разметку внутри кода", () => {
      assert.equal(
        convert("```py\nx = a_b_c ** 2 # *not italic*\n```"),
        '<pre><code class="language-py">x = a_b_c ** 2 # *not italic*</code></pre>',
      );
      assert.equal(convert("`**не жирный**`"), "<code>**не жирный**</code>");
    });

    it("экранирует HTML внутри кода", () => {
      assert.equal(
        convert("```\nif (a < b && c > d) {}\n```"),
        "<pre><code>if (a &lt; b &amp;&amp; c &gt; d) {}</code></pre>",
      );
    });
  });

  describe("ссылки", () => {
    it("конвертирует ссылку и экранирует амперсанд в URL", () => {
      assert.equal(
        convert("[тут](https://ex.com?a=1&b=2)"),
        '<a href="https://ex.com?a=1&amp;b=2">тут</a>',
      );
    });

    it("не ломает подчёркивания внутри URL", () => {
      assert.equal(
        convert("[док](https://ex.com/_start_/page)"),
        '<a href="https://ex.com/_start_/page">док</a>',
      );
    });

    it("применяет разметку внутри подписи ссылки", () => {
      assert.equal(
        convert("[**важное**](https://ex.com)"),
        '<a href="https://ex.com"><b>важное</b></a>',
      );
    });
  });

  describe("экранирование HTML", () => {
    it("экранирует спецсимволы в обычном тексте", () => {
      assert.equal(convert("a < b & c > d"), "a &lt; b &amp; c &gt; d");
    });

    it("экранирует HTML, присланный моделью как текст", () => {
      assert.equal(
        convert("<script>alert(1)</script>"),
        "&lt;script&gt;alert(1)&lt;/script&gt;",
      );
    });
  });

  describe("регрессии: ложное срабатывание разметки", () => {
    it("не превращает маркированный список на звёздочках в курсив", () => {
      assert.equal(convert("* первый\n* второй"), "* первый\n* второй");
    });

    it("не считает разметкой умножение", () => {
      assert.equal(convert("2 * 3 * 4 = 24"), "2 * 3 * 4 = 24");
      assert.equal(convert("2 ** 3 = 8"), "2 ** 3 = 8");
    });

    it("не курсивит подчёркивания внутри идентификатора", () => {
      assert.equal(convert("func_name и some_var_here"), "func_name и some_var_here");
    });

    it("оставляет незакрытую разметку как есть", () => {
      assert.equal(convert("начало **не закрыт"), "начало **не закрыт");
      assert.equal(convert("и *тут тоже"), "и *тут тоже");
    });

    it("не склеивает разные строки списка в одну разметку", () => {
      const input = "Итого:\n* **раз** и текст\n* два";
      assert.equal(convert(input), "Итого:\n* <b>раз</b> и текст\n* два");
    });
  });

  describe("комбинации", () => {
    it("обрабатывает смешанный ответ модели целиком", () => {
      const input = [
        "# Итог",
        "Используйте **fetch** и `JSON.parse`:",
        "```js",
        'const r = await fetch(url);',
        "```",
        "Подробнее — [в доках](https://developer.mozilla.org/docs).",
      ].join("\n");

      const expected = [
        "<b>Итог</b>",
        "Используйте <b>fetch</b> и <code>JSON.parse</code>:",
        '<pre><code class="language-js">const r = await fetch(url);</code></pre>',
        'Подробнее — <a href="https://developer.mozilla.org/docs">в доках</a>.',
      ].join("\n");

      assert.equal(convert(input), expected);
    });

    it("не оставляет служебных плейсхолдеров в результате", () => {
      const result = convert("`a` и ```\nb\n``` и [c](https://d.e)");
      assert.ok(!/[]/.test(result), `в результате остались плейсхолдеры: ${result}`);
    });

    it("не падает на пустой строке", () => {
      assert.equal(convert(""), "");
    });
  });
});
