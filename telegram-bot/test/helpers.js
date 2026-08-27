import http from "node:http";

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
 * Заглушка CoreClient: копит вызовы и умеет падать.
 * @param {{ failSendMessage?: boolean, failReset?: boolean }} [options]
 */
export function createFakeCoreClient({ failSendMessage = false, failReset = false } = {}) {
  const sentMessages = [];
  const resets = [];
  let jobCounter = 0;

  return {
    sentMessages,
    resets,
    async sendMessage({ chatId, text, updateId }) {
      if (failSendMessage) throw new Error("Core недоступен");
      sentMessages.push({ chatId, text, updateId });
      return { jobId: `j_${(jobCounter += 1)}`, status: "queued" };
    },
    async reset({ chatId }) {
      if (failReset) throw new Error("Core недоступен");
      resets.push({ chatId });
      return { conversationId: 1, sessionId: resets.length };
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
      let payload;
      try {
        payload = body ? JSON.parse(body) : {};
      } catch {
        payload = undefined;
      }
      requests.push({ url: req.url, method: req.method, payload });

      const { status = 200, json = { ok: true, result: {} }, delayMs = 0 } =
        (await handler(payload, req)) ?? {};
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(typeof json === "string" ? json : JSON.stringify(json));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    requests,
    port,
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
