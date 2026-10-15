/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Every glyph of the UI is an inline SVG (user rule: no emoji / unicode pictographs or arrows in the UI).
// Stroke style, currentColor, aligned with the text by .vc-stx-svg.

interface P { size?: number; }

const Svg = ({ size = 14, fill = "none", children }: { size?: number; fill?: string; children: React.ReactNode; }) => (
    <svg
        className="vc-stx-svg" width={size} height={size} viewBox="0 0 24 24" fill={fill}
        stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"
    >{children}</svg>
);

const STAR = "M12 3.5l2.6 5.3 5.9.9-4.25 4.1 1 5.85L12 16.9l-5.25 2.75 1-5.85L3.5 9.7l5.9-.9z";

/** Favourite star: filled = in favourites. */
export const IconStar = ({ size, filled = false }: P & { filled?: boolean; }) => (
    <Svg size={size} fill={filled ? "currentColor" : "none"}><path d={STAR} /></Svg>
);

export const IconClose = ({ size }: P) => <Svg size={size}><path d="M6 6l12 12M18 6L6 18" /></Svg>;

export const IconSearch = ({ size }: P) => <Svg size={size}><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></Svg>;

/** Disclosure chevron: right when closed, down when open. */
export const IconChevron = ({ size, open = false }: P & { open?: boolean; }) => (
    <Svg size={size}><path d={open ? "M6 9l6 6 6-6" : "M9 6l6 6-6 6"} /></Svg>
);

/** Enter / Return key. */
export const IconEnter = ({ size }: P) => <Svg size={size}><path d="M19 5v6a3 3 0 0 1-3 3H6" /><path d="M10 10l-4 4 4 4" /></Svg>;

/** Shift key (outlined up arrow). */
export const IconShift = ({ size }: P) => <Svg size={size}><path d="M12 4l7.5 8H15.5v7h-7v-7H4.5z" /></Svg>;

export const IconBack = ({ size }: P) => <Svg size={size}><path d="M19 12H5M11 6l-6 6 6 6" /></Svg>;

/** Neutral "templates" glyph (a page with lines): common templates, no project. */
export const IconTemplates = ({ size }: P) => (
    <Svg size={size}><rect x="5" y="3.5" width="14" height="17" rx="2.5" /><path d="M9 8.5h6M9 12h6M9 15.5h3.5" /></Svg>
);

export const IconSettings = ({ size }: P) => <Svg size={size}><path d="M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z" /><circle cx="12" cy="12" r="3" /></Svg>;
export const IconFolder = ({ size }: P) => <Svg size={size}><path d="M3 7V5h6l2 2h10v13H3z" /></Svg>;
export const IconLink = ({ size }: P) => <Svg size={size}><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2" /></Svg>;
export const IconPlus = ({ size }: P) => <Svg size={size}><path d="M12 5v14M5 12h14" /></Svg>;
