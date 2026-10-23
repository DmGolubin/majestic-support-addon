/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Use inline SVG glyphs instead of emoji or Unicode pictographs.
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

export const IconArrowUpRight = ({ size }: P) => <Svg size={size}><path d="M7 17L17 7M7 7h10v10" /></Svg>;

export const IconBell = ({ size }: P) => <Svg size={size}><path d="M6 8a6 6 0 0 1 12 0v6l2 3H4l2-3V8M10 21h4M12 2V1" /></Svg>;

export const IconSearch = ({ size }: P) => <Svg size={size}><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></Svg>;

/** Disclosure chevron: right when closed, down when open. */
export const IconChevron = ({ size, open = false }: P & { open?: boolean; }) => (
    <Svg size={size}><path d={open ? "M6 9l6 6 6-6" : "M9 6l6 6-6 6"} /></Svg>
);

/** Enter / Return key. */
export const IconEnter = ({ size }: P) => <Svg size={size}><path d="M19 5v6a3 3 0 0 1-3 3H6" /><path d="M10 10l-4 4 4 4" /></Svg>;

export const IconBack = ({ size }: P) => <Svg size={size}><path d="M19 12H5M11 6l-6 6 6 6" /></Svg>;

/** Neutral "templates" glyph (a page with lines): common templates, no project. */
export const IconTemplates = ({ size }: P) => (
    <Svg size={size}><rect x="5" y="3.5" width="14" height="17" rx="2.5" /><path d="M9 8.5h6M9 12h6M9 15.5h3.5" /></Svg>
);

export const IconSettings = ({ size }: P) => <Svg size={size}><path d="M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z" /><circle cx="12" cy="12" r="3" /></Svg>;
export const IconRefresh = ({ size }: P) => <Svg size={size}><path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-2l2 3M4 16l2 3a7 7 0 0 0 12-2" /></Svg>;
export const IconLogout = ({ size }: P) => <Svg size={size}><path d="M9 4H4v16h5M13 8l4 4-4 4M8 12h12" /></Svg>;
