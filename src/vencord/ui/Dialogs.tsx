/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useEffect, useRef, useState } from "@webpack/common";

import { bindProblem, comboLabel, comboOf } from "../core/keys";
import { toast } from "../platform";
import { dlog } from "./debug";
import { latchKey } from "./keylatch";
import { Dialog, store, ui } from "./uiState";

function Frame({ children, onEscape }: { children: React.ReactNode; onEscape(): void; }) {
    useEffect(() => {
        const h = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onEscape(); } };
        document.addEventListener("keydown", h, true);
        return () => document.removeEventListener("keydown", h, true);
    }, []);
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        // Take focus away from Discord's chat editor unless a child already took it.
        if (ref.current && !ref.current.contains(document.activeElement)) ref.current.focus();
    }, []);
    return <><div className="vc-stx-backdrop" onMouseDown={onEscape} /><div
        className="vc-stx-dialog" ref={ref} tabIndex={-1}
        // Enter/Space here may confirm and insert: latch it so a held key never repeats into Discord.
        onKeyDownCapture={e => { if (e.key === "Enter" || e.key === " ") latchKey(e.nativeEvent.code); }}
    >{children}</div></>;
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
    const firstText = d.fields.find(f => !f.options.length);
    return (
        <Frame onEscape={() => d.resolve(null)}>
            <h4>{d.title} — заполните перед вставкой</h4>
            {d.fields.map(f => (
                <div key={f.name} className="vc-stx-field">
                    <label>{f.name}</label>
                    {f.options.length
                        ? f.options.map(o => <button key={o} className={"vc-stx-opt" + (vals[f.name] === o ? " on" : "")} onClick={() => set(f.name, o)}>{o}</button>)
                        : <input
                            className="vc-stx-search" style={{ width: "100%", boxSizing: "border-box" }}
                            autoFocus={f === firstText} value={vals[f.name] ?? ""}
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
    const close = () => { dlog("dialog-close", { kind: "bind", id: d.templateId }); ui.set({ dialog: null }); };
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
            toast(`${comboLabel(combo)} — «${t?.title}»` + (stolen ? ` (снята с «${store.byId(stolen)?.title}»)` : ""), "success");
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

// Each opened dialog mounts fresh (own state, own Escape handler).
const ids = new WeakMap<Dialog, number>();
let nextId = 0;
export const idOf = (d: Dialog) => { let n = ids.get(d); if (n === undefined) ids.set(d, n = ++nextId); return n; };

export function Dialogs() {
    const dialog = ui.useSelect(s => s.dialog);
    if (!dialog) return null;
    switch (dialog.kind) {
        case "confirm": return <Confirm key={idOf(dialog)} d={dialog} />;
        case "fields": return <Fields key={idOf(dialog)} d={dialog} />;
        case "bind": return <Bind key={idOf(dialog)} d={dialog} />;
    }
}
