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
import { generationNow, rememberComposeTarget, Target, targetNow } from "./op";
import { activeScope, currentMode, Dialog, ensureLibraryFresh, libraryIsFresh, Scope, store, ui } from "./uiState";

type ConfirmArgs = Omit<Extract<Dialog, { kind: "confirm"; }>, "kind" | "resolve">;
const supersededDialogs = new WeakSet<Dialog>();
let dialogSequence = 0;
let preparationSequence = 0;

/**
 * What an insert was prepared for, captured at the start of the flow (before dialogs take focus):
 * the channel and its server's scope (mj / ro / all), the target editor and draft, the selection, the plugin generation.
 */
export interface Snap { channelId: string | null; scope: Scope | null; gen: number; setVersion: number; editor: HTMLElement | null; draftText: string | null; selection: string; }

export function snapNow(target: Target): Snap {
    return { channelId: currentChannel().id, scope: activeScope(), gen: generationNow(), setVersion: store.setVersion, editor: target.editor, draftText: target.editor?.textContent ?? null, selection: target.selection };
}

/** true while the plugin, channel, scope, target editor and draft are unchanged; otherwise drop the insert. */
export function stillCurrent(s: Snap): boolean {
    if (!libraryIsFresh()) return false;
    if (s.gen !== generationNow()) { dlog("cancel", { reason: "плагин перезапущен или выключен" }); return false; }
    if (s.setVersion !== store.setVersion) {
        dlog("cancel", { reason: "шаблоны заменены импортом" });
        toast("Шаблоны заменены — вставка отменена", "failure");
        return false;
    }
    if (s.editor && !s.editor.isConnected) {
        dlog("cancel", { reason: "поле ввода, из которого начата вставка, закрылось" });
        toast("Поле ввода закрылось — вставка отменена", "failure");
        return false;
    }
    // Dialogs may own focus while preparing the answer; only a changed draft invalidates it here.
    if (s.editor && s.editor.textContent !== s.draftText) {
        dlog("cancel", { reason: "черновик изменился" });
        toast("Черновик изменился — выберите шаблон снова", "message");
        return false;
    }
    if (s.scope !== null && currentChannel().id === s.channelId && activeScope() === s.scope) return true;
    dlog("cancel", { reason: "канал сменился", wasChannel: s.channelId, wasScope: s.scope, nowChannel: currentChannel().id, nowScope: activeScope() });
    toast("Канал сменился — вставка отменена", "failure");
    return false;
}

/** Focus goes back to the editor the insert was started from (a thread in the side panel stays the target). */
export function focusTarget(s: Snap) {
    (s.editor ?? activeEditor())?.focus();
}

/** "project:id" of foreign templates the user explicitly confirmed (used by the compose bar). */
export const confirmedForeign = new Set<string>();

/** A new dialog must never orphan a pending one: cancel the open one (if it awaits an answer) first. */
export function supersede() {
    const d = ui.get().dialog;
    if (!d) return;
    supersededDialogs.add(d);
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
function open<T>(make: (resolve: (v: T) => void) => Dialog, onAnswer?: (v: T) => void): Promise<T> {
    supersede();
    ++dialogSequence;
    return new Promise<T>(resolve => {
        const dialog: Dialog = make(v => {
            if (debugEnabled()) dlog("dialog-close", { kind: dialog.kind, result: answerOf(dialog.kind, v), current: ui.get().dialog === dialog });
            if (ui.get().dialog === dialog) {
                ui.set({ dialog: null });
                if (!supersededDialogs.has(dialog)) onAnswer?.(v);
            }
            resolve(v);
        });
        if (debugEnabled()) dlog("dialog-open", { kind: dialog.kind, title: "title" in dialog ? dialog.title : undefined });
        ui.set({ dialog });
    });
}

export function confirm(args: ConfirmArgs, onCancel?: () => void): Promise<{ ok: boolean; checked: boolean; }> {
    return open<{ ok: boolean; checked: boolean; }>(resolve => ({ kind: "confirm", ...args, resolve }), r => { if (!r.ok) onCancel?.(); });
}

/** Fills panel tokens; asks the user for fields. null = cancelled. */
export async function fillFields(title: string, text: string, snap: Snap, onCancel?: () => void): Promise<string | null> {
    const fields = fieldsOf(text);
    let values: Record<string, string> = Object.create(null);
    if (fields.length) {
        const initial: Record<string, string> = Object.create(null); // a field named __proto__ is a field like any other
        for (const f of fields) initial[f.name] = f.def || f.options[0] || "";
        const got = await open<Record<string, string> | null>(resolve => ({ kind: "fields", title, fields, initial, resolve }), v => { if (v === null) onCancel?.(); });
        if (!got) { dlog("cancel", { reason: "отмена в диалоге полей", title }); return null; }
        values = got;
    }
    const ch = currentChannel();
    const clipboard = /\{\{\s*clipboard\s*[}=|]/i.test(text) ? await readClipboard() : "";
    if (clipboard === null) {
        toast("Не удалось прочитать буфер обмена — вставка отменена. Скопируйте текст и попробуйте снова.", "failure");
        return null;
    }
    const env = {
        now: new Date(),
        clipboard,
        selection: snap.selection,
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
async function guard(t: Template, scope: Scope, onCancel?: () => void): Promise<Template | null> {
    if (scope !== "all") {
        const g = await projectGuard(t, scope, onCancel);
        if (!g) return null;
        t = g;
    }
    return statusGuard(t, onCancel);
}

/** "Intentional mention" answer key: tied to the text, so an edited / re-imported template is checked again. */
function intentKey(t: Template): string {
    let h = 5381;
    for (let i = 0; i < t.text.length; i++) h = (h * 33 ^ t.text.charCodeAt(i)) >>> 0;
    return `${t.id}@${h.toString(36)}`;
}

/** Mirror / foreign / other-project markers for a project's server. */
async function projectGuard(t: Template, project: ProjectId, onCancel?: () => void): Promise<Template | null> {
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
        }, onCancel);
        if (!r.ok) { dlog("cancel", { reason: "отмена в диалоге: шаблон другого проекта", id: t.id }); return null; }
        confirmedForeign.add(`${project}:${t.id}`);
        return t; // confirmed as the other project's: naming that project is expected, no second warning
    }

    // Local and personal texts are checked whatever group/project they came with (a RO-group template may still
    // name Majestic); panel FAQ texts are reviewed on the panel.
    if (t.source !== "faq" && !store.isIntentional(intentKey(t))) {
        const found = foreignMarkers(t.text, project);
        if (found.length) {
            const r = await confirm({
                tone: "warn", label: "Упоминается другой проект",
                title: t.title,
                body: `В тексте есть: ${found.join(", ")}. Канал — ${PROJECTS[project].name}.`,
                ok: "Вставить", checkbox: "Это намеренно, больше не спрашивать",
            }, onCancel);
            if (!r.ok) { dlog("cancel", { reason: "отмена в диалоге: упоминается другой проект", id: t.id, markers: found.join(", ") }); return null; }
            if (r.checked) store.markIntentional(intentKey(t));
        }
    }
    return t;
}

async function statusGuard(t: Template, onCancel?: () => void): Promise<Template | null> {
    if (t.status !== "actual") {
        const r = await confirm({
            tone: "danger", label: t.status === "outdated" ? "Шаблон помечен «Устарело»" : "Шаблон на проверке",
            title: t.title,
            body: (t.statusNote ? `Комментарий: «${t.statusNote}». ` : "") + "Проверьте текст, прежде чем отправлять игроку.",
            ok: "Вставить всё равно",
        }, onCancel);
        if (!r.ok) { dlog("cancel", { reason: "отмена в диалоге: статус " + t.status, id: t.id }); return null; }
    }
    return t;
}

export async function prepareText(t: Template, target: Target, opts: { noGreeting?: boolean; } = {}): Promise<{ t: Template; text: string; snap: Snap; } | null> {
    const operation = ++preparationSequence;
    if (store.byId(t.id) !== t) return null;
    const snap = snapNow(target);
    let cancelledDialog: number | null = null;
    const onCancel = () => { cancelledDialog = dialogSequence; };
    // Restore only a user's cancellation. Supersession and newer operations must never steal focus.
    const restoreCancelledFocus = () => {
        const state = ui.get();
        if (cancelledDialog === null || cancelledDialog !== dialogSequence || operation !== preparationSequence
            || state.dialog || state.management || state.windowOpen || !snap.editor?.isConnected
            || snap.gen !== generationNow() || snap.channelId !== currentChannel().id
            || snap.scope === null || snap.scope !== activeScope()) return;
        const focused = document.activeElement;
        if (focused === document.body || focused?.closest(".vc-stx-dialog")) snap.editor.focus();
    };
    if ((!libraryIsFresh() && !await ensureLibraryFresh()) || !stillCurrent(snap)) return null;
    const scope = scopeHere();
    if (!scope) return null;
    const g = await guard(t, scope, onCancel);
    if (!g) { restoreCancelledFocus(); return null; }
    if (store.byId(g.id) !== g || !stillCurrent(snap)) return null;
    const raw = opts.noGreeting ? splitGreeting(g.text).body : stripMarker(g.text);
    const text = await fillFields(g.title, raw, snap, onCancel);
    if (text === null) { restoreCancelledFocus(); return null; }
    return (!libraryIsFresh() && !await ensureLibraryFresh()) || store.byId(g.id) !== g || !stillCurrent(snap) ? null : { t: g, text, snap };
}

/** `via` — where the insert came from, for the debug log only. */
export async function insertTemplate(t: Template, opts: { noGreeting?: boolean; via?: string; } = {}) {
    dlog("insert-start", { id: t.id, title: t.title, via: opts.via ?? "?", noGreeting: opts.noGreeting || undefined });
    const target = targetNow(); // before the window closes: its target is the editor it was opened from
    ui.set({ windowOpen: false, menu: null });
    const r = await prepareText(t, target, opts);
    if (!r || !stillCurrent(r.snap)) return;
    focusTarget(r.snap);
    const ok = insertText(r.text);
    dlog("insert", { id: r.t.id, title: r.t.title, via: opts.via ?? "?", ok });
    if (!ok) dlog("error", { where: "insertText", id: r.t.id });
    if (ok) store.markUsed(r.t.id);
}

export async function addToCompose(t: Template) {
    if (store.byId(t.id) !== t) return;
    const snap = snapNow(targetNow());
    if ((!libraryIsFresh() && !await ensureLibraryFresh()) || !stillCurrent(snap)) return;
    const scope = scopeHere();
    if (!scope) return;
    const g = await guard(t, scope);
    if (!g || store.byId(g.id) !== g || !stillCurrent(snap)) return;
    rememberComposeTarget();
    dlog("compose-add", { id: g.id, title: g.title, already: ui.get().compose.includes(g.id) || undefined });
    if (!ui.get().compose.includes(g.id)) ui.set({ compose: [...ui.get().compose, g.id] });
    toast("Добавлено в ответ: " + g.title, "message");
}
