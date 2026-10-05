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
