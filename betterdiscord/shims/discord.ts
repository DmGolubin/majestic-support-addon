// SPDX-License-Identifier: GPL-3.0-or-later
import { api } from "./host";

// Read only the Slate text leaves, never mutate DOM/Slate or retain draft content.
function draftText(children: any[]): string {
    const leaves: string[] = [];
    const pending = [...children].reverse();
    let count = 0;
    while (pending.length) {
        if (++count > 100000) throw new Error("Discord composer draft is too large");
        const node = pending.pop();
        if (typeof node?.text === "string") leaves.push(node.text);
        else if (Array.isArray(node?.children)) pending.push(...[...node.children].reverse());
    }
    return JSON.stringify(leaves);
}

export function insertTextIntoChatInputBox(text: string) {
    const editor = document.activeElement?.closest('[data-slate-editor="true"]');
    if (!editor?.isConnected || !editor.closest('[class*="channelTextArea"]')) throw new Error("No focused chat editor");
    // ComponentDispatch returns itself even with zero listeners and routes to the
    // last subscriber, which need not own this editor. Resolve the captured DOM
    // editor's React ancestor instead. These methods are the composer's own
    // INSERT_TEXT handler and Slate accessor (also used by its native controls).
    let fiber = api().ReactUtils?.getInternalInstance?.(editor);
    let owner: any;
    for (let depth = 0; fiber && depth < 100; depth++, fiber = fiber.return) {
        const candidate = fiber.stateNode;
        if (typeof candidate?.getSlateEditor === "function" && typeof candidate?.handleInsertText === "function") {
            owner = candidate;
            break;
        }
    }
    if (!owner) throw new Error("Discord composer insertion handler is unavailable");
    if (owner.props?.disabled || owner.props?.submitting) throw new Error("Discord composer is unavailable");
    const slate = owner.getSlateEditor();
    if (!Array.isArray(slate?.children) || !Array.isArray(slate?.operations)) throw new Error("Discord composer is unavailable");
    // DOM focus alone does not restore Slate's selection/focus state.
    // The outer owner's focus() is queued behind React state. Its inner ref's
    // focus() goes straight to Slate, as in Discord's imperative editor API.
    owner.ref?.current?.focus?.();
    if (!editor.isConnected || document.activeElement?.closest('[data-slate-editor="true"]') !== editor || owner.getSlateEditor() !== slate) {
        throw new Error("Discord composer changed before insertion");
    }
    const before = draftText(slate.children);
    const operations = new Set(slate.operations ?? []);
    let failed = false;
    try {
        owner.handleInsertText({ rawText: text, plainText: text, addSpace: false });
    } catch { failed = true; }
    if (owner.getSlateEditor() !== slate) throw new Error("Discord composer changed during insertion");
    // Slate applies model changes synchronously; React may paint later. Actual
    // insertion operations also cover replacing a selection with identical text.
    // Do not retry via another route: a late focus error can follow a good insert.
    const changes: number[] = [];
    for (const op of slate.operations) {
        if (operations.has(op)) continue;
        const nonempty = typeof op.text === "string" ? op.text.length > 0
            : op.node && JSON.parse(draftText([op.node])).some((leaf: string) => leaf.length > 0);
        if (!nonempty) continue;
        if (op.type === "insert_text" || op.type === "insert_node") changes.push(1);
        if (op.type === "remove_text" || op.type === "remove_node") changes.push(-1);
    }
    const replacedIdentically = !failed && changes.includes(-1) && changes.at(-1) === 1;
    if (!changes.includes(1) || (draftText(slate.children) === before && !replacedIdentically)) {
        throw new Error(failed ? "Discord composer insertion failed" : "Discord composer draft did not change");
    }
}
