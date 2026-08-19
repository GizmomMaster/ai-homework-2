# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository state

This repository currently contains **no implementation code** — only a requirements
document at `telegram-bot/promt.md` (in Russian) describing a Telegram bot that has
not yet been built. There is no `package.json`, no source files, and no build/lint/test
tooling yet. When asked to work on "the bot," start by implementing it per the spec below
inside `telegram-bot/`.

## Project spec (from telegram-bot/promt.md)

Build a Telegram bot with the following behavior and constraints:

**Functionality**
- Accepts a text message from a user in Telegram (bot runs on a local machine).
- Forwards the received text as a request to an LLM API.
- Initial integration target is the **Ollama API**. Structure the code so the LLM backend
  is swappable — i.e. use an abstraction/interface for "local LLM runner integrations"
  rather than calling Ollama's API directly from the bot logic, so other local LLM
  runners can be added later without rewriting the bot.
- Returns the model's response back to the user in the Telegram chat.
- **No conversation history/state** — every incoming message is handled as an independent,
  one-shot request (no per-user context accumulation).

**Technical requirements**
- Implementation language: JavaScript (Node.js).
- Talk to the Telegram Bot API using raw HTTP requests only — **no third-party Telegram
  bot libraries** (e.g. no `node-telegram-bot-api`, `telegraf`, etc.). Node's built-in
  `https`/`fetch` is fine.

**Security & configuration**
- `TELEGRAM_BOT_TOKEN` must be provided via an environment variable, loaded from a
  `.env` file. Never hardcode the token in source code, and never commit the `.env`
  file to git (ensure it's in `.gitignore` once created).
