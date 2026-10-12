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

/** A new dialog must never orphan a pending one: cancel the open one (if it awaits an answer) first. */
function supersede() {
    const d = ui.get().dialog;
    if (!d) return;
    if (d.kind === "askProject" || d.kind === "fields") d.resolve(null);
    else if (d.kind === "confirm") d.resolve({ ok: false, checked: false });
}

export function confirm(args: ConfirmArgs): Promise<{ ok: boolean; checked: boolean; }> {
    supersede();
    return new Promise(resolve => ui.set({ dialog: { kind: "confirm", ...args, resolve: v => { ui.set({ dialog: null }); resolve(v); } } }));
}

function askProject(): Promise<ServerBinding | null> {
    supersede();
    return new Promise(resolve => ui.set({ dialog: { kind: "askProject", resolve: v => { ui.set({ dialog: null }); resolve(v); } } }));
}

/** Fills panel tokens; asks the user for fields. null = cancelled. */
export async function fillFields(title: string, text: string): Promise<string | null> {
    const fields = fieldsOf(text);
    let values: Record<string, string> = {};
    if (fields.length) {
        const initial: Record<string, string> = {};
        for (const f of fields) initial[f.name] = f.def || f.options[0] || "";
        supersede();
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
    const raw = opts.noGreeting ? splitGreeting(g.text).body : stripMarker(g.text);
    const text = await fillFields(g.title, raw);
    return text === null ? null : { t: g, text };
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
