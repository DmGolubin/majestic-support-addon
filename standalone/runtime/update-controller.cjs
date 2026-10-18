/* SPDX-License-Identifier: GPL-3.0-or-later */
"use strict";
const { compareVersions } = require('../../distribution/updater/index.cjs');

// Poll through the shared engine, then hand its reverified package to a helper
// that survives Electron exit. Native code is NEVER replaced inside this host.
function createStandaloneController({ createUpdater, config, stagingDir, launch, notify = () => {},
    onError = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, random = Math.random }) {
    let stopped = false, timer, inFlight, handedOff = false;
    const updater = createUpdater({ config, variant: 'standalone', stagingDir,
        currentVersion: config.version, baseVersion: config.version,
        adapter: {
            canApplyNative: async () => false,
            // Even a renderer ZIP receives a full install after exit. No reload,
            // IPC execution, or loss of unsaved drafts during this session.
            apply: async () => ({ applied: false, reason: 'Install after the host closes' })
        }
    });
    async function handoffPending() {
        const pending = await updater.getPending();
        if (!pending || stopped || handedOff || compareVersions(pending.version, config.version) <= 0) return;
        await launch(pending);
        handedOff = true;
        notify(pending.version);
    }
    async function tick() {
        try {
            // Clears a pending record already included in the running build.
            // Our adapter never writes native code inside a running Electron host.
            try {
                await updater.applyPending({ phase: 'startup' });
                // Recover a verified download offline before contacting GitHub.
                await handoffPending();
            } catch (error) {
                // check() quarantines invalid pending state and can download a fresh
                // copy; a failed offline handoff must not permanently block discovery.
                onError(error);
            }
            if (!stopped && !handedOff) {
                await updater.check();
                await handoffPending();
            }
        } catch (error) { onError(error); }
        finally {
            if (!stopped && !handedOff) {
                timer = setTimer(() => { inFlight = tick(); }, config.checkIntervalHours * 3600000 * (0.9 + random() * 0.2));
                timer?.unref?.();
            }
        }
    }
    return {
        start() { if (!inFlight && !stopped) inFlight = tick(); return inFlight; },
        async stop() { stopped = true; clearTimer(timer); await updater.stop(); await inFlight; }
    };
}
module.exports = { createStandaloneController };
