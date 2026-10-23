/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useState } from "@webpack/common";

import { fieldToken } from "../core/tokenEditor";
import "./token-toolbar.css";

export function TokenToolbar({ capture, insert, hasBoundary }: { capture(): void; insert(token: string): boolean; hasBoundary: boolean; }) {
    const [name, setName] = useState("");
    const [value, setValue] = useState("");
    const [error, setError] = useState("");
    const [expanded, setExpanded] = useState(false);
    const [greeting, setGreeting] = useState(false);
    const add = (token: string) => { capture(); if (insert(token)) { setExpanded(false); setGreeting(false); } };
    const submit = () => {
        try {
            add(fieldToken(name, value, false));
            setError("");
        } catch (e) { setError((e as Error).message); }
    };
    return <div className="vc-stx-token-tools">
        <div className="vc-stx-token-buttons vc-stx-token-disclosures">
            <button type="button" aria-expanded={expanded} onClick={() => { capture(); setExpanded(!expanded); setGreeting(false); setName(""); setValue(""); setError(""); }}>Поле для заполнения <span aria-hidden="true">{expanded ? "−" : "+"}</span></button>
            <button type="button" aria-expanded={greeting} onClick={() => { capture(); setGreeting(!greeting); setExpanded(false); }}>Приветствие <span aria-hidden="true">{greeting ? "−" : "+"}</span></button>
        </div>
        {expanded && <div className="vc-stx-token-panel">
            <p><code>{"{{ник}}"}</code> — запрос ника перед вставкой.</p>
        <div className="vc-stx-token-builder" role="group" aria-label="Настройка поля" onKeyDown={e => { if (e.key === "Enter" && e.target instanceof HTMLInputElement && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); submit(); } }}>
                <label>Имя поля<input autoFocus value={name} placeholder="Например: ник" onChange={e => setName(e.currentTarget.value)} /></label>
                <label>Значение по умолчанию (необязательно)<input value={value} onChange={e => setValue(e.currentTarget.value)} /></label>
            {error && <p role="alert" className="vc-stx-form-error">{error}</p>}
            <div className="vc-stx-lib-actions"><button type="button" className="vc-stx-btn vc-stx-ghost" onClick={() => setExpanded(false)}>Отмена</button><button type="button" className="vc-stx-btn" onClick={submit}>Добавить в текст</button></div>
        </div>
        </div>}
        {greeting && <div className="vc-stx-token-panel">
            <strong>Вставка без повторного приветствия</strong>
            <p>{hasBoundary ? "Граница отмечена. Без приветствия вставится только основной ответ." : "Поставьте курсор после приветствия и отметьте границу. При вставке без приветствия текст до неё будет пропущен."}</p>
            <p className="vc-stx-muted">Служебная отметка видна только в редакторе и не попадёт в сообщение.</p>
            <button type="button" className="vc-stx-btn vc-stx-ghost" disabled={hasBoundary} onClick={() => add("\n[[greeting:end]]\n")}>Отметить конец приветствия</button>
        </div>}
    </div>;
}
