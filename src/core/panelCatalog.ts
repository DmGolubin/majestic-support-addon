/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SupportTemplates contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PersonalFolder, PersonalTemplate } from "./personal";
import { templateTokens } from "./tokens";
import { ProjectId, Template, TemplateStatus } from "./types";

export interface PanelProfile {
    schemaVersion: 1;
    accountId: string;
    connectionId: string;
    name: string;
    projects: ProjectId[];
    scopes: string[];
    permissionsRevision: string;
    minimumPluginVersion: string;
    serverTime: string;
}

export interface PanelCatalog {
    schemaVersion: 1;
    accountId: string;
    revision: string;
    permissionsRevision: string;
    serverTime: string;
    projects: ProjectId[];
    /** Complete replacement: FAQ plus the same objects returned in personal. Never merge with an older snapshot. */
    templates: Template[];
    personal: PersonalTemplate[];
    folders: PersonalFolder[];
    /** Server records stay in memory; never persist these through the local personal store. */
    personalRecords: PanelPersonalRecord[];
    folderRecords: PanelFolderRecord[];
    colors: string[];
    colorLabels: Record<string, string>;
}

export interface PanelPersonalRecord {
    id: string; version: string; title: string; text: string; projects: ProjectId[];
    shared: boolean; command: string | null; color: string | null; folderId: string | null; updatedAt: string;
}
export interface PanelFolderRecord {
    id: string; version: string; title: string; project: ProjectId; position: number; updatedAt: string;
}

function serverVersion(value: unknown): string {
    const v = string(value);
    if (!/^[\x21\x23-\x5b\x5d-\x7e]{1,512}$/.test(v)) return invalid();
    return v;
}

export function parsePersonalRecord(value: unknown, allowed: ProjectId[], colors: string[]): PanelPersonalRecord {
    const t = record(value);
    personalProject(t, allowed);
    if (t.format !== "text") return invalid();
    color(t.color, new Set(colors));
    return { id: decimal(t.id), version: serverVersion(t.version), ...metadata(t), text: string(t.text, 20000, true),
        projects: entryProjects(t.projects, allowed), shared: t.shared as boolean, command: command(t.command),
        color: t.color as string | null, folderId: t.folderId === null ? null : decimal(t.folderId) };
}

export function parseFolderRecord(value: unknown, allowed: ProjectId[]): PanelFolderRecord {
    const f = record(value), p = project(f.project);
    if (!allowed.includes(p) || !Number.isSafeInteger(f.position) || (f.position as number) < 0 || (f.position as number) > 100000) return invalid();
    return { id: decimal(f.id), version: serverVersion(f.version), title: string(f.title, 120), project: p,
        position: f.position as number, updatedAt: timestamp(f.updatedAt) };
}

// The delivered schema leaves response required[] largely empty. The MD contract requires
// identity, schema and rights metadata: missing fields must never grant access by default.
export class PanelCatalogValidationError extends Error {
    constructor(public readonly kind: "access" | "data" = "access") {
        super("Некорректный каталог или права API панели");
        this.name = "PanelCatalogValidationError";
    }
}
function invalid(): never { throw new PanelCatalogValidationError(); }
function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
    return value as Record<string, unknown>;
}
function list(value: unknown, max = 10000): unknown[] {
    if (!Array.isArray(value) || value.length > max) return invalid();
    return value;
}
function string(value: unknown, max = 512, multiline = false, empty = false): string {
    if (typeof value !== "string" || value.length > max || (!empty && !value.trim())
        || (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(value)) return invalid();
    return value;
}
function decimal(value: unknown): string {
    const id = string(value, 20);
    if (!/^[1-9]\d{0,19}$/.test(id)) return invalid();
    return id;
}
function timestamp(value: unknown): string {
    const text = string(value, 40);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(text)) return invalid();
    const ms = Date.parse(text);
    if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== text.slice(0, 19)) return invalid();
    return text;
}
function strings(value: unknown, maxItems: number, maxLength = 128): string[] {
    const values = list(value, maxItems).map(v => string(v, maxLength));
    if (new Set(values).size !== values.length) return invalid();
    return values;
}
function project(value: unknown): ProjectId {
    if (value === "majestic") return "mj";
    if (value === "russia-online") return "ro";
    return invalid();
}
function projects(value: unknown): ProjectId[] {
    const values = list(value, 2).map(project);
    if (new Set(values).size !== values.length) return invalid();
    return values;
}
function equalProjects(a: ProjectId[], b: ProjectId[]): boolean {
    return a.length === b.length && a.every(p => b.includes(p));
}
function version(value: unknown): string {
    const v = string(value, 128);
    const numeric = "(?:0|[1-9]\\d*)";
    const pre = "(?:0|[1-9]\\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)";
    if (!new RegExp(`^${numeric}\\.${numeric}\\.${numeric}(?:-${pre}(?:\\.${pre})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`).test(v)) return invalid();
    return v; // Compatibility comparison belongs to the caller, not this parser.
}

/** Full SemVer precedence. Build metadata does not change compatibility; a
 * prerelease remains below the stable release with the same core version.
 * Compare numeric strings without Number rounding for large identifiers.
 */
export function supportsPanelVersion(current: unknown, minimum: unknown): boolean {
    const parse = (value: unknown) => {
        const v = version(value).split("+")[0], dash = v.indexOf("-");
        return { core: (dash < 0 ? v : v.slice(0, dash)).split("."), pre: dash < 0 ? [] : v.slice(dash + 1).split(".") };
    };
    const numeric = (a: string, b: string) => a === b ? 0 : a.length !== b.length ? (a.length > b.length ? 1 : -1) : a > b ? 1 : -1;
    try {
        const a = parse(current), b = parse(minimum);
        for (let i = 0; i < 3; i++) {
            const comparison = numeric(a.core[i], b.core[i]);
            if (comparison) return comparison > 0;
        }
        if (!a.pre.length || !b.pre.length) return !a.pre.length;
        for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
            const x = a.pre[i], y = b.pre[i];
            if (x === undefined || y === undefined) return y === undefined;
            if (x === y) continue;
            const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
            if (nx && ny) return numeric(x, y) > 0;
            if (nx !== ny) return !nx;
            return x > y;
        }
        return true;
    } catch { return false; }
}

export function parseProfile(value: unknown): PanelProfile {
    const r = record(value);
    if (r.schemaVersion !== 1) return invalid();
    const connectionId = string(r.connectionId, 36);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(connectionId)) return invalid();
    const scopes = strings(r.scopes, 64);
    if (!scopes.includes("profile:read")) return invalid();
    return {
        schemaVersion: 1, accountId: decimal(r.accountId), connectionId, name: string(r.name, 1024),
        projects: projects(r.projects), scopes, permissionsRevision: string(r.permissionsRevision),
        minimumPluginVersion: version(r.minimumPluginVersion), serverTime: timestamp(r.serverTime),
    };
}

// limits.colors is the authority for wire values, never the legacy HEX contract or colorLabels.
// The supplied OpenAPI does not enumerate the keys. Known semantic keys map to the existing
// palette; a server-declared key without a supported equivalent safely renders without color.
const COLOR_HEX: Readonly<Record<string, string>> = Object.freeze({
    red: "#ef4444", orange: "#f97316", yellow: "#eab308", green: "#22c55e",
    teal: "#14b8a6", cyan: "#14b8a6", blue: "#3b82f6", purple: "#8b5cf6", violet: "#8b5cf6", pink: "#ec4899",
});
function colorKeys(value: unknown): Set<string> {
    const colors = Array.isArray(value) ? strings(value, 64) : Object.keys(record(value));
    if (colors.length > 64 || colors.some(k => !/^[a-z][a-z0-9_-]{0,39}$/.test(k))) return invalid();
    return new Set(colors);
}
function color(value: unknown, allowed: Set<string>): string | null {
    if (value === null) return null;
    const key = string(value, 40);
    if (!allowed.has(key)) return invalid();
    return Object.prototype.hasOwnProperty.call(COLOR_HEX, key) ? COLOR_HEX[key] : null;
}
function command(value: unknown): string | null {
    if (value === null) return null;
    const text = string(value, 40);
    if (/[\s/]/u.test(text)) return invalid();
    return text; // Preserve the panel's command spelling; do not apply the narrower local editor grammar.
}
function takeId(value: unknown, seen: Set<string>): string {
    const id = string(value, 128);
    if (seen.has(id)) return invalid();
    seen.add(id);
    return id;
}
function entryProjects(value: unknown, allowed: ProjectId[]): ProjectId[] {
    const ps = projects(value);
    if (!ps.length || ps.some(p => !allowed.includes(p))) return invalid();
    return ps;
}
function personalProject(r: Record<string, unknown>, allowed: ProjectId[]): ProjectId | null {
    const ps = entryProjects(r.projects, allowed);
    if (typeof r.shared !== "boolean" || (!r.shared && ps.length !== 1)) return invalid();
    // A shared record exposed only in one authorised project stays scoped to that project.
    // null means usable in BOTH projects and is emitted only when both are explicitly authorised.
    return ps.length === 2 ? null : ps[0];
}
function metadata(r: Record<string, unknown>) {
    string(r.version); // opaque server revision, not an incrementable client number
    return { title: string(r.title, 160), updatedAt: timestamp(r.updatedAt) };
}

function neutralizeFaqMentions(text: string): string {
    const neutralize = (part: string) => part.replace(/<@(?=[!&]?\d+>)/g, "<@\u200b")
        .replace(/(^|[^\p{L}\p{N}_.+-])@(everyone|here)\b/gu, "$1@\u200b$2");
    // Leave URL destinations intact, but stop at Markdown delimiters so adjacent mentions
    // are still protected. Parenthesized path segments are part of the URL.
    const urls = /https?:\/\/(?:[^\s<>()\[\]`"']|\([^\s<>()]*\))+/gi;
    const parts: string[] = [];
    let end = 0;
    for (const match of text.matchAll(urls)) {
        parts.push(neutralize(text.slice(end, match.index)), match[0]);
        end = match.index! + match[0].length;
    }
    parts.push(neutralize(text.slice(end)));
    return parts.join("");
}

function faqText(text: string): string {
    // Match the legacy HTML converter's mention policy without decoding HTML or normalizing
    // whitespace. Token defaults/options remain template syntax, as in that converter.
    const parts: string[] = [];
    let end = 0;
    for (const match of templateTokens(text)) {
        parts.push(neutralizeFaqMentions(text.slice(end, match.index)), match.raw);
        end = match.index + match.raw.length;
    }
    parts.push(neutralizeFaqMentions(text.slice(end)));
    return parts.join("");
}

/** Pure all-or-nothing validation. The caller binds profile.accountId to the active session/Discord user. */
export function parseSnapshot(value: unknown, profile: PanelProfile, htmlToText: (html: string) => string): PanelCatalog {
    const r = record(value);
    if (r.schemaVersion !== 1 || profile.schemaVersion !== 1 || typeof htmlToText !== "function") return invalid();
    const accountId = decimal(r.accountId), permissionsRevision = string(r.permissionsRevision);
    const ps = projects(r.projects);
    if (accountId !== profile.accountId || permissionsRevision !== profile.permissionsRevision || !equalProjects(ps, profile.projects)
        || !["profile:read", "faq:read", "personal:read", "folders:read"].every(s => profile.scopes.includes(s))) return invalid();
    // Only content failures AFTER identity and rights validation may retain the session.
    // Unknown exceptions remain terminal rather than disguising programming errors as bad data.
    try {
        return parseSnapshotContents(r, accountId, permissionsRevision, ps, htmlToText);
    } catch (error) {
        if (error instanceof PanelCatalogValidationError) throw new PanelCatalogValidationError("data");
        throw error;
    }
}

function parseSnapshotContents(r: Record<string, unknown>, accountId: string, permissionsRevision: string,
    ps: ProjectId[], htmlToText: (html: string) => string): PanelCatalog {
    const revision = string(r.revision), serverTime = timestamp(r.serverTime);
    const allowedColors = colorKeys(record(r.limits).colors);
    for (const label of Object.values(record(r.colorLabels))) string(label, 160);
    const faqRows = list(r.faq), personalRows = list(r.personal), folderRows = list(r.folders), trashRows = list(r.trash);
    const folderIds = new Set<string>(), faqIds = new Set<string>(), personalIds = new Set<string>();
    const folderProjects = new Map<string, ProjectId>();
    const folderRecords = folderRows.map(f => parseFolderRecord(f, ps)).sort((a, b) => a.position - b.position);
    const personalRecords = personalRows.map(t => parsePersonalRecord(t, ps, [...allowedColors]));
    const folders = folderRows.map(value => {
        const f = record(value), id = decimal(takeId(f.id, folderIds));
        string(f.version); timestamp(f.updatedAt);
        const p = project(f.project);
        if (!ps.includes(p) || typeof f.position !== "number" || !Number.isSafeInteger(f.position) || f.position < 0 || f.position > 100000) return invalid();
        const folder = { id: "folder:panel:" + id, name: string(f.title, 120) };
        folderProjects.set(folder.id, p);
        return { folder, position: f.position };
    }).sort((a, b) => a.position - b.position).map(f => f.folder);
    const folderById = new Map(folders.map(f => [f.id, f]));

    const faq: Template[] = faqRows.map(value => {
        const t = record(value), id = takeId(t.id, faqIds);
        const match = /^(majestic|russia-online):([1-9]\d{0,19})$/.exec(id);
        const owned = entryProjects(t.projects, ps);
        if (!match || owned.length !== 1 || project(match[1]) !== owned[0] || (t.format !== "html" && t.format !== "text")) return invalid();
        strings(t.tags, 100, 160);
        const category = t.category === null ? null : string(t.category, 1024);
        // The server may redact editing status for a reader without faq_edit.
        const status = t.status === undefined ? "actual" : t.status;
        if (!["actual", "needs_review", "outdated"].includes(status as string)) return invalid();
        const meta = metadata(t);
        let text: string;
        try {
            const source = string(t.text, 1000000, true);
            // Live API now sends Discord Markdown as text. HTML decoding would change literal
            // entities, tags, whitespace and URLs; only legacy HTML needs the converter.
            text = string(t.format === "text" ? faqText(source) : htmlToText(source), 1000000, true);
        } catch { return invalid(); }
        return { id: "faq:" + id, ...meta, text, project: owned[0], category, status: status as TemplateStatus,
            source: "faq", statusNote: null, command: null, color: null, teamUses: 0 };
    });

    const personal: PersonalTemplate[] = personalRows.map(value => {
        const t = record(value), id = decimal(takeId(t.id, personalIds));
        const p = personalProject(t, ps);
        if (t.format !== "text") return invalid();
        const folderId = t.folderId === null ? null : "folder:panel:" + decimal(t.folderId);
        const folder = folderId === null ? undefined : folderById.get(folderId);
        if (folderId && (!folder || (p !== null && folderProjects.get(folderId) !== p))) return invalid();
        return { id: "personal:panel:" + id, ...metadata(t), text: string(t.text, 20000, true), project: p,
            source: "personal", folderId, category: folder?.name ?? "Мои шаблоны", command: command(t.command), color: color(t.color, allowedColors),
            status: "actual", statusNote: null, teamUses: 0 };
    });

    // Trash is validated but never made usable. A live and deleted record cannot share an ID.
    for (const value of trashRows) {
        const t = record(value);
        decimal(takeId(t.id, personalIds)); string(t.version); string(t.title, 160); string(t.text, 20000, true);
        personalProject(t, ps); color(t.color, allowedColors); command(t.command); timestamp(t.purgeAt);
    }
    return { schemaVersion: 1, accountId, revision, permissionsRevision, serverTime, projects: ps,
        templates: [...faq, ...personal], personal, folders, personalRecords, folderRecords,
        colors: [...allowedColors], colorLabels: { ...record(r.colorLabels) } as Record<string, string> };
}
