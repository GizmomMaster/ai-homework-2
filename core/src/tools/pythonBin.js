import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Поиск интерпретатора Python, которым считается RSI.
 *
 * Настройкой служит флаг `RSI_ENABLED`, а не путь к файлу: путь неудобно
 * писать, он разный на каждой машине и — что хуже — один и тот же `.env`
 * читают и хост, и контейнер (compose пробрасывает его через `env_file`),
 * так что путь с хоста внутри образа просто не существует. Флаг переносится
 * между ними без правок.
 *
 * Проверяем кандидатов **импортом библиотеки**, а не наличием файла:
 * `python3` в системе есть почти всегда, а TA-Lib в нём обычно нет, и
 * инструмент, отказывающий на каждом вызове, хуже отсутствующего —
 * планировщик всё равно потратит на него шаг. Проверка стоит один раз при
 * старте, а не на каждом вызове: за время работы сервиса ответ не изменится.
 */

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Чем проверяем: библиотека либо импортируется, либо нет. */
const PROBE_ARGS = ["-c", "import talib"];

/** Интерпретатор, зависший на импорте, не должен задержать старт сервиса. */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * Кандидаты в порядке предпочтения: сначала PATH (активированный venv
 * подменяет `python3` своим — явная активация должна побеждать), затем venv
 * рядом с сервисом и общий venv в домашнем каталоге.
 *
 * `RSI_PYTHON_BIN` — запасной выход для нестандартной установки (conda,
 * pyenv, интерпретатор в неожиданном месте). Если он задан, список из него и
 * состоит: подставить вместо опечатки другой интерпретатор — значит
 * посчитать не тем, чем просили.
 *
 * @param {{ env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform }} [options]
 * @returns {string[]}
 */
export function pythonCandidates({ env = process.env, platform = process.platform } = {}) {
  const override = env.RSI_PYTHON_BIN?.trim();
  if (override) return [override];

  const venvBin = platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"];
  const fromPath = platform === "win32" ? ["python"] : ["python3", "python"];

  return [
    ...fromPath,
    join(projectRoot, ".venv", ...venvBin),
    join(homedir(), ".venv", ...venvBin),
  ];
}

/**
 * Первый кандидат, у которого импортируется TA-Lib, или `undefined`, если
 * такого нет — тогда инструмент RSI просто не попадёт в реестр.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   platform?: NodeJS.Platform,
 *   spawnImpl?: typeof spawnSync,
 * }} [options]
 * @returns {string | undefined}
 */
export function findRsiPython({ env, platform, spawnImpl = spawnSync } = {}) {
  for (const bin of pythonCandidates({ env, platform })) {
    const probe = spawnImpl(bin, PROBE_ARGS, { stdio: "ignore", timeout: PROBE_TIMEOUT_MS });
    if (probe.status === 0) return bin;
  }
  return undefined;
}
