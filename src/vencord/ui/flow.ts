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
