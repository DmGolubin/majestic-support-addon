# SupportTemplates — этап 1: ядро + Vencord на локальных данных

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Рабочий Vencord-плагин SupportTemplates на локальных шаблонах (импорт конфига 0.5.1): окно в стиле панели, ввод `;команда`, защита проекта, поля и граница приветствия, сборка ответа — чтобы пользователь покликал его в Discord.

**Architecture:** Чистое ядро на TypeScript (`src/core`, без DOM и Discord, покрыто Vitest) + Vencord-обёртка (`src/vencord`: React через `@webpack/common`, вставка через `insertTextIntoChatInputBox`, хранилище `@api/DataStore`). Скрипт `sync-vencord` копирует обёртку в корень `Vencord/src/userplugins/supportTemplates/` и ядро в его подпапку `core/`; Vencord собирается `pnpm build`.

**Tech Stack:** TypeScript 5, Vitest 3, Node 24, pnpm; Vencord (исходники в `C:\Users\oblako\dev\Vencord`, коммит b52ed36).

**Spec:** `docs/superpowers/specs/2026-10-05-support-templates-design.md`

## Global Constraints

- Только проекты ru (Majestic RP, guild `530693013622489088`) и ro (Россия Онлайн, guild `1089530150540034181`), без EU.
- Плагин никогда не отправляет сообщения и команды; вставка — одним `INSERT_TEXT` (`insertTextIntoChatInputBox`), без `execCommand` и синтетического paste.
- Удержание клавиши не повторяет вставку (`e.repeat` игнорируется).
- Пока проект канала не определён, проектный шаблон не вставляется ни одним способом.
- Стиль панели: фон `hsl(216 16% 6%)`, карточки `hsl(218 17% 9%)`, рамки `hsl(215 16% 15%)`, текст `hsl(216 10% 91%)`, приглушённый `hsl(214 10% 80%)`, акцент `hsl(342 77% 44%)`, янтарь `#e0a83f`, шрифт `Golos Text, Inter, Segoe UI, sans-serif`.
- Проекты различаются иконками в одинаковых квадратах, не цветом. Других SVG-иконок нет.
- Каждый файл в `src/vencord` и `src/core` начинается с заголовка Vencord:
  ```
  /*
   * Vencord, a Discord client mod
   * Copyright (c) 2026 Vendicated and contributors
   * SPDX-License-Identifier: GPL-3.0-or-later
   */
  ```
- Импорты ядра из обёртки пишутся относительно **итоговой** раскладки в Vencord: из корня плагина `./core/x`, из `ui/` — `../core/x`. В репозитории эти пути не резолвятся — обёртку проверяет `tsc` Vencord после синка.
- CSS-классы обёртки — с префиксом `vc-stx-`.

## Файлы

```
support-templates/
  package.json, tsconfig.json
  assets/mj.png, assets/ro-logo.svg           иконки проектов (уже в репо)
  scripts/sync-vencord.mjs                    копирование в Vencord
  scripts/make-icons.mjs                      assets → src/vencord/ui/icons.ts
  src/core/types.ts        Template, ProjectId, PROJECTS, Usage
  src/core/text.ts         нормализация, граница приветствия
  src/core/importer.ts     разбор формата 0.5.1 и бэкапа
  src/core/aliases.ts      синонимы из VKMaj.js
  src/core/search.ts       поиск: уровни, синонимы, нечёткий, раскладка
  src/core/rank.ts         разделы и порядок
  src/core/tokens.ts       поля и токены панели
  src/core/guard.ts        проект по серверу, зеркала, чужие маркеры
  src/core/compose.ts      склейка ответа
  src/core/trigger.ts      «;слово» перед курсором
  src/core/keys.ts         сочетания клавиш, запреты
  src/core/state.ts        Store: данные + сохранение
  src/vencord/index.tsx    definePlugin, кнопка, хост, клавиатура, настройки
  src/vencord/platform.ts  Discord/Vencord-зависимости
  src/vencord/ui/observable.ts  мини-стор UI
  src/vencord/ui/uiState.ts     состояние UI + проект
  src/vencord/ui/flow.ts        конвейер вставки и диалоги
  src/vencord/ui/inline.ts      контроллер «;»
  src/vencord/ui/icons.ts       (генерируется)
  src/vencord/ui/Host.tsx, Window.tsx, Preview.tsx, Inline.tsx,
                 ComposeBar.tsx, Dialogs.tsx, ContextMenu.tsx, Settings.tsx, ProjectIcon.tsx
  src/vencord/styles.css
  tests/*.test.ts, tests/fixtures/config-0.5.1.json
```

---

### Task 1: Каркас репо, типы, разбор формата 0.5.1

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `src/core/types.ts`, `src/core/text.ts`, `src/core/importer.ts`
- Create: `tests/fixtures/config-0.5.1.json` (копия `C:\Users\oblako\Downloads\Telegram Desktop\SupportTemplates.config.json`)
- Test: `tests/importer.test.ts`, `tests/text.test.ts`

**Interfaces:**
- Produces: `Template`, `ProjectId`, `PROJECTS`, `Usage` (types.ts); `soft`, `hard`, `tokenize`, `titleKey`, `splitGreeting`, `stripMarker` (text.ts); `parseRaw(raw): Template[]`, `importBackup(text): ImportResult`, `localId(group,title)`, `projectOfGroup(group)` (importer.ts)

- [ ] **Step 1: Каркас**

`package.json`:
```json
{
  "name": "support-templates",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "icons": "node scripts/make-icons.mjs",
    "sync:vencord": "node scripts/sync-vencord.mjs"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^3.2.0"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "types": []
  },
  "include": ["src/core", "tests"]
}
```

`.gitignore`:
```
node_modules
```

Run: `pnpm install` (в `C:\Users\oblako\dev\support-templates`)
Run: `cp "C:/Users/oblako/Downloads/Telegram Desktop/SupportTemplates.config.json" tests/fixtures/config-0.5.1.json`

- [ ] **Step 2: Тесты (падают)**

`tests/text.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { hard, soft, splitGreeting, stripMarker, titleKey, tokenize } from "../src/core/text";

describe("text", () => {
    it("soft keeps length, folds ё and nbsp", () => {
        expect(soft("Ёлка\u00a0X")).toBe("елка x");
        expect(soft("Ёлка\u00a0X").length).toBe(6);
    });
    it("hard drops {placeholders} and squeezes spaces", () => {
        expect(hard("  Привет {user name}  мир ")).toBe("привет мир");
        expect(tokenize("Server  NOT")).toEqual(["server", "not"]);
    });
    it("titleKey ignores punctuation and case", () => {
        expect(titleKey("Проблемы с соединением / Server not responding"))
            .toBe(titleKey("проблемы  с соединением — server not responding!"));
    });
    it("splitGreeting uses panel marker", () => {
        const r = splitGreeting("**Привет!**\n[[greeting:end]]\nТело");
        expect(r).toEqual({ greeting: "**Привет!**", body: "Тело" });
    });
    it("splitGreeting falls back to first greeting paragraph", () => {
        const r = splitGreeting("**Приветствую! Благодарим Вас.**\n\n*Убедитесь…*\n\n1. Шаг");
        expect(r.greeting).toBe("**Приветствую! Благодарим Вас.**");
        expect(r.body).toBe("*Убедитесь…*\n\n1. Шаг");
    });
    it("splitGreeting leaves text without greeting", () => {
        expect(splitGreeting("Просто текст\n\nещё")).toEqual({ greeting: "", body: "Просто текст\n\nещё" });
    });
    it("stripMarker removes marker line like panel", () => {
        expect(stripMarker("A\n[[greeting:end]]\nB")).toBe("A\nB");
    });
});
```

`tests/importer.test.ts`:
```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { importBackup, localId, parseRaw, projectOfGroup } from "../src/core/importer";

const fixture = readFileSync(new URL("./fixtures/config-0.5.1.json", import.meta.url), "utf8");

describe("importer", () => {
    it("maps group names to projects", () => {
        expect(projectOfGroup("Majestic RP")).toBe("mj");
        expect(projectOfGroup("Россия Онлайн")).toBe("ro");
        expect(projectOfGroup("")).toBeNull();
    });
    it("parses ## project / ### title format with escaped headings", () => {
        const t = parseRaw("### Общий\nтекст\n## Majestic RP\n### Один\n\\## не заголовок\nстрока\n## Россия Онлайн\n### Два\nтело");
        expect(t.map(x => [x.project, x.title])).toEqual([[null, "Общий"], ["mj", "Один"], ["ro", "Два"]]);
        expect(t[1].text).toBe("## не заголовок\nстрока");
        expect(t[1].id).toBe(localId("Majestic RP", "Один"));
        expect(t[1].source).toBe("local");
        expect(t[1].status).toBe("actual");
    });
    it("parses JSON array format", () => {
        const t = parseRaw(JSON.stringify([{ title: "A", text: "x", group: "Majestic RP" }]));
        expect(t).toHaveLength(1);
        expect(t[0].project).toBe("mj");
    });
    it("imports the real 0.5.1 config", () => {
        const r = importBackup(fixture);
        expect(r.templates).toHaveLength(133);
        expect(r.templates.filter(t => t.project === "mj")).toHaveLength(68);
        expect(r.templates.filter(t => t.project === "ro")).toHaveLength(65);
        expect(r.favorites).toHaveLength(17);
        expect(r.favorites[0]).toBe("local:Россия Онлайн||Проблемы с соединением / Server not responding");
        expect(Object.keys(r.usage).length).toBeGreaterThan(20);
    });
    it("imports plain text and rejects garbage", () => {
        expect(importBackup("## Majestic RP\n### A\nb").templates).toHaveLength(1);
        expect(() => importBackup("ничего")).toThrow();
    });
});
```

- [ ] **Step 3: Run — FAIL**

Run: `pnpm test`
Expected: FAIL — modules `../src/core/text`, `../src/core/importer` not found.

- [ ] **Step 4: Реализация**

`src/core/types.ts`:
```ts
/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export type ProjectId = "mj" | "ro";
export type TemplateStatus = "actual" | "needs_review" | "outdated";

export interface Template {
    id: string;
    project: ProjectId | null;
    title: string;
    text: string;
    category: string | null;
    status: TemplateStatus;
    statusNote: string | null;
    teamUses: number;
    command: string | null;
    updatedAt: string | null;
    source: "local" | "faq" | "personal";
}

export interface Usage {
    n: number;
    last: number;
}

export const PROJECTS: Record<ProjectId, { name: string; short: string; guildId: string; }> = {
    mj: { name: "Majestic RP", short: "Majestic", guildId: "530693013622489088" },
    ro: { name: "Россия Онлайн", short: "Россия Онлайн", guildId: "1089530150540034181" },
};

export const otherProject = (p: ProjectId): ProjectId => (p === "mj" ? "ro" : "mj");
```

`src/core/text.ts`:
```ts
/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** Lower case, ё→е, nbsp→space. Keeps string length (needed for highlighting). */
export const soft = (s: string) => String(s ?? "").replace(/\u00a0/g, " ").toLowerCase().replace(/ё/g, "е");

/** For matching: placeholders {…} removed, whitespace squeezed. */
export const hard = (s: string) => soft(s).replace(/\{[^}]*\}/g, " ").replace(/\s+/g, " ").trim();

export const tokenize = (s: string) => hard(s).split(" ").filter(Boolean);

/** Title identity for mirror lookup: letters and digits only. */
export const titleKey = (s: string) => soft(s).replace(/[^\p{L}\p{N}]+/gu, "");

// Same marker and regex as the panel (greeting-*.js).
const MARKER = /[^\S\r\n]*\[\[greeting:end\]\][^\S\r\n]*\r?\n?/;
const GREETING_HINT = /привет|здравств|благодар/i;

export function splitGreeting(text: string): { greeting: string; body: string; } {
    const m = MARKER.exec(text);
    if (m) return { greeting: text.slice(0, m.index).trimEnd(), body: text.slice(m.index + m[0].length).trimStart() };
    // Local templates have no marker: the first paragraph is the greeting if it looks like one.
    const i = text.search(/\n[^\S\n]*\n/);
    if (i > 0) {
        const first = text.slice(0, i);
        if (first.length <= 300 && GREETING_HINT.test(first)) return { greeting: first.trimEnd(), body: text.slice(i).trimStart() };
    }
    return { greeting: "", body: text };
}

export const stripMarker = (text: string) => text.replace(MARKER, "");
```

`src/core/importer.ts`:
```ts
/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { soft } from "./text";
import { ProjectId, Template, Usage } from "./types";

export function projectOfGroup(group: string): ProjectId | null {
    const g = soft(group);
    if (/majestic|маджестик/.test(g)) return "mj";
    if (/росси|russia/.test(g)) return "ro";
    return null;
}

/** Same key as 0.5.1 ("group||title") so its usage/pins/binds carry over. */
export const localId = (group: string, title: string) => `local:${group}||${title}`;

function mk(group: string, title: string, text: string): Template {
    return {
        id: localId(group, title), project: projectOfGroup(group), title, text,
        category: null, status: "actual", statusNote: null, teamUses: 0,
        command: null, updatedAt: null, source: "local",
    };
}

export function parseRaw(raw: string): Template[] {
    const src = String(raw ?? "").replace(/\r/g, "").trim();
    if (!src) return [];

    if (src.startsWith("[")) {
        try {
            const arr = JSON.parse(src) as any[];
            return arr
                .map(x => mk(String(x.group ?? "").trim(), String(x.title ?? x.name ?? "").trim(), String(x.text ?? x.content ?? "").trim()))
                .filter(t => t.title && t.text);
        } catch { /* not JSON — parse as text */ }
    }

    const out: Template[] = [];
    let cur: { title: string; group: string; lines: string[]; } | null = null;
    let group = "";
    const flush = () => {
        if (!cur) return;
        const text = cur.lines.join("\n").trim();
        if (text) out.push(mk(cur.group, cur.title, text));
    };
    for (const rawLine of src.split("\n")) {
        const esc = /^\\#{1,6}\s/.test(rawLine);
        const line = esc ? rawLine.slice(1) : rawLine;
        const t = esc ? null : line.match(/^###\s+(.+?)\s*$/);
        const g = esc ? null : line.match(/^##\s+(.+?)\s*$/);
        if (t) { flush(); cur = { title: t[1], group, lines: [] }; }
        else if (g) { flush(); cur = null; group = g[1]; }
        else if (cur) cur.lines.push(line);
    }
    flush();
    return out;
}

export interface ImportResult {
    raw: string;
    templates: Template[];
    favorites: string[];
    usage: Record<string, Usage>;
    binds: Record<string, string>;
}

/** Accepts the 0.5.1 config/backup JSON ({raw, usage, pinned, binds}), a JSON array or plain text. */
export function importBackup(text: string): ImportResult {
    let obj: any = null;
    try { obj = JSON.parse(text); } catch { /* plain text */ }
    const isObj = obj && typeof obj === "object" && !Array.isArray(obj);
    const raw: string = isObj ? (typeof obj.raw === "string" ? obj.raw : "") : String(text);
    const templates = parseRaw(raw);
    if (!templates.length) throw new Error("Не нашёл ни одного шаблона");

    const ids = new Set(templates.map(t => t.id));
    const toId = (k: string) => "local:" + k;

    const favorites: string[] = [];
    const pinned = isObj ? obj.pinned : null;
    const pinKeys: string[] = Array.isArray(pinned) ? pinned : pinned && typeof pinned === "object" ? Object.keys(pinned).filter(k => pinned[k]) : [];
    for (const k of pinKeys) if (typeof k === "string" && ids.has(toId(k)) && !favorites.includes(toId(k))) favorites.push(toId(k));

    const usage: Record<string, Usage> = {};
    if (isObj && obj.usage && typeof obj.usage === "object") {
        for (const [k, v] of Object.entries<any>(obj.usage)) {
            const n = Math.floor(Number(v?.n));
            if (ids.has(toId(k)) && n > 0) usage[toId(k)] = { n, last: Number(v?.last) || 0 };
        }
    }

    const binds: Record<string, string> = {};
    if (isObj && obj.binds && typeof obj.binds === "object") {
        for (const [k, v] of Object.entries<any>(obj.binds)) if (ids.has(toId(k)) && typeof v === "string") binds[toId(k)] = v;
    }

    return { raw, templates, favorites, usage, binds };
}
```

- [ ] **Step 5: Run — PASS**

Run: `pnpm test && pnpm typecheck`
Expected: все тесты text/importer зелёные, tsc без ошибок.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): template model, text helpers, 0.5.1 importer"
```

---

### Task 2: Поиск (логика VKMaj.js)

**Files:**
- Create: `src/core/aliases.ts`, `src/core/search.ts`
- Test: `tests/search.test.ts`

**Interfaces:**
- Consumes: `Template` (types.ts), `soft`, `hard`, `tokenize` (text.ts), `importBackup` (tests)
- Produces: `search(pool: Template[], query: string): SearchResult`, `Hit {t: Template; level: number; line: string | null}`, `SearchResult {hits; tokens: string[]; fuzzy: boolean; layout: string | null}`, `swapLayout(q): string | null`

- [ ] **Step 1: Тест (падает)**

`tests/search.test.ts`:
```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { importBackup } from "../src/core/importer";
import { search, swapLayout } from "../src/core/search";

const all = importBackup(readFileSync(new URL("./fixtures/config-0.5.1.json", import.meta.url), "utf8")).templates;
const mj = all.filter(t => t.project === "mj");
const titles = (q: string) => search(mj, q).hits.map(h => h.t.title);

describe("search", () => {
    it("empty query returns everything at level 0", () => {
        const r = search(mj, "  ");
        expect(r.hits).toHaveLength(mj.length);
        expect(r.hits.every(h => h.level === 0)).toBe(true);
    });
    it("title words → level 4", () => {
        const r = search(mj, "соедин");
        const conn = r.hits.find(h => h.t.title === "Проблемы с соединением / Server not responding");
        expect(conn?.level).toBe(4);
    });
    it("aliases → level 3 (снр, фпс)", () => {
        const r = search(mj, "снр");
        expect(r.hits.some(h => h.level === 3 && /Server not responding/.test(h.t.title))).toBe(true);
        expect(titles("фпс").some(t => /Фризит игру/.test(t))).toBe(true);
    });
    it("body match → level 2 with best line", () => {
        const r = search(mj, "kaspersky");
        const h = r.hits.find(x => x.level === 2)!;
        expect(h).toBeTruthy();
        expect(h.line!.toLowerCase()).toContain("kaspersky");
    });
    it("fuzzy single word when nothing strict", () => {
        const r = search(mj, "соеднение");
        expect(r.fuzzy).toBe(true);
        expect(r.hits[0].level).toBe(1);
    });
    it("wrong keyboard layout", () => {
        expect(swapLayout("cjtl")).toBe("соед");
        const r = search(mj, "cjtl");
        expect(r.layout).toBe("соед");
        expect(r.hits.length).toBeGreaterThan(0);
    });
    it("exact command → level 5", () => {
        const t = { ...mj[0], command: "nv" };
        expect(search([t], "nv").hits[0].level).toBe(5);
    });
});
```

- [ ] **Step 2: Run — FAIL**

Run: `pnpm test tests/search.test.ts`
Expected: FAIL — `../src/core/search` not found.

- [ ] **Step 3: Реализация**

`src/core/aliases.ts`:
```ts
/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** key = substring of a template title (normalized), value = synonyms that also find it. From VKMaj.js. */
export const ALIASES: [string, string][] = [
    ["фризит игру", "фпс fps лаги лагает фризы тормозит просадки статтер stutter"],
    ["ошибка внедрения патча", "краш крашится вылет вылетает закрывается патч инжект"],
    ["вечный запуск", "бесконечный висит зависает не запускается патчится"],
    ["server not responding", "снр сервер не отвечает коннект подключение"],
    ["черный экран", "чёрный blackscreen пустой экран"],
    ["долгая проверка файлов", "загрузка качается медленно скачивание"],
    ["не удалось скачать ресурс", "ресурс кэш cache файл не качается"],
    ["не удаляют моды", "redux редукс замененки одежда текстуры"],
    ["reshade", "решейд енб enb коммандлайн commandline графмоды"],
    ["пропадает голосовой чат", "войс voice голос микрофон не слышно"],
    ["отсутствует миникарта", "радар карта миникарта пропала гпс"],
    ["не удалось обнаружить rgl", "рокстар rockstar лаунчер рокстара socialclub"],
    ["аккаунт social club", "сошиалклаб сц регистрация уже зарегистрирован"],
    ["выбивает чужой аккаунт", "чужой бан не мой аккаунт ip"],
    ["запускается версия стим", "steam стим steamapi"],
    ["microsoft vc", "визуал visual c++ redist драйвера msvc"],
    ["vpn", "впн обход запрет прокси proxy днс dns"],
    ["переустановка винды", "windows винда виндовс переустановить систему образ"],
    ["запрос логов", "логи log main.log клиентлог"],
    ["проблемы с донатом", "донат оплата платеж деньги чек не пришло валюта"],
    ["проблемы с аккаунтом", "2фа 2fa двухфакторка восстановление угнали взлом почта"],
    ["временная блокировка", "ограничение транзакции заморозка снятие"],
    ["разбаны амнистии жалобы", "разбан бан амнистия жалоба апелляция unban"],
    ["разбан telegram", "тг телега телеграм дискорд discord мут"],
    ["баг репорт", "баг bug багрепорт сообщить о баге"],
    ["обращение к администрации", "админ администратор репорт report жалоба на игрока"],
    ["улучшение проекта", "предложение идея фича suggestion"],
    ["вопросы по форуму", "форум forum регистрация на форуме"],
    ["вопросы по медиа", "медиа media блогер стример ютуб twitch"],
    ["купить ключ активации", "ключ key гта5 гта покупка активация rockstar"],
    ["бонус код", "бонускод бонус premium промокод"],
    ["проблемы с мерчем", "мерч merch store магазин одежда"],
    ["о проблеме известно", "известно баг чиним разработчики"],
    ["технический раздел", "техраздел форум техподдержка"],
    ["наш лаунчер", "лаунчер launcher скачать установщик"],
    ["1.500.7", "ошибка регистрации 1.000.7 rockstar reg"],
];
```

`src/core/search.ts`:
```ts
/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ALIASES } from "./aliases";
import { hard, soft, tokenize } from "./text";
import { Template } from "./types";

export interface Hit { t: Template; level: number; line: string | null; }
export interface SearchResult { hits: Hit[]; tokens: string[]; fuzzy: boolean; layout: string | null; }

const MIN_BODY = 3;  // shorter words are not searched in the body — they match everything
const MIN_FUZZY = 4;

const aliasCache = new WeakMap<Template, string>();
function aliasOf(t: Template) {
    let a = aliasCache.get(t);
    if (a === undefined) {
        const title = hard(t.title);
        a = ALIASES.filter(([k]) => title.includes(k)).map(([, v]) => v).join(" ");
        aliasCache.set(t, a);
    }
    return a;
}

/** Body line with the most token hits — shown instead of the template start. */
export function bestLine(text: string, toks: string[]): string | null {
    let best: string | null = null, bestHits = 0;
    for (const line of text.split("\n")) {
        const s = soft(line);
        const hits = toks.reduce((n, t) => n + (s.includes(t) ? 1 : 0), 0);
        if (hits > bestHits) { bestHits = hits; best = line.trim(); }
    }
    return best;
}

function strict(t: Template, toks: string[]): Hit | null {
    const all = (h: string) => toks.every(x => h.includes(x));
    if (t.command && toks.length === 1 && soft(t.command) === toks[0]) return { t, level: 5, line: null };
    const title = hard(t.title);
    if (all(title)) return { t, level: 4, line: null };
    const alias = aliasOf(t);
    if (alias && all(title + " " + alias)) return { t, level: 3, line: null };
    if (toks.every(x => x.length >= MIN_BODY) && all(hard(t.text))) return { t, level: 2, line: bestLine(t.text, toks) };
    return null;
}

/** Length of the stretch of hay holding needle as a subsequence; -1 if none. */
export function subseqSpan(needle: string, hay: string) {
    let i = 0, start = -1;
    for (let p = 0; p < hay.length; p++) {
        if (hay[p] === needle[i]) {
            if (i === 0) start = p;
            if (++i === needle.length) return p - start + 1;
        }
    }
    return -1;
}

function fuzzy(t: Template, toks: string[]): Hit | null {
    if (toks.length !== 1 || toks[0].length < MIN_FUZZY) return null;
    const span = subseqSpan(toks[0], hard(t.title));
    return span >= 0 && span <= toks[0].length * 3 ? { t, level: 1, line: null } : null;
}

const EN = "qwertyuiop[]asdfghjkl;'zxcvbnm,./`";
const RU = "йцукенгшщзхъфывапролджэячсмитьбю.ё";

/** "cjtl" → "соед" and back; null when the query mixes layouts or has no letters. */
export function swapLayout(q: string): string | null {
    const s = q.toLowerCase();
    const cyr = /[а-яё]/.test(s), lat = /[a-z]/.test(s);
    if (cyr === lat) return null;
    const [from, to] = lat ? [EN, RU] : [RU, EN];
    let out = "";
    for (const ch of s) {
        const i = from.indexOf(ch);
        out += i >= 0 ? to[i] : ch;
    }
    return out;
}

function run(pool: Template[], q: string) {
    const tokens = tokenize(q);
    if (!tokens.length) return { hits: pool.map(t => ({ t, level: 0, line: null })), tokens, fuzzy: false };
    let hits = pool.map(t => strict(t, tokens)).filter((h): h is Hit => !!h);
    let fz = false;
    if (!hits.length) {
        hits = pool.map(t => fuzzy(t, tokens)).filter((h): h is Hit => !!h);
        fz = hits.length > 0;
    }
    return { hits, tokens, fuzzy: fz };
}

export function search(pool: Template[], query: string): SearchResult {
    let r = run(pool, query);
    let layout: string | null = null;
    if (!r.hits.length && query.trim()) {
        const alt = swapLayout(query);
        if (alt) {
            const r2 = run(pool, alt);
            if (r2.hits.length) { r = r2; layout = alt.trim(); }
        }
    }
    return { ...r, layout };
}
```

- [ ] **Step 4: Run — PASS**

Run: `pnpm test && pnpm typecheck`
Expected: PASS. Если «фпс» не находит «Фризит игру» — проверить точное название в фикстуре (`grep -n "### Фризит" tests/fixtures/config-0.5.1.json`) и ключ алиаса.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): search with aliases, fuzzy and layout fallback"
```

---

### Task 3: Ранжирование, токены, склейка ответа

**Files:**
- Create: `src/core/rank.ts`, `src/core/tokens.ts`, `src/core/compose.ts`
- Test: `tests/rank.test.ts`, `tests/tokens.test.ts`, `tests/compose.test.ts`

**Interfaces:**
- Consumes: `Template`, `Usage`; `Hit`; `splitGreeting`, `stripMarker`
- Produces:
  - `RankCtx {favorites: string[]; recent: string[]; usage: Record<string, Usage>}`, `Section {key: string; title: string; items: Template[]}`, `favoritesOf(pool, ctx): Template[]`, `sections(pool, ctx): Section[]`, `orderHits(hits, ctx): Hit[]`
  - `FieldSpec {name: string; def: string; options: string[]}`, `Env {now: Date; clipboard: string; selection: string; url: string; title: string}`, `fieldsOf(text): FieldSpec[]`, `fill(text, values: Record<string,string>, env: Env): {text: string; caret: number | null}`, `fmtDate(d)`, `fmtTime(d)`
  - `joinPieces(texts: string[]): string`

- [ ] **Step 1: Тесты (падают)**

`tests/rank.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { favoritesOf, orderHits, sections } from "../src/core/rank";
import { Template } from "../src/core/types";

const T = (id: string, extra: Partial<Template> = {}): Template => ({
    id, project: "mj", title: id, text: id, category: null, status: "actual", statusNote: null,
    teamUses: 0, command: null, updatedAt: null, source: "local", ...extra,
});
const pool = ["a", "b", "c", "d", "e", "f", "g", "h"].map(id => T(id));

describe("rank", () => {
    it("favorites keep their own order and skip missing", () => {
        expect(favoritesOf(pool, { favorites: ["c", "zz", "a"], recent: [], usage: {} }).map(t => t.id)).toEqual(["c", "a"]);
    });
    it("sections: favorites, recent (max 5, no favorites), then rest by popularity", () => {
        const s = sections(pool, { favorites: ["c"], recent: ["c", "b", "d", "e", "f", "g", "h"], usage: { a: { n: 9, last: 1 } } });
        expect(s.map(x => x.key)).toEqual(["fav", "recent", "cat:"]);
        expect(s[0].items.map(t => t.id)).toEqual(["c"]);
        expect(s[1].items.map(t => t.id)).toEqual(["b", "d", "e", "f", "g"]);
        expect(s[2].items.map(t => t.id)).toEqual(["a", "h"]);
        expect(s[2].title).toBe("Все шаблоны");
    });
    it("sections group by category in first-seen order", () => {
        const p = [T("x", { category: "Навигация" }), T("y", { category: "Частые проблемы" }), T("z", { category: "Навигация" })];
        expect(sections(p, { favorites: [], recent: [], usage: {} }).map(s => s.title)).toEqual(["Навигация", "Частые проблемы"]);
    });
    it("orderHits: level first, then favorite, then usage", () => {
        const hits = [
            { t: T("a"), level: 2, line: null },
            { t: T("b"), level: 4, line: null },
            { t: T("c"), level: 4, line: null },
        ];
        const r = orderHits(hits, { favorites: ["c"], recent: [], usage: { b: { n: 50, last: 0 } } });
        expect(r.map(h => h.t.id)).toEqual(["c", "b", "a"]);
    });
});
```

`tests/tokens.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { fieldsOf, fill } from "../src/core/tokens";

const env = { now: new Date(2026, 9, 5, 19, 7), clipboard: "CLIP", selection: "Ivan_Petrov", url: "https://discord.com/x", title: "ticket-1" };

describe("tokens", () => {
    it("lists user fields once, skips built-ins", () => {
        const f = fieldsOf("{{ник}} {{сервер|NY|Detroit}} {{ник}} {{date+3d}} {{clipboard}} {{срок=2 дня}}");
        expect(f).toEqual([
            { name: "ник", def: "", options: [] },
            { name: "сервер", def: "", options: ["NY", "Detroit"] },
            { name: "срок", def: "2 дня", options: [] },
        ]);
    });
    it("fills built-ins with date/time offsets", () => {
        expect(fill("{{date}} {{time}} {{date+3d}} {{time-30m}} {{date+1w}}", {}, env).text)
            .toBe("05.10.2026 19:07 08.10.2026 18:37 12.10.2026");
        expect(fill("{{clipboard}}|{{selection}}|{{url}}|{{title}}", {}, env).text)
            .toBe("CLIP|Ivan_Petrov|https://discord.com/x|ticket-1");
    });
    it("fills fields: value, default, first option", () => {
        expect(fill("{{a}}/{{b=деф}}/{{c|x|y}}", { a: "1" }, env).text).toBe("1/деф/x");
    });
    it("caret marker is removed and its position returned", () => {
        expect(fill("ab{|}cd", {}, env)).toEqual({ text: "abcd", caret: 2 });
        expect(fill("abcd", {}, env).caret).toBeNull();
    });
});
```

`tests/compose.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { joinPieces } from "../src/core/compose";

describe("compose", () => {
    it("keeps greeting only in the first piece", () => {
        const a = "**Приветствую!**\n\nПервый";
        const b = "**Приветствую!**\n\nВторой";
        expect(joinPieces([a, b])).toBe("**Приветствую!**\n\nПервый\n\nВторой");
    });
    it("strips panel markers", () => {
        expect(joinPieces(["Привет\n[[greeting:end]]\nA", "Привет\n[[greeting:end]]\nB"])).toBe("Привет\nA\n\nB");
    });
});
```

- [ ] **Step 2: Run — FAIL**

Run: `pnpm test`
Expected: FAIL — rank/tokens/compose modules not found.

- [ ] **Step 3: Реализация**

`src/core/rank.ts`:
```ts
/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Hit } from "./search";
import { Template, Usage } from "./types";

export interface RankCtx { favorites: string[]; recent: string[]; usage: Record<string, Usage>; }
export interface Section { key: string; title: string; items: Template[]; }

export function favoritesOf(pool: Template[], ctx: RankCtx): Template[] {
    const byId = new Map(pool.map(t => [t.id, t]));
    return ctx.favorites.map(id => byId.get(id)).filter((t): t is Template => !!t);
}

/** Personal frequency dominates, team usage breaks ties. */
export function popularity(t: Template, ctx: RankCtx) {
    const n = ctx.usage[t.id]?.n ?? 0;
    return Math.log2(1 + Math.min(n, 100)) * 8 + Math.min(6, Math.log2(1 + t.teamUses));
}

export function sections(pool: Template[], ctx: RankCtx): Section[] {
    const fav = favoritesOf(pool, ctx);
    const favIds = new Set(fav.map(t => t.id));
    const byId = new Map(pool.map(t => [t.id, t]));
    const recent = ctx.recent
        .map(id => byId.get(id))
        .filter((t): t is Template => !!t && !favIds.has(t.id))
        .slice(0, 5);
    const used = new Set([...fav, ...recent].map(t => t.id));
    const order = new Map(pool.map((t, i) => [t.id, i]));
    const rest = pool
        .filter(t => !used.has(t.id))
        .sort((a, b) => popularity(b, ctx) - popularity(a, ctx) || order.get(a.id)! - order.get(b.id)!);

    const cats: Section[] = [];
    const byCat = new Map<string, Section>();
    for (const t of pool) {
        const c = t.category ?? "";
        if (!byCat.has(c)) {
            const s = { key: "cat:" + c, title: c || "Все шаблоны", items: [] as Template[] };
            byCat.set(c, s);
            cats.push(s);
        }
    }
    for (const t of rest) byCat.get(t.category ?? "")!.items.push(t);

    return [
        { key: "fav", title: "★ Избранное", items: fav },
        { key: "recent", title: "Недавние", items: recent },
        ...cats,
    ].filter(s => s.items.length);
}

export function orderHits(hits: Hit[], ctx: RankCtx): Hit[] {
    const fav = new Set(ctx.favorites);
    return [...hits].sort((a, b) =>
        b.level - a.level
        || Number(fav.has(b.t.id)) - Number(fav.has(a.t.id))
        || popularity(b.t, ctx) - popularity(a.t, ctx));
}
```

`src/core/tokens.ts`:
```ts
/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Same token grammar as the panel's Templates page: {{name}}, {{name=default}}, {{name|a|b}}, {|}.
const TOKEN = /\{\{\s*([^}|=]+?)\s*(?:=\s*([^}|]*?)\s*)?(\|[^}]*)?\s*\}\}/g;
const DATE_TIME = /^(date|time)(?:([+-])(\d+)([mhdw]))?$/i;
const BUILTIN = new Set(["clipboard", "selection", "url", "title"]);
const UNIT_MS: Record<string, number> = { m: 6e4, h: 36e5, d: 864e5, w: 6048e5 };

export interface FieldSpec { name: string; def: string; options: string[]; }
export interface Env { now: Date; clipboard: string; selection: string; url: string; title: string; }

const isBuiltin = (name: string) => DATE_TIME.test(name) || BUILTIN.has(name.toLowerCase());
const pad = (n: number) => String(n).padStart(2, "0");
export const fmtDate = (d: Date) => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
export const fmtTime = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

export function fieldsOf(text: string): FieldSpec[] {
    const out: FieldSpec[] = [];
    for (const m of text.matchAll(TOKEN)) {
        const name = m[1].trim();
        if (isBuiltin(name) || out.some(f => f.name === name)) continue;
        out.push({
            name,
            def: (m[2] ?? "").trim(),
            options: m[3] ? m[3].slice(1).split("|").map(s => s.trim()).filter(Boolean) : [],
        });
    }
    return out;
}

export function fill(text: string, values: Record<string, string>, env: Env): { text: string; caret: number | null; } {
    let out = text.replace(TOKEN, (_all, rawName: string, def: string | undefined, opts: string | undefined) => {
        const name = rawName.trim();
        const dt = DATE_TIME.exec(name);
        if (dt) {
            const shift = dt[2] ? (dt[2] === "-" ? -1 : 1) * Number(dt[3]) * UNIT_MS[dt[4].toLowerCase()] : 0;
            const d = new Date(env.now.getTime() + shift);
            return dt[1].toLowerCase() === "date" ? fmtDate(d) : fmtTime(d);
        }
        const key = name.toLowerCase();
        if (BUILTIN.has(key)) return env[key as "clipboard" | "selection" | "url" | "title"];
        if (values[name] !== undefined) return values[name];
        if (def) return def.trim();
        if (opts) return opts.slice(1).split("|").map(s => s.trim()).filter(Boolean)[0] ?? "";
        return "";
    });
    const i = out.indexOf("{|}");
    out = out.replace(/\{\|\}/g, "");
    return { text: out, caret: i >= 0 ? i : null };
}
```

`src/core/compose.ts`:
```ts
/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { splitGreeting, stripMarker } from "./text";

/** Greeting stays only in the first piece; pieces are separated by a blank line. */
export function joinPieces(texts: string[]): string {
    return texts
        .map((t, i) => (i === 0 ? stripMarker(t) : splitGreeting(t).body))
        .map(s => s.trim())
        .filter(Boolean)
        .join("\n\n");
}
```

- [ ] **Step 4: Run — PASS**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): ranking sections, panel tokens, answer composition"
```

---

### Task 4: Защита проекта, триггер «;», клавиши

**Files:**
- Create: `src/core/guard.ts`, `src/core/trigger.ts`, `src/core/keys.ts`
- Test: `tests/guard.test.ts`, `tests/trigger.test.ts`, `tests/keys.test.ts`

**Interfaces:**
- Consumes: `Template`, `ProjectId`, `PROJECTS`, `otherProject`; `soft`, `titleKey`
- Produces:
  - `ServerBinding = ProjectId | "none"`, `DEFAULT_GUILDS`, `DM_KEY = "@dm"`, `projectForGuild(guildId: string | null, saved: Record<string, ServerBinding>): ServerBinding | null`, `findMirror(t, pool, project): Template | null`, `Decision = {kind:"ok";t} | {kind:"mirror";t;from} | {kind:"foreign";t}`, `decide(t, project: ProjectId, pool): Decision`, `foreignMarkers(text, project): string[]`
  - `findTrigger(before: string, prefix: string): {query: string; length: number} | null`, `PREFIXES = [";", ".", ",", "!"]`
  - `KeyLike`, `comboOf(e: KeyLike): string | null`, `bindProblem(combo): string`, `comboLabel(combo): string`

- [ ] **Step 1: Тесты (падают)**

`tests/guard.test.ts`:
```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decide, findMirror, foreignMarkers, projectForGuild } from "../src/core/guard";
import { importBackup } from "../src/core/importer";

const all = importBackup(readFileSync(new URL("./fixtures/config-0.5.1.json", import.meta.url), "utf8")).templates;
const roConn = all.find(t => t.project === "ro" && /Проблемы с соединением/.test(t.title))!;

describe("guard", () => {
    it("knows both project servers; saved bindings for others; null when unknown", () => {
        expect(projectForGuild("530693013622489088", {})).toBe("mj");
        expect(projectForGuild("1089530150540034181", {})).toBe("ro");
        expect(projectForGuild("42", { "42": "none" })).toBe("none");
        expect(projectForGuild("43", {})).toBeNull();
        expect(projectForGuild(null, { "@dm": "mj" })).toBe("mj");
    });
    it("finds the mirror template of the other project", () => {
        const m = findMirror(roConn, all, "mj")!;
        expect(m.project).toBe("mj");
        expect(m.title).toBe(roConn.title);
    });
    it("most RO templates have a Majestic mirror", () => {
        const ro = all.filter(t => t.project === "ro");
        const mirrored = ro.filter(t => findMirror(t, all, "mj"));
        expect(mirrored.length / ro.length).toBeGreaterThan(0.8);
    });
    it("decide: ok for own and common, mirror for other project, foreign when no pair", () => {
        expect(decide(roConn, "ro", all).kind).toBe("ok");
        const d = decide(roConn, "mj", all);
        expect(d.kind).toBe("mirror");
        const lonely = { ...roConn, id: "x", title: "Только в РО уникальное" };
        expect(decide(lonely, "mj", [...all, lonely]).kind).toBe("foreign");
        expect(decide({ ...roConn, project: null }, "mj", all).kind).toBe("ok");
    });
    it("spots the other project's markers in text", () => {
        expect(foreignMarkers("Зайдите на forum.russia.online", "mj")).toEqual(["russia.online"]);
        expect(foreignMarkers("Сайт majestic-rp.ru", "ro")).toEqual(["majestic-rp.ru"]);
        expect(foreignMarkers("Обычный текст", "mj")).toEqual([]);
    });
});
```

`tests/trigger.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { findTrigger } from "../src/core/trigger";

describe("trigger", () => {
    it("finds ;word at line start or after space", () => {
        expect(findTrigger(";снр", ";")).toEqual({ query: "снр", length: 4 });
        expect(findTrigger("текст ;лог", ";")).toEqual({ query: "лог", length: 4 });
    });
    it("ignores mid-word, bare prefix and spaces after", () => {
        expect(findTrigger("abc;снр", ";")).toBeNull();
        expect(findTrigger(";", ";")).toBeNull();
        expect(findTrigger(";снр ", ";")).toBeNull();
    });
    it("ignores Slate zero-width chars and supports other prefixes", () => {
        expect(findTrigger("\uFEFF.тех", ".")).toEqual({ query: "тех", length: 4 });
    });
});
```

`tests/keys.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { bindProblem, comboLabel, comboOf } from "../src/core/keys";

const ev = (code: string, m: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean; }> = {}) =>
    ({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...m });

describe("keys", () => {
    it("builds layout-independent combos", () => {
        expect(comboOf(ev("KeyF", { ctrlKey: true, altKey: true }))).toBe("Ctrl+Alt+KeyF");
        expect(comboOf(ev("ShiftLeft", { shiftKey: true }))).toBeNull();
    });
    it("rejects reserved and modifier-less combos", () => {
        expect(bindProblem("Ctrl+KeyC")).not.toBe("");
        expect(bindProblem("Ctrl+Alt+KeyT")).not.toBe("");
        expect(bindProblem("Alt+Digit3")).not.toBe("");
        expect(bindProblem("KeyF")).not.toBe("");
        expect(bindProblem("Shift+KeyF")).not.toBe("");
        expect(bindProblem("F8")).toBe("");
        expect(bindProblem("Ctrl+Alt+KeyF")).toBe("");
    });
    it("labels combos", () => {
        expect(comboLabel("Ctrl+Alt+KeyF")).toBe("Ctrl+Alt+F");
        expect(comboLabel("Alt+Digit1")).toBe("Alt+1");
    });
});
```

- [ ] **Step 2: Run — FAIL**

Run: `pnpm test`
Expected: FAIL — guard/trigger/keys modules not found.

- [ ] **Step 3: Реализация**

`src/core/guard.ts`:
```ts
/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { soft, titleKey } from "./text";
import { otherProject, ProjectId, PROJECTS, Template } from "./types";

export type ServerBinding = ProjectId | "none";

export const DEFAULT_GUILDS: Record<string, ProjectId> = {
    [PROJECTS.mj.guildId]: "mj",
    [PROJECTS.ro.guildId]: "ro",
};

/** Key under which the answer for DMs / group DMs is remembered. */
export const DM_KEY = "@dm";

/** Project of a server: built-in table first, then the user's answer. null = never asked. */
export function projectForGuild(guildId: string | null, saved: Record<string, ServerBinding>): ServerBinding | null {
    if (!guildId) return saved[DM_KEY] ?? null;
    return DEFAULT_GUILDS[guildId] ?? saved[guildId] ?? null;
}

export function findMirror(t: Template, pool: Template[], project: ProjectId): Template | null {
    if (!t.project || t.project === project) return null;
    const k = titleKey(t.title);
    return pool.find(x => x.project === project && titleKey(x.title) === k) ?? null;
}

export type Decision =
    | { kind: "ok"; t: Template; }
    | { kind: "mirror"; t: Template; from: Template; }
    | { kind: "foreign"; t: Template; };

/** What to insert when template t is picked in a channel of `project`. */
export function decide(t: Template, project: ProjectId, pool: Template[]): Decision {
    if (!t.project || t.project === project) return { kind: "ok", t };
    const m = findMirror(t, pool, project);
    return m ? { kind: "mirror", t: m, from: t } : { kind: "foreign", t };
}

const MARKERS: Record<ProjectId, string[]> = {
    mj: ["majestic-rp.ru", "gta5majestic.com", "majestic rp", "маджестик"],
    ro: ["russia.online", "россия онлайн", "russia online"],
};

/** Markers of the *other* project found in a template that has no project of its own. */
export function foreignMarkers(text: string, project: ProjectId): string[] {
    const s = soft(text);
    return MARKERS[otherProject(project)].filter(m => s.includes(m))
        .filter((m, _i, arr) => !arr.some(o => o !== m && o.includes(m)));
}
```

`src/core/trigger.ts`:
```ts
/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const PREFIXES = [";", ".", ",", "!"] as const;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "…text ;снр" before the caret → { query: "снр", length: 4 } (length includes the prefix). */
export function findTrigger(before: string, prefix: string): { query: string; length: number; } | null {
    const s = before.replace(/\uFEFF/g, "");
    const p = esc(prefix);
    const m = new RegExp(`(?:^|\\s)${p}([^\\s${p}]{1,40})$`, "u").exec(s);
    return m ? { query: m[1], length: m[1].length + prefix.length } : null;
}
```

`src/core/keys.ts`:
```ts
/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface KeyLike { code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean; }

const MODIFIER_CODES = ["ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight"];
const RESERVED = [
    "Ctrl+KeyC", "Ctrl+KeyV", "Ctrl+KeyX", "Ctrl+KeyA", "Ctrl+KeyZ", "Ctrl+KeyY",
    "Meta+KeyC", "Meta+KeyV", "Meta+KeyX", "Meta+KeyA", "Meta+KeyZ", "Meta+KeyY",
    "Ctrl+Alt+KeyT", "Ctrl+KeyD", "Ctrl+KeyN",
];

/** Physical key (e.code) based, so it does not depend on the keyboard layout. */
export function comboOf(e: KeyLike): string | null {
    if (!e.code || MODIFIER_CODES.includes(e.code)) return null;
    const mods: string[] = [];
    if (e.ctrlKey) mods.push("Ctrl");
    if (e.altKey) mods.push("Alt");
    if (e.shiftKey) mods.push("Shift");
    if (e.metaKey) mods.push("Meta");
    return [...mods, e.code].join("+");
}

/** "" when the combo can be assigned, otherwise the reason. */
export function bindProblem(combo: string): string {
    const parts = combo.split("+");
    const code = parts.pop()!;
    const isF = /^F([1-9]|1\d|2[0-4])$/.test(code);
    if (!code || MODIFIER_CODES.includes(code) || code === "Escape") return "Эту клавишу назначить нельзя";
    if (!isF && !parts.some(m => m !== "Shift")) return "Нужен Ctrl, Alt или Win вместе с клавишей";
    if (RESERVED.includes(combo)) return "Это сочетание занято";
    if (parts.join("+") === "Alt" && /^Digit[1-9]$/.test(code)) return "Alt+1…9 — избранное";
    return "";
}

export function comboLabel(combo: string): string {
    const parts = combo.split("+");
    const code = parts.pop()!;
    const label = /^Key([A-Z])$/.exec(code)?.[1] ?? /^Digit(\d)$/.exec(code)?.[1] ?? /^Numpad(\d)$/.exec(code)?.[1]?.replace(/^/, "Num") ?? code;
    return [...parts.map(m => (m === "Meta" ? "Win" : m)), label].join("+");
}
```

- [ ] **Step 4: Run — PASS**

Run: `pnpm test && pnpm typecheck`
Expected: PASS. Если доля зеркал ≤ 0.8 — вывести незеркальные (`ro.filter(t => !findMirror(...)).map(t => t.title)`), убедиться, что это реально уникальные шаблоны РО, и опустить порог до фактического значения минус запас.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): project guard, ;trigger detection, key combos"
```

---

### Task 5: Store — данные плагина и их сохранение

**Files:**
- Create: `src/core/state.ts`
- Test: `tests/state.test.ts`

**Interfaces:**
- Consumes: `importBackup`, `parseRaw`, `RankCtx`, `ServerBinding`, `bindProblem`, `PREFIXES`, `Template`, `Usage`
- Produces: `StorageLike {get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void>}`, `Persisted`, `STORE_KEY = "SupportTemplates_v2"`, `LEGACY_KEY = "SupportTemplates_data"`, `class Store` with: `data: Persisted`, `templates: Template[]`, `subscribe(fn): () => void`, `load(): Promise<void>`, `importText(text): string`, `byId(id)`, `ctx(): RankCtx`, `isFavorite(id)`, `toggleFavorite(id)`, `markUsed(id)`, `bindFor(id)`, `templateForCombo(combo)`, `setBind(id, combo): string | null`, `clearBind(id)`, `setGuild(key, b)`, `clearGuilds()`, `isIntentional(id)`, `markIntentional(id)`, `setPrefix(p)`, `setPreviewOpen(b)`

- [ ] **Step 1: Тест (падает)**

`tests/state.test.ts`:
```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LEGACY_KEY, Store, STORE_KEY } from "../src/core/state";

const fixture = readFileSync(new URL("./fixtures/config-0.5.1.json", import.meta.url), "utf8");
const mem = (init: Record<string, unknown> = {}) => {
    const m = new Map(Object.entries(init));
    return { m, get: async (k: string) => m.get(k), set: async (k: string, v: unknown) => { m.set(k, structuredClone(v)); } };
};

describe("Store", () => {
    it("imports the 0.5.1 config and persists", async () => {
        const st = mem();
        const s = new Store(st);
        await s.load();
        expect(s.templates).toHaveLength(0);
        const msg = s.importText(fixture);
        expect(msg).toContain("133");
        expect(s.templates).toHaveLength(133);
        expect(s.data.favorites).toHaveLength(17);
        await Promise.resolve();
        const s2 = new Store(st);
        await s2.load();
        expect(s2.templates).toHaveLength(133);
    });
    it("migrates the spike's DataStore key", async () => {
        const legacy = JSON.parse(fixture);
        const s = new Store(mem({ [LEGACY_KEY]: { raw: legacy.raw, usage: legacy.usage, pinned: legacy.pinned, tabs: {} } }));
        await s.load();
        expect(s.templates).toHaveLength(133);
        expect(s.data.favorites).toHaveLength(17);
    });
    it("favorites, recent and usage", async () => {
        const s = new Store(mem());
        await s.load();
        s.importText("## Majestic RP\n### A\na\n### B\nb");
        const [a, b] = s.templates;
        s.toggleFavorite(b.id);
        expect(s.isFavorite(b.id)).toBe(true);
        s.markUsed(a.id); s.markUsed(b.id); s.markUsed(a.id);
        expect(s.data.recent).toEqual([a.id, b.id]);
        expect(s.data.usage[a.id].n).toBe(2);
        expect(s.ctx().favorites).toEqual([b.id]);
    });
    it("binds: validated, unique, stolen from previous owner", async () => {
        const s = new Store(mem());
        await s.load();
        s.importText("## Majestic RP\n### A\na\n### B\nb");
        const [a, b] = s.templates;
        expect(() => s.setBind(a.id, "Ctrl+KeyC")).toThrow();
        expect(s.setBind(a.id, "Ctrl+Alt+KeyF")).toBeNull();
        expect(s.templateForCombo("Ctrl+Alt+KeyF")?.id).toBe(a.id);
        expect(s.setBind(b.id, "Ctrl+Alt+KeyF")).toBe(a.id);
        expect(s.bindFor(a.id)).toBeUndefined();
        s.clearBind(b.id);
        expect(s.templateForCombo("Ctrl+Alt+KeyF")).toBeUndefined();
    });
    it("server bindings, intentional marks, prefix", async () => {
        const s = new Store(mem());
        await s.load();
        s.setGuild("42", "none");
        expect(s.data.guilds["42"]).toBe("none");
        s.clearGuilds();
        expect(s.data.guilds).toEqual({});
        s.markIntentional("x");
        expect(s.isIntentional("x")).toBe(true);
        s.setPrefix(".");
        expect(s.data.prefix).toBe(".");
        expect(() => s.setPrefix("/")).toThrow();
    });
    it("notifies subscribers", async () => {
        const s = new Store(mem());
        await s.load();
        let n = 0;
        const off = s.subscribe(() => n++);
        s.setPreviewOpen(true);
        off();
        s.setPreviewOpen(false);
        expect(n).toBe(1);
        expect(STORE_KEY).toBe("SupportTemplates_v2");
    });
});
```

- [ ] **Step 2: Run — FAIL**

Run: `pnpm test tests/state.test.ts`
Expected: FAIL — `../src/core/state` not found.

- [ ] **Step 3: Реализация**

`src/core/state.ts`:
```ts
/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ServerBinding } from "./guard";
import { importBackup, parseRaw } from "./importer";
import { bindProblem } from "./keys";
import { RankCtx } from "./rank";
import { PREFIXES } from "./trigger";
import { Template, Usage } from "./types";

export interface StorageLike {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
}

export interface Persisted {
    v: 2;
    raw: string;
    favorites: string[];
    recent: string[];
    usage: Record<string, Usage>;
    binds: Record<string, string>;
    guilds: Record<string, ServerBinding>;
    intentional: string[];
    prefix: string;
    previewOpen: boolean;
}

export const STORE_KEY = "SupportTemplates_v2";
/** Key used by the Vencord spike (raw/usage/pinned/tabs). */
export const LEGACY_KEY = "SupportTemplates_data";

const empty = (): Persisted => ({
    v: 2, raw: "", favorites: [], recent: [], usage: {}, binds: {}, guilds: {}, intentional: [], prefix: ";", previewOpen: false,
});

export class Store {
    data: Persisted = empty();
    templates: Template[] = [];
    private subs = new Set<() => void>();

    constructor(private storage: StorageLike) { }

    subscribe(fn: () => void) {
        this.subs.add(fn);
        return () => void this.subs.delete(fn);
    }

    private changed() {
        void this.storage.set(STORE_KEY, this.data);
        this.subs.forEach(fn => fn());
    }

    async load() {
        const saved = await this.storage.get(STORE_KEY) as Persisted | undefined;
        if (saved && saved.v === 2) {
            this.data = { ...empty(), ...saved };
            this.templates = parseRaw(this.data.raw);
        } else {
            const legacy = await this.storage.get(LEGACY_KEY) as { raw?: string; } | undefined;
            if (legacy && typeof legacy.raw === "string" && legacy.raw.trim()) {
                try { this.importText(JSON.stringify(legacy)); return; } catch { /* broken legacy data — start empty */ }
            }
        }
        this.subs.forEach(fn => fn());
    }

    /** Replaces templates; favorites/usage/binds come from the file. Returns a summary line. */
    importText(text: string): string {
        const r = importBackup(text);
        this.data = { ...this.data, raw: r.raw, favorites: r.favorites, usage: r.usage, binds: r.binds, recent: [] };
        this.templates = r.templates;
        this.changed();
        const mj = r.templates.filter(t => t.project === "mj").length;
        const ro = r.templates.filter(t => t.project === "ro").length;
        return `Шаблонов: ${r.templates.length} (Majestic ${mj}, Россия Онлайн ${ro}), избранных: ${r.favorites.length}`;
    }

    byId(id: string) {
        return this.templates.find(t => t.id === id);
    }

    ctx(): RankCtx {
        return { favorites: this.data.favorites, recent: this.data.recent, usage: this.data.usage };
    }

    isFavorite(id: string) {
        return this.data.favorites.includes(id);
    }

    toggleFavorite(id: string) {
        const f = this.data.favorites;
        this.data.favorites = f.includes(id) ? f.filter(x => x !== id) : [...f, id];
        this.changed();
    }

    markUsed(id: string) {
        const u = this.data.usage[id] ?? { n: 0, last: 0 };
        this.data.usage = { ...this.data.usage, [id]: { n: u.n + 1, last: Date.now() } };
        this.data.recent = [id, ...this.data.recent.filter(x => x !== id)].slice(0, 20);
        this.changed();
    }

    bindFor(id: string): string | undefined {
        return this.data.binds[id];
    }

    templateForCombo(combo: string) {
        const id = Object.keys(this.data.binds).find(k => this.data.binds[k] === combo);
        return id ? this.byId(id) : undefined;
    }

    /** Throws on a forbidden combo; returns the id the combo was taken from, if any. */
    setBind(id: string, combo: string): string | null {
        const problem = bindProblem(combo);
        if (problem) throw new Error(problem);
        let stolen: string | null = null;
        const binds = { ...this.data.binds };
        for (const k of Object.keys(binds)) if (k !== id && binds[k] === combo) { stolen = k; delete binds[k]; }
        binds[id] = combo;
        this.data.binds = binds;
        this.changed();
        return stolen;
    }

    clearBind(id: string) {
        const binds = { ...this.data.binds };
        delete binds[id];
        this.data.binds = binds;
        this.changed();
    }

    setGuild(key: string, b: ServerBinding) {
        this.data.guilds = { ...this.data.guilds, [key]: b };
        this.changed();
    }

    clearGuilds() {
        this.data.guilds = {};
        this.changed();
    }

    isIntentional(id: string) {
        return this.data.intentional.includes(id);
    }

    markIntentional(id: string) {
        if (!this.isIntentional(id)) this.data.intentional = [...this.data.intentional, id];
        this.changed();
    }

    setPrefix(p: string) {
        if (!(PREFIXES as readonly string[]).includes(p)) throw new Error("Префикс: ; . , или !");
        this.data.prefix = p;
        this.changed();
    }

    setPreviewOpen(b: boolean) {
        this.data.previewOpen = b;
        this.changed();
    }
}
```

- [ ] **Step 4: Run — PASS**

Run: `pnpm test && pnpm typecheck`
Expected: PASS (все тесты ядра).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): Store with persistence, legacy migration, binds"
```

---

### Task 6: Vencord-каркас: синк, иконки, платформа, кнопка, пустое окно

Цель задачи — проводка: плагин собирается в Vencord, кнопка в строке ввода открывает и закрывает пустое окно, Ctrl+Alt+T работает, импорт в настройках грузит конфиг. Спайк заменяется.

**Files:**
- Create: `scripts/sync-vencord.mjs`, `scripts/make-icons.mjs`, `src/vencord/index.tsx`, `src/vencord/platform.ts`, `src/vencord/ui/observable.ts`, `src/vencord/ui/uiState.ts`, `src/vencord/ui/ProjectIcon.tsx`, `src/vencord/ui/Settings.tsx`, `src/vencord/ui/Host.tsx`, `src/vencord/styles.css`
- Generated: `src/vencord/ui/icons.ts`

**Interfaces:**
- Consumes: `Store`, `StorageLike`, `projectForGuild`, `DM_KEY`, `ProjectId`, `PROJECTS`
- Produces (для задач 7–10):
  - platform.ts: `storage: StorageLike`, `insertText(text: string): void`, `currentGuildId(): string | null`, `currentChannel(): {id: string | null; name: string; guildId: string | null}`, `onChannelChange(fn): () => void`, `toast(msg, type?: "message" | "success" | "failure")`, `activeEditor(): HTMLElement | null`, `chatAreaRect(): DOMRect | null`, `readClipboard(): Promise<string>`
  - observable.ts: `createObservable<T>(initial): { get(): T; set(patch: Partial<T>): void; use(): T; subscribe(fn): () => void }`
  - uiState.ts: `store: Store`, `ui` (observable of `UiState`), `UiState`, `Dialog` union, `activeProject(): {project: ProjectId | null; binding: ServerBinding | null}`, `poolFor(project): Template[]`, `useStore(): number`
  - ProjectIcon.tsx: `ProjectIcon({project, size})`

- [ ] **Step 1: Скрипт иконок**

`scripts/make-icons.mjs` — рендерит логотип РО в PNG через headless Chrome и пишет оба PNG как data URI:
```js
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const tmp = mkdtempSync(join(tmpdir(), "stx-icons-"));

const svg = readFileSync(join(root, "assets/ro-logo.svg"), "utf8");
const html = join(tmp, "ro.html");
writeFileSync(html, `<!doctype html><html><body style="margin:0;background:transparent">
<div style="width:128px;height:128px;display:flex;align-items:center;justify-content:center">
<div style="width:116px">${svg.replace("<svg ", '<svg width="116" ')}</div></div></body></html>`);
const roPng = join(tmp, "ro.png");
execFileSync(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--default-background-color=00000000",
    `--user-data-dir=${join(tmp, "profile")}`, "--window-size=128,128", `--screenshot=${roPng}`, pathToFileURL(html).href]);

const uri = p => "data:image/png;base64," + readFileSync(p).toString("base64");
const header = "/*\n * Vencord, a Discord client mod\n * Copyright (c) 2026 Vendicated and contributors\n * SPDX-License-Identifier: GPL-3.0-or-later\n */\n\n";
writeFileSync(join(root, "src/vencord/ui/icons.ts"), header +
    "// Generated by scripts/make-icons.mjs from assets/. Do not edit.\n" +
    `export const MJ_ICON = ${JSON.stringify(uri(join(root, "assets/mj.png")))};\n` +
    `export const RO_ICON = ${JSON.stringify(uri(roPng))};\n`);
console.log("icons.ts written");
```

Run: `mkdir -p src/vencord/ui && pnpm icons`
Expected: `icons.ts written`; файл ~40–60 KB.

- [ ] **Step 2: Скрипт синка**

`scripts/sync-vencord.mjs`:
```js
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vencord = process.env.VENCORD_DIR ?? "C:/Users/oblako/dev/Vencord";
const dest = join(vencord, "src/userplugins/supportTemplates");
if (!existsSync(join(vencord, "package.json"))) throw new Error("Vencord not found at " + vencord);

// Plugin root = src/vencord (index.tsx at the top), core goes to ./core next to it.
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(join(root, "src/vencord"), dest, { recursive: true });
cpSync(join(root, "src/core"), join(dest, "core"), { recursive: true });
console.log("synced →", dest);
```

- [ ] **Step 3: Платформа и состояние UI**

`src/vencord/platform.ts`:
```ts
/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { insertTextIntoChatInputBox } from "@utils/discord";
import { ChannelStore, FluxDispatcher, SelectedChannelStore, SelectedGuildStore, showToast } from "@webpack/common";

import { StorageLike } from "./core/state";

export const storage: StorageLike = {
    get: key => DataStore.get(key),
    set: (key, value) => DataStore.set(key, value),
};

/** One INSERT_TEXT into the focused chat box. Never sends. */
export function insertText(text: string) {
    insertTextIntoChatInputBox(text);
}

export const currentGuildId = (): string | null => SelectedGuildStore.getGuildId() ?? null;

export function currentChannel() {
    const id = SelectedChannelStore.getChannelId() ?? null;
    const ch = id ? ChannelStore.getChannel(id) : null;
    return { id, name: ch?.name ?? "", guildId: ch?.guild_id ?? null };
}

export function onChannelChange(fn: () => void) {
    const h = () => fn();
    FluxDispatcher.subscribe("CHANNEL_SELECT", h);
    return () => FluxDispatcher.unsubscribe("CHANNEL_SELECT", h);
}

export function toast(msg: string, type: "message" | "success" | "failure" = "message") {
    showToast(msg, type);
}

/** The Slate editor that has focus, else the main chat editor. */
export function activeEditor(): HTMLElement | null {
    const focused = document.activeElement?.closest?.('[data-slate-editor="true"]') as HTMLElement | null;
    return focused ?? document.querySelector('main [role="textbox"][data-slate-editor="true"], [role="textbox"][data-slate-editor="true"]');
}

export function chatAreaRect(): DOMRect | null {
    const el = document.querySelector('[class*="channelTextArea"]');
    return el ? el.getBoundingClientRect() : null;
}

export async function readClipboard(): Promise<string> {
    try { return await navigator.clipboard.readText(); } catch { return ""; }
}
```

`src/vencord/ui/observable.ts`:
```ts
/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useEffect, useState } from "@webpack/common";

export function createObservable<T extends object>(initial: T) {
    let value = initial;
    const subs = new Set<() => void>();
    const subscribe = (fn: () => void) => {
        subs.add(fn);
        return () => void subs.delete(fn);
    };
    return {
        get: () => value,
        set(patch: Partial<T>) {
            value = { ...value, ...patch };
            subs.forEach(fn => fn());
        },
        subscribe,
        use(): T {
            const [, force] = useState(0);
            useEffect(() => subscribe(() => force(x => x + 1)), []);
            return value;
        },
    };
}
```

`src/vencord/ui/uiState.ts`:
```ts
/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useEffect, useState } from "@webpack/common";

import { DM_KEY, projectForGuild, ServerBinding } from "../core/guard";
import { Store } from "../core/state";
import { FieldSpec } from "../core/tokens";
import { ProjectId, Template } from "../core/types";
import { currentGuildId, storage } from "../platform";
import { createObservable } from "./observable";

export const store = new Store(storage);

export type Dialog =
    | { kind: "askProject"; resolve(v: ServerBinding | null): void; }
    | { kind: "confirm"; tone: "danger" | "warn"; label: string; title: string; body: string; ok: string; checkbox?: string; resolve(v: { ok: boolean; checked: boolean; }): void; }
    | { kind: "fields"; title: string; fields: FieldSpec[]; initial: Record<string, string>; resolve(v: Record<string, string> | null): void; }
    | { kind: "bind"; templateId: string; };

export interface InlineState { query: string; length: number; items: Template[]; sel: number; note: string; }

export interface UiState {
    windowOpen: boolean;
    dialog: Dialog | null;
    compose: string[];
    inline: InlineState | null;
    /** Project picked in the window on a server bound to "none". */
    sessionProject: ProjectId | null;
    menu: { x: number; y: number; id: string; } | null;
    /** Selected message text captured when the window/trigger opened. */
    selection: string;
}

export const ui = createObservable<UiState>({
    windowOpen: false, dialog: null, compose: [], inline: null, sessionProject: null, menu: null, selection: "",
});

export const guildKey = () => currentGuildId() ?? DM_KEY;

export function activeProject(): { project: ProjectId | null; binding: ServerBinding | null; } {
    const binding = projectForGuild(currentGuildId(), store.data.guilds);
    if (binding === "mj" || binding === "ro") return { project: binding, binding };
    if (binding === "none") return { project: ui.get().sessionProject, binding };
    return { project: null, binding: null };
}

/** Templates visible for a project: its own + common (no project). */
export const poolFor = (project: ProjectId | null) =>
    store.templates.filter(t => !t.project || t.project === project);

/** Re-render on any Store change; returns a version number. */
export function useStore() {
    const [v, setV] = useState(0);
    useEffect(() => store.subscribe(() => setV(x => x + 1)), []);
    return v;
}
```

`src/vencord/ui/ProjectIcon.tsx`:
```tsx
/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ProjectId, PROJECTS } from "../core/types";
import { MJ_ICON, RO_ICON } from "./icons";

export function ProjectIcon({ project, size = 16 }: { project: ProjectId | null; size?: number; }) {
    if (!project) return <span className="vc-stx-pi vc-stx-pi-none" style={{ width: size, height: size }}>★</span>;
    return (
        <img
            className={"vc-stx-pi vc-stx-pi-" + project}
            src={project === "mj" ? MJ_ICON : RO_ICON}
            alt={PROJECTS[project].short}
            style={{ width: size, height: size }}
        />
    );
}
```

- [ ] **Step 4: Настройки, хост, плагин**

`src/vencord/ui/Settings.tsx`:
```tsx
/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useState } from "@webpack/common";

import { PREFIXES } from "../core/trigger";
import { PROJECTS } from "../core/types";
import { toast } from "../platform";
import { store, useStore } from "./uiState";

export function Settings() {
    useStore();
    const [status, setStatus] = useState("");
    const mj = store.templates.filter(t => t.project === "mj").length;
    const ro = store.templates.filter(t => t.project === "ro").length;

    const pick = () => {
        const inp = document.createElement("input");
        inp.type = "file";
        inp.accept = ".json,.txt,.md";
        inp.onchange = async () => {
            const file = inp.files?.[0];
            if (!file) return;
            try {
                setStatus(store.importText(await file.text()));
                toast("Импорт выполнен", "success");
            } catch (e: any) {
                setStatus("Ошибка: " + e.message);
                toast("Импорт не удался", "failure");
            }
        };
        inp.click();
    };

    const guilds = Object.entries(store.data.guilds);
    return (
        <div className="vc-stx-settings">
            <h3>Шаблоны</h3>
            <p>Сейчас: {store.templates.length} (Majestic {mj}, Россия Онлайн {ro}). Источник — локальный; вход через панель появится позже.</p>
            <p>Импорт: <code>SupportTemplates.config.json</code> из BetterDiscord, резервная копия или текст «## проект / ### шаблон». Заменяет текущие шаблоны, избранное и бинды.</p>
            <button className="vc-stx-btn" onClick={pick}>Импорт из файла</button>
            {status && <p className="vc-stx-muted">{status}</p>}

            <h3>Быстрый ввод</h3>
            <p>Префикс команды в строке ввода («/» занят командами Discord):</p>
            <div className="vc-stx-row">
                {PREFIXES.map(p => (
                    <button key={p} className={"vc-stx-btn " + (store.data.prefix === p ? "" : "vc-stx-ghost")} onClick={() => store.setPrefix(p)}>{p}снр</button>
                ))}
            </div>

            <h3>Серверы</h3>
            <p>{PROJECTS.mj.name} и {PROJECTS.ro.name} определяются сами. Ответы для остальных серверов:</p>
            {guilds.length
                ? <ul>{guilds.map(([k, b]) => <li key={k}><code>{k}</code> → {b === "none" ? "выбирать при открытии" : PROJECTS[b].name}</li>)}</ul>
                : <p className="vc-stx-muted">пока нет</p>}
            {guilds.length > 0 && <button className="vc-stx-btn vc-stx-ghost" onClick={() => store.clearGuilds()}>Сбросить ответы</button>}
        </div>
    );
}
```

`src/vencord/ui/Host.tsx` (на этом шаге — заглушка окна; полное окно в задаче 7):
```tsx
/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ui } from "./uiState";

export function Host() {
    const s = ui.use();
    return (
        <div className="vc-stx-root">
            {s.windowOpen && <div className="vc-stx-win" style={{ right: 80, bottom: 80, width: 300, height: 120 }}>окно</div>}
        </div>
    );
}
```

`src/vencord/index.tsx`:
```tsx
/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { IconComponent, OptionType } from "@utils/types";
import { createRoot } from "@webpack/common";

import { Host } from "./ui/Host";
import { MJ_ICON } from "./ui/icons";
import { Settings } from "./ui/Settings";
import { store, ui } from "./ui/uiState";

const Icon: IconComponent = ({ height = 20, width = 20, className }) => (
    <img src={MJ_ICON} height={height} width={width} className={className} style={{ borderRadius: 5 }} alt="" />
);

export function toggleWindow(open = !ui.get().windowOpen) {
    ui.set({ windowOpen: open, menu: null, selection: open ? String(window.getSelection() ?? "") : "" });
}

const Button: ChatBarButtonFactory = ({ isMainChat }) => {
    if (!isMainChat) return null;
    return (
        <ChatBarButton tooltip="Шаблоны (Ctrl+Alt+T)" onClick={() => toggleWindow()} buttonProps={{ className: "vc-stx-button" } as any}>
            <Icon />
        </ChatBarButton>
    );
};

function onKey(e: KeyboardEvent) {
    if (e.ctrlKey && e.altKey && !e.shiftKey && e.code === "KeyT") {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) toggleWindow();
    }
}

let host: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

const settings = definePluginSettings({
    panel: { type: OptionType.COMPONENT, component: Settings },
});

export default definePlugin({
    name: "SupportTemplates",
    description: "Шаблоны ответов поддержки Majestic RP и Россия Онлайн в строке ввода.",
    authors: [{ name: "Oblako", id: 0n }],
    settings,
    chatBarButton: { icon: Icon, render: Button },

    async start() {
        await store.load();
        document.addEventListener("keydown", onKey, true);
        host = document.createElement("div");
        host.id = "vc-stx-host";
        document.body.append(host);
        root = createRoot(host);
        root.render(<Host />);
    },

    stop() {
        document.removeEventListener("keydown", onKey, true);
        root?.unmount();
        host?.remove();
        root = host = null;
        ui.set({ windowOpen: false, dialog: null, inline: null, menu: null });
    },
});
```

`src/vencord/styles.css` (полная таблица стилей — используется задачами 7–10):
```css
#vc-stx-host {
    --stx-bg: hsl(216 16% 6%);
    --stx-card: hsl(218 17% 9%);
    --stx-hover: hsl(215 16% 13%);
    --stx-bd: hsl(215 16% 15%);
    --stx-bd2: hsl(215 16% 20%);
    --stx-tx: hsl(216 10% 91%);
    --stx-mu: hsl(214 10% 72%);
    --stx-pr: hsl(342 77% 44%);
    --stx-ring: hsl(342 80% 56%);
    --stx-amber: #e0a83f;

    font-family: "Golos Text", Inter, "Segoe UI", sans-serif;
    color: var(--stx-tx);
}

.vc-stx-root { position: fixed; inset: 0; pointer-events: none; z-index: 1000; }
.vc-stx-root > * { pointer-events: auto; }

.vc-stx-win, .vc-stx-pop, .vc-stx-dialog, .vc-stx-menu, .vc-stx-compose {
    position: fixed;
    background: var(--stx-card);
    border: 1px solid var(--stx-bd);
    border-radius: 12px;
    box-shadow: 0 12px 32px rgb(0 0 0 / 55%);
    color: var(--stx-tx);
    font-size: 13px;
}

.vc-stx-win { display: flex; overflow: hidden; height: 420px; }
.vc-stx-col { display: flex; flex-direction: column; min-width: 0; padding: 10px 6px 8px 10px; width: 400px; flex: none; }
.vc-stx-search { background: var(--stx-bg); border: 1px solid var(--stx-bd); border-radius: 8px; padding: 8px 10px; color: var(--stx-tx); outline: none; font: inherit; }
.vc-stx-search:focus { border-color: var(--stx-ring); }
.vc-stx-proj { display: flex; align-items: center; gap: 8px; margin: 8px 2px 4px; padding-bottom: 6px; border-bottom: 1px solid var(--stx-bd); }
.vc-stx-proj b { font-weight: 600; }
.vc-stx-tab { background: none; border: 0; color: var(--stx-mu); font: inherit; padding: 0 2px 5px; display: inline-flex; gap: 6px; align-items: center; cursor: pointer; }
.vc-stx-tab.on { color: #fff; box-shadow: inset 0 -2px 0 var(--stx-pr); }
.vc-stx-hint { color: var(--stx-mu); font-size: 11px; padding: 2px 3px 4px; }
.vc-stx-list { overflow-y: auto; flex: 1; padding-right: 4px; }
.vc-stx-sec { color: var(--stx-mu); font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; margin: 8px 3px 3px; }
.vc-stx-item { padding: 6px 8px; border-radius: 8px; cursor: pointer; }
.vc-stx-item.sel { background: var(--stx-hover); box-shadow: inset 3px 0 0 var(--stx-pr); }
.vc-stx-r { display: flex; align-items: center; gap: 7px; min-width: 0; }
.vc-stx-nm { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vc-stx-line { color: var(--stx-mu); font-size: 11.5px; margin: 2px 0 0 23px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vc-stx-kb { flex: none; padding: 0 5px; border-radius: 5px; font-size: 10px; font-weight: 600; border: 1px solid var(--stx-bd2); color: var(--stx-mu); }
.vc-stx-badge { flex: none; font-size: 10px; padding: 0 6px; border-radius: 999px; }
.vc-stx-badge.old { color: #f2879f; background: #1d1116; border: 1px solid #3b1a24; }
.vc-stx-badge.star { color: var(--stx-amber); }
.vc-stx-empty { color: var(--stx-mu); padding: 14px 6px; }
.vc-stx-foot { color: var(--stx-mu); font-size: 10.5px; padding: 6px 3px 0; border-top: 1px solid var(--stx-bd); margin-top: 4px; }
.vc-stx mark, .vc-stx-root mark { background: #211b10; color: #f1c46f; border-radius: 3px; }

.vc-stx-pi { flex: none; border-radius: 4px; box-sizing: border-box; object-fit: cover; display: inline-flex; align-items: center; justify-content: center; font-size: 10px; }
.vc-stx-pi-ro { background: #2a2b31; object-fit: contain; padding: 1px; }
.vc-stx-pi-none { background: #2a2b31; color: var(--stx-amber); }

.vc-stx-pre { flex: 1; min-width: 0; display: flex; flex-direction: column; padding: 12px; border-left: 1px solid var(--stx-bd); }
.vc-stx-pre h4 { margin: 0 0 6px; font-size: 14px; color: #fff; border-left: 4px solid var(--stx-amber); padding-left: 9px; }
.vc-stx-meta { color: var(--stx-mu); font-size: 11px; margin-bottom: 8px; }
.vc-stx-body { flex: 1; overflow-y: auto; white-space: pre-wrap; line-height: 1.45; font-size: 12.5px; color: hsl(216 10% 85%); }
.vc-stx-greet { color: var(--stx-mu); }
.vc-stx-gmark { display: inline-block; font-size: 10.5px; color: #f1c46f; background: #211b10; border-radius: 4px; padding: 0 5px; margin: 4px 0; }
.vc-stx-acts { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }

.vc-stx-btn { background: var(--stx-pr); color: #fff; border: 0; border-radius: 7px; padding: 6px 12px; font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; }
.vc-stx-btn:hover { filter: brightness(1.1); }
.vc-stx-btn.vc-stx-ghost { background: transparent; color: var(--stx-tx); box-shadow: inset 0 0 0 1px var(--stx-bd2); font-weight: 500; }
.vc-stx-btn.vc-stx-danger { background: transparent; color: #f2879f; box-shadow: inset 0 0 0 1px #3b1a24; }

.vc-stx-pop { padding: 6px 8px; min-width: 360px; max-width: 560px; }

.vc-stx-backdrop { position: fixed; inset: 0; background: rgb(0 0 0 / 45%); }
.vc-stx-dialog { left: 50%; top: 28%; transform: translateX(-50%); width: 440px; padding: 16px; }
.vc-stx-dialog h4 { margin: 0 0 8px; font-size: 14px; color: #fff; border-left: 4px solid var(--stx-amber); padding-left: 9px; }
.vc-stx-callout { border-radius: 10px; padding: 10px 12px; margin-bottom: 10px; font-size: 12.5px; }
.vc-stx-callout.danger { background: #1d1116; border-left: 4px solid #ef456e; }
.vc-stx-callout.warn { background: #211b10; border-left: 4px solid var(--stx-amber); }
.vc-stx-callout span { display: block; font-size: 10.5px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; margin-bottom: 3px; }
.vc-stx-callout.danger span { color: #f2879f; }
.vc-stx-callout.warn span { color: #f1c46f; }
.vc-stx-field { margin: 8px 0; }
.vc-stx-field label { display: block; color: var(--stx-mu); font-size: 11px; margin-bottom: 3px; }
.vc-stx-opt { display: inline-block; margin: 0 4px 4px 0; padding: 4px 10px; border-radius: 7px; border: 1px solid var(--stx-bd2); background: none; color: var(--stx-mu); font: inherit; cursor: pointer; }
.vc-stx-opt.on { border-color: var(--stx-pr); background: rgb(198 26 89 / 15%); color: #fff; }
.vc-stx-check { display: flex; gap: 6px; align-items: center; color: var(--stx-mu); font-size: 12px; margin-top: 8px; }

.vc-stx-menu { padding: 4px; min-width: 200px; }
.vc-stx-menu button { display: block; width: 100%; text-align: left; background: none; border: 0; color: var(--stx-tx); font: inherit; padding: 6px 10px; border-radius: 6px; cursor: pointer; }
.vc-stx-menu button:hover { background: var(--stx-hover); }

.vc-stx-compose { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-radius: 10px; background: #1a160e; border-color: #3a2e14; }
.vc-stx-chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 6px 3px 8px; border-radius: 7px; background: var(--stx-card); border: 1px solid var(--stx-bd); cursor: grab; user-select: none; }
.vc-stx-chip.drag { opacity: .5; }
.vc-stx-chip button { background: none; border: 0; color: var(--stx-mu); cursor: pointer; font: inherit; padding: 0 2px; }

/* Settings render inside Discord's settings, outside #vc-stx-host — give them the tokens too. */
.vc-stx-settings { --stx-pr: hsl(342 77% 44%); --stx-tx: hsl(216 10% 91%); --stx-bd2: hsl(215 16% 20%); color: var(--text-default, #dbdee1); }
.vc-stx-settings h3 { margin: 16px 0 6px; font-weight: 600; }
.vc-stx-settings p { margin: 4px 0 8px; }
.vc-stx-muted { color: var(--text-muted, #949ba4); }
.vc-stx-row { display: flex; gap: 6px; }

@media (prefers-reduced-motion: no-preference) {
    .vc-stx-win, .vc-stx-pop, .vc-stx-dialog { animation: vc-stx-in .12s ease-out; }
}
@keyframes vc-stx-in { from { opacity: 0; } to { opacity: 1; } }
```

- [ ] **Step 5: Синк, проверка типов Vencord, сборка**

Run:
```bash
pnpm sync:vencord
cd C:/Users/oblako/dev/Vencord && npx tsc --noEmit -p . 2>&1 | grep -i userplugins/supportTemplates ; pnpm build
```
Expected: `synced → …`, нет строк с ошибками из `userplugins/supportTemplates`, сборка `Done`.

- [ ] **Step 6: Ручная проверка (пользователь, Ctrl+R в Discord)**

- В строке ввода — иконка Majestic; клик открывает заглушку «окно», повторный — закрывает; Ctrl+Alt+T — то же.
- Настройки → Plugins → SupportTemplates (шестерёнка): «Импорт из файла» → `SupportTemplates.config.json` → «Шаблонов: 133 (Majestic 68, Россия Онлайн 65), избранных: 17».
- После Ctrl+R импорт сохранился (данные спайка тоже подхватываются автоматически при первом запуске).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(vencord): plugin skeleton, sync script, icons, settings import"
```

---

### Task 7: Окно шаблонов (состояние Б)

**Files:**
- Create: `src/vencord/ui/Window.tsx`, `src/vencord/ui/Preview.tsx`, `src/vencord/ui/ContextMenu.tsx`, `src/vencord/ui/flow.ts` (базовая версия: защита проекта + вставка)
- Modify: `src/vencord/ui/Host.tsx`, `src/vencord/index.tsx`

**Interfaces:**
- Consumes: `store`, `ui`, `activeProject`, `poolFor`, `useStore`, `guildKey`, platform, core `search`, `orderHits`, `sections`, `favoritesOf`, `decide`, `foreignMarkers`, `splitGreeting`, `stripMarker`
- Produces: flow.ts `insertTemplate(t: Template, opts?: {noGreeting?: boolean}): Promise<void>`, `prepareText(t, opts): Promise<{t: Template; text: string} | null>`, `ensureProject(): Promise<ProjectId | null>`, `addToCompose(t): Promise<void>`, `confirm(d): Promise<{ok; checked}>`; Window.tsx `Window()`, `visibleItems: Template[]` (module-level, для Alt+N); ContextMenu `ContextMenu()`

- [ ] **Step 1: Конвейер вставки (без полей — поля в задаче 8)**

`src/vencord/ui/flow.ts`:
```ts
/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { decide, foreignMarkers, ServerBinding } from "../core/guard";
import { splitGreeting, stripMarker } from "../core/text";
import { ProjectId, PROJECTS, Template } from "../core/types";
import { activeEditor, insertText, toast } from "../platform";
import { activeProject, Dialog, guildKey, store, ui } from "./uiState";

type ConfirmArgs = Omit<Extract<Dialog, { kind: "confirm"; }>, "kind" | "resolve">;

export function confirm(args: ConfirmArgs): Promise<{ ok: boolean; checked: boolean; }> {
    return new Promise(resolve => ui.set({ dialog: { kind: "confirm", ...args, resolve: v => { ui.set({ dialog: null }); resolve(v); } } }));
}

function askProject(): Promise<ServerBinding | null> {
    return new Promise(resolve => ui.set({ dialog: { kind: "askProject", resolve: v => { ui.set({ dialog: null }); resolve(v); } } }));
}

/** Project for this channel; asks once on an unknown server. null = nothing may be inserted. */
export async function ensureProject(): Promise<ProjectId | null> {
    const { project, binding } = activeProject();
    if (project) return project;
    if (binding === "none") {
        toast("На этом сервере выбери проект во вкладке окна шаблонов", "failure");
        return null;
    }
    const ans = await askProject();
    if (!ans) return null;
    store.setGuild(guildKey(), ans);
    if (ans === "none") {
        toast("Выбери проект во вкладке окна шаблонов", "message");
        ui.set({ windowOpen: true });
        return null;
    }
    return ans;
}

/** Guard + warnings. Returns the template to use (maybe a mirror) or null when cancelled. */
async function guard(t: Template, project: ProjectId): Promise<Template | null> {
    const d = decide(t, project, store.templates);
    if (d.kind === "mirror") {
        toast(`Вставлен вариант для ${PROJECTS[project].short}`, "message");
        t = d.t;
    } else if (d.kind === "foreign") {
        const r = await confirm({
            tone: "danger", label: "Шаблон другого проекта",
            title: t.title,
            body: `Это шаблон ${PROJECTS[t.project!].name}, а канал — ${PROJECTS[project].name}. Пары для ${PROJECTS[project].short} нет.`,
            ok: `Да, вставить шаблон ${PROJECTS[t.project!].short}`,
        });
        if (!r.ok) return null;
    }

    if (!t.project && !store.isIntentional(t.id)) {
        const found = foreignMarkers(t.text, project);
        if (found.length) {
            const r = await confirm({
                tone: "warn", label: "Упоминается другой проект",
                title: t.title,
                body: `В тексте есть: ${found.join(", ")}. Канал — ${PROJECTS[project].name}.`,
                ok: "Вставить", checkbox: "Это намеренно, больше не спрашивать",
            });
            if (!r.ok) return null;
            if (r.checked) store.markIntentional(t.id);
        }
    }

    if (t.status !== "actual") {
        const r = await confirm({
            tone: "danger", label: t.status === "outdated" ? "Шаблон помечен «Устарело»" : "Шаблон на проверке",
            title: t.title,
            body: (t.statusNote ? `Комментарий: «${t.statusNote}». ` : "") + "Проверьте текст, прежде чем отправлять игроку.",
            ok: "Вставить всё равно",
        });
        if (!r.ok) return null;
    }
    return t;
}

export async function prepareText(t: Template, opts: { noGreeting?: boolean; } = {}): Promise<{ t: Template; text: string; } | null> {
    const project = await ensureProject();
    if (!project) return null;
    const g = await guard(t, project);
    if (!g) return null;
    const text = opts.noGreeting ? splitGreeting(g.text).body : stripMarker(g.text);
    return { t: g, text };
}

export async function insertTemplate(t: Template, opts: { noGreeting?: boolean; } = {}) {
    ui.set({ windowOpen: false, menu: null });
    const r = await prepareText(t, opts);
    if (!r) return;
    activeEditor()?.focus();
    insertText(r.text);
    store.markUsed(r.t.id);
}

export async function addToCompose(t: Template) {
    const project = await ensureProject();
    if (!project) return;
    const g = await guard(t, project);
    if (!g) return;
    if (!ui.get().compose.includes(g.id)) ui.set({ compose: [...ui.get().compose, g.id] });
    toast("Добавлено в ответ: " + g.title, "message");
}
```

- [ ] **Step 2: Окно, предпросмотр, контекстное меню**

`src/vencord/ui/Preview.tsx`:
```tsx
/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { splitGreeting } from "../core/text";
import { PROJECTS, Template } from "../core/types";
import { addToCompose, insertTemplate } from "./flow";
import { store } from "./uiState";

export function Preview({ t }: { t: Template | undefined; }) {
    if (!t) return <div className="vc-stx-pre"><div className="vc-stx-empty">Выбери шаблон</div></div>;
    const { greeting, body } = splitGreeting(t.text);
    const uses = store.data.usage[t.id]?.n ?? 0;
    const meta = [
        t.category,
        t.project ? PROJECTS[t.project].name : "общий",
        t.source === "local" ? "локальный" : null,
        uses ? `использован ${uses} раз` : null,
        t.teamUses ? `командой ${t.teamUses} раз` : null,
    ].filter(Boolean).join(" · ");
    const fav = store.isFavorite(t.id);
    return (
        <div className="vc-stx-pre">
            <h4>{t.title}</h4>
            <div className="vc-stx-meta">{meta}</div>
            <div className="vc-stx-body">
                {greeting && <><span className="vc-stx-greet">{greeting}</span>{"\n"}<span className="vc-stx-gmark">— граница приветствия —</span>{"\n"}</>}
                {body}
            </div>
            <div className="vc-stx-acts">
                <button className="vc-stx-btn" onClick={() => insertTemplate(t)}>Вставить</button>
                {greeting && <button className="vc-stx-btn vc-stx-ghost" onClick={() => insertTemplate(t, { noGreeting: true })}>Без приветствия</button>}
                <button className="vc-stx-btn vc-stx-ghost" onClick={() => addToCompose(t)}>+ в ответ</button>
                <button className="vc-stx-btn vc-stx-ghost" title="Избранное (Ctrl+D)" onClick={() => store.toggleFavorite(t.id)}>{fav ? "★" : "☆"}</button>
            </div>
        </div>
    );
}
```

`src/vencord/ui/ContextMenu.tsx`:
```tsx
/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useEffect } from "@webpack/common";

import { comboLabel } from "../core/keys";
import { splitGreeting } from "../core/text";
import { addToCompose, insertTemplate } from "./flow";
import { store, ui } from "./uiState";

export function ContextMenu() {
    const { menu } = ui.use();
    useEffect(() => {
        if (!menu) return;
        const close = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest?.(".vc-stx-menu")) ui.set({ menu: null }); };
        document.addEventListener("mousedown", close, true);
        return () => document.removeEventListener("mousedown", close, true);
    }, [menu]);
    if (!menu) return null;
    const t = store.byId(menu.id);
    if (!t) return null;
    const bind = store.bindFor(t.id);
    const run = (fn: () => void) => () => { ui.set({ menu: null }); fn(); };
    return (
        <div className="vc-stx-menu" style={{ left: menu.x, top: menu.y }}>
            <button onClick={run(() => insertTemplate(t))}>Вставить</button>
            {splitGreeting(t.text).greeting && <button onClick={run(() => insertTemplate(t, { noGreeting: true }))}>Вставить без приветствия</button>}
            <button onClick={run(() => addToCompose(t))}>+ в ответ</button>
            <button onClick={run(() => store.toggleFavorite(t.id))}>{store.isFavorite(t.id) ? "Убрать из избранного" : "★ В избранное"}</button>
            <button onClick={run(() => ui.set({ dialog: { kind: "bind", templateId: t.id } }))}>{bind ? `Изменить клавишу (${comboLabel(bind)})` : "Назначить клавишу…"}</button>
            {bind && <button onClick={run(() => store.clearBind(t.id))}>Снять клавишу</button>}
        </div>
    );
}
```

`src/vencord/ui/Window.tsx`:
```tsx
/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useEffect, useMemo, useRef, useState } from "@webpack/common";

import { comboLabel } from "../core/keys";
import { favoritesOf, orderHits, sections } from "../core/rank";
import { search } from "../core/search";
import { nqHighlight } from "./highlight";
import { ProjectId, PROJECTS, Template } from "../core/types";
import { chatAreaRect } from "../platform";
import { addToCompose, ensureProject, insertTemplate } from "./flow";
import { Preview } from "./Preview";
import { ProjectIcon } from "./ProjectIcon";
import { activeProject, poolFor, store, ui, useStore } from "./uiState";

/** Rows currently visible in the window — Alt+1…9 uses them while the window is open. */
export let visibleItems: Template[] = [];

export function Window() {
    useStore();
    const s = ui.use();
    const { project, binding } = activeProject();
    const [query, setQuery] = useState("");
    const [sel, setSel] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);

    const pool = poolFor(project);
    const ctx = store.ctx();
    const res = useMemo(() => (query.trim() ? search(pool, query) : null), [query, pool, store.data]);
    const hits = res ? orderHits(res.hits, ctx) : [];
    const secs = res ? [] : sections(pool, ctx);
    const items: Template[] = res ? hits.map(h => h.t) : secs.flatMap(x => x.items);
    const favIds = favoritesOf(pool, ctx).map(t => t.id);
    visibleItems = items;
    const current = items[Math.min(sel, items.length - 1)];

    useEffect(() => {
        inputRef.current?.focus();
        // Unknown server: ask right away, otherwise the list would be empty.
        if (activeProject().binding === null) void ensureProject();
    }, []);
    useEffect(() => { setSel(0); }, [query, project]);
    useEffect(() => { listRef.current?.querySelector(".vc-stx-item.sel")?.scrollIntoView({ block: "nearest" }); }, [sel]);
    useEffect(() => {
        const onDown = (e: MouseEvent) => {
            const el = e.target as HTMLElement;
            if (el.closest?.(".vc-stx-win, .vc-stx-menu, .vc-stx-dialog, .vc-stx-button, .vc-stx-backdrop")) return;
            ui.set({ windowOpen: false });
        };
        document.addEventListener("mousedown", onDown, true);
        return () => document.removeEventListener("mousedown", onDown, true);
    }, []);

    const pickProject = (p: ProjectId) => ui.set({ sessionProject: p });

    const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        const input = inputRef.current;
        const atEnd = !!input && input.selectionStart === input.value.length;
        const atStart = !!input && input.selectionEnd === 0;
        if (e.key === "Escape") {
            e.preventDefault();
            if (query) setQuery(""); else ui.set({ windowOpen: false });
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (items.length) setSel(i => (i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length);
        } else if (e.key === "Enter" && current) {
            e.preventDefault();
            if (e.shiftKey) void addToCompose(current); else void insertTemplate(current);
        } else if (e.key === "ArrowRight" && atEnd && !store.data.previewOpen) {
            e.preventDefault();
            store.setPreviewOpen(true);
        } else if (e.key === "ArrowLeft" && atStart && store.data.previewOpen) {
            e.preventDefault();
            store.setPreviewOpen(false);
        } else if (e.key === "Tab" && binding === "none") {
            e.preventDefault();
            pickProject(project === "mj" ? "ro" : "mj");
        } else if (e.ctrlKey && e.code === "KeyD" && current) {
            e.preventDefault();
            store.toggleFavorite(current.id);
        }
    };

    const rect = chatAreaRect();
    const wide = store.data.previewOpen;
    const width = Math.min(wide ? 820 : 400, (rect?.width ?? 900) - 8);
    const style: React.CSSProperties = rect
        ? { right: Math.max(8, window.innerWidth - rect.right), bottom: window.innerHeight - rect.top + 8 + (s.compose.length ? 48 : 0), width }
        : { right: 80, bottom: 80, width };

    const row = (t: Template, i: number) => {
        const favIdx = favIds.indexOf(t.id);
        const bind = store.bindFor(t.id);
        const hit = res ? hits[i] : null;
        return (
            <div
                key={t.id}
                className={"vc-stx-item" + (i === sel ? " sel" : "")}
                onMouseEnter={() => setSel(i)}
                onClick={() => insertTemplate(t)}
                onContextMenu={e => { e.preventDefault(); ui.set({ menu: { x: e.clientX, y: e.clientY, id: t.id } }); }}
            >
                <div className="vc-stx-r">
                    <ProjectIcon project={t.project} />
                    <span className="vc-stx-nm">{nqHighlight(t.title, res?.tokens ?? [])}</span>
                    {t.status !== "actual" && <span className="vc-stx-badge old">{t.status === "outdated" ? "устарел" : "на проверке"}</span>}
                    {bind && <span className="vc-stx-kb">{comboLabel(bind)}</span>}
                    {!res && favIdx >= 0 && favIdx < 9 && <span className="vc-stx-kb">Alt {favIdx + 1}</span>}
                    {res && i < 9 && <span className="vc-stx-kb">Alt {i + 1}</span>}
                </div>
                {hit?.line && <div className="vc-stx-line">{nqHighlight(hit.line, res!.tokens)}</div>}
            </div>
        );
    };

    let idx = 0;
    return (
        <div className="vc-stx-win" style={style} onKeyDown={onKeyDown}>
            <div className="vc-stx-col">
                <input
                    ref={inputRef}
                    className="vc-stx-search"
                    placeholder="Поиск: название, текст или синоним — «фпс», «снр»…"
                    value={query}
                    onChange={e => setQuery(e.currentTarget.value)}
                />
                <div className="vc-stx-proj">
                    {binding === "none"
                        ? (["mj", "ro"] as ProjectId[]).map(p => (
                            <button key={p} className={"vc-stx-tab" + (project === p ? " on" : "")} onClick={() => pickProject(p)}>
                                <ProjectIcon project={p} size={14} />{PROJECTS[p].short}
                            </button>))
                        : project
                            ? <><ProjectIcon project={project} size={16} /><b>{PROJECTS[project].name}</b><span className="vc-stx-hint">по серверу</span></>
                            : <span className="vc-stx-hint">Проект сервера не определён — спрошу при вставке</span>}
                </div>
                {res?.layout && <div className="vc-stx-hint">Раскладка: показаны результаты для «{res.layout}»</div>}
                {res?.fuzzy && <div className="vc-stx-hint">Точных совпадений нет — похожие</div>}
                <div className="vc-stx-list" ref={listRef}>
                    {!store.templates.length && <div className="vc-stx-empty">Шаблонов нет. Импортируй конфиг в настройках плагина.</div>}
                    {store.templates.length > 0 && !items.length && <div className="vc-stx-empty">Ничего не найдено</div>}
                    {res
                        ? items.map((t, i) => row(t, i))
                        : secs.map(sec => (
                            <div key={sec.key}>
                                <div className="vc-stx-sec">{sec.title}</div>
                                {sec.items.map(t => row(t, idx++))}
                            </div>))}
                </div>
                <div className="vc-stx-foot">
                    Enter вставить · Shift+Enter в ответ · {wide ? "← скрыть текст" : "→ текст"} · Ctrl+D ★ · ПКМ меню{binding === "none" ? " · Tab проект" : ""}
                </div>
            </div>
            {wide && <Preview t={current} />}
        </div>
    );
}
```

Подсветка — отдельный маленький модуль `src/vencord/ui/highlight.tsx` (длина сохраняется благодаря `soft`):
```tsx
/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { soft } from "../core/text";

export function nqHighlight(text: string, tokens: string[]): React.ReactNode {
    if (!tokens.length) return text;
    const f = soft(text);
    const marks = new Uint8Array(text.length);
    for (const tok of tokens) {
        for (let i = f.indexOf(tok); i !== -1; i = f.indexOf(tok, i + tok.length)) marks.fill(1, i, i + tok.length);
    }
    const out: React.ReactNode[] = [];
    for (let i = 0; i < text.length;) {
        let j = i;
        while (j < text.length && marks[j] === marks[i]) j++;
        const seg = text.slice(i, j);
        out.push(marks[i] ? <mark key={i}>{seg}</mark> : <span key={i}>{seg}</span>);
        i = j;
    }
    return out;
}
```
(в `Window.tsx` импорт `import { nqHighlight } from "./highlight";` — путь `./highlight`, файл `highlight.tsx`.)

- [ ] **Step 3: Хост и клавиши Alt+N / бинды**

`src/vencord/ui/Host.tsx`:
```tsx
/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ContextMenu } from "./ContextMenu";
import { ui } from "./uiState";
import { Window } from "./Window";

export function Host() {
    const s = ui.use();
    return (
        <div className="vc-stx-root">
            {s.windowOpen && <Window />}
            <ContextMenu />
        </div>
    );
}
```

В `src/vencord/index.tsx` заменить `onKey` на полную версию и добавить импорты:
```tsx
import { comboOf } from "./core/keys";
import { favoritesOf } from "./core/rank";
import { insertTemplate } from "./ui/flow";
import { activeProject, poolFor } from "./ui/uiState";
import { visibleItems } from "./ui/Window";

function onKey(e: KeyboardEvent) {
    const s = ui.get();
    if (s.dialog) return; // dialogs handle their own keys

    if (e.ctrlKey && e.altKey && !e.shiftKey && e.code === "KeyT") {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) toggleWindow();
        return;
    }

    const digit = /^Digit([1-9])$/.exec(e.code);
    if (digit && e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat) return;
        const i = Number(digit[1]) - 1;
        const list = s.windowOpen ? visibleItems : favoritesOf(poolFor(activeProject().project), store.ctx());
        const t = list[i];
        if (t) void insertTemplate(t);
        return;
    }

    const combo = comboOf(e);
    const bound = combo ? store.templateForCombo(combo) : undefined;
    if (bound) {
        const target = e.target as HTMLElement;
        if (target?.closest?.("input, textarea, select") && !target.closest(".vc-stx-root")) return;
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) void insertTemplate(bound);
    }
}
```

- [ ] **Step 4: Синк, типы, сборка**

Run:
```bash
pnpm sync:vencord
cd C:/Users/oblako/dev/Vencord && npx tsc --noEmit -p . 2>&1 | grep -i userplugins/supportTemplates ; pnpm build
```
Expected: нет ошибок из плагина, сборка `Done`. (Диалоги `confirm`/`askProject` пока не рендерятся — задача 8. До неё проверять только на серверах Маджи и РО: на чужом сервере окно запросит невидимый диалог и клавиши плагина замолчат до Ctrl+R.)

- [ ] **Step 5: Ручная проверка (Ctrl+R)**

На сервере Majestic:
- Окно: заголовок «Majestic RP · по серверу», разделы ★ Избранное → Недавние → Все шаблоны; шаблонов РО нет.
- Поиск «снр», «фпс», «cjtl» (раскладка), «соеднение» (похожие) — находят; совпадения подсвечены.
- → открывает текст справа (окно шире), ← закрывает; после Ctrl+R состояние запомнилось.
- Enter / клик вставляет; длинный шаблон («Разбаны Амнистии Жалобы») стирается Backspace'ом целиком.
- Alt+1 при закрытом окне — первый из избранного Маджи; зажатый Alt+1 вставляет один раз.
- ПКМ по шаблону — меню; «★ В избранное» работает.
На сервере Россия Онлайн: только шаблоны РО, Alt+1 — избранное РО.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(vencord): templates window with sections, preview, context menu, Alt+N"
```

---

### Task 8: Диалоги: проект сервера, предупреждения, поля, бинд

**Files:**
- Create: `src/vencord/ui/Dialogs.tsx`
- Modify: `src/vencord/ui/flow.ts` (поля), `src/vencord/ui/Host.tsx`

**Interfaces:**
- Consumes: `Dialog` union (uiState), `fieldsOf`, `fill`, `Env`, `comboOf`, `comboLabel`, `bindProblem`, `readClipboard`, `currentChannel`
- Produces: `Dialogs()` component; flow.ts `fillFields(title, text): Promise<string | null>`; `insertTemplate` теперь спрашивает поля

- [ ] **Step 1: Компонент диалогов**

`src/vencord/ui/Dialogs.tsx`:
```tsx
/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useEffect, useRef, useState } from "@webpack/common";

import { bindProblem, comboLabel, comboOf } from "../core/keys";
import { PROJECTS } from "../core/types";
import { toast } from "../platform";
import { ProjectIcon } from "./ProjectIcon";
import { Dialog, store, ui } from "./uiState";

function Frame({ children, onEscape }: { children: React.ReactNode; onEscape(): void; }) {
    useEffect(() => {
        const h = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onEscape(); } };
        document.addEventListener("keydown", h, true);
        return () => document.removeEventListener("keydown", h, true);
    }, []);
    return <><div className="vc-stx-backdrop" onMouseDown={onEscape} /><div className="vc-stx-dialog">{children}</div></>;
}

function AskProject({ d }: { d: Extract<Dialog, { kind: "askProject"; }>; }) {
    return (
        <Frame onEscape={() => d.resolve(null)}>
            <h4>Это сервер какого проекта?</h4>
            <p className="vc-stx-hint">Отвечу один раз и запомню для этого сервера. Изменить — в настройках плагина.</p>
            <div className="vc-stx-acts">
                <button className="vc-stx-btn vc-stx-ghost" onClick={() => d.resolve("mj")}><ProjectIcon project="mj" size={14} /> {PROJECTS.mj.name}</button>
                <button className="vc-stx-btn vc-stx-ghost" onClick={() => d.resolve("ro")}><ProjectIcon project="ro" size={14} /> {PROJECTS.ro.name}</button>
                <button className="vc-stx-btn vc-stx-ghost" onClick={() => d.resolve("none")}>Ни того ни другого — выбирать в окне</button>
            </div>
        </Frame>
    );
}

function Confirm({ d }: { d: Extract<Dialog, { kind: "confirm"; }>; }) {
    const [checked, setChecked] = useState(false);
    const cancelRef = useRef<HTMLButtonElement>(null);
    useEffect(() => { cancelRef.current?.focus(); }, []); // safe default: Enter = cancel
    return (
        <Frame onEscape={() => d.resolve({ ok: false, checked })}>
            <div className={"vc-stx-callout " + d.tone}><span>{d.label}</span>{d.body}</div>
            <h4>{d.title}</h4>
            {d.checkbox && <label className="vc-stx-check"><input type="checkbox" checked={checked} onChange={e => setChecked(e.currentTarget.checked)} />{d.checkbox}</label>}
            <div className="vc-stx-acts">
                <button className="vc-stx-btn" onClick={() => d.resolve({ ok: true, checked })}>{d.ok}</button>
                <button ref={cancelRef} className="vc-stx-btn vc-stx-ghost" onClick={() => d.resolve({ ok: false, checked })}>Отмена</button>
            </div>
        </Frame>
    );
}

function Fields({ d }: { d: Extract<Dialog, { kind: "fields"; }>; }) {
    const [vals, setVals] = useState<Record<string, string>>(d.initial);
    const set = (k: string, v: string) => setVals(x => ({ ...x, [k]: v }));
    const submit = () => d.resolve(vals);
    return (
        <Frame onEscape={() => d.resolve(null)}>
            <h4>{d.title} — заполните перед вставкой</h4>
            {d.fields.map((f, i) => (
                <div key={f.name} className="vc-stx-field">
                    <label>{f.name}</label>
                    {f.options.length
                        ? f.options.map(o => <button key={o} className={"vc-stx-opt" + (vals[f.name] === o ? " on" : "")} onClick={() => set(f.name, o)}>{o}</button>)
                        : <input
                            className="vc-stx-search" style={{ width: "100%", boxSizing: "border-box" }}
                            autoFocus={i === 0} value={vals[f.name] ?? ""}
                            onChange={e => set(f.name, e.currentTarget.value)}
                            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); submit(); } }} />}
                </div>
            ))}
            <div className="vc-stx-acts">
                <button className="vc-stx-btn" onClick={submit}>Вставить</button>
                <button className="vc-stx-btn vc-stx-ghost" onClick={() => d.resolve(null)}>Отмена</button>
            </div>
        </Frame>
    );
}

function Bind({ d }: { d: Extract<Dialog, { kind: "bind"; }>; }) {
    const t = store.byId(d.templateId);
    const close = () => ui.set({ dialog: null });
    useEffect(() => {
        const h = (e: KeyboardEvent) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.key === "Escape") return close();
            if (e.key === "Backspace" && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
                store.clearBind(d.templateId);
                toast("Клавиша снята", "message");
                return close();
            }
            const combo = comboOf(e);
            if (!combo) return; // waiting for the main key
            const problem = bindProblem(combo);
            if (problem) return toast(problem, "failure");
            const stolen = store.setBind(d.templateId, combo);
            toast(`${comboLabel(combo)} → «${t?.title}»` + (stolen ? ` (снята с «${store.byId(stolen)?.title}»)` : ""), "success");
            close();
        };
        document.addEventListener("keydown", h, true);
        return () => document.removeEventListener("keydown", h, true);
    }, []);
    return (
        <>
            <div className="vc-stx-backdrop" onMouseDown={close} />
            <div className="vc-stx-dialog">
                <h4>Клавиша для «{t?.title}»</h4>
                <p>Нажми сочетание: Ctrl/Alt/Win + клавиша или F1–F24.</p>
                <p className="vc-stx-hint">Esc — отмена · Backspace — снять клавишу</p>
            </div>
        </>
    );
}

export function Dialogs() {
    const { dialog } = ui.use();
    if (!dialog) return null;
    switch (dialog.kind) {
        case "askProject": return <AskProject d={dialog} />;
        case "confirm": return <Confirm d={dialog} />;
        case "fields": return <Fields d={dialog} />;
        case "bind": return <Bind d={dialog} />;
    }
}
```

- [ ] **Step 2: Поля в конвейере**

В `src/vencord/ui/flow.ts` добавить импорты и функцию, и поменять `prepareText`:
```ts
import { fieldsOf, fill } from "../core/tokens";
import { currentChannel, readClipboard } from "../platform";

/** Fills panel tokens; asks the user for fields. null = cancelled. */
export async function fillFields(title: string, text: string): Promise<string | null> {
    const fields = fieldsOf(text);
    let values: Record<string, string> = {};
    if (fields.length) {
        const initial: Record<string, string> = {};
        for (const f of fields) initial[f.name] = f.def || f.options[0] || "";
        const got = await new Promise<Record<string, string> | null>(resolve =>
            ui.set({ dialog: { kind: "fields", title, fields, initial, resolve: v => { ui.set({ dialog: null }); resolve(v); } } }));
        if (!got) return null;
        values = got;
    }
    const ch = currentChannel();
    const env = {
        now: new Date(),
        clipboard: text.includes("clipboard") ? await readClipboard() : "",
        selection: ui.get().selection,
        url: ch.id ? `https://discord.com/channels/${ch.guildId ?? "@me"}/${ch.id}` : "",
        title: ch.name,
    };
    return fill(text, values, env).text;
}
```
и в `prepareText` заменить последние две строки на:
```ts
    const raw = opts.noGreeting ? splitGreeting(g.text).body : stripMarker(g.text);
    const text = await fillFields(g.title, raw);
    return text === null ? null : { t: g, text };
```

- [ ] **Step 3: Подключить в хост**

`src/vencord/ui/Host.tsx` — добавить `import { Dialogs } from "./Dialogs";` и `<Dialogs />` последним элементом внутри `.vc-stx-root`.

- [ ] **Step 4: Синк, типы, сборка**

Run:
```bash
pnpm sync:vencord
cd C:/Users/oblako/dev/Vencord && npx tsc --noEmit -p . 2>&1 | grep -i userplugins/supportTemplates ; pnpm build
```
Expected: без ошибок, `Done`.

- [ ] **Step 5: Ручная проверка (Ctrl+R)**

- В ЛС или на постороннем сервере: вставка шаблона → «Это сервер какого проекта?»; ответ запоминается (в настройках виден), «Ни того ни другого» → в окне вкладки Majestic / Россия Онлайн, Tab переключает.
- На Мадже: поиском найти шаблон РО нельзя (скрыт) — проверить автоподбор через импорт тестового текста `## Россия Онлайн\n### Уникальный РО\nтекст` … вставка на Мадже через бинд → «Шаблон другого проекта», по умолчанию фокус на «Отмена».
- Импорт текста `### Тест полей\nПривет {{ник}}, сервер {{сервер|NY|Detroit}}, дата {{date+3d}}{|}` → вставка спрашивает ник и сервер, дата подставлена.
- ПКМ → «Назначить клавишу…» → Ctrl+Alt+F → вставляет; Backspace в окне назначения снимает; Ctrl+C отказывает.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(vencord): project question, warnings, token fields, key binding dialog"
```

---

### Task 9: Сборка ответа

**Files:**
- Create: `src/vencord/ui/ComposeBar.tsx`
- Modify: `src/vencord/ui/Host.tsx`, `src/vencord/index.tsx` (очистка при смене канала)

**Interfaces:**
- Consumes: `ui.compose: string[]`, `joinPieces`, `fillFields`, `insertText`, `activeEditor`, `chatAreaRect`, `onChannelChange`
- Produces: `ComposeBar()`

- [ ] **Step 1: Компонент**

`src/vencord/ui/ComposeBar.tsx`:
```tsx
/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useState } from "@webpack/common";

import { joinPieces } from "../core/compose";
import { activeEditor, chatAreaRect, insertText } from "../platform";
import { fillFields } from "./flow";
import { ProjectIcon } from "./ProjectIcon";
import { store, ui } from "./uiState";

export function ComposeBar() {
    const { compose } = ui.use();
    const [drag, setDrag] = useState<string | null>(null);
    if (!compose.length) return null;
    const rect = chatAreaRect();
    if (!rect) return null;
    const items = compose.map(id => store.byId(id)).filter(t => !!t);

    const move = (over: string) => {
        if (!drag || drag === over) return;
        const ids = compose.filter(x => x !== drag);
        ids.splice(ids.indexOf(over) + (compose.indexOf(drag) < compose.indexOf(over) ? 1 : 0), 0, drag);
        ui.set({ compose: ids });
    };

    const insertAll = async () => {
        const text = await fillFields("Ответ", joinPieces(items.map(t => t!.text)));
        if (text === null) return;
        activeEditor()?.focus();
        insertText(text);
        items.forEach(t => store.markUsed(t!.id));
        ui.set({ compose: [] });
    };

    return (
        <div
            className="vc-stx-compose"
            style={{ left: rect.left + 8, width: rect.width - 16, bottom: window.innerHeight - rect.top + 6 }}
            onMouseUp={() => setDrag(null)}
            onMouseLeave={() => setDrag(null)}
        >
            <span className="vc-stx-sec" style={{ margin: 0 }}>Ответ:</span>
            {items.map(t => (
                <span
                    key={t!.id}
                    className={"vc-stx-chip" + (drag === t!.id ? " drag" : "")}
                    onMouseDown={e => { e.preventDefault(); setDrag(t!.id); }}
                    onMouseEnter={() => move(t!.id)}
                    title="Перетащи, чтобы поменять порядок"
                >
                    <ProjectIcon project={t!.project} size={14} />{t!.title}
                    <button onMouseDown={e => e.stopPropagation()} onClick={() => ui.set({ compose: compose.filter(x => x !== t!.id) })}>✕</button>
                </span>
            ))}
            <span style={{ flex: 1 }} />
            <button className="vc-stx-btn vc-stx-ghost" onClick={() => ui.set({ compose: [] })}>Очистить</button>
            <button className="vc-stx-btn" onClick={insertAll}>Вставить всё</button>
        </div>
    );
}
```

- [ ] **Step 2: Подключить**

`Host.tsx`: `import { ComposeBar } from "./ComposeBar";` и `<ComposeBar />` перед `<ContextMenu />`.

`index.tsx`: в `start()` после рендера:
```tsx
        offChannel = onChannelChange(() => ui.set({ compose: [], inline: null, menu: null }));
```
объявить `let offChannel: (() => void) | null = null;` рядом с `host`, импортировать `onChannelChange` из `./platform`, в `stop()` добавить `offChannel?.(); offChannel = null;`.

- [ ] **Step 3: Синк, типы, сборка**

Run:
```bash
pnpm sync:vencord
cd C:/Users/oblako/dev/Vencord && npx tsc --noEmit -p . 2>&1 | grep -i userplugins/supportTemplates ; pnpm build
```
Expected: без ошибок, `Done`.

- [ ] **Step 4: Ручная проверка (Ctrl+R)**

- Shift+Enter на «Проблемы с соединением» и на «Запрос логов» → над строкой ввода полоска с двумя кусками; окно сдвинулось выше полоски.
- Перетаскивание меняет порядок; ✕ убирает кусок.
- «Вставить всё» → приветствие одно (из первого куска), куски через пустую строку.
- Переход в другой канал очищает полоску.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(vencord): answer composition bar"
```

---

### Task 10: Быстрый ввод «;команда» (состояние А)

**Files:**
- Create: `src/vencord/ui/inline.ts`, `src/vencord/ui/Inline.tsx`
- Modify: `src/vencord/index.tsx`, `src/vencord/ui/Host.tsx`

**Interfaces:**
- Consumes: `findTrigger`, `search`, `orderHits`, `prepareText`, `activeProject`, `poolFor`, `store`, `ui.inline`, `activeEditor`, `chatAreaRect`, `insertText`, `toast`
- Produces: inline.ts `startInline(): () => void`, `handleInlineKey(e: KeyboardEvent): boolean`, `acceptInline(i: number, noGreeting: boolean): Promise<void>`; `Inline()` component

- [ ] **Step 1: Контроллер**

`src/vencord/ui/inline.ts`:
```ts
/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { orderHits } from "../core/rank";
import { search } from "../core/search";
import { findTrigger } from "../core/trigger";
import { activeEditor, insertText, toast } from "../platform";
import { prepareText } from "./flow";
import { activeProject, poolFor, store, ui } from "./uiState";

function textBeforeCaret(ed: HTMLElement): string | null {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return null;
    const r = sel.getRangeAt(0);
    if (!ed.contains(r.startContainer)) return null;
    const pre = document.createRange();
    pre.selectNodeContents(ed);
    pre.setEnd(r.startContainer, r.startOffset);
    return pre.toString();
}

function check() {
    const ed = activeEditor();
    if (!ed || !ed.contains(document.activeElement)) return close();
    const before = textBeforeCaret(ed);
    const trig = before !== null ? findTrigger(before.split("\n").pop() ?? "", store.data.prefix) : null;
    if (!trig) return close();
    const { project } = activeProject();
    if (!project) {
        ui.set({ inline: { query: trig.query, length: trig.length, items: [], sel: 0, note: "Проект канала не выбран — открой окно (Ctrl+Alt+T)" } });
        return;
    }
    const hits = orderHits(search(poolFor(project), trig.query).hits, store.ctx()).slice(0, 6);
    const prev = ui.get().inline;
    ui.set({ inline: { query: trig.query, length: trig.length, items: hits.map(h => h.t), sel: prev?.query === trig.query ? prev.sel : 0, note: hits.length ? "" : "Ничего не найдено" } });
}

function close() {
    if (ui.get().inline) ui.set({ inline: null });
}

let raf = 0;
const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(check); };

export function startInline() {
    document.addEventListener("input", schedule, true);
    document.addEventListener("selectionchange", schedule);
    return () => {
        document.removeEventListener("input", schedule, true);
        document.removeEventListener("selectionchange", schedule);
        close();
    };
}

/** Selects the trigger text right before the caret so INSERT_TEXT replaces it. */
function selectTrigger(length: number): boolean {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return false;
    const node = sel.focusNode, off = sel.focusOffset;
    if (!node || node.nodeType !== Node.TEXT_NODE || off < length) return false;
    const r = document.createRange();
    r.setStart(node, off - length);
    r.setEnd(node, off);
    sel.removeAllRanges();
    sel.addRange(r);
    return true;
}

export async function acceptInline(i: number, noGreeting: boolean) {
    const st = ui.get().inline;
    const t = st?.items[i];
    if (!st || !t) return;
    ui.set({ inline: null });
    const ed = activeEditor();
    const prepared = await prepareText(t, { noGreeting }); // may open dialogs and steal focus
    if (!prepared) return;
    ed?.focus();
    await new Promise(r => setTimeout(r, 0));
    const trig = ed ? findTrigger((textBeforeCaret(ed) ?? "").split("\n").pop() ?? "", store.data.prefix) : null;
    const selected = !!trig && selectTrigger(trig.length);
    await new Promise(r => setTimeout(r, 30)); // let Slate pick up the DOM selection
    insertText(prepared.text);
    store.markUsed(prepared.t.id);
    if (!selected) toast(`Удалите «${store.data.prefix}${st.query}» вручную`, "message");
}

/** Keyboard while suggestions are shown. true = handled (event consumed). */
export function handleInlineKey(e: KeyboardEvent): boolean {
    const st = ui.get().inline;
    if (!st) return false;
    const n = st.items.length;
    if (e.key === "Escape") { ui.set({ inline: null }); return true; }
    if (!n) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        ui.set({ inline: { ...st, sel: (st.sel + (e.key === "ArrowDown" ? 1 : -1) + n) % n } });
        return true;
    }
    if (e.key === "Tab" || e.key === "Enter") {
        if (!e.repeat) void acceptInline(st.sel, e.key === "Tab" && e.shiftKey);
        return true;
    }
    return false;
}
```

- [ ] **Step 2: Подсказки**

`src/vencord/ui/Inline.tsx`:
```tsx
/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PROJECTS } from "../core/types";
import { chatAreaRect } from "../platform";
import { nqHighlight } from "./highlight";
import { acceptInline } from "./inline";
import { ProjectIcon } from "./ProjectIcon";
import { activeProject, ui } from "./uiState";

export function Inline() {
    const { inline, compose } = ui.use();
    if (!inline) return null;
    const rect = chatAreaRect();
    if (!rect) return null;
    const { project } = activeProject();
    return (
        <div className="vc-stx-pop" style={{ left: rect.left + 8, bottom: window.innerHeight - rect.top + 6 + (compose.length ? 48 : 0) }}>
            <div className="vc-stx-sec">Шаблоны{project ? " · " + PROJECTS[project].name : ""}</div>
            {inline.note && <div className="vc-stx-empty">{inline.note}</div>}
            {inline.items.map((t, i) => (
                <div
                    key={t.id}
                    className={"vc-stx-item" + (i === inline.sel ? " sel" : "")}
                    onMouseDown={e => { e.preventDefault(); void acceptInline(i, false); }}
                >
                    <div className="vc-stx-r">
                        <ProjectIcon project={t.project} />
                        <span className="vc-stx-nm">{nqHighlight(t.title, [inline.query.toLowerCase()])}</span>
                        {t.command && <span className="vc-stx-kb">{t.command}</span>}
                    </div>
                </div>
            ))}
            <div className="vc-stx-foot">Tab / Enter — подставить · Shift+Tab — без приветствия · ↑↓ · Esc</div>
        </div>
    );
}
```

- [ ] **Step 3: Подключить**

`Host.tsx`: `import { Inline } from "./Inline";` и `<Inline />` после `<ComposeBar />`.

`index.tsx`:
- импорт `import { handleInlineKey, startInline } from "./ui/inline";`
- в начале `onKey` после проверки диалога:
```tsx
    if (handleInlineKey(e)) {
        e.preventDefault();
        e.stopPropagation();
        return;
    }
```
- в `start()`: `offInline = startInline();`, переменная `let offInline: (() => void) | null = null;`, в `stop()`: `offInline?.(); offInline = null;`.

- [ ] **Step 4: Синк, типы, сборка**

Run:
```bash
pnpm sync:vencord
cd C:/Users/oblako/dev/Vencord && npx tsc --noEmit -p . 2>&1 | grep -i userplugins/supportTemplates ; pnpm build
```
Expected: без ошибок, `Done`.

- [ ] **Step 5: Ручная проверка (Ctrl+R) — главный риск задачи**

- В тикете Маджи набрать `;снр` → подсказки над полем, первая «Проблемы с соединением…».
- Tab → `;снр` **заменён** текстом шаблона (не дописан после). Если `;снр` остался — в консоли (Ctrl+Shift+I) проверить, что `selectTrigger` вернул true; при false — попробовать увеличить задержку 30 → 80 мс в `acceptInline`; если и так не заменяется, оставить тост «Удалите вручную» и записать в спек (открытый вопрос «замена триггера в Slate»).
- Shift+Tab — без приветствия. Enter при открытых подсказках не отправляет сообщение.
- Esc убирает подсказки, `;снр` остаётся текстом; `abc;снр` подсказок не даёт.
- Смена префикса в настройках на `.` → `.снр` работает, `;снр` нет.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(vencord): ;command inline suggestions in the chat input"
```

---

### Task 11: Итоговая проверка этапа

**Files:**
- Create: `README.md`

- [ ] **Step 1: Автотесты и типы**

Run: `pnpm test && pnpm typecheck`
Expected: все зелёные.

- [ ] **Step 2: README**

`README.md`:
````markdown
# SupportTemplates

Шаблоны ответов поддержки Majestic RP и Россия Онлайн в Discord (Vencord; BetterDiscord — этап 2).
Спек: `docs/superpowers/specs/2026-10-05-support-templates-design.md`.

## Разработка

```bash
pnpm install
pnpm test            # ядро (Vitest)
pnpm icons           # перегенерировать src/vencord/ui/icons.ts из assets/
pnpm sync:vencord    # скопировать плагин в C:/Users/oblako/dev/Vencord/src/userplugins/supportTemplates
cd C:/Users/oblako/dev/Vencord && pnpm build   # затем Ctrl+R в Discord
```

`VENCORD_DIR` переопределяет путь к Vencord. Vencord должен быть установлен из исходников (`pnpm inject`).
````

- [ ] **Step 3: Полный ручной прогон (пользователь)**

Чек-лист из спека, раздел 12 (платформа Vencord): кнопка, Ctrl+R-устойчивость, Ctrl+Alt+T, `;снр`+Tab, Alt+N с зажатием, длинный шаблон + Backspace, Маджа ↔ РО ↔ чужой сервер, автоподбор зеркала, предупреждение о чужом проекте, форма полей, сборка ответа, смена канала, импорт конфига 0.5.1. Найденное — в список багов и улучшений для следующего круга.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: README for stage 1"
```
