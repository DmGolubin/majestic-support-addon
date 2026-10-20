// SPDX-License-Identifier: GPL-3.0-or-later
import { hasNativeStorage } from "./capabilities";

export async function prepareUpdates(isStartup: () => boolean, onEvent: (event: any) => void) {
    if (!hasNativeStorage()) {
        const host = await import("./hostUpdater");
        return host.prepareHostUpdates(isStartup, onEvent);
    }
    const native = await import("./updater");
    return native.prepareUpdates(isStartup, onEvent);
}
