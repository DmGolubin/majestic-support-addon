// Version 2: construction attribution and WeakRefs; never retain observers/targets.
(() => {
    const timers = new Map(), frames = new Map(), observers = new Set(), callbacks = {};
    const owner = () => {
        const stack = new Error().stack ?? '';
        for (const frame of stack.split('\n').slice(2)) {
            if (/\/host\.js/.test(frame)) return 'fixture';
            if (/\/runtime\.js/.test(frame)) return 'plugin';
            if (/\/react\.js/.test(frame)) return 'react';
            if (/InjectedScript|injectedScript|UtilityScript|utilityScript/.test(frame)) return 'playwright';
        }
        return 'other';
    };
    const count = (type, origin) => { const k = origin + ':' + type; callbacks[k] = (callbacks[k] ?? 0) + 1; };
    const timeout = window.setTimeout.bind(window), interval = window.setInterval.bind(window);
    const clearT = window.clearTimeout.bind(window), clearI = window.clearInterval.bind(window);
    const raf = window.requestAnimationFrame.bind(window), caf = window.cancelAnimationFrame.bind(window);
    for (const [name, native, kind] of [['setTimeout', timeout, 'timeout'], ['setInterval', interval, 'interval']]) {
        window[name] = (fn, delay, ...args) => {
            const origin = owner();
            const id = native(() => {
                if (kind === 'timeout') timers.delete(id);
                count(kind, origin);
                if (typeof fn === 'function') fn(...args); else (0, eval)(String(fn));
            }, delay);
            timers.set(id, {kind, delay: Number(delay) || 0, owner: origin}); return id;
        };
    }
    window.clearTimeout = id => { timers.delete(id); clearT(id); };
    window.clearInterval = id => { timers.delete(id); clearI(id); };
    window.requestAnimationFrame = fn => {
        const origin = owner();
        const id = raf(t => { frames.delete(id); count('animation', origin); fn(t); });
        frames.set(id, origin); return id;
    };
    window.cancelAnimationFrame = id => { frames.delete(id); caf(id); };
    for (const name of ['MutationObserver', 'ResizeObserver']) {
        const Native = window[name];
        window[name] = class extends Native {
            constructor(fn) {
                const record = {kind: name, owner: owner(), active: false, ref: null};
                super((...args) => { count(name, record.owner); fn(...args); });
                record.ref = new WeakRef(this);
                observers.add(record);
                this.__qaRecord = record;
            }
            observe(...args) { super.observe(...args); this.__qaRecord.active = true; }
            disconnect() { super.disconnect(); this.__qaRecord.active = false; }
        };
    }
    window.instrumentMetrics = () => {
        const byOwner = {}, live = [];
        for (const record of observers) {
            if (!record.ref.deref()) { observers.delete(record); continue; }
            const {kind, owner: origin, active} = record;
            live.push({kind, owner: origin, active});
            if (active) { const k = origin + ':' + kind; byOwner[k] = (byOwner[k] ?? 0) + 1; }
        }
        const sum = kind => live.filter(r => r.kind === kind && r.active).length;
        return {version: 2, callbacks: {...callbacks}, observers: live, activeObserversByOwner: byOwner,
            activeMutationObservers: sum('MutationObserver'), activeResizeObservers: sum('ResizeObserver'),
            pendingFrames: frames.size, framesByOwner: [...frames.values()], timers: [...timers.values()],
            note: 'Legacy counts included Playwright observers and collected objects; v2 prunes WeakRefs and separates construction owners.'};
    };
    window.testFrame = () => new Promise(resolve => raf(() => raf(resolve)));
})();
