# CLAUDE.md

## Repository state

Telegram-бот на Node.js с интеграцией Ollama реализован в `telegram-bot/`. Исходное ТЗ — `telegram-bot/promt.md`, подробная спецификация — `telegram-bot/SPEC.md`, инструкция по запуску — `telegram-bot/README.md`.

Идёт выделение сервиса `core/` (Core Orchestrator): доменная логика — сессии, контекст, учёт токенов, вызов LLM — переезжает туда, а `telegram-bot/` становится тонким адаптером Telegram ↔ HTTP. Обмен асинхронный: адаптер шлёт `POST /v1/conversations/:adapter/:externalId/messages` и получает `202 { jobId }`, готовый ответ Core доставляет обратно запросом на `POST /callbacks/replies` адаптера. План реализации: https://claude.ai/code/artifact/c7d79508-b02c-415f-96ce-47422f9dcbda

Состояние: все пять фаз плана выполнены. Core владеет доменной логикой (`core/src/domain/DialogService.js`), очередью заданий с устойчивой доставкой (`core/src/jobs/`) и SQLite; адаптер сведён к трансляции Telegram ↔ HTTP и не содержит ни БД, ни LLM. Сервисы подтверждают друг друга общим секретом `CORE_AUTH_TOKEN`, запускаются вместе через корневой `docker-compose.yml`.  Перенос старой базы бота выполняется скриптом `core/scripts/migrate-from-adapter.mjs`.

Оба пакета тестируются встроенным `node --test` без внешних зависимостей: `npm test` в `core/` и в `telegram-bot/`.
