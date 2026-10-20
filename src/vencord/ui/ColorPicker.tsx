/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SupportTemplates contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "../styles/color-picker.css";

export interface ColorPickerProps {
    value: string | null;
    colors: readonly string[];
    labels: Record<string, string>;
    onChange(value: string | null): void;
    disabled?: boolean;
}

const COLOR_LABELS: Record<string, string> = {
    red: "Красный", orange: "Оранжевый", amber: "Янтарный", green: "Зелёный",
    teal: "Бирюзовый", blue: "Синий", violet: "Фиолетовый", pink: "Розовый",
    yellow: "Жёлтый", purple: "Фиолетовый", cyan: "Бирюзовый",
};

/** Controlled template palette. Native buttons also respect a disabled parent fieldset. */
export function ColorPicker({ value, colors, labels, onChange, disabled = false }: ColorPickerProps) {
    const options: (string | null)[] = [null, ...new Set(colors.filter(color => color !== ""))];

    return <div className="vc-stx-color-picker" role="group" aria-label="Цвет">
        <span className="vc-stx-color-picker-title" aria-hidden="true">Цвет</span>
        <div className="vc-stx-color-picker-options">
            {options.map(color => <button
                key={color === null ? "none" : `color-${color}`}
                type="button"
                className="vc-stx-color-picker-option"
                aria-pressed={value === color}
                disabled={disabled}
                onClick={() => onChange(color)}
            >
                <span className="vc-stx-color-picker-swatch" data-color={color ?? "none"} aria-hidden="true" />
                <span className="vc-stx-color-picker-label">{color === null ? "Без цвета" : labels[color] || COLOR_LABELS[color] || color}</span>
                <svg className="vc-stx-color-picker-check" width="14" height="14" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                    <path d="m5 12 4 4L19 6" />
                </svg>
            </button>)}
        </div>
    </div>;
}
