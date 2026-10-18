/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { React, useLayoutEffect, useRef, useState } from "@webpack/common";

import { IconChevron } from "./svg";

/** Controlled dropdown; native button focus and fieldset disabling are preserved. */
export function Select({ value, onChange, children, "aria-label": label }: {
    value: string;
    onChange(e: { currentTarget: { value: string; }; }): void;
    children: React.ReactNode;
    "aria-label": string;
}) {
    const options = React.Children.toArray(children).filter(React.isValidElement) as React.ReactElement<{ value: string; children: React.ReactNode; }>[];
    const [open, setOpen] = useState(false);
    const [active, setActive] = useState(0);
    const [up, setUp] = useState(false);
    const [maxHeight, setMaxHeight] = useState(200);
    const root = useRef<HTMLDivElement>(null);
    const button = useRef<HTMLButtonElement>(null);
    const list = useRef<HTMLDivElement>(null);
    const [id] = useState(() => "stx-select-" + crypto.randomUUID());
    const selected = Math.max(0, options.findIndex(o => o.props.value === value));
    const activeIndex = Math.max(0, Math.min(active, options.length - 1));
    useLayoutEffect(() => {
        if (open) list.current?.children[activeIndex]?.scrollIntoView({ block: "nearest" });
    }, [open, activeIndex]);
    const show = () => {
        const rect = button.current?.getBoundingClientRect();
        const bounds = root.current?.closest(".vc-stx-settings, .vc-stx-win")?.getBoundingClientRect();
        if (rect) {
            const below = Math.min(innerHeight, bounds?.bottom ?? innerHeight) - rect.bottom;
            const above = rect.top - Math.max(0, bounds?.top ?? 0);
            const upward = below < Math.min(200, options.length * 38 + 8) && above > below;
            setUp(upward);
            setMaxHeight(Math.max(0, Math.min(200, (upward ? above : below) - 8)));
        }
        setOpen(true);
    };
    const choose = (i: number) => { if (options[i]) onChange({ currentTarget: { value: options[i].props.value } }); setOpen(false); button.current?.focus(); };
    return <div className={"vc-stx-select" + (up ? " vc-stx-select-up" : "")} ref={root} data-stx-select-open={open || undefined}
        onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false); }}>
        <button type="button" ref={button} role="combobox" aria-label={label} aria-expanded={open} aria-controls={id} aria-haspopup="listbox"
            aria-activedescendant={open && options.length ? `${id}-${activeIndex}` : undefined}
            onClick={() => { setActive(selected); if (open) setOpen(false); else show(); }}
            onKeyDown={e => {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === "Escape" && open) { e.preventDefault(); e.stopPropagation(); setOpen(false); }
                else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
                    e.preventDefault(); e.stopPropagation();
                    setActive(e.key === "Home" ? 0 : e.key === "End" ? Math.max(0, options.length - 1) : !open ? selected : (activeIndex + (e.key === "ArrowDown" ? 1 : -1) + options.length) % Math.max(1, options.length));
                    show();
                } else if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault(); e.stopPropagation();
                    if (e.repeat) return;
                    if (open) choose(activeIndex);
                    else { setActive(selected); show(); }
                }
                else if (e.key === "Tab") setOpen(false);
            }}><span>{options[selected]?.props.children}</span><IconChevron open /></button>
        {open && <div id={id} ref={list} role="listbox" aria-label={label} className="vc-stx-select-options" style={{ maxHeight }}>
            {options.map((o, i) => <div key={o.props.value} id={`${id}-${i}`} role="option" aria-selected={value === o.props.value}
                className={i === activeIndex ? "active" : ""} onMouseDown={e => e.preventDefault()} onMouseEnter={() => setActive(i)} onClick={() => choose(i)}>{o.props.children}</div>)}
        </div>}
    </div>;
}
