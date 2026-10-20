// SPDX-License-Identifier: GPL-3.0-or-later
import { api, byKeys, hostStore, lazy } from "./host";
export const React = api().React;
export const { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } = React;
export const createRoot = (element: Element) => api().ReactDOM.createRoot(element);
export const ChannelStore = hostStore("ChannelStore");
export const SelectedChannelStore = hostStore("SelectedChannelStore");
export const SelectedGuildStore = hostStore("SelectedGuildStore");
export const GuildStore = hostStore("GuildStore");
export const UserStore = hostStore("UserStore");
export const PermissionStore = hostStore("PermissionStore");
export const NavigationRouter = lazy(() => {
    // Discord mangles the router's export name; use the same narrow signature as Vencord.
    const transitionTo = api().Webpack.getModule((value: any) => typeof value === "function"
        && Function.prototype.toString.call(value).includes("transitionTo -"), { searchExports: true });
    return typeof transitionTo === "function" ? { transitionTo } : undefined;
}, "NavigationRouter");
export const AccessibilityStore = hostStore("AccessibilityStore");
export const LocaleStore = hostStore("LocaleStore");
export const ThemeStore = hostStore("ThemeStore");
export const FluxDispatcher = lazy(() => byKeys("dispatch", "subscribe", "unsubscribe"), "FluxDispatcher");
export function showToast({ text, variant }: { text: string; variant: string }) {
    api().UI.showToast(text, { type: variant === "critical" ? "error" : variant === "success" ? "success" : "info" });
}
export function useStateFromStores(stores: any[], read: () => any, deps: any[] = []) {
    const [, force] = useState(0);
    const current = useRef(read); current.current = read;
    useEffect(() => {
        let live = true;
        const changed = () => { if (live) force((n: number) => n + 1); };
        const attached: any[] = [];
        try {
            for (const store of stores) { attached.push(store); store.addChangeListener(changed); }
            changed(); // cover a store change between render and effect
        } catch { /* The shared UI error boundary reports a failed read. */ }
        return () => {
            live = false;
            for (const store of attached) {
                // Host bridges can throw before or after completing the removal.
                try { store.removeChangeListener(changed); }
                catch { try { store.removeChangeListener(changed); } catch {} }
            }
        };
    }, [...stores, ...deps]);
    return current.current();
}
