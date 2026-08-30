import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSkills, parseSkill } from "../src/skills/index.js";
import { buildPlannerPrompt } from "../src/agents/PlannerAgent.js";
import { RSI_TOOL, createTools } from "../src/tools/index.js";
import { muteConsole } from "./helpers.js";

const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "skills");

/** Каталог навыков во временной папке: {имя: содержимое SKILL.md}. */
function withSkills(files) {
  const dir = mkdtempSync(join(tmpdir(), "skills-"));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, "SKILL.md"), content, "utf8");
  }
  return dir;
}

const VALID = `---
name: demo
description: Демонстрационный навык.
---
Правило первое.`;

describe("навыки", () => {
  describe("разбор SKILL.md", () => {
    it("делит файл на заголовок и правила", () => {
      const skill = parseSkill(VALID);

      assert.equal(skill.name, "demo");
      assert.equal(skill.description, "Демонстрационный навык.");
      assert.equal(skill.body, "Правило первое.");
    });

    it("двоеточие внутри описания не ломает разбор", () => {
      const skill = parseSkill("---\nname: demo\ndescription: Считает так: и никак иначе.\n---\nПравило.");
      assert.equal(skill.description, "Считает так: и никак иначе.");
    });

    it("файл без заголовка — ошибка, а не навык с пустым именем", () => {
      assert.throws(() => parseSkill("Просто текст без заголовка."), /заголовка/);
    });

    it("заголовок без описания — ошибка: описание идёт в промпт", () => {
      assert.throws(() => parseSkill("---\nname: demo\n---\nПравило."), /description/);
    });

    it("пустое тело — ошибка: навык без правил ничему не учит", () => {
      assert.throws(() => parseSkill("---\nname: demo\ndescription: Пусто.\n---\n\n"), /пустое тело/);
    });
  });

  describe("загрузка каталога", () => {
    it("читает по файлу на подкаталог", () => {
      const skills = loadSkills(withSkills({ demo: VALID }));

      assert.equal(skills.length, 1);
      assert.equal(skills[0].name, "demo");
    });

    it("отсутствие каталога — не ошибка: навыков может не быть вовсе", () => {
      assert.deepEqual(loadSkills(join(tmpdir(), "нет-такого-каталога-навыков")), []);
    });

    it("испорченный файл пропускает, а остальные грузит", (t) => {
      muteConsole(t);
      const dir = withSkills({ good: VALID, bad: "без заголовка" });

      const skills = loadSkills(dir);

      assert.deepEqual(skills.map((s) => s.name), ["demo"]);
    });

    it("порядок навыков не зависит от порядка файлов в каталоге", () => {
      const dir = withSkills({
        second: VALID.replace("name: demo", "name: second"),
        first: VALID.replace("name: demo", "name: first"),
      });

      assert.deepEqual(loadSkills(dir).map((s) => s.name), ["first", "second"]);
    });
  });

  describe("в промпте планировщика", () => {
    const tools = () => createTools({ binance: {}, rsi: { pythonBin: "python3", scriptPath: "rsi.py" } });

    it("без навыков раздела нет — пустой заголовок только отвлекал бы модель", () => {
      assert.ok(!buildPlannerPrompt(tools(), []).includes("НАВЫКИ"));
    });

    it("правила навыка попадают в промпт дословно", () => {
      const prompt = buildPlannerPrompt(tools(), [parseSkill(VALID)]);

      assert.match(prompt, /НАВЫКИ/);
      assert.match(prompt, /Правило первое\./);
    });

    it("правила идут после общих — последнее слово за навыком", () => {
      const prompt = buildPlannerPrompt(tools(), [parseSkill(VALID)]);

      assert.ok(prompt.indexOf("ПРАВИЛА:") < prompt.indexOf("НАВЫКИ"));
    });
  });

  describe("навык crypto-rsi из репозитория", () => {
    const skills = loadSkills(SKILLS_DIR);

    it("загружается", () => {
      assert.deepEqual(skills.map((s) => s.name), ["crypto-rsi"]);
    });

    it("называет инструмент его настоящим именем", () => {
      // Разъедься эти два имени — планировщик получил бы правила про
      // инструмент, которого в схеме плана нет.
      assert.ok(skills[0].body.includes(RSI_TOOL));
    });

    it("говорит и про ограничение, и про то, что делать с остальными монетами", () => {
      assert.match(skills[0].body, /только для BTC и ETH|ТОЛЬКО для BTC \(BTCUSDT\)/);
      assert.match(skills[0].body, /canExecute=false/);
    });
  });
});
