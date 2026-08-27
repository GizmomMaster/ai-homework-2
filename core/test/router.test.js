import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/http/router.js";

const noop = async () => ({ status: 200, json: {} });

function routerWithRoutes() {
  return createRouter()
    .add("GET", "/health", noop)
    .add("POST", "/v1/conversations/:adapter/:externalId/messages", noop)
    .add("GET", "/v1/jobs/:jobId", noop);
}

describe("createRouter", () => {
  describe("совпадение пути", () => {
    it("находит статический маршрут", () => {
      const match = routerWithRoutes().match("GET", "/health");

      assert.equal(match.found, true);
      assert.deepEqual(match.params, {});
    });

    it("извлекает параметры пути", () => {
      const match = routerWithRoutes().match(
        "POST",
        "/v1/conversations/telegram/8123/messages",
      );

      assert.equal(match.found, true);
      assert.deepEqual(match.params, { adapter: "telegram", externalId: "8123" });
    });

    it("не путает маршруты с разным числом сегментов", () => {
      const match = routerWithRoutes().match("GET", "/v1/jobs/abc/extra");

      assert.equal(match.found, false);
      assert.equal(match.pathMatched, false);
    });

    it("игнорирует лишние слэши по краям", () => {
      const match = routerWithRoutes().match("GET", "/health/");

      assert.equal(match.found, true);
    });

    it("декодирует процентную кодировку в параметрах", () => {
      const match = routerWithRoutes().match(
        "POST",
        "/v1/conversations/telegram/%D1%87%D0%B0%D1%82/messages",
      );

      assert.equal(match.params.externalId, "чат");
    });

    it("сообщает об ошибке при битой кодировке", () => {
      assert.throws(() => routerWithRoutes().match("GET", "/v1/jobs/%ZZ"), /кодировка/i);
    });
  });

  describe("совпадение метода", () => {
    it("отличает неизвестный путь от неверного метода", () => {
      const router = routerWithRoutes();

      const wrongMethod = router.match("DELETE", "/health");
      assert.equal(wrongMethod.found, false);
      assert.equal(wrongMethod.pathMatched, true, "путь существует — это 405");

      const unknownPath = router.match("GET", "/nope");
      assert.equal(unknownPath.found, false);
      assert.equal(unknownPath.pathMatched, false, "пути нет — это 404");
    });

    it("разводит разные методы на одном пути", async () => {
      const router = createRouter()
        .add("GET", "/thing", async () => ({ status: 200, json: { verb: "get" } }))
        .add("POST", "/thing", async () => ({ status: 201, json: { verb: "post" } }));

      const get = await router.match("GET", "/thing").handler({});
      const post = await router.match("POST", "/thing").handler({});

      assert.equal(get.json.verb, "get");
      assert.equal(post.json.verb, "post");
    });
  });
});
