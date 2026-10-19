// SPDX-License-Identifier: GPL-3.0-or-later
import { React, createRoot, ChannelStore, SelectedChannelStore, FluxDispatcher } from "./shims/common";
import { serverMode } from "../src/core/guard";

const pendingSubscriptions = new Set<() => void>();
function releaseSubscriptions() {
    for (const remove of pendingSubscriptions) {
        for (let attempt = 0; attempt < 2; attempt++) {
            try { remove(); pendingSubscriptions.delete(remove); break; }
            catch (error) { if (attempt === 1) console.error("[SupportTemplates] Toolbar subscription cleanup failed", error); }
        }
    }
}

/** Each composer owns its mount: the upstream button captures the adjacent Slate editor.
 * Avoid patching obfuscated React render functions; the keyboard entry remains available
 * if Discord changes its chat-toolbar DOM classes.
 */
export function mountChatButtons(Button: any) {
    releaseSubscriptions();
    if (pendingSubscriptions.size) throw new Error("SupportTemplates toolbar subscription still active");
    const mounts = new Map<Element, { node: HTMLElement; root: any; channel: string }>();
    let live = true;
    let frame = 0;
    // Some host calls can throw after performing their side effect. Retry once,
    // but never let one broken resource prevent cleanup of all the others.
    const release = (fn: () => void) => { try { fn(); } catch { try { fn(); } catch (error) { console.error("[SupportTemplates] Toolbar cleanup failed", error); } } };
    const remove = (area: Element, mount: { node: HTMLElement; root: any }) => {
        mounts.delete(area);
        release(() => mount.root.unmount());
        mount.node.remove();
    };
    function scan() {
        frame = 0;
        if (!live) return;
        let channel: any;
        try { channel = ChannelStore.getChannel(SelectedChannelStore.getChannelId()); } catch {}
        const allowed = !!channel && serverMode(channel.guild_id) !== "off";
        for (const [area, mount] of mounts) {
            if (!allowed || !area.isConnected || !area.contains(mount.node) || !area.querySelector('[data-slate-editor="true"]')) {
                remove(area, mount);
            } else if (mount.channel !== channel.id) {
                mount.channel = channel.id;
                mount.root.render(React.createElement(Button, { isAnyChat: true, channel }));
            }
        }
        if (!allowed) return;
        for (const area of document.querySelectorAll('[class*="channelTextArea"]')) {
            if (mounts.has(area) || !area.querySelector('[data-slate-editor="true"]')) continue;
            const toolbar = area.querySelector('[class*="buttons_"]') ?? area.querySelector('[class*="buttons"]');
            // Never place controls inside contenteditable/Slate (would corrupt drafts).
            if (!toolbar || toolbar.closest('[contenteditable="true"]')) continue;
            // A host can clone/replace a composer, including our old inert DOM.
            for (const stale of area.querySelectorAll('.stx-bd-button-mount')) stale.remove();
            const node = document.createElement("span"); node.className = "stx-bd-button-mount";
            toolbar.prepend(node);
            let root;
            try { root = createRoot(node); }
            catch (error) { node.remove(); throw error; }
            mounts.set(area, { node, root, channel: channel.id });
            root.render(React.createElement(Button, { isAnyChat: true, channel }));
        }
    }
    const schedule = () => {
        if (live && !frame) frame = requestAnimationFrame(() => {
            try { scan(); }
            catch (error) { cleanup(); console.error("[SupportTemplates] Toolbar mount failed", error); }
        });
    };
    const composer = '[class*="channelTextArea"]';
    const controls = '[data-slate-editor="true"], [class*="buttons"]';
    const contains = (node: Node, selector: string) => node instanceof Element && (node.matches(selector) || !!node.querySelector(selector));
    const observer = new MutationObserver(records => {
        if (!live || frame) return;
        for (const record of records) {
            const target = record.target instanceof Element ? record.target : record.target.parentElement;
            // React rendering our button, typing into Slate and incoming messages
            // do not change composer structure. Only structural changes need a scan.
            if (target?.closest('.stx-bd-button-mount, [data-slate-editor="true"]')) continue;
            const inComposer = !!target?.closest(composer);
            if ([...record.addedNodes].some(n => contains(n, composer) || (inComposer && contains(n, controls))) ||
                [...record.removedNodes].some(n => contains(n, composer) || (inComposer && contains(n, controls + ', .stx-bd-button-mount')))) {
                schedule(); return;
            }
        }
    });
    let subscribed = false;
    const cleanup = () => {
        live = false;
        release(() => observer.disconnect());
        cancelAnimationFrame(frame); frame = 0;
        if (subscribed) {
            subscribed = false;
            pendingSubscriptions.add(() => FluxDispatcher.unsubscribe("CHANNEL_SELECT", schedule));
        }
        releaseSubscriptions();
        for (const [area, mount] of mounts) remove(area, mount);
    };
    try {
        observer.observe(document.body, { childList: true, subtree: true });
        subscribed = true;
        FluxDispatcher.subscribe("CHANNEL_SELECT", schedule);
        scan();
    } catch (error) { cleanup(); throw error; }
    return cleanup;
}
