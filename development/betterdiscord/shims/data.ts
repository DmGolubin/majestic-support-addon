// SPDX-License-Identifier: GPL-3.0-or-later
import { api, NAME } from "./host";
// BdApi.Data is for preferences/library data only. OAuth tokens use the native vault.
export async function get(key: string) {
    const value = api().Data.load(NAME, key);
    return value === undefined ? undefined : structuredClone(value);
}
export async function set(key: string, value: unknown) {
    const snapshot = structuredClone(value);
    api().Data.save(NAME, key, snapshot);
    // Some BD versions log write errors instead of throwing. Verify the persisted view.
    if (JSON.stringify(api().Data.load(NAME, key)) !== JSON.stringify(snapshot)) throw new Error("Local settings were not saved.");
}
