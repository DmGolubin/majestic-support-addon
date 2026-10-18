// SPDX-License-Identifier: GPL-3.0-or-later
import { byKeys } from "./host";
export function insertTextIntoChatInputBox(text: string) {
    const editor = document.activeElement?.closest('[data-slate-editor="true"]');
    if (!editor?.isConnected || !editor.closest('[class*="channelTextArea"]')) throw new Error("No focused chat editor");
    const dispatcher = byKeys("dispatchToLastSubscribed", "subscribe");
    if (!dispatcher) throw new Error("Discord text insertion is unavailable");
    // ComponentDispatch, NOT FluxDispatcher. Same INSERT_TEXT contract as Vencord.
    dispatcher.dispatchToLastSubscribed("INSERT_TEXT", { plainText: text });
}
