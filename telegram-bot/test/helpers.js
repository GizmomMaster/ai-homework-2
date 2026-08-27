import http from "node:http";
import { createDatabase } from "../src/db/database.js";
import { ChatRepository } from "../src/db/chatRepository.js";

/** Репозиторий поверх БД в памяти — тесты не трогают файловую систему. */
export function createTestRepository() {
  return new ChatRepository(createDatabase(":memory:"));
}

/**
 * Заглушка TelegramClient: запоминает отправленное вместо похода в сеть.
 * @param {{ failSendMessage?: boolean }} [options]
 */
export function createFakeTelegramClient({ failSendMessage = false } = {}) {
  const sent = [];
  return {
    sent,
    async sendMessage({ chatId, text, parseMode }) {
      if (failSendMessage) throw new Error("Telegram недоступен");
      sent.push({ chatId, text, parseMode });
    },
    lastText: () => sent[sent.length - 1]?.text,
    texts: () => sent.map((m) => m.text),
  };
}

/**
 * Заглушка LlmRunner. `reply` — либо объект ответа, либо функция от messages.
 * Запоминает историю, с которой её вызывали.
 */
export function createFakeLlmRunner(reply = { content: "ответ", promptTokens: 10, completionTokens: 5 }) {
  const calls = [];
  return {
    calls,
    async chat(messages) {
      calls.push(messages);
      const result = typeof reply === "function" ? reply(messages) : reply;
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

/**
 * Поднимает локальный HTTP-сервер и возвращает его базовый URL.
 * `handler(payload, req)` возвращает объект-ответ (сериализуется в JSON).
 */
export async function startTestServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      const payload = body ? JSON.parse(body) : {};
      requests.push({ url: req.url, payload });
      const result = await handler(payload, req);
      const { status = 200, json = { ok: true, result: {} }, delayMs = 0 } = result ?? {};
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(typeof json === "string" ? json : JSON.stringify(json));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    requests,
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Ждёт выполнения условия, чтобы не завязываться на фиксированные паузы. */
export async function waitFor(predicate, { timeoutMs = 2000, label = "условие" } = {}) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Таймаут ожидания: ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Глушит вывод логгера на время теста, чтобы не засорять отчёт. */
export function muteConsole(t) {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  t.after(() => {
    console.log = originalLog;
    console.error = originalError;
  });
}
