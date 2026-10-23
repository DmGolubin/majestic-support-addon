/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { fieldsOf } from "./tokens";

export function fieldToken(name: string, value: string, list: boolean): string {
    name = name.trim();
    if (!name || /[{}|=\r\n]/.test(name) || !fieldsOf(`{{${name}}}`).length)
        throw new Error("Укажите имя поля без скобок, | и =. Служебные имена вроде date зарезервированы.");
    if (list) {
        const options = value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        if (options.length < 2 || options.some(s => /[{}|]/.test(s)))
            throw new Error("Введите минимум два варианта, каждый с новой строки, без скобок и |.");
        return `{{${name}|${options.join("|")}}}`;
    }
    if (/[{}|\r\n]/.test(value)) throw new Error("Значение по умолчанию должно быть одной строкой без скобок и |.");
    return `{{${name}${value.trim() ? "=" + value.trim() : ""}}}`;
}

export function insertToken(text: string, start: number, end: number, token: string) {
    start = Math.max(0, Math.min(text.length, start));
    end = Math.max(start, Math.min(text.length, end));
    const next = text.slice(0, start) + token + text.slice(end);
    if (next.length > 20000) throw new Error("Текст с переменной превышает 20 000 символов.");
    return { text: next, caret: start + token.length };
}
