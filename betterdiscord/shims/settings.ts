// SPDX-License-Identifier: GPL-3.0-or-later
import { api, NAME } from "./host";
export function definePluginSettings(definitions: Record<string, any>) {
    const values: Record<string, any> = {};
    let loaded = false;
    const load = () => {
        if (loaded) return;
        const saved = api().Data.load(NAME, "host-settings") ?? {};
        for (const [key, definition] of Object.entries(definitions)) {
            if (definition.type === "boolean") values[key] = typeof saved[key] === "boolean" ? saved[key] : definition.default;
        }
        loaded = true;
    };
    return { definitions, store: new Proxy(values, {
        get(_target, key: string) { load(); return values[key]; },
        set(_target, key: string, value) {
            load();
            if (definitions[key]?.type !== "boolean" || typeof value !== "boolean") throw new Error("Invalid host setting");
            const next = { ...values, [key]: value };
            api().Data.save(NAME, "host-settings", next);
            values[key] = value;
            definitions[key].onChange?.(value);
            return true;
        }
    }) };
}
