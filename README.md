# Telegram-бот с локальной LLM

Система из двух сервисов: **Core Orchestrator** держит всю доменную логику
(диалоги, история, контекстное окно, вызов модели, очередь заданий), а
**telegram-bot** — тонкий адаптер, который транслирует Telegram Bot API в
HTTP-контракт Core.

```
Telegram ──► telegram-bot ──POST /v1/.../messages──► Core ──► Ollama
                  ▲                                    │        │
                  └────POST /callbacks/replies─────────┘     SQLite
                       (когда ответ готов)
```

Обмен асинхронный: Core отвечает `202 { jobId }` сразу, не дожидаясь модели, а
готовый ответ доставляет отдельным запросом. Генерация занимает десятки секунд,
и держать соединение всё это время незачем.

## Состав

| Каталог | Что это |
|---|---|
| [`core/`](./core) | Core Orchestrator: HTTP-API, SQLite, очередь заданий, вызов LLM |
| [`telegram-bot/`](./telegram-bot) | Адаптер Telegram |

Подробная спецификация — [`telegram-bot/SPEC.md`](./telegram-bot/SPEC.md),
исходное ТЗ — [`telegram-bot/promt.md`](./telegram-bot/promt.md).

## Требования

- Node.js 18+ (для запуска без Docker) либо Docker с Compose.
- Установленная и запущенная [Ollama](https://ollama.com) со скачанной моделью:
  `ollama pull llama3`.
- Токен бота от [@BotFather](https://t.me/BotFather).

## Запуск в Docker (рекомендуется)

1. Подготовьте конфигурацию обоих сервисов:

   ```bash
   cp core/.env.example core/.env
   cp telegram-bot/.env.example telegram-bot/.env
   ```

2. Заполните обязательные значения:

   - `telegram-bot/.env` → `TELEGRAM_BOT_TOKEN` — токен от BotFather;
   - `core/.env` → `OLLAMA_BASE_URL=http://host.docker.internal:11434`
     (Ollama живёт на хосте, а не в контейнере);
   - в **обоих** файлах → одинаковый `CORE_AUTH_TOKEN`, например из
     `openssl rand -hex 24`. Это общий секрет, которым сервисы подтверждают
     друг друга.

3. Разрешите Ollama принимать соединения не только с localhost:

   ```bash
   OLLAMA_HOST=0.0.0.0 ollama serve
   ```

4. Запустите:

   ```bash
   docker compose up --build -d
   docker compose logs -f
   ```

Наружу не публикуется ни один порт: адаптер сам ходит в Telegram (long polling —
исходящее соединение), а Core доступен только адаптеру внутри сети compose.
История диалогов лежит в `core/data/` на хосте и переживает пересоздание
контейнеров.

Остановить: `docker compose down`.

## Запуск без Docker

Нужны два терминала — по одному на сервис.

```bash
# Терминал 1
cd core && cp .env.example .env
npm install    # соберёт better-sqlite3, это займёт пару минут
npm start

# Терминал 2
cd telegram-bot && cp .env.example .env   # впишите TELEGRAM_BOT_TOKEN
npm start                                  # зависимостей нет, install не нужен
```

При локальном запуске поправьте адреса в `.env`: у адаптера
`CORE_BASE_URL=http://localhost:8080`, у Core
`ADAPTER_TELEGRAM_CALLBACK_URL=http://localhost:8081/callbacks/replies`.

## Перенос истории из старой версии

Если бот уже работал до выделения Core, его база лежит в
`telegram-bot/data/bot.db`. Перенести историю в схему Core:

```bash
cd core
node scripts/migrate-from-adapter.mjs ../telegram-bot/data/bot.db ./data/core.db
```

Каждому `chat_id` заводится диалог с `adapter='telegram'`, сессии и сообщения
переезжают как есть — вместе со счётчиками токенов и временем создания.
Скрипт идемпотентен: повторный запуск перенесёт только то, что появилось после
прошлого раза, и не тронет диалоги, уже созданные работающим Core. Запускать
лучше при остановленных сервисах.

## Команды бота

- `/new` — начать новый диалог, сбросив контекст;
- `/start` — приветствие и новый диалог;
- `/help` — краткая справка.

Команды зарегистрированы в меню Telegram (кнопка «/» рядом с полем ввода).

## Тесты

```bash
cd core && npm test
cd telegram-bot && npm test
```

Оба набора используют встроенный `node --test` — тестовых зависимостей нет.
Сеть, Telegram и Ollama заменяются локальными заглушками, SQLite поднимается
в памяти, поэтому ни токен, ни запущенная модель для тестов не нужны.

## Возможные проблемы

- **Бот молчит.** Посмотрите `docker compose logs -f core`. У каждого принятого
  сообщения есть `jobId`, а состояние задания доступно через
  `GET /v1/jobs/<jobId>`. В логах адаптера и Core фигурирует один и тот же
  `jobId` — по нему удобно сопоставлять записи.
- **«Сервис временно недоступен».** Адаптер не достучался до Core: проверьте
  `CORE_BASE_URL` и что контейнер `core` запущен и здоров (`docker compose ps`).
- **Core отвечает 401.** Не совпадают значения `CORE_AUTH_TOKEN` в двух `.env`.
- **«Не удалось подключиться к Ollama».** `OLLAMA_BASE_URL` должен указывать на
  `host.docker.internal` (не `localhost`) при запуске в Docker, а сама Ollama —
  быть запущена с `OLLAMA_HOST=0.0.0.0`.
- **Контекст не доходит до лимита.** Core передаёт модели `num_ctx`, равный
  `CONTEXT_WINDOW_TOKENS`. Большое значение требует много оперативной памяти;
  если модель не тянет, уменьшите его.
