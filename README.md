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
  `ollama pull qwen3:8b` (около 5 ГБ). Имя модели должно совпадать с
  `OLLAMA_MODEL` в `core/.env`. Модель на 8B рассчитана на видеокарту: на
  голом процессоре она поедет, но каждый ответ займёт минуты — тогда берите
  `qwen3:4b` или `qwen3:1.7b` и не забудьте уменьшить `CONTEXT_WINDOW_TOKENS`.
- Токен бота от [@BotFather](https://t.me/BotFather).

### Установка на Windows

Работать удобнее всего в **PowerShell** (Windows Terminal или «PowerShell» из
меню «Пуск»). Там, где команда в bash и PowerShell различается, ниже по тексту
приведены оба варианта — второй блок всегда PowerShell.

Поставить всё необходимое:

```powershell
winget install Ollama.Ollama
winget install OpenJS.NodeJS.LTS
winget install Git.Git
```

После установки закройте и откройте терминал заново, иначе он не увидит новые
команды в `PATH`. Проверка: `node --version`, `ollama --version`.

Четыре места, где PowerShell ведёт себя не так, как bash, — они встречаются
в инструкциях ниже:

| bash | PowerShell |
|---|---|
| `cmd1 && cmd2` | `&&` работает только в PowerShell 7+. В штатном 5.1 пишите `cmd1; cmd2` или две строки |
| `VAR=value cmd` | так переменную не передать: сначала `$env:VAR = "value"`, затем `cmd` |
| `curl -s <url>` | `curl` здесь — псевдоним `Invoke-WebRequest` с другими флагами. Пишите `curl.exe` или `Invoke-RestMethod <url>` |
| `openssl rand -hex 24` | openssl в комплекте нет, замена показана ниже |

Файлы `.env` сохраняйте в **UTF-8 без BOM**. Обычный Блокнот дописывает BOM в
начало файла, и первая переменная — как правило `TELEGRAM_BOT_TOKEN` — не
распознаётся. Подойдёт VS Code или Notepad++.

### Видеокарта AMD

Ollama считает на GPU только через ROCm, а официально в ROCm входят не все
карты RDNA2: например, у RX 6700 XT ядро `gfx1031`, поддерживается же `gfx1030`.
Без подсказки Ollama молча уходит считать на процессор — со стороны это
выглядит как «видеокарта почему-то медленная».

Проверить, кто считает:

```
ollama ps
```

В колонке `PROCESSOR` будет `100% GPU` или `100% CPU`. Команда показывает
только загруженные модели, поэтому сначала задайте модели любой вопрос.

Если оказалось `100% CPU`, скажите ROCm считать карту за `gfx1030`.

**Linux** (Ollama работает как systemd-сервис):

```bash
sudo systemctl edit ollama.service
```

```ini
[Service]
Environment="HSA_OVERRIDE_GFX_VERSION=10.3.0"
```

```bash
sudo systemctl restart ollama
```

**Windows** (Ollama работает фоновым приложением из трея, поэтому переменную
надо задать на уровне пользователя — в сессии терминала она до неё не дойдёт):

```powershell
[Environment]::SetEnvironmentVariable("HSA_OVERRIDE_GFX_VERSION", "10.3.0", "User")
```

Затем **полностью перезапустить** Ollama: правой кнопкой по значку в трее →
Quit, и запустить заново из меню «Пуск». Без этого приложение не подхватит
новое значение.

Подмена нужна только семейству gfx103x; на других картах она сделает хуже.

Ollama при этом должна работать **нативно**, не внутри WSL: проброс AMD-карт
в WSL поддерживается для узкого списка моделей, и RX 6700 XT в него не входит.
Node.js и сервисы запускать в WSL можно — им видеокарта не нужна, они ходят в
Ollama по HTTP.

## Запуск в Docker (рекомендуется)

1. Подготовьте конфигурацию обоих сервисов:

   ```bash
   cp core/.env.example core/.env
   cp telegram-bot/.env.example telegram-bot/.env
   ```

   ```powershell
   Copy-Item core\.env.example core\.env
   Copy-Item telegram-bot\.env.example telegram-bot\.env
   ```

2. Заполните обязательные значения:

   - `telegram-bot/.env` → `TELEGRAM_BOT_TOKEN` — токен от BotFather;
   - `core/.env` → `OLLAMA_BASE_URL=http://host.docker.internal:11434`
     (Ollama живёт на хосте, а не в контейнере);
   - в **обоих** файлах → одинаковый `CORE_AUTH_TOKEN`. Это общий секрет,
     которым сервисы подтверждают друг друга; сгодится любая случайная строка:

     ```bash
     openssl rand -hex 24
     ```

     ```powershell
     -join ((1..24) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
     ```

3. Разрешите Ollama принимать соединения не только с localhost — иначе она
   слушает `127.0.0.1` и из контейнера недоступна:

   ```bash
   OLLAMA_HOST=0.0.0.0 ollama serve
   ```

   На Windows Ollama обычно работает фоновым приложением из трея, а не через
   `ollama serve`, поэтому переменную задают на уровне пользователя — в сессии
   терминала она до приложения не дойдёт:

   ```powershell
   [Environment]::SetEnvironmentVariable("OLLAMA_HOST", "0.0.0.0", "User")
   ```

   Затем **полностью перезапустите** Ollama: правой кнопкой по значку в трее →
   Quit, и запустить заново из «Пуска». Если всё же запускаете вручную —
   `$env:OLLAMA_HOST = "0.0.0.0"`, потом `ollama serve`.

4. Запустите:

   ```
   docker compose up --build -d
   docker compose logs -f
   ```

Наружу не публикуется ни один порт: адаптер сам ходит в Telegram (long polling —
исходящее соединение), а Core доступен только адаптеру внутри сети compose.
История диалогов лежит в `core/data/` на хосте и переживает пересоздание
контейнеров.

Остановить: `docker compose down`.

### Нюансы Docker Desktop на Windows

- **Файрвол может блокировать порт 11434.** Docker Desktop поднимает контейнеры
  в отдельной сети WSL2, и первое обращение к Ollama Брандмауэр Windows иногда
  режет. Если после всех настроек Core не достучался до модели — проверьте, не
  всплывал ли запрос на разрешение доступа, и при необходимости добавьте
  входящее правило для порта 11434.

- **`host.docker.internal` резолвится сам.** Строка `extra_hosts` в
  `docker-compose.yml` нужна только на Linux; здесь она не обязательна, но и не
  мешает — трогать не нужно.

- **Ollama остаётся на хосте, а не в WSL** — см. «Видеокарта AMD» выше.
  Сервисы в контейнерах ходят к ней по `host.docker.internal`.

## Запуск без Docker

Нужны два терминала — по одному на сервис.

```bash
# Терминал 1
cd core
cp .env.example .env
npm install    # соберёт better-sqlite3, это займёт пару минут
npm start

# Терминал 2
cd telegram-bot
cp .env.example .env   # впишите TELEGRAM_BOT_TOKEN
npm start              # зависимостей нет, install не нужен
```

```powershell
# Терминал 1
cd core
Copy-Item .env.example .env
npm install    # соберёт better-sqlite3, это займёт пару минут
npm start

# Терминал 2
cd telegram-bot
Copy-Item .env.example .env   # впишите TELEGRAM_BOT_TOKEN
npm start                     # зависимостей нет, install не нужен
```

При локальном запуске поправьте адреса в `.env` — значения по умолчанию
рассчитаны на compose-сеть:

- у адаптера `CORE_BASE_URL=http://localhost:8080`;
- у Core `ADAPTER_TELEGRAM_CALLBACK_URL=http://localhost:8081/callbacks/replies`;
- у Core `OLLAMA_BASE_URL=http://localhost:11434` — **не**
  `host.docker.internal`. Это имя резолвится только изнутри контейнера; если
  оставить его при локальном запуске, Core не найдёт модель и сообщит
  «Не удалось подключиться к Ollama».

## Перенос истории из старой версии

Если бот уже работал до выделения Core, его база лежит в
`telegram-bot/data/bot.db`. Перенести историю в схему Core:

```
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

Запускаются из каталога каждого сервиса, синтаксис одинаковый в bash и
PowerShell:

```
cd core
npm test

cd ../telegram-bot
npm test
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
- **«Не удалось подключиться к Ollama».** Адрес в `OLLAMA_BASE_URL` зависит от
  того, где запущен **Core**, а не Ollama — та в обоих случаях живёт на хосте.
  - Core в контейнере → `http://host.docker.internal:11434`, и Ollama должна
    слушать не только localhost (`OLLAMA_HOST=0.0.0.0`, см. шаг 3). Проверить,
    на чём она висит: `netstat -ano | findstr 11434` на Windows,
    `ss -ltn | grep 11434` на Linux — нужен `0.0.0.0`, а не `127.0.0.1`.
  - Core запущен локально через `npm start` → `http://localhost:11434`.
    `host.docker.internal` вне контейнера не резолвится, и запрос падает
    с `fetch failed`.

  Отвечает ли Ollama вообще: `curl.exe http://localhost:11434/api/tags`
  (в PowerShell — `Invoke-RestMethod http://localhost:11434/api/tags`).
- **Контекст не доходит до лимита.** Core передаёт модели `num_ctx`, равный
  `CONTEXT_WINDOW_TOKENS`. Большое значение требует много оперативной памяти;
  если модель не тянет, уменьшите его. Значение выше нативного окна модели
  (`ollama show <модель>`, строка `context length`) бессмысленно: модель на нём
  не обучалась и связного ответа не даст.
- **Модель отвечает, но ерундой, и в ответе виден блок `<think>`.** Так ведут
  себя reasoning-модели вроде Qwen3. Core такие блоки вырезает; если они всё же
  доходят, проверьте `OLLAMA_THINK` в `core/.env`.
