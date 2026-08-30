#!/usr/bin/env node
/**
 * Заглушка Python-скрипта расчёта RSI для тестов инструмента.
 *
 * Node вместо Python специально: проверяем не расчёт (за него отвечает TA-Lib
 * и отдельный тест на настоящем скрипте), а обвязку — аргументы, stdin, коды
 * возврата, таймаут. Заглушка на Node позволяет прогонять эти проверки везде,
 * где есть Node, и через настоящий spawn, а не через подделку child_process.
 *
 * Договор со скриптом воспроизведён дословно: JSON в stdout, 0 — успех,
 * 1 — отказ с полем code. Режим задаётся аргументом --mode, который тест
 * дописывает к настоящим аргументам инструмента.
 */
const args = process.argv.slice(2);

// `node --test test/` считает тестовым файлом всё, что лежит под test/, и эту
// заглушку тоже запустит — без аргументов и без stdin. Выходим сразу, иначе
// она повиснет в ожидании данных и остановит весь прогон.
if (!args.includes("--symbol")) process.exit(0);

const value = (name) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};

const mode = value("mode") ?? "ok";

if (mode === "hang") {
  // Ничего не печатаем и не завершаемся: инструмент должен убить нас сам.
  setTimeout(() => {}, 60_000);
} else if (mode === "garbage") {
  process.stdout.write("Traceback (most recent call last): ImportError\n");
  process.exit(3);
} else if (mode === "refusal") {
  process.stdout.write(
    JSON.stringify({ ok: false, code: "unsupported_symbol", message: "Только BTC и ETH." }) + "\n",
  );
  process.exit(1);
} else if (mode === "broken") {
  process.stdout.write(JSON.stringify({ ok: false, code: "not_enough_data", message: "Мало свечей." }) + "\n");
  process.exit(1);
} else {
  let input = "";
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => {
    const closes = JSON.parse(input).closes;
    process.stdout.write(
      JSON.stringify({
        ok: true,
        symbol: value("symbol"),
        interval: value("interval"),
        length: Number(value("length")),
        rsi: 61.42,
        zone: "нейтральная",
        recent: [58.1, 59.3, 60.0, 60.8, 61.1],
        overbought: 70,
        oversold: 30,
        samples: closes.length,
        // Эхо для проверок обвязки: настоящий скрипт этого поля не отдаёт.
        echo: { noFetch: args.includes("--no-fetch"), lastClose: closes.at(-1) },
      }) + "\n",
    );
    process.exit(0);
  });
}
