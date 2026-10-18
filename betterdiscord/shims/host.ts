// SPDX-License-Identifier: GPL-3.0-or-later
export const NAME = "SupportTemplates";
export function api(): any {
    const host = (globalThis as any).BdApi;
    if (!host) throw new Error("BetterDiscord is required.");
    return host;
}

/** Resolve lazily: Discord can load stores after BD has loaded this file. */
export function lazy(resolve: () => any, label: string): any {
    let cached: any;
    return new Proxy({}, {
        get(_target, key) {
            cached ??= resolve();
            if (!cached) throw new Error(`Discord capability unavailable: ${label}`);
            const value = cached[key];
            return typeof value === "function" ? value.bind(cached) : value;
        }
    });
}
export function byKeys(...keys: string[]): any {
    return api().Webpack.getModule((m: any) => m && keys.every(k => typeof m[k] === "function"), { searchExports: true });
}
export function hostStore(name: string): any {
    return lazy(() => api().Webpack.getStore(name), name);
}
