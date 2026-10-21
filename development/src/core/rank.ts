/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Hit } from "./search";
import { Template, Usage, WindowTab } from "./types";

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
        { key: "fav", title: "Избранное", items: fav },
        { key: "recent", title: "Недавние", items: recent },
        ...cats,
    ].filter(s => s.items.length);
}

export function orderHits(hits: Hit[], ctx: RankCtx, generalFirst = false): Hit[] {
    const fav = new Set(ctx.favorites);
    const ranked = [...hits].sort((a, b) =>
        b.level - a.level
        || Number(fav.has(b.t.id)) - Number(fav.has(a.t.id))
        || popularity(b.t, ctx) - popularity(a.t, ctx));
    return generalFirst
        ? [...ranked.filter(h => h.t.source !== "personal"), ...ranked.filter(h => h.t.source === "personal")]
        : ranked;
}

/** Input is already permission/project scoped. Visibility options never change stored references. */
export function windowTabPool(pool: Template[], view: WindowTab, ctx: RankCtx, showPersonalInAll: boolean): Template[] {
    if (view === "personal") return pool.filter(t => t.source === "personal");
    if (view === "fav") return favoritesOf(pool, ctx);
    if (view === "recent") return recentOf(pool, ctx, 10);
    return showPersonalInAll ? pool : pool.filter(t => t.source !== "personal");
}

/** Last used templates, newest first (the "Недавние" tab). */
export function recentOf(pool: Template[], ctx: RankCtx, n: number): Template[] {
    const byId = new Map(pool.map(t => [t.id, t]));
    return ctx.recent.map(id => byId.get(id)).filter((t): t is Template => !!t).slice(0, n);
}

/** Distinct categories in first-seen order (category filter chips). */
export function categoriesOf(pool: Template[]): string[] {
    const seen = new Set<string>();
    for (const t of pool) if (t.category) seen.add(t.category);
    return [...seen];
}
