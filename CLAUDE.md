# CLAUDE.md

## Repository state

Telegram-бот на Node.js с интеграцией Ollama реализован в `telegram-bot/`. Исходное ТЗ — `telegram-bot/promt.md`, подробная спецификация — `telegram-bot/SPEC.md`, инструкция по запуску — `telegram-bot/README.md`.

Идёт выделение сервиса `core/` (Core Orchestrator): доменная логика — сессии, контекст, учёт токенов, вызов LLM — переезжает туда, а `telegram-bot/` становится тонким адаптером Telegram ↔ HTTP. Обмен асинхронный: адаптер шлёт `POST /v1/conversations/:adapter/:externalId/messages` и получает `202 { jobId }`, готовый ответ Core доставляет обратно запросом на `POST /callbacks/replies` адаптера. План реализации: https://claude.ai/code/artifact/c7d79508-b02c-415f-96ce-47422f9dcbda

Сервисы подтверждают друг друга общим секретом `CORE_AUTH_TOKEN`, запускаются вместе через корневой `docker-compose.yml`.  Перенос старой базы бота выполняется скриптом `core/scripts/migrate-from-adapter.mjs`.

Следующее направление — `docs/crypto-orchestrator-spec.md`: превращение Core в мультиагентного ассистента для криптотрейдеров (маршрутизатор интентов, планировщик задач, инструменты поверх публичных API бирж). К реализации ещё не приступали: готов только LLM-слой под неё (системные промпты, JSON Schema, отключение размышления) и замер качества маршрутизатора — `core/scripts/router-eval.mjs`.

Целевая локальная модель — `qwen3:8b` на видеокарте (RX 6700 XT, 12 ГБ). Это reasoning-модель: размышление у неё включено по умолчанию и приезжает блоком `<think>…</think>` в теле ответа, поэтому `OllamaRunner` его вырезает, а `OLLAMA_THINK` по умолчанию `false`. При смене модели `OLLAMA_THINK` и `CONTEXT_WINDOW_TOKENS` надо пересматривать вместе: первый зависит от того, reasoning ли модель, второй — и от нативного окна модели, и от размера KV-кеша: на полном контексте он сопоставим с самими весами. Расчёт — в комментариях `core/.env.example`.
