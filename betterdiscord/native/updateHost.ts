// SPDX-License-Identifier: GPL-3.0-or-later
import { hasNativeStorage } from "./capabilities";

export async function prepareUpdates(isStartup: () => boolean, onEvent: (event: any) => void) {
    if (!hasNativeStorage()) {
        onEvent({ type: "unsupported-host" });
        return null;
    }
    const native = await import("./updater");
    return native.prepareUpdates(isStartup, onEvent);
}
