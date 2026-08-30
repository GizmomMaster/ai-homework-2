import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { loadEnvFile } from "./env.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
loadEnvFile(join(projectRoot, ".env"));

function positiveInt(name, defaultValue) {
  const raw = process.env[name];
  if (!raw) return defaultValue;

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `Переменная окружения ${name} должна быть положительным целым числом, получено: "${raw}".`,
    );
  }
  return value;
}

/**
 * Режим «размышления» гибридных reasoning-моделей (Qwen3 и подобных).
 * Значение "omit" убирает поле из запроса: модели без поддержки размышления
 * отвергают запрос, в котором оно есть.
 */
function thinkMode(name, defaultValue) {
  const raw = process.env[name];
  if (!raw) return defaultValue;

  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "omit") return "omit";
  throw new Error(
    `Переменная окружения ${name} должна быть "true", "false" или "omit", получено: "${raw}".`,
  );
}

/**
 * Интерпретатор Python для расчёта индикаторов.
 *
 * По умолчанию — `python3` из PATH. Этого достаточно и для venv: активированное
 * окружение подменяет `python3` своим, и отдельный путь нужен только там, где
 * Core запускают мимо активации, — например в контейнере, где путь прописан
 * в Dockerfile.
 *
 * Пустая строка отключает инструмент RSI целиком, и это рабочее состояние, а
 * не поломка: без интерпретатора с TA-Lib он отказывал бы на каждом вызове,
 * уже потратив шаг планировщика. Лучше не иметь его в реестре вовсе.
 */
function pythonBin() {
  const raw = process.env.RSI_PYTHON_BIN;
  return raw === undefined ? "python3" : raw.trim();
}

/**
 * Относительные пути к БД разрешаются от корня сервиса, а не от текущего
 * рабочего каталога: иначе запуск из другого места молча создал бы вторую
 * пустую базу.
 */
function resolveFromProjectRoot(path) {
  return isAbsolute(path) || path === ":memory:" ? path : resolve(projectRoot, path);
}

/**
 * Адреса callback-эндпоинтов адаптеров: куда Core отправляет готовый ответ.
 * Держим их в конфиге, а не принимаем в запросе, — так сервис не превратить
 * в отправщика запросов на произвольный адрес.
 */
function callbackUrls() {
  const urls = {};
  if (process.env.ADAPTER_TELEGRAM_CALLBACK_URL) {
    urls.telegram = process.env.ADAPTER_TELEGRAM_CALLBACK_URL;
  }
  return urls;
}

export const config = {
  port: positiveInt("CORE_PORT", 8080),
  host: process.env.CORE_HOST || "0.0.0.0",
  maxBodyBytes: positiveInt("CORE_MAX_BODY_BYTES", 64 * 1024),
  /**
   * Общий секрет между Core и адаптерами. Если не задан, проверка выключена —
   * допустимо при локальной разработке, но не при запуске в compose.
   */
  authToken: process.env.CORE_AUTH_TOKEN || undefined,

  sqlitePath: resolveFromProjectRoot(process.env.SQLITE_DB_PATH || "./data/core.db"),
  /**
   * Бюджет диалога в токенах: при достижении лимита Core отвечает отказом
   * context_limit вместо того, чтобы молча обрезать историю. У Ollama это
   * значение ещё и передаётся модели как num_ctx (см. OllamaRunner) — там
   * оно упирается не только в нативное окно модели, но и в память под
   * KV-кеш. У LM Studio раннер num_ctx не передаёт: там длину контекста
   * задают при загрузке модели в самом приложении, и её нужно выставить не
   * меньше этого значения отдельно — см. LMSTUDIO_* в core/.env.example.
   */
  contextWindowTokens: positiveInt("CONTEXT_WINDOW_TOKENS", 16000),

  llmProvider: process.env.LLM_PROVIDER || "lmstudio",
  ollama: {
    baseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
    model: process.env.OLLAMA_MODEL || "qwen3:8b",
    timeoutMs: positiveInt("OLLAMA_TIMEOUT_MS", 120000),
    think: thinkMode("OLLAMA_THINK", false),
  },
  /**
   * У LM Studio нет запросного аналога num_ctx: длина контекста задаётся при
   * загрузке модели в самом LM Studio, а не в теле запроса, поэтому здесь
   * этого поля нет — см. LmStudioRunner и LMSTUDIO_* в core/.env.example.
   */
  lmstudio: {
    baseUrl: process.env.LMSTUDIO_BASE_URL || "http://localhost:1234",
    model: process.env.LMSTUDIO_MODEL || "bonsai-27b",
    timeoutMs: positiveInt("LMSTUDIO_TIMEOUT_MS", 300000),
  },

  /**
   * Инструменты сбора рыночных данных. Базовый адрес держится здесь, а не
   * приходит в параметрах вызова: параметры инструментов формирует языковая
   * модель, и адрес из них означал бы, что вывод модели решает, к какому
   * хосту пойдёт сервис.
   */
  tools: {
    binanceBaseUrl: process.env.BINANCE_BASE_URL || "https://api.binance.com",
    /**
     * Источник рыночной капитализации. Нужен отдельно от биржи по существу,
     * а не для подстраховки: Binance знает торговые пары и их объёмы, но не
     * знает, сколько монет выпущено, — рейтинга «топ по капитализации» из неё
     * не получить.
     */
    coingeckoBaseUrl: process.env.COINGECKO_BASE_URL || "https://api.coingecko.com",
    timeoutMs: positiveInt("TOOLS_TIMEOUT_MS", 10000),
    /**
     * Расчёт RSI: он живёт в Python-скрипте, который Core запускает
     * подпроцессом. Путь к скрипту — из нашего кода, не из окружения и тем
     * более не из параметров вызова: запускаемая команда не то, что стоит
     * оставлять настраиваемым.
     */
    rsi: {
      pythonBin: pythonBin(),
      scriptPath: join(projectRoot, "scripts", "rsi", "rsi.py"),
      // Расчёт занимает доли секунды; предел нужен на случай, если
      // интерпретатор чего-то ждёт, а шаг плана — нет.
      timeoutMs: positiveInt("RSI_TIMEOUT_MS", 30000),
    },
  },

  /**
   * Каталог с навыками: правила использования инструментов словами, которые
   * дописываются в промпт планировщика (см. src/skills/index.js).
   */
  skillsDir: join(projectRoot, "skills"),

  jobs: {
    pollIntervalMs: positiveInt("JOB_POLL_INTERVAL_MS", 500),
    deliveryMaxAttempts: positiveInt("CALLBACK_MAX_ATTEMPTS", 6),
    deliveryBackoffMs: positiveInt("CALLBACK_BACKOFF_MS", 2000),
    deliveryTimeoutMs: positiveInt("CALLBACK_TIMEOUT_MS", 10000),
  },

  callbackUrls: callbackUrls(),
};
