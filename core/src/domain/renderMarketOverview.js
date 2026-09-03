/**
 * Отрисовка сводки по рынку.
 *
 * Собирается кодом, а не языковой моделью, и это осознанный выбор: колонки
 * здесь держатся на подсчёте пробелов, а модель считать пробелы не умеет —
 * ошибка в один знак ломает выравнивание всей таблицы. Свести данные в текст
 * модель могла бы, но выровнять их — нет.
 *
 * Формат — markdown, как и у `renderReport`: Core остаётся независимым от
 * канала, а перевод в разметку конкретного мессенджера делает адаптер. Важная
 * деталь для Telegram: таблиц он не поддерживает **ни в markdown, ни в HTML**,
 * и markdown-таблица приедет к пользователю сырым текстом с палками, который
 * пропорциональным шрифтом не выровнен. Единственный способ получить колонки —
 * блок кода: адаптер превращает ```-блок в <pre><code>, а внутри него шрифт
 * моноширинный (см. telegram-bot/src/telegram/markdown.js).
 */

const MONTHS = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];

/**
 * @param {ReturnType<typeof import("../tools/marketOverview.js").buildMarketOverview> extends Promise<infer T> ? T : never} overview
 * @param {{ commentary?: string }} [options]
 *   `commentary` — пара фраз о том, что происходило на рынке; их пишет
 *   `MarketOverviewAgent`. Единственное место, где модель участвует в сводке:
 *   всё остальное здесь механическое, а вот увидеть в цифрах картину шаблон
 *   не умеет. Без комментария сводка остаётся полной — просто без вывода.
 * @returns {string} markdown
 */
export function renderMarketOverview(overview, { commentary } = {}) {
  const { coins, excluded, dayStartMs } = overview;

  const blocks = [`**Крипторынок за ${formatDate(dayStartMs)}**`];

  if (commentary) blocks.push("", commentary);

  blocks.push(
    "",
    "Топ монет по рыночной капитализации, итоги суток (UTC):",
    "",
    codeBlock(yesterdayTable(coins)),
    "",
    "**Сейчас**",
    "",
    codeBlock(currentTable(coins)),
  );

  const notes = footnotes(coins, excluded);
  if (notes.length > 0) blocks.push("", notes.join("\n"));

  blocks.push("", "**Что можно спросить**", "", examples(coins).join("\n"));

  return blocks.join("\n");
}

/** Итоги вчерашних суток: цена на открытии и закрытии, изменение, объём. */
function yesterdayTable(coins) {
  return table(
    ["МОНЕТА", "ОТКР", "ЗАКР", "Δ%", "ОБЪЁМ"],
    ["left", "right", "right", "right", "right"],
    coins.map((coin) => [
      coin.symbol,
      price(coin.open),
      price(coin.close),
      percent(coin.changePercent),
      money(coin.dayVolume),
    ]),
  );
}

/** Текущее состояние: цена, скользящие сутки, объём, капитализация. */
function currentTable(coins) {
  return table(
    ["МОНЕТА", "ЦЕНА", "Δ24Ч", "ОБЪЁМ", "КАПИТАЛ."],
    ["left", "right", "right", "right", "right"],
    coins.map((coin) => [
      coin.symbol,
      price(coin.price),
      percent(coin.priceChangePercent24h),
      money(coin.volume24h),
      money(coin.marketCap),
    ]),
  );
}

/**
 * Сноски: что отфильтровано и откуда взяты цифры. Подменять состав десятки
 * молча нельзя — пользователь должен понимать, почему в списке нет USDT.
 */
function footnotes(coins, excluded) {
  const notes = [];

  if (excluded.stablecoins.length > 0) {
    notes.push(`_Стейблкоины исключены: ${tickers(excluded.stablecoins)}._`);
  }
  if (excluded.wrapped.length > 0) {
    notes.push(`_Обёртки и стейкинг-деривативы исключены: ${tickers(excluded.wrapped)}._`);
  }

  // Две колонки процентов считаются по разным окнам, и расхождение между ними
  // выглядит как ошибка, пока не сказано, что это не она.
  notes.push("_Δ% — за календарные сутки UTC, Δ24ч — за скользящие сутки от текущего момента._");

  // Две причины отката на CoinGecko, и путать их нельзя: «пары нет в
  // листинге» — свойство монеты, которое не изменится к следующему запросу,
  // а «биржа не ответила» — сегодняшняя заминка. Пока сноска была одна, она
  // приписывала монете отсутствие пары каждый раз, когда до Binance просто не
  // достучались.
  const notListed = symbolsWhere(coins, "coingecko", "not_listed");
  if (notListed.length > 0) {
    notes.push(
      `_Нет пары к USDT на Binance, сутки посчитаны по данным CoinGecko: ${tickers(notListed)}._`,
    );
  }

  const binanceFailed = symbolsWhere(coins, "coingecko", "unavailable");
  if (binanceFailed.length > 0) {
    notes.push(
      `_Binance не ответила, сутки посчитаны по данным CoinGecko: ${tickers(binanceFailed)}._`,
    );
  }

  const missing = coins.filter((coin) => coin.source === null).map((coin) => coin.symbol);
  if (missing.length > 0) {
    notes.push(`_Итоги суток собрать не удалось: ${tickers(missing)}._`);
  }

  return notes;
}

/** Тикеры монет, у которых совпали источник итогов суток и причина отката. */
function symbolsWhere(coins, source, binanceMiss) {
  return coins
    .filter((coin) => coin.source === source && coin.binanceMiss === binanceMiss)
    .map((coin) => coin.symbol);
}

/**
 * Тикеры в сноске — инлайн-кодом, и не ради красоты. В тикере может быть
 * подчёркивание (`FIGR_HELOC`), а подчёркивание — это маркер курсива: попав в
 * текст как есть, оно рвёт разметку строки, и пользователь видит сырые `_` по
 * краям вместо наклонного шрифта. Инлайн-код адаптер вынимает из текста до
 * разбора остальной разметки, поэтому содержимое тикера её уже не задевает.
 */
function tickers(symbols) {
  return symbols.map((symbol) => `\`${symbol}\``).join(", ");
}

/**
 * Примеры запросов. Половина привязана к тому, что реально в таблице: общие
 * формулировки читаются как заглушка, а «почему ZEC вырос на 6%» — как
 * продолжение разговора.
 */
function examples(coins) {
  const measured = coins.filter((coin) => coin.changePercent !== null);
  const sorted = [...measured].sort((a, b) => b.changePercent - a.changePercent);
  const top = sorted[0];
  const bottom = sorted[sorted.length - 1];
  const first = coins[0]?.symbol ?? "BTC";

  const lines = [];
  if (top && top !== bottom) {
    lines.push(`• Почему \`${top.symbol}\` вырос за сутки — покажи свечи по часу`);
    lines.push(`• Сравни объёмы \`${top.symbol}\` и \`${bottom.symbol}\` за неделю`);
  }
  lines.push(
    `• Покажи стакан по \`${first}USDT\` — есть ли крупные стенки`,
    "• Найди топ-10 пар по суточному объёму торгов",
    "• Что такое funding rate?",
    "• В чём разница между спотом и фьючерсом?",
  );
  return lines;
}

/** Обрамляет готовые строки блоком кода — в Telegram это моноширинный <pre>. */
function codeBlock(text) {
  return ["```", text, "```"].join("\n");
}

/**
 * Таблица фиксированной ширины. Ширина колонки — по самому длинному значению
 * в ней, включая заголовок; лишние пробелы справа срезаются, чтобы строка не
 * тянулась дальше нужного.
 *
 * @param {string[]} headers
 * @param {Array<"left"|"right">} align
 * @param {string[][]} rows
 */
function table(headers, align, rows) {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => row[column].length)),
  );

  const line = (cells) =>
    cells
      .map((cell, column) =>
        align[column] === "right"
          ? cell.padStart(widths[column])
          : cell.padEnd(widths[column]),
      )
      .join("  ")
      .trimEnd();

  return [line(headers), ...rows.map(line)].join("\n");
}

/**
 * Цена. Дробная часть зависит от масштаба: округлить DOGE до «0.09» значит
 * потерять всё содержание строки, а показывать биткоин с шестью знаками —
 * занять полколонки нулями.
 */
function price(value) {
  if (value === null || value === undefined) return "н/д";
  if (value >= 1) return value.toFixed(2);
  if (value >= 0.01) return value.toFixed(4);
  return value.toPrecision(4);
}

/** Знак обязателен: без него рост и падение в таблице неразличимы. */
function percent(value) {
  if (value === null || value === undefined) return "н/д";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}

/** Объёмы и капитализации — сокращённо, иначе колонка не помещается в экран. */
function money(value) {
  if (value === null || value === undefined) return "н/д";
  const units = [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [scale, suffix] of units) {
    if (value >= scale) {
      const scaled = value / scale;
      return `$${scaled >= 100 ? scaled.toFixed(0) : scaled.toFixed(scaled >= 10 ? 1 : 2)}${suffix}`;
    }
  }
  return `$${value.toFixed(0)}`;
}

function formatDate(ms) {
  const date = new Date(ms);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}
