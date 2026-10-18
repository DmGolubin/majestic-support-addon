/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SupportTemplates contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Deliberately string-only: no DOMParser, innerHTML, document, resource loading or execution.
// This is a conservative text converter, not an HTML renderer or a sanitizer for later rendering.
const ENTITIES: Readonly<Record<string, string>> = Object.freeze({
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
    ndash: "–", mdash: "—", hellip: "…", bull: "•", copy: "©", reg: "®", trade: "™",
    euro: "€", pound: "£", laquo: "«", raquo: "»", ensp: " ", emsp: " ", thinsp: " ",
});
function decode(text: string): string {
    return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (whole, key: string) => {
        if (key[0] !== "#") return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : whole;
        const hex = key[1].toLowerCase() === "x";
        const n = Number.parseInt(key.slice(hex ? 2 : 1), hex ? 16 : 10);
        return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "\uFFFD";
    });
}
function outsideTokens(text: string, convert: (part: string) => string): string {
    // Same token grammar as core/tokens.ts; escaping its pipes, underscores or defaults changes
    // field names/options. Preserve grammar plus greeting/caret markers during text cleanup.
    const tokens = /\{\{\s*([^}|=]+?)\s*(?:=\s*([^}|]*?)\s*)?(\|[^}]*)?\s*\}\}|\[\[greeting:end\]\]|\{\|\}/g;
    const parts: string[] = [];
    let end = 0;
    for (const match of text.matchAll(tokens)) {
        parts.push(convert(text.slice(end, match.index)), match[0]);
        end = match.index! + match[0].length;
    }
    parts.push(convert(text.slice(end)));
    return parts.join("");
}
// Keep this converter standalone: it is also consumed directly outside the
// bundled plugin, where core/ has a different relative path.
function neutralizeFaqMentions(text: string): string {
    const neutralize = (part: string) => part.replace(/<@(?=[!&]?\d+>)/g, "<@\u200b")
        .replace(/(^|[^\p{L}\p{N}_.+-])@(everyone|here)\b/gu, "$1@\u200b$2");
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

function plain(text: string): string {
    text = decode(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
    // FAQ text contains Discord Markdown even inside HTML wrappers. Preserve its syntax,
    // line breaks and indentation; HTML is removed by the inert scanner below, never rendered.
    // A blanket @ replacement corrupts email addresses and URL handles from the FAQ.
    return outsideTokens(text, neutralizeFaqMentions);
}
function attr(attrs: string, name: string): string | null {
    // Consume whole attributes in order, including quoted values of unrelated attributes.
    // Searching for just the requested name can mistake text inside title/alt for an href.
    const attributes = /\s*([^\s"'=<>`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/y;
    while (attributes.lastIndex < attrs.length) {
        const match = attributes.exec(attrs);
        if (!match) return null;
        if (match[1].toLowerCase() === name) {
            const value = match[2] ?? match[3] ?? match[4];
            return value === undefined ? null : decode(value);
        }
    }
    return null;
}
function link(value: string | null): string | null {
    if (!value || /[\s<>\\]/.test(value)) return null;
    try {
        const url = new URL(value);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
        return url.href;
    } catch { return null; }
}
const OMIT = new Set(["script", "style", "noscript", "iframe", "object", "embed", "svg", "math", "template", "head", "video", "audio"]);
const BLOCK = new Set(["p", "div", "section", "article", "header", "footer", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6"]);

export function htmlToDiscordText(html: string): string {
    if (typeof html !== "string" || html.length > 1000000) throw new Error("Некорректный HTML FAQ");
    const out: string[] = [], links: (string | null)[] = [], lists: (number | null)[] = [];
    let i = 0, pending = "";
    // Inline formatting may split a variable across spans. Reassemble text before processing tokens.
    const flush = () => { if (pending) out.push(plain(pending)); pending = ""; };
    const emit = (text: string) => { flush(); out.push(text); };
    while (i < html.length) {
        if (html[i] !== "<") {
            const next = html.indexOf("<", i);
            const end = next < 0 ? html.length : next;
            pending += html.slice(i, end); i = end; continue;
        }
        if (html.startsWith("<!--", i)) {
            const end = html.indexOf("-->", i + 4); i = end < 0 ? html.length : end + 3; continue;
        }
        // Discord autolinks are text, not tags. Do not discard them as unknown HTML elements.
        const autolink = /^<(https?:\/\/[^<>\s]+)>/i.exec(html.slice(i));
        if (autolink && link(decode(autolink[1]))) {
            pending += autolink[0]; i += autolink[0].length; continue;
        }
        const opening = /^<(\/)?([a-z][a-z0-9:-]*)(?=[\s/>])/i.exec(html.slice(i));
        if (!opening) { pending += "<"; i++; continue; }
        // A quoted '>' is an attribute character, not the end of the tag.
        let end = i + opening[0].length, quote = "";
        for (; end < html.length; end++) {
            const ch = html[end];
            if (quote) { if (ch === quote) quote = ""; }
            else if (ch === '"' || ch === "'") quote = ch;
            else if (ch === ">") break;
        }
        if (end === html.length) break; // incomplete markup never becomes raw HTML in the result
        const name = opening[2].toLowerCase(), closing = !!opening[1];
        const attrs = html.slice(i + opening[0].length, end);
        i = end + 1;
        if (OMIT.has(name)) {
            if (!closing && !/\/\s*$/.test(attrs) && name !== "embed") {
                const close = new RegExp("</" + name + "\\s*>", "gi"); close.lastIndex = i;
                const match = close.exec(html); i = match ? close.lastIndex : html.length;
            }
            continue;
        }
        if (name === "a") {
            if (!closing) links.push(link(attr(attrs, "href")));
            else { const href = links.pop(); if (href) emit(" <" + href + ">"); }
        } else if (name === "img" && !closing) {
            const alt = attr(attrs, "alt"); if (alt) pending += alt;
        } else if (name === "br" || name === "hr") emit("\n");
        else if (name === "pre") emit("\n\n");
        else if (name === "ul" || name === "ol") {
            if (closing) lists.pop(); else lists.push(name === "ol" ? 0 : null);
            emit("\n");
        } else if (name === "li") {
            emit("\n");
            if (!closing) {
                const n = lists.length - 1;
                emit(n >= 0 && lists[n] !== null ? String(lists[n] = lists[n]! + 1) + ". " : "- ");
            }
        } else if (name === "tr") emit("\n");
        else if ((name === "td" || name === "th") && closing) emit(" | ");
        else if (BLOCK.has(name)) emit("\n\n");
    }
    flush();
    return outsideTokens(out.join(""), part => part.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n")).trim();
}
