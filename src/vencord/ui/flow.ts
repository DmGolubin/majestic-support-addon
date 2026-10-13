/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { decide, foreignMarkers } from "../core/guard";
import { splitGreeting, stripMarker } from "../core/text";
import { fieldsOf, fill } from "../core/tokens";
import { ProjectId, PROJECTS, Template } from "../core/types";
import { activeEditor, currentChannel, insertText, readClipboard, toast } from "../platform";
import { debugEnabled, dlog } from "./debug";
import { activeScope, currentMode, Dialog, Scope, store, ui } from "./uiState";

type ConfirmArgs = Omit<Extract<Dialog, { kind: "confirm"; }>, "kind" | "resolve">;

/** What an insert was prepared for: the channel and its server's scope (mj / ro / all) at the start of the flow. */
export interface Snap { channelId: string | null; scope: Scope | null; }

/** true while the channel and its scope are unchanged; otherwise toasts and the insert must be dropped. */
export function stillCurrent(s: Snap): boolean {
    if (s.scope !== null && currentChannel().id === s.channelId && activeScope() === s.scope) return true;
    dlog("cancel", { reason: "канал сменился", wasChannel: s.channelId, wasScope: s.scope, nowChannel: currentChannel().id, nowScope: activeScope() });
    toast("Канал сменился — вставка отменена", "failure");
    return false;
}

/** "project:id" of foreign templates the user explicitly confirmed (used by the compose bar). */
export const confirmedForeign = new Set<string>();

/** A new dialog must never orphan a pending one: cancel the open one (if it awaits an answer) first. */
export function supersede() {
    const d = ui.get().dialog;
    if (!d) return;
    dlog("dialog-supersede", { kind: d.kind });
    if (d.kind === "fields") d.resolve(null);
    else if (d.kind === "confirm") d.resolve({ ok: false, checked: false });
}

/** Debug summary of a dialog answer — never field values. */
function answerOf(kind: Dialog["kind"], v: unknown): string {
    if (v === null) return "отмена";
    if (kind === "confirm") { const r = v as { ok: boolean; checked: boolean; }; return r.ok ? "ok" + (r.checked ? " +галочка" : "") : "отмена"; }
    if (kind === "fields") return "заполнено";
    return String(v);
}

/** Opens a dialog whose resolve clears it only while it is still the current one. */
function open<T>(make: (resolve: (v: T) => void) => Dialog): Promise<T> {
    supersede();
    return new Promise<T>(resolve => {
        const dialog: Dialog = make(v => {
            if (debugEnabled()) dlog("dialog-close", { kind: dialog.kind, result: answerOf(dialog.kind, v), current: ui.get().dialog === dialog });
            if (ui.get().dialog === dialog) ui.set({ dialog: null });
            resolve(v);
        });
        if (debugEnabled()) dlog("dialog-open", { kind: dialog.kind, title: "title" in dialog ? dialog.title : undefined });
        ui.set({ dialog });
    });
}

export function confirm(args: ConfirmArgs): Promise<{ ok: boolean; checked: boolean; }> {
    return open(resolve => ({ kind: "confirm", ...args, resolve }));
}

/** Fills panel tokens; asks the user for fields. null = cancelled. */
export async function fillFields(title: string, text: string): Promise<string | null> {
    const fields = fieldsOf(text);
    let values: Record<string, string> = {};
    if (fields.length) {
        const initial: Record<string, string> = {};
        for (const f of fields) initial[f.name] = f.def || f.options[0] || "";
        const got = await open<Record<string, string> | null>(resolve => ({ kind: "fields", title, fields, initial, resolve }));
        if (!got) { dlog("cancel", { reason: "отмена в диалоге полей", title }); return null; }
        values = got;
    }
    const ch = currentChannel();
    const env = {
        now: new Date(),
        clipboard: /\{\{\s*clipboard\s*[}=|]/i.test(text) ? await readClipboard() : "",
        selection: ui.get().selection,
        url: ch.id ? `https://discord.com/channels/${ch.guildId ?? "@me"}/${ch.id}` : "",
        title: ch.name,
    };
    return fill(text, values, env).text;
}

/** Scope of this channel's server; null (logged) where the plugin is off — nothing may be inserted. */
function scopeHere(): Scope | null {
    const scope = activeScope();
    if (!scope) dlog("cancel", { reason: "плагин выключен на этом сервере", mode: currentMode() });
    return scope;
}

/**
 * Guard + warnings. Returns the template to use (maybe a mirror) or null when cancelled.
 * On Tech ("all") any template is fine (the switch only filters the list): no mirror, no foreign/marker warnings — only the status check.
 */
async function guard(t: Template, scope: Scope): Promise<Template | null> {
    if (scope !== "all") {
        const g = await projectGuard(t, scope);
        if (!g) return null;
        t = g;
    }
    return statusGuard(t);
}

/** Mirror / foreign / other-project markers for a project's server. */
async function projectGuard(t: Template, project: ProjectId): Promise<Template | null> {
    const d = decide(t, project, store.templates);
    if (d.kind === "mirror") {
        dlog("guard", { result: "зеркало", from: t.id, to: d.t.id, project });
        toast(`Вставлен вариант для ${PROJECTS[project].short}`, "message");
        t = d.t;
    } else if (d.kind === "foreign") {
        const r = await confirm({
            tone: "danger", label: "Шаблон другого проекта",
            title: t.title,
            body: `Это шаблон ${PROJECTS[t.project!].name}, а канал — ${PROJECTS[project].name}. Пары для ${PROJECTS[project].short} нет.`,
            ok: `Да, вставить шаблон ${PROJECTS[t.project!].short}`,
        });
        if (!r.ok) { dlog("cancel", { reason: "отмена в диалоге: шаблон другого проекта", id: t.id }); return null; }
        confirmedForeign.add(`${project}:${t.id}`);
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
            if (!r.ok) { dlog("cancel", { reason: "отмена в диалоге: упоминается другой проект", id: t.id, markers: found.join(", ") }); return null; }
            if (r.checked) store.markIntentional(t.id);
        }
    }
    return t;
}

async function statusGuard(t: Template): Promise<Template | null> {
    if (t.status !== "actual") {
        const r = await confirm({
            tone: "danger", label: t.status === "outdated" ? "Шаблон помечен «Устарело»" : "Шаблон на проверке",
            title: t.title,
            body: (t.statusNote ? `Комментарий: «${t.statusNote}». ` : "") + "Проверьте текст, прежде чем отправлять игроку.",
            ok: "Вставить всё равно",
        });
        if (!r.ok) { dlog("cancel", { reason: "отмена в диалоге: статус " + t.status, id: t.id }); return null; }
    }
    return t;
}

export async function prepareText(t: Template, opts: { noGreeting?: boolean; } = {}): Promise<{ t: Template; text: string; snap: Snap; } | null> {
    const channelId = currentChannel().id;
    const scope = scopeHere();
    if (!scope) return null;
    const g = await guard(t, scope);
    if (!g) return null;
    const raw = opts.noGreeting ? splitGreeting(g.text).body : stripMarker(g.text);
    const text = await fillFields(g.title, raw);
    return text === null ? null : { t: g, text, snap: { channelId, scope } };
}

/** `via` — where the insert came from, for the debug log only. */
export async function insertTemplate(t: Template, opts: { noGreeting?: boolean; via?: string; } = {}) {
    dlog("insert-start", { id: t.id, title: t.title, via: opts.via ?? "?", noGreeting: opts.noGreeting || undefined });
    ui.set({ windowOpen: false, menu: null });
    const r = await prepareText(t, opts);
    if (!r || !stillCurrent(r.snap)) return;
    activeEditor()?.focus();
    const ok = insertText(r.text);
    dlog("insert", { id: r.t.id, title: r.t.title, via: opts.via ?? "?", ok });
    if (!ok) dlog("error", { where: "insertText", id: r.t.id });
    if (ok) store.markUsed(r.t.id);
}

export async function addToCompose(t: Template) {
    const channelId = currentChannel().id;
    const scope = scopeHere();
    if (!scope) return;
    const g = await guard(t, scope);
    if (!g || !stillCurrent({ channelId, scope })) return;
    dlog("compose-add", { id: g.id, title: g.title, already: ui.get().compose.includes(g.id) || undefined });
    if (!ui.get().compose.includes(g.id)) ui.set({ compose: [...ui.get().compose, g.id] });
    toast("Добавлено в ответ: " + g.title, "message");
}
