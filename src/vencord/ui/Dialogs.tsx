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
