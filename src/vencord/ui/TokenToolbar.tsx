/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useState } from "@webpack/common";

import { fieldToken } from "../core/tokenEditor";
import { Select } from "./Select";

export function TokenToolbar({ capture, insert, hasBoundary }: { capture(): void; insert(token: string): boolean; hasBoundary: boolean; }) {
    const [kind, setKind] = useState<"field" | "list" | "date" | "time" | null>(null);
    const [name, setName] = useState("");
    const [value, setValue] = useState("");
    const [offset, setOffset] = useState("0");
    const [unit, setUnit] = useState("d");
    const [error, setError] = useState("");
    const open = (next: typeof kind) => {
        capture(); setKind(next); setName(""); setValue(""); setOffset("0");
        setUnit(next === "time" ? "m" : "d"); setError("");
    };
    const add = (token: string) => { if (insert(token)) setKind(null); };
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
        <div className="vc-stx-token-buttons" role="group" aria-label="Добавить переменную">
            <button type="button" onClick={() => open("field")}>Поле</button>
            <button type="button" onClick={() => open("list")}>Список</button>
            <button type="button" onClick={() => open("date")}>Дата</button>
            <button type="button" onClick={() => open("time")}>Время</button>
            {[
                ["Буфер", "{{clipboard}}", "Содержимое буфера при использовании шаблона"],
                ["Выделение", "{{selection}}", "Текст, выделенный перед открытием окна шаблонов"],
                ["Ссылка", "{{url}}", "Ссылка на канал Discord"],
                ["Заголовок", "{{title}}", "Название канала Discord"],
            ].map(([label, token, hint]) => <button type="button" key={token} title={hint} onClick={() => { capture(); add(token); }}>{label}</button>)}
            <button type="button" disabled={hasBoundary} onClick={() => { capture(); add("\n[[greeting:end]]\n"); }}>Граница приветствия</button>
        </div>
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
            <div className="vc-stx-lib-actions"><button type="button" className="vc-stx-btn vc-stx-ghost" onClick={() => setKind(null)}>Отмена переменной</button><button type="button" className="vc-stx-btn" onClick={submit}>Добавить в текст</button></div>
        </div>}
    </div>;
}
