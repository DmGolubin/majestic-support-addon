/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ServerBinding } from "./guard";
import { importBackup, parseRaw } from "./importer";
import { bindProblem, cleanBinds } from "./keys";
import { PersonalDraft, PersonalFolder, PersonalTemplate, personalTemplate, readFolders, readPersonal } from "./personal";
import { RankCtx } from "./rank";
import { validPrefix } from "./trigger";
import { ProjectId, Template, Usage } from "./types";

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
    /** Legacy answers of the removed "which project?" dialog: kept in the shape for old saves, never read. */
    guilds: Record<string, ServerBinding>;
    intentional: string[];
    prefix: string;
    previewOpen: boolean;
    /** Tech server: which project's templates the window, Alt+1…9, binds and suggestions use. Not part of an import. */
    techProject: ProjectId;
    personal: PersonalTemplate[];
    folders: PersonalFolder[];
}

export const STORE_KEY = "SupportTemplates_v2";
/** Key used by the Vencord spike (raw/usage/pinned/tabs). */
export const LEGACY_KEY = "SupportTemplates_data";

const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * A saved object made safe field by field: wrong types fall back to defaults (a broken field never takes the
 * others down), binds pass the same rules as new ones. fixed = something had to be repaired.
 */
export function sanitize(saved: Record<string, unknown>, templates: Template[]): { data: Persisted; fixed: string[]; } {
    const d = empty();
    d.folders = readFolders(saved.folders);
    d.personal = readPersonal(saved.personal, d.folders);
    const fixed: string[] = [];
    for (const k of ["personal", "folders"] as const) {
        if (k in saved && (!Array.isArray(saved[k]) || (saved[k] as unknown[]).length !== d[k].length)) fixed.push(k);
    }
    const take = <K extends keyof Persisted>(k: K, ok: boolean, v: Persisted[K]) => {
        if (ok) d[k] = v; else if (k in saved) fixed.push(k);
    };
    take("raw", typeof saved.raw === "string", saved.raw as string);
    for (const k of ["favorites", "recent", "intentional"] as const) {
        const v = saved[k];
        take(k, Array.isArray(v), strings(v));
        if (Array.isArray(v) && strings(v).length !== v.length) fixed.push(k);
    }
    const usage: Record<string, Usage> = {};
    if (isRecord(saved.usage)) {
        for (const [id, u] of Object.entries(saved.usage)) {
            const n = isRecord(u) ? Math.floor(Number(u.n)) : NaN;
            if (n > 0) usage[id] = { n, last: Number((u as any).last) || 0 };
        }
    } else if ("usage" in saved) fixed.push("usage");
    d.usage = usage;
    const ids = new Set([...templates, ...d.personal].map(t => t.id));
    const b = cleanBinds(saved.binds, ids);
    d.binds = b.binds;
    if (b.dropped || ("binds" in saved && !isRecord(saved.binds))) fixed.push("binds");
    take("guilds", isRecord(saved.guilds), saved.guilds as Persisted["guilds"]);
    take("prefix", validPrefix(saved.prefix), saved.prefix as string);
    take("previewOpen", typeof saved.previewOpen === "boolean", saved.previewOpen as boolean);
    take("techProject", saved.techProject === "mj" || saved.techProject === "ro", saved.techProject as ProjectId);
    return { data: d, fixed };
}

const empty = (): Persisted => ({
    v: 2, raw: "", favorites: [], recent: [], usage: {}, binds: {}, guilds: {}, intentional: [], prefix: ";", previewOpen: true, techProject: "mj", personal: [], folders: [],
});

export class Store {
    data: Persisted = empty();
    templates: Template[] = [];
    /** Bumped whenever the template set is replaced (import): work prepared from an older set must not insert. */
    setVersion = 0;
    private subs = new Set<() => void>();
    private lastSave: Promise<void> = Promise.resolve();

    constructor(private storage: StorageLike, readonly catalogReadOnly = false) { }

    private writableCatalog() {
        if (this.catalogReadOnly) throw new Error("Библиотека панели доступна только для чтения");
    }

    /** A validated, complete server snapshot. Never merges stale/local records into an account. */
    replacePanelCatalog(catalog: { templates: Template[]; personal: PersonalTemplate[]; folders: PersonalFolder[]; }) {
        if (!this.catalogReadOnly) throw new Error("Для библиотеки панели нужно отдельное хранилище");
        const ids = new Set(catalog.templates.map(t => t.id));
        this.data = { ...this.data, raw: "", personal: catalog.personal, folders: catalog.folders,
            favorites: this.data.favorites.filter(id => ids.has(id)), recent: this.data.recent.filter(id => ids.has(id)),
            usage: Object.fromEntries(Object.entries(this.data.usage).filter(([id]) => ids.has(id))),
            binds: Object.fromEntries(Object.entries(this.data.binds).filter(([id]) => ids.has(id))), intentional: [] };
        this.templates = catalog.templates;
        this.setVersion++;
        this.subs.forEach(fn => fn());
    }

    flush() { return this.lastSave; }

    subscribe(fn: () => void) {
        this.subs.add(fn);
        return () => void this.subs.delete(fn);
    }

    private changed() {
        const snapshot = structuredClone(this.data);
        this.lastSave = this.lastSave.catch(() => {}).then(() => this.storage.set(STORE_KEY, snapshot));
        this.lastSave.catch(e => console.error("[SupportTemplates]", e));
        this.subs.forEach(fn => fn());
    }

    async load() {
        const saved = await this.storage.get(STORE_KEY) as Record<string, unknown> | undefined;
        if (isRecord(saved) && saved.v === 2) {
            this.templates = parseRaw(typeof saved.raw === "string" ? saved.raw : "");
            const { data, fixed } = sanitize(saved, this.templates);
            this.data = data;
            this.templates = [...this.templates, ...data.personal];
            if (fixed.length) {
                // Keep the damaged original next to the repaired one, then save the repaired data.
                console.warn("[SupportTemplates] saved data repaired:", fixed.join(", "));
                await this.storage.set(STORE_KEY + "_damaged", saved).catch(() => { });
                this.storage.set(STORE_KEY, this.data).catch(e => console.error("[SupportTemplates]", e));
            }
        } else {
            const legacy = await this.storage.get(LEGACY_KEY) as { raw?: string; } | undefined;
            if (legacy && typeof legacy.raw === "string" && legacy.raw.trim()) {
                try { this.importText(JSON.stringify(legacy)); return; } catch (e) { console.error("[SupportTemplates] legacy data not imported", e); /* start empty */ }
            }
        }
        this.subs.forEach(fn => fn());
    }

    /** Replaces templates; favorites/usage/binds come from the file. Returns a summary line. */
    importText(text: string): string {
        this.writableCatalog();
        const r = importBackup(text);
        // "Intentional mention" answers belonged to the old texts: they are not carried over to the new set.
        const own = new Set(this.data.personal.map(t => t.id));
        // Existing personal shortcuts win over imported FAQ shortcuts using the same combination.
        const mergedBinds = cleanBinds({
            ...Object.fromEntries(Object.entries(this.data.binds).filter(([id]) => own.has(id))),
            ...Object.fromEntries(Object.entries(r.binds).filter(([id]) => !own.has(id)))
        }, new Set([...r.templates, ...this.data.personal].map(t => t.id)));
        this.data = { ...this.data, raw: r.raw,
            favorites: [...r.favorites, ...this.data.favorites.filter(id => own.has(id))],
            usage: { ...r.usage, ...Object.fromEntries(Object.entries(this.data.usage).filter(([id]) => own.has(id))) },
            binds: mergedBinds.binds,
            recent: this.data.recent.filter(id => own.has(id)), intentional: [] };
        this.templates = [...r.templates, ...this.data.personal];
        this.setVersion++;
        this.changed();
        const mj = r.templates.filter(t => t.project === "mj").length;
        const ro = r.templates.filter(t => t.project === "ro").length;
        return `Шаблонов: ${r.templates.length} (Majestic ${mj}, Россия Онлайн ${ro}), избранных: ${r.favorites.length}`
            + (r.dupes ? ` · повторяющихся названий: ${r.dupes} (получили номер)` : "")
            + (r.droppedBinds + mergedBinds.dropped ? ` · клавиш не принято: ${r.droppedBinds + mergedBinds.dropped} (запрещённые или повторы)` : "");
    }

    byId(id: string) {
        return this.templates.find(t => t.id === id);
    }

    /** Demo transport catalog: stable IDs and local preferences survive refresh; real storage is never selected here. */
    replaceDemoCatalog(raw: string) {
        this.writableCatalog();
        const templates = parseRaw(raw).map(t => ({ ...t, source: "faq" as const }));
        this.data.raw = raw;
        this.templates = [...templates, ...this.data.personal];
        this.setVersion++;
        this.changed();
    }

    private personalChanged() {
        this.templates = [...this.templates.filter(t => !t.id.startsWith("personal:")), ...this.data.personal];
        this.setVersion++;
        this.changed();
        return this.lastSave;
    }

    async savePersonal(draft: PersonalDraft, id?: string, createId?: string) {
        this.writableCatalog();
        if (id && !this.data.personal.some(t => t.id === id)) throw new Error("Личный шаблон больше не существует");
        if (createId && (!createId.startsWith("personal:") || this.byId(createId))) throw new Error("Недопустимый ID нового шаблона");
        const t = personalTemplate(id ?? createId ?? "personal:" + crypto.randomUUID(), draft, this.data.folders);
        if (t.command && this.templates.some(x => x.id !== t.id && x.command?.toLowerCase() === t.command && (x.project === null || t.project === null || x.project === t.project))) {
            throw new Error("Эта команда уже используется в выбранном проекте");
        }
        this.data.personal = [...this.data.personal.filter(x => x.id !== t.id), t];
        await this.personalChanged();
        return t.id;
    }

    async deletePersonal(id: string) {
        this.writableCatalog();
        // Deletion is idempotent, including a retry after a failed disk write.
        if (!id.startsWith("personal:")) throw new Error("Можно удалить только личный шаблон");
        this.data.personal = this.data.personal.filter(t => t.id !== id);
        this.data.favorites = this.data.favorites.filter(x => x !== id);
        this.data.recent = this.data.recent.filter(x => x !== id);
        const { [id]: _bind, ...binds } = this.data.binds;
        const { [id]: _usage, ...usage } = this.data.usage;
        this.data.binds = binds;
        this.data.usage = usage;
        await this.personalChanged();
    }

    async saveFolder(name: string, id?: string, createId?: string) {
        this.writableCatalog();
        name = name.trim();
        if (!name || name.length > 80) throw new Error("Название папки: от 1 до 80 символов");
        if (id && !this.data.folders.some(f => f.id === id)) throw new Error("Папка больше не существует");
        if (this.data.folders.some(f => f.id !== id && f.name.toLowerCase() === name.toLowerCase())) throw new Error("Такая папка уже есть");
        if (createId && (!createId.startsWith("folder:") || this.data.folders.some(f => f.id === createId))) throw new Error("Недопустимый ID папки");
        const folderId = id ?? createId ?? "folder:" + crypto.randomUUID();
        this.data.folders = [...this.data.folders.filter(f => f.id !== folderId), { id: folderId, name }];
        this.data.personal = this.data.personal.map(t => t.folderId === folderId ? { ...t, category: name } : t);
        await this.personalChanged();
        return folderId;
    }

    async deleteFolder(id: string) {
        this.writableCatalog();
        this.data.folders = this.data.folders.filter(f => f.id !== id);
        this.data.personal = this.data.personal.map(t => t.folderId === id ? { ...t, folderId: null, category: "Мои шаблоны" } : t);
        await this.personalChanged();
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

    isIntentional(id: string) {
        return this.data.intentional.includes(id);
    }

    markIntentional(id: string) {
        if (!this.isIntentional(id)) this.data.intentional = [...this.data.intentional, id];
        this.changed();
    }

    setPrefix(p: string) {
        if (!validPrefix(p)) throw new Error("Используйте один символ: ! # $ % & * + . , : ; = ? ^ ~ _ -");
        this.data.prefix = p;
        this.changed();
    }

    setPreviewOpen(b: boolean) {
        this.data.previewOpen = b;
        this.changed();
    }

    setTechProject(p: ProjectId) {
        if (p !== "mj" && p !== "ro") throw new Error("Проект: mj или ro");
        if (this.data.techProject === p) return;
        this.data.techProject = p;
        this.changed();
    }
}
