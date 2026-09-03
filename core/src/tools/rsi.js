import { spawn } from "node:child_process";
import { TOOL_ERROR, ToolError } from "./errors.js";
import { optionalCount, requireInterval, requireSymbol } from "./params.js";

/**
 * Инструмент расчёта RSI поверх Python-скрипта `scripts/rsi/rsi.py`.
 *
 * Почему расчёт вынесен в подпроцесс, а не написан на Node: RSI Уайлдера
 * рекурсивен, и совпадение с биржевыми терминалами держится на мелочах —
 * затравке первого среднего, порядке сглаживания. Готовая TA-Lib эти мелочи
 * уже знает, а своя реализация была бы третьей версией правды рядом с
 * терминалом пользователя и графиком биржи.
 *
 * **Свечи скрипту передаём через stdin, а ходить в сеть запрещаем флагом
 * `--no-fetch`.** У Core уже есть клиент биржи с кешем, таймаутами и разбором
 * её кодов ошибок; второй такой же внутри подпроцесса означал бы вторую
 * политику ретраев, второй счётчик лимитов и исходящее соединение из
 * контейнера мимо всего, что мы про эти соединения знаем. Сам скрипт умеет
 * сходить на биржу — но только когда его запускают руками.
 *
 * Поддерживаются **только BTC и ETH** (требование задания). Проверка стоит
 * здесь, до запуска подпроцесса: отказ не должен стоить ни свечей, ни
 * интерпретатора. Тот же список продублирован в самом скрипте — он
 * самостоятельная утилита, и запуск руками не должен обходить правило.
 */

/** Что может написать пользователь или модель → символ Binance. */
export const RSI_SYMBOLS = {
  BTC: "BTCUSDT",
  BTCUSDT: "BTCUSDT",
  ETH: "ETHUSDT",
  ETHUSDT: "ETHUSDT",
};

/**
 * Формулировка отказа. Уходит модели вместе с неудавшимся шагом и попадает
 * в отчёт почти дословно, поэтому написана для пользователя, а не для лога.
 * Тот же текст живёт в `scripts/rsi/rsi.py`.
 */
export const RSI_ONLY_BTC_ETH =
  "Пока показатель RSI считается только для BTC и ETH. " +
  "Для остальных монет доступны цена, объёмы, свечи и стакан.";

const DEFAULT_INTERVAL = "1h";
const DEFAULT_LENGTH = 14;

/**
 * Сколько свечей брать. RSI зависит от всей предыдущей истории, и посчитанный
 * по сотне баров он не сойдётся с тем, что показывает терминал по тысяче.
 * Расхождение затухает примерно за 250 баров — берём предел Binance на запрос.
 */
const CANDLES = 500;

/** Время жизни результата: как у прочих котировок, минута. */
const TTL_MS = 60_000;

/**
 * Ответ скрипта заведомо короткий; предел — на случай, если что-то пошло не
 * так. Знаки, а не байты: потоки читаются с заданной кодировкой (см.
 * `execute`), и на входе у накопителя строка.
 */
const MAX_OUTPUT_CHARS = 64 * 1024;

/**
 * @param {{
 *   binance: import("./BinanceClient.js").BinanceClient,
 *   cache: import("./cache.js").TtlCache,
 *   pythonBin: string,
 *   scriptPath: string,
 *   timeoutMs?: number,
 *   spawnImpl?: typeof spawn,
 * }} deps
 */
export function createRsiTool({ binance, cache, pythonBin, scriptPath, timeoutMs = 30_000, spawnImpl = spawn }) {
  return {
    description:
      "Индекс относительной силы (RSI) по свечам Binance: текущее значение, " +
      "несколько предыдущих и зона (перекупленность выше 70, перепроданность ниже 30). " +
      "Считается ТОЛЬКО для BTC и ETH; для других монет инструмент откажет.",
    parameters: {
      symbol: { type: "string", description: "Только BTCUSDT или ETHUSDT" },
      interval: { type: "string", description: `Размер свечи, например 1h или 1d (по умолчанию ${DEFAULT_INTERVAL})` },
      length: { type: "integer", description: `Период RSI в свечах (по умолчанию ${DEFAULT_LENGTH})` },
    },
    required: ["symbol"],
    async run(params) {
      const symbol = requireRsiSymbol(params.symbol);
      const interval = params.interval === undefined ? DEFAULT_INTERVAL : requireInterval(params.interval);
      const length = optionalCount(params.length, {
        min: 2,
        max: 100,
        fallback: DEFAULT_LENGTH,
        name: "length",
      });

      return cache.through(`rsi:${symbol}:${interval}:${length}`, TTL_MS, async () => {
        const closes = await fetchCloses({ binance, cache, symbol, interval });
        const computed = await runScript({
          spawnImpl,
          pythonBin,
          scriptPath,
          timeoutMs,
          symbol,
          interval,
          length,
          closes,
        });

        // Момент расчёта дописываем здесь: у скрипта на входе одни цены, а в
        // отчёте «RSI 63» без времени — число без опоры.
        return { ...computed, asOf: new Date().toISOString() };
      });
    },
  };
}

/**
 * Символ с проверкой по списку поддерживаемых. Общая проверка идёт первой:
 * до сравнения со списком значение должно быть похоже на символ, а не на
 * произвольную строку из вывода модели.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function requireRsiSymbol(value) {
  const symbol = requireSymbol(value);
  const supported = RSI_SYMBOLS[symbol];
  if (!supported) throw new ToolError(TOOL_ERROR.unsupportedAsset, RSI_ONLY_BTC_ETH);
  return supported;
}

/** Цены закрытия. Кеш общий с прочими запросами свечей — ключ тот же по смыслу. */
async function fetchCloses({ binance, cache, symbol, interval }) {
  const rows = await cache.through(`rsi-kl:${symbol}:${interval}`, TTL_MS, () =>
    binance.get("/api/v3/klines", { symbol, interval, limit: CANDLES }),
  );

  if (!Array.isArray(rows) || rows.length === 0) {
    throw new ToolError(TOOL_ERROR.upstreamError, "Binance вернула пустой список свечей.");
  }

  // Свеча Binance — массив; цена закрытия четвёртая по счёту.
  return rows.map((row) => Number(row[4]));
}

/**
 * Запуск скрипта и разбор его ответа.
 *
 * Договор со скриптом: в stdout всегда JSON, код возврата 0 — успех, 1 —
 * отказ с полем `code`, всё прочее — непредвиденный сбой. Разделение нужно,
 * чтобы «RSI не считается для этой монеты» не выглядело в отчёте так же,
 * как «интерпретатор упал».
 */
async function runScript({ spawnImpl, pythonBin, scriptPath, timeoutMs, symbol, interval, length, closes }) {
  const args = [
    scriptPath,
    "--symbol", symbol,
    "--interval", interval,
    "--length", String(length),
    // Сеть подпроцессу не нужна: свечи он получает на stdin.
    "--no-fetch",
  ];

  const { code, stdout, stderr } = await execute({
    spawnImpl,
    pythonBin,
    args,
    input: JSON.stringify({ closes }),
    timeoutMs,
  });

  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new ToolError(
      TOOL_ERROR.computationFailed,
      `Скрипт расчёта вернул не JSON (код ${code}): ${tail(stderr || stdout)}`,
    );
  }

  if (code === 0 && payload.ok) {
    const { ok, ...result } = payload;
    return result;
  }

  // Отказ, который скрипт объяснил сам. Единственный, который может дойти
  // сюда штатно, — несовпадение версий списка монет здесь и в скрипте;
  // остальные (нет библиотеки, короткий ряд) значат неверную сборку.
  const message = payload.message ?? `Скрипт расчёта завершился с кодом ${code}.`;
  throw new ToolError(
    payload.code === "unsupported_symbol" ? TOOL_ERROR.unsupportedAsset : TOOL_ERROR.computationFailed,
    message,
  );
}

/**
 * Подпроцесс с таймаутом. Отдаёт код возврата и потоки, ошибками считает
 * только то, из-за чего результата не будет вовсе: не нашли интерпретатор,
 * не дождались ответа.
 */
function execute({ spawnImpl, pythonBin, args, input, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(pythonBin, args, { stdio: ["pipe", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // SIGKILL, а не SIGTERM: висящий расчёт не станет прибираться за собой,
      // а ждать его второй раз нам уже нечем.
      child.kill("SIGKILL");
      reject(
        new ToolError(
          TOOL_ERROR.computationFailed,
          `Скрипт расчёта не ответил за ${timeoutMs} мс.`,
        ),
      );
    }, timeoutMs);

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    child.on("error", (error) => {
      finish(
        reject,
        new ToolError(
          TOOL_ERROR.computationFailed,
          error.code === "ENOENT"
            ? `Не найден интерпретатор Python по пути "${pythonBin}".`
            : `Не удалось запустить скрипт расчёта: ${error.message}`,
        ),
      );
    });

    // Кодировка задаётся потоку, а не выводится при склейке: без неё каждый
    // кусок превращался в строку сам по себе, и многобайтный символ,
    // разрезанный границей куска, приезжал битым. Сообщения об отказе у
    // скрипта русские — портились именно они.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk;
    });

    // Скрипт вправе отказаться до того, как дочитает stdin (например, увидев
    // неподдерживаемую монету). Тогда запись в закрытый поток даёт EPIPE —
    // это не ошибка расчёта, ответ придёт кодом возврата.
    child.stdin.on("error", () => {});
    child.stdin.end(input);

    child.on("close", (code) => finish(resolve, { code, stdout, stderr }));
  });
}

/** Хвост вывода для сообщения об ошибке: целиком он в лог не нужен. */
function tail(text, limit = 300) {
  const trimmed = String(text).trim();
  return trimmed.length > limit ? `…${trimmed.slice(-limit)}` : trimmed || "пустой вывод";
}
