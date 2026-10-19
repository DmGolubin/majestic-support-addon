// SPDX-License-Identifier: GPL-3.0-or-later
import { hasNativeStorage } from "./capabilities";

let native: typeof import("./vault") | undefined;
export async function createPanelVault(accountId: string) {
    if (!hasNativeStorage()) return undefined; // Shared UI explicitly reports session-only login.
    native ??= await import("./vault");
    return native.createPanelVault(accountId);
}
export async function closePanelVault() {
    await native?.closePanelVault();
}
