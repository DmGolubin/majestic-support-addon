/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useState } from "@webpack/common";

import { fieldToken } from "../core/tokenEditor";
import { Select } from "./Select";
import "./token-toolbar.css";

export function TokenToolbar({ capture, insert, hasBoundary }: { capture(): void; insert(token: string): boolean; hasBoundary: boolean; }) {
    const [kind, setKind] = useState<"field" | "list" | "date" | "time" | null>(null);
    const [name, setName] = useState("");
    const [value, setValue] = useState("");
    const [offset, setOffset] = useState("0");
    const [unit, setUnit] = useState("d");
    const [error, setError] = useState("");
    const [expanded, setExpanded] = useState(false);
    const [greeting, setGreeting] = useState(false);
    const open = (next: typeof kind) => {
        capture(); setKind(next); setName(""); setValue(""); setOffset("0");
        setUnit(next === "time" ? "m" : "d"); setError("");
    };
    const add = (token: string) => { capture(); if (insert(token)) { setKind(null); setExpanded(false); setGreeting(false); } };
    const submit = () => {
        try {
            if (kind === "field" || kind === "list") add(fieldToken(name, value, kind === "list"));
            else {
                if (!/^-?\d+$/.test(offset) || Math.abs(Number(offset)) > 10000) throw new Error("Сдвиг: целое число от −10000 до 10000.");
                const n = Number(offset);
                add(`{{${kind}${n ? (n > 0 ? "+" : "") + n + unit : ""}}}`);
            }
            setError("");
        } catch (e) { setError((e as Error).message); }
    };
    return <div className="vc-stx-token-tools">
        <div className="vc-stx-token-buttons vc-stx-token-disclosures">
            <button type="button" aria-expanded={expanded} onClick={() => { capture(); setExpanded(!expanded); setGreeting(false); setKind(null); }}>Добавить подстановку <span aria-hidden="true">{expanded ? "−" : "+"}</span></button>
            <button type="button" aria-expanded={greeting} onClick={() => { capture(); setGreeting(!greeting); setExpanded(false); setKind(null); }}>Приветствие <span aria-hidden="true">{greeting ? "−" : "+"}</span></button>
        </div>
        {expanded && <div className="vc-stx-token-panel">
            <p>Подстановка меняется при использовании шаблона. Например, <code>{"{{ник}}"}</code> предложит ввести ник игрока перед вставкой.</p>
            {!kind && <div className="vc-stx-token-choices" role="group" aria-label="Что подставить в текст">
            {([
                ["field", "Запросить значение", "Ник, номер обращения или другой текст"],
                ["list", "Выбрать из списка", "Например, сервер из заданных вариантов"],
                ["date", "Текущая дата", "Дата вставки или дата со сдвигом"],
                ["time", "Текущее время", "Время вставки или время со сдвигом"],
            ] as const).map(([key, label, hint]) => <button type="button" key={key} onClick={() => open(key)}><strong>{label}</strong><span>{hint}</span></button>)}
            {[
                ["Скопированный текст", "{{clipboard}}", "Из буфера обмена в момент вставки"],
                ["Выделенный текст", "{{selection}}", "Выделение перед открытием шаблонов"],
                ["Ссылка на канал", "{{url}}", "Адрес текущего канала Discord"],
                ["Название канала", "{{title}}", "Название текущего канала Discord"],
            ].map(([label, token, hint]) => <button type="button" key={token} onClick={() => add(token)}><strong>{label}</strong><span>{hint}</span></button>)}
            </div>}
        {kind && <div className="vc-stx-token-builder" role="group" aria-label="Настройка переменной" onKeyDown={e => { if (e.key === "Enter" && e.target instanceof HTMLInputElement && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }}>
            {kind === "field" || kind === "list" ? <>
                <label>Имя поля<input autoFocus value={name} placeholder="Например: ник" onChange={e => setName(e.currentTarget.value)} /></label>
                {kind === "list" ? <label>Варианты списка<textarea value={value} placeholder={"Первый вариант\nВторой вариант"} onChange={e => setValue(e.currentTarget.value)} /></label>
                    : <label>Значение по умолчанию (необязательно)<input value={value} onChange={e => setValue(e.currentTarget.value)} /></label>}
                <p className="vc-stx-muted">При использовании шаблона появится форма заполнения. Одинаковое имя объединяет повторяющиеся поля.</p>
            </> : <>
                <div className="vc-stx-form-grid"><label>Сдвиг относительно момента вставки<input autoFocus type="number" min={-10000} max={10000} step={1} value={offset} onChange={e => setOffset(e.currentTarget.value)} /></label>
                    <label>Единица<Select aria-label="Единица" value={unit} onChange={e => setUnit(e.currentTarget.value)}><option value="m">Минуты</option><option value="h">Часы</option><option value="d">Дни</option><option value="w">Недели</option></Select></label></div>
                <p className="vc-stx-muted">{kind === "date" ? "Формат: ДД.ММ.ГГГГ." : "Формат: ЧЧ:ММ."} Ноль — текущее значение; отрицательное число — назад.</p>
            </>}
            {error && <p role="alert" className="vc-stx-form-error">{error}</p>}
            <div className="vc-stx-lib-actions"><button type="button" className="vc-stx-btn vc-stx-ghost" onClick={() => setKind(null)}>Назад</button><button type="button" className="vc-stx-btn" onClick={submit}>Добавить в текст</button></div>
        </div>}
        </div>}
        {greeting && <div className="vc-stx-token-panel">
            <strong>Вставка без повторного приветствия</strong>
            <p>{hasBoundary ? "Конец приветствия уже отмечен. При вставке без приветствия останется только основной ответ." : "Поставьте курсор после приветствия в тексте и нажмите кнопку ниже. При вставке без приветствия текст до этой отметки будет пропущен."}</p>
            <p className="vc-stx-muted">Служебная отметка видна только в редакторе и не попадёт в сообщение.</p>
            <button type="button" className="vc-stx-btn vc-stx-ghost" disabled={hasBoundary} onClick={() => add("\n[[greeting:end]]\n")}>Отметить конец приветствия</button>
        </div>}
    </div>;
}
