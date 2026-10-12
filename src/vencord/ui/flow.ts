/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { decide, foreignMarkers, ServerBinding } from "../core/guard";
import { splitGreeting, stripMarker } from "../core/text";
import { fieldsOf, fill } from "../core/tokens";
import { ProjectId, PROJECTS, Template } from "../core/types";
import { activeEditor, currentChannel, insertText, readClipboard, toast } from "../platform";
import { activeProject, Dialog, guildKey, store, ui } from "./uiState";

type ConfirmArgs = Omit<Extract<Dialog, { kind: "confirm"; }>, "kind" | "resolve">;

/** What an insert was prepared for: the channel and its project at the start of the flow. */
export interface Snap { channelId: string | null; project: ProjectId | null; }

/** true while the channel and its project are unchanged; otherwise toasts and the insert must be dropped. */
export function stillCurrent(s: Snap): boolean {
    if (currentChannel().id === s.channelId && activeProject().project === s.project) return true;
    toast("Канал сменился — вставка отменена", "failure");
    return false;
}

/** "project:id" of foreign templates the user explicitly confirmed (used by the compose bar). */
export const confirmedForeign = new Set<string>();

/** A new dialog must never orphan a pending one: cancel the open one (if it awaits an answer) first. */
export function supersede() {
    const d = ui.get().dialog;
    if (!d) return;
    if (d.kind === "askProject" || d.kind === "fields") d.resolve(null);
    else if (d.kind === "confirm") d.resolve({ ok: false, checked: false });
}

/** Opens a dialog whose resolve clears it only while it is still the current one. */
function open<T>(make: (resolve: (v: T) => void) => Dialog): Promise<T> {
    supersede();
    return new Promise<T>(resolve => {
        const dialog: Dialog = make(v => {
            if (ui.get().dialog === dialog) ui.set({ dialog: null });
            resolve(v);
        });
        ui.set({ dialog });
    });
}

export function confirm(args: ConfirmArgs): Promise<{ ok: boolean; checked: boolean; }> {
    return open(resolve => ({ kind: "confirm", ...args, resolve }));
}

function askProject(): Promise<ServerBinding | null> {
    return open(resolve => ({ kind: "askProject", resolve }));
}

/** Fills panel tokens; asks the user for fields. null = cancelled. */
export async function fillFields(title: string, text: string): Promise<string | null> {
    const fields = fieldsOf(text);
    let values: Record<string, string> = {};
    if (fields.length) {
        const initial: Record<string, string> = {};
        for (const f of fields) initial[f.name] = f.def || f.options[0] || "";
        const got = await open<Record<string, string> | null>(resolve => ({ kind: "fields", title, fields, initial, resolve }));
        if (!got) return null;
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

/** Project for this channel; asks once on an unknown server. null = nothing may be inserted. */
export async function ensureProject(): Promise<ProjectId | null> {
    const { project, binding } = activeProject();
    if (project) return project;
    if (binding === "none") {
        toast("На этом сервере выбери проект во вкладке окна шаблонов", "failure");
        return null;
    }
    const key = guildKey(); // the server asked about, even if the user switches while the dialog is open
    const ans = await askProject();
    if (!ans) return null;
    store.setGuild(key, ans);
    if (guildKey() !== key) return null;
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

export async function prepareText(t: Template, opts: { noGreeting?: boolean; } = {}): Promise<{ t: Template; text: string; snap: Snap; } | null> {
    const channelId = currentChannel().id;
    const project = await ensureProject();
    if (!project) return null;
    const g = await guard(t, project);
    if (!g) return null;
    const raw = opts.noGreeting ? splitGreeting(g.text).body : stripMarker(g.text);
    const text = await fillFields(g.title, raw);
    return text === null ? null : { t: g, text, snap: { channelId, project } };
}

export async function insertTemplate(t: Template, opts: { noGreeting?: boolean; } = {}) {
    ui.set({ windowOpen: false, menu: null });
    const r = await prepareText(t, opts);
    if (!r || !stillCurrent(r.snap)) return;
    activeEditor()?.focus();
    if (insertText(r.text)) store.markUsed(r.t.id);
}

export async function addToCompose(t: Template) {
    const channelId = currentChannel().id;
    const project = await ensureProject();
    if (!project) return;
    const g = await guard(t, project);
    if (!g || !stillCurrent({ channelId, project })) return;
    if (!ui.get().compose.includes(g.id)) ui.set({ compose: [...ui.get().compose, g.id] });
    toast("Добавлено в ответ: " + g.title, "message");
}
