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

function Frame({ children, onEscape, label }: { children: React.ReactNode; onEscape(): void; label: string; }) {
    useEffect(() => {
        const h = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); e.stopPropagation(); onEscape(); } };
        document.addEventListener("keydown", h, true);
        return () => document.removeEventListener("keydown", h, true);
    }, []);
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        // Take focus away from Discord's chat editor unless a child already took it.
        if (ref.current && !ref.current.contains(document.activeElement)) ref.current.focus();
    }, []);
    return <><div className="vc-stx-backdrop" onMouseDown={onEscape} /><div
        className="vc-stx-dialog" ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={label}
        // Enter/Space here may confirm and insert: latch it so a held key never repeats into Discord.
        onKeyDownCapture={e => { if ((e.key === "Enter" || e.key === " ") && !e.nativeEvent.isComposing) latchKey(e.nativeEvent.code); }}
    >{children}</div></>;
}

function Confirm({ d }: { d: Extract<Dialog, { kind: "confirm"; }>; }) {
    const [checked, setChecked] = useState(false);
    const cancelRef = useRef<HTMLButtonElement>(null);
    useEffect(() => { cancelRef.current?.focus(); }, []); // safe default: Enter = cancel
    return (
        <Frame label={d.title} onEscape={() => d.resolve({ ok: false, checked })}>
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
        <Frame label={`${d.title} — заполните перед вставкой`} onEscape={() => d.resolve(null)}>
            <h4>{d.title} — заполните перед вставкой</h4>
            {d.fields.map((f, index) => (
                <div key={f.name} className="vc-stx-field" role={f.options.length ? "group" : undefined} aria-labelledby={f.options.length ? `stx-field-${idOf(d)}-${index}-label` : undefined}>
                    <label id={`stx-field-${idOf(d)}-${index}-label`} htmlFor={f.options.length ? undefined : `stx-field-${idOf(d)}-${index}`}>{f.name}</label>
                    {f.options.length
                        ? f.options.map(o => <button key={o} aria-pressed={vals[f.name] === o} className={"vc-stx-opt" + (vals[f.name] === o ? " on" : "")} onClick={() => set(f.name, o)}>{o}</button>)
                        : <input
                            id={`stx-field-${idOf(d)}-${index}`}
                            className="vc-stx-search" style={{ width: "100%", boxSizing: "border-box" }}
                            autoFocus={f === firstText} value={vals[f.name] ?? ""}
                            onChange={e => set(f.name, e.currentTarget.value)}
                            onKeyDown={e => { if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); submit(); } }} />}
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
    const [t] = useState(() => store.byId(d.templateId));
    const [mode, setMode] = useState(() => store.bindModeFor(d.templateId));
    const modeRef = useRef(mode);
    modeRef.current = mode;
    const [conflict, setConflict] = useState<{ combo: string; ownerId: string; title: string; } | null>(null);
    const conflictRef = useRef(conflict);
    conflictRef.current = conflict;
    const ref = useRef<HTMLDivElement>(null);
    const close = () => {
        if (ui.get().dialog !== d) return;
        dlog("dialog-close", { kind: "bind", id: d.templateId }); ui.set({ dialog: null });
    };
    const current = () => {
        if (ui.get().dialog !== d) return false;
        if (t && store.byId(d.templateId) === t) return true;
        toast("Шаблон изменился — откройте назначение клавиш снова", "failure"); close(); return false;
    };
    const assign = (combo: string, confirmedOwner?: string) => {
        if (!current()) return;
        const owner = store.templateForCombo(combo);
        if (owner && owner.id !== d.templateId && owner.id !== confirmedOwner) {
            setConflict({ combo, ownerId: owner.id, title: owner.title });
            return;
        }
        store.setBind(d.templateId, combo, modeRef.current);
        toast(`${comboLabel(combo)} — «${t?.title}»`, "success");
        close();
    };
    const remove = () => {
        if (!current()) return;
        store.clearBind(d.templateId); toast("Клавиша снята", "message"); close();
    };
    useEffect(() => {
        ref.current?.focus();
        const h = (e: KeyboardEvent) => {
            if (e.isComposing || e.keyCode === 229 || e.getModifierState?.("AltGraph")) return;
            // Keep native navigation/activation for the explicit cancel/remove/reassign controls.
            if (e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey) {
                const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? []);
                if (buttons.length) {
                    e.preventDefault(); e.stopPropagation();
                    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
                    const next = i < 0 ? (e.shiftKey ? buttons.length - 1 : 0)
                        : (i + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
                    buttons[next].focus();
                }
                return;
            }
            if ((e.key === "Enter" || e.key === " ") && !e.ctrlKey && !e.altKey && !e.metaKey
                && (e.target as HTMLElement)?.closest?.("button")) return;
            e.preventDefault();
            e.stopPropagation();
            if (e.repeat) return;
            if (e.key === "Escape") return close();
            if (e.key === "Backspace" && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
                return remove();
            }
            const combo = comboOf(e);
            if (!combo) return; // waiting for the main key
            const problem = bindProblem(combo);
            if (problem) return toast(problem, "failure");
            setConflict(null);
            assign(combo);
        };
        document.addEventListener("keydown", h, true);
        return () => document.removeEventListener("keydown", h, true);
    }, []);
    return (
        <>
            <div className="vc-stx-backdrop" onMouseDown={close} />
            <div className="vc-stx-dialog" ref={ref} tabIndex={-1} role="dialog" aria-modal="true"
                aria-label={`Сочетание клавиш для «${t?.title}»`}
                onKeyDownCapture={e => { if ((e.key === "Enter" || e.key === " ") && !e.nativeEvent.isComposing) latchKey(e.nativeEvent.code); }}>
                <h4>Сочетание клавиш для «{t?.title}»</h4>
                <p>Выбери действие, затем нажми сочетание: Ctrl/Alt/Win + клавиша или F1–F24.</p>
                <div role="group" aria-label="Действие сочетания клавиш" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    <button type="button" className={"vc-stx-btn" + (mode === "insert" ? "" : " vc-stx-ghost")} aria-pressed={mode === "insert"}
                        onClick={() => setMode("insert")}>Обычная вставка</button>
                    <button type="button" className={"vc-stx-btn" + (mode === "noGreeting" ? "" : " vc-stx-ghost")} aria-pressed={mode === "noGreeting"}
                        onClick={() => setMode("noGreeting")}>Без приветствия</button>
                </div>
                <p>Работает для этого шаблона независимо от избранного.</p>
                <p className="vc-stx-hint">Esc — отмена · Backspace — снять клавишу</p>
                {conflict && <p role="alert">{comboLabel(conflict.combo)} уже назначено шаблону «{conflict.title}». Переназначить его на «{t?.title}»?</p>}
                <div className="vc-stx-acts">
                    {!conflict && store.bindFor(d.templateId) && <button type="button" className="vc-stx-btn"
                        onClick={() => {
                            const combo = store.bindFor(d.templateId);
                            if (combo) assign(combo);
                        }}>Сохранить режим</button>}
                    {conflict && <button type="button" className="vc-stx-btn"
                        onClick={() => {
                            const pending = conflictRef.current;
                            if (pending) assign(pending.combo, pending.ownerId);
                        }}>Переназначить</button>}
                    <button type="button" className="vc-stx-btn vc-stx-ghost" onClick={remove}>Снять клавишу</button>
                    <button type="button" className="vc-stx-btn vc-stx-ghost" onClick={close}>Отмена</button>
                </div>
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
