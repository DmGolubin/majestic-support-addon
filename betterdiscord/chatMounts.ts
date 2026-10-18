// SPDX-License-Identifier: GPL-3.0-or-later
import { React, createRoot, ChannelStore, SelectedChannelStore, FluxDispatcher } from "./shims/common";
import { serverMode } from "../src/core/guard";

/** Each composer owns its mount: the upstream button captures the adjacent Slate editor.
 * Avoid patching obfuscated React render functions; the keyboard entry remains available
 * if Discord changes its chat-toolbar DOM classes.
 */
export function mountChatButtons(Button: any) {
    const mounts = new Map<Element, { node: HTMLElement; root: any; channel: string }>();
    let live = true;
    let frame = 0;
    function scan() {
        frame = 0;
        if (!live) return;
        let channel: any;
        try { channel = ChannelStore.getChannel(SelectedChannelStore.getChannelId()); } catch {}
        const allowed = !!channel && serverMode(channel.guild_id) !== "off";
        for (const [area, mount] of mounts) {
            if (!allowed || !area.isConnected || !area.contains(mount.node) || !area.querySelector('[data-slate-editor="true"]')) {
                mount.root.unmount(); mount.node.remove(); mounts.delete(area);
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
            const root = createRoot(node);
            mounts.set(area, { node, root, channel: channel.id });
            root.render(React.createElement(Button, { isAnyChat: true, channel }));
        }
    }
    const schedule = () => { if (live && !frame) frame = requestAnimationFrame(scan); };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    FluxDispatcher.subscribe("CHANNEL_SELECT", schedule);
    scan();
    return () => {
        live = false; observer.disconnect(); cancelAnimationFrame(frame);
        try { FluxDispatcher.unsubscribe("CHANNEL_SELECT", schedule); } catch {}
        for (const mount of mounts.values()) { mount.root.unmount(); mount.node.remove(); }
        mounts.clear();
    };
}
