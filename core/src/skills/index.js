import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { logError } from "../logger.js";

/**
 * Навыки: правила использования инструментов, записанные словами.
 *
 * Зачем отдельный слой поверх реестра инструментов. Реестр отвечает на вопрос
 * «что система умеет»: имя, назначение, параметры — из него собирается схема
 * плана. Но у части инструментов есть правила, которые в описание параметра не
 * помещаются: когда инструмент уместен, чего он не умеет, что ответить, если
 * просят невозможное. Раньше такие правила пришлось бы вписать в промпт
 * планировщика — то есть в код, где их не найдёт тот, кто ищет «а что там с
 * RSI».
 *
 * Формат — `SKILL.md` в отдельном каталоге на навык: заголовок с полями между
 * строками `---`, дальше правила обычным текстом. Файл, а не константа в
 * коде, по существу: текст правил — это промпт, его правят и подбирают, и
 * править его должно быть можно, не трогая JavaScript.
 *
 * Тело файла попадает в системный промпт планировщика **дословно**, поэтому
 * писать его нужно как инструкцию модели, а не как документацию для человека.
 */

/** Обязательные поля заголовка. Без них навык не грузим: имя нужно в промпте. */
const REQUIRED_FIELDS = ["name", "description"];

/**
 * Читает навыки из каталога: по подкаталогу на навык, в каждом — SKILL.md.
 *
 * Отсутствие каталога — не ошибка: навыков может не быть вовсе, и это рабочее
 * состояние системы. А вот испорченный файл пропускаем с записью в лог:
 * молча потерянное правило дороже, чем шумная строка при старте.
 *
 * @param {string} dir каталог с навыками
 * @returns {Array<{ name: string, description: string, body: string }>}
 */
export function loadSkills(dir) {
  if (!existsSync(dir)) return [];

  const skills = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;

    const path = join(dir, entry.name, "SKILL.md");
    if (!existsSync(path)) continue;

    try {
      skills.push(parseSkill(readFileSync(path, "utf8")));
    } catch (error) {
      logError(`Навык ${entry.name} пропущен:`, error);
    }
  }
  return skills;
}

/**
 * Разбор SKILL.md. Заголовок читаем построчно, а не полноценным YAML: полей
 * два, оба — строки, и тащить ради них зависимость незачем.
 *
 * @param {string} source
 * @returns {{ name: string, description: string, body: string }}
 */
export function parseSkill(source) {
  const text = source.replace(/^﻿/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) throw new Error("нет заголовка между строками ---");

  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const separator = line.indexOf(":");
    if (separator === -1) throw new Error(`строка заголовка без двоеточия: "${line.trim()}"`);
    meta[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }

  for (const field of REQUIRED_FIELDS) {
    if (!meta[field]) throw new Error(`в заголовке нет поля ${field}`);
  }

  const body = text.slice(match[0].length).trim();
  if (!body) throw new Error("пустое тело файла: правила навыка не описаны");

  return { name: meta.name, description: meta.description, body };
}
