// SPDX-License-Identifier: GPL-3.0-or-later
import { createDiagnosticBackup } from "../core/diagnosticBackup";
import { waitForInteractionIdle } from "../core/interactionIdle";
import { storage } from "../platform";

const KEY = "SupportTemplates_diagnostics_v1";
// A single queue survives diagnostics stop/start, preventing stale writes from
// overtaking a new session's opt-out. BD's async storage shim is synchronous
// underneath, so the interaction gate must run before invoking storage.set.
export const diagnosticBackup = createDiagnosticBackup({
    beforeWrite: waitForInteractionIdle,
    async read() {
        const saved = await storage.get(KEY);
        if (saved !== undefined && saved !== null) return saved;
        // Migrate the previous browser backup only when the host has no record.
        // Discord may remove localStorage entirely; that is not a host-backup error.
        try { return window.localStorage?.getItem(KEY) ?? null; } catch { return null; }
    },
    write: value => storage.set(KEY, value),
});
