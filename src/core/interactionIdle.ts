// SPDX-License-Identifier: GPL-3.0-or-later
// BD's filesystem bridge is synchronous even behind a Promise. Keep optional
// persistence out of pointer gestures, then yield a task between queued writes.
export function createInteractionIdle() {
    let active = 0, quietUntil = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waiting: (() => void)[] = [];
    const schedule = () => {
        if (active || !waiting.length || timer !== undefined) return;
        timer = setTimeout(() => {
            timer = undefined;
            if (active) return;
            if (Date.now() < quietUntil) { schedule(); return; }
            waiting.shift()?.();
            // One writer per task, including independent native/backup queues.
            // Admit its continuation before scheduling the next timer so queued
            // input gets an opportunity to acquire the gate between writers.
            void Promise.resolve().then(schedule);
        }, Math.max(0, quietUntil - Date.now()));
    };
    return {
        beginInteraction() {
            active++;
            clearTimeout(timer); timer = undefined;
            let ended = false;
            return () => {
                if (ended) return;
                ended = true; active--;
                quietUntil = Date.now() + 150;
                schedule();
            };
        },
        waitForInteractionIdle() {
            const pending = new Promise<void>(resolve => { waiting.push(resolve); });
            schedule();
            return pending;
        },
    };
}
const interactionIdle = createInteractionIdle();
export const { beginInteraction, waitForInteractionIdle } = interactionIdle;
