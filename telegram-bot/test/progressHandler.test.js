import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createProgressTracker } from "../src/handlers/progressHandler.js";
import { createFakeTelegramClient, muteConsole } from "./helpers.js";

function payload(jobId, progress) {
  return { jobId, adapter: "telegram", externalId: "8123", status: "progress", progress };
}

describe("progressTracker", () => {
  it("на первый статус задания отправляет новое сообщение", async () => {
    const telegramClient = createFakeTelegramClient();
    const tracker = createProgressTracker({ telegramClient });

    await tracker.handle(payload("j_1", { stage: "routing" }));

    assert.equal(telegramClient.sent.length, 1);
    assert.equal(telegramClient.sent[0].chatId, "8123");
    assert.match(telegramClient.sent[0].text, /разбираю запрос/i);
  });

  it("следующий статус того же задания редактирует то же сообщение", async () => {
    const telegramClient = createFakeTelegramClient();
    const tracker = createProgressTracker({ telegramClient });

    await tracker.handle(payload("j_1", { stage: "routing" }));
    await tracker.handle(payload("j_1", { stage: "planning" }));

    assert.equal(telegramClient.sent.length, 1, "второе сообщение не создаётся");
    assert.equal(telegramClient.edited.length, 1);
    assert.equal(telegramClient.edited[0].messageId, 1);
    assert.match(telegramClient.edited[0].text, /план/i);
  });

  it("статус выполнения шага упоминает номер шага и его описание", async () => {
    const telegramClient = createFakeTelegramClient();
    const tracker = createProgressTracker({ telegramClient });

    await tracker.handle(
      payload("j_1", {
        stage: "executing",
        totalSteps: 3,
        step: { stepNumber: 2, totalSteps: 3, action: "Цена ETH" },
      }),
    );

    assert.match(telegramClient.sent[0].text, /2\/3/);
    assert.match(telegramClient.sent[0].text, /Цена ETH/);
  });

  it("разные задания получают разные статусные сообщения", async () => {
    const telegramClient = createFakeTelegramClient();
    const tracker = createProgressTracker({ telegramClient });

    await tracker.handle(payload("j_1", { stage: "routing" }));
    await tracker.handle(payload("j_2", { stage: "routing" }));

    assert.equal(telegramClient.sent.length, 2);
  });

  it("finish удаляет статусное сообщение задания", async () => {
    const telegramClient = createFakeTelegramClient();
    const tracker = createProgressTracker({ telegramClient });
    await tracker.handle(payload("j_1", { stage: "routing" }));

    await tracker.finish("j_1");

    assert.equal(telegramClient.deleted.length, 1);
    assert.equal(telegramClient.deleted[0].messageId, 1);
  });

  it("finish для задания без статусного сообщения — не падает", async () => {
    const telegramClient = createFakeTelegramClient();
    const tracker = createProgressTracker({ telegramClient });

    await assert.doesNotReject(() => tracker.finish("нет-такого"));
    assert.equal(telegramClient.deleted.length, 0);
  });

  it("статус, пришедший после finish, новое сообщение не создаёт", async () => {
    const telegramClient = createFakeTelegramClient();
    const tracker = createProgressTracker({ telegramClient });
    await tracker.handle(payload("j_1", { stage: "routing" }));
    await tracker.finish("j_1");

    await tracker.handle(payload("j_1", { stage: "planning" }));

    assert.equal(telegramClient.sent.length, 1, "новых сообщений не появилось");
    assert.equal(telegramClient.edited.length, 0, "и редактировать уже нечего");
  });

  it("неизвестная стадия не отправляет ничего", async () => {
    const telegramClient = createFakeTelegramClient();
    const tracker = createProgressTracker({ telegramClient });

    await tracker.handle(payload("j_1", { stage: "что-то новое" }));

    assert.equal(telegramClient.sent.length, 0);
  });

  it("ошибка отправки статуса гасится — это не гарантия задания", async (t) => {
    muteConsole(t);
    const telegramClient = createFakeTelegramClient({ failSendMessage: true });
    const tracker = createProgressTracker({ telegramClient });

    await assert.doesNotReject(() => tracker.handle(payload("j_1", { stage: "routing" })));
  });
});
