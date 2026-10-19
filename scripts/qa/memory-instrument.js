(() => {
    const timers = new Map(), frames = new Set();
    const counts = { timeoutCallbacks:0, intervalCallbacks:0, animationCallbacks:0, mutationCallbacks:0, resizeCallbacks:0, activeMutationObservers:0, activeResizeObservers:0 };
    const timeout = window.setTimeout.bind(window), interval = window.setInterval.bind(window), clearT = window.clearTimeout.bind(window), clearI = window.clearInterval.bind(window);
    const raf = window.requestAnimationFrame.bind(window), caf = window.cancelAnimationFrame.bind(window);
    window.setTimeout = (fn, delay, ...args) => {
        const id = timeout(() => { timers.delete(id); counts.timeoutCallbacks++; if(typeof fn === 'function')fn(...args); }, delay);
        timers.set(id, {kind:'timeout',delay:Number(delay)||0}); return id;
    };
    window.setInterval = (fn, delay, ...args) => {
        const id = interval(() => { counts.intervalCallbacks++; fn(...args); },delay);
        timers.set(id, {kind:'interval',delay:Number(delay)||0}); return id;
    };
    window.clearTimeout = id => { timers.delete(id); clearT(id); };
    window.clearInterval = id => { timers.delete(id); clearI(id); };
    window.requestAnimationFrame = fn => { const id=raf(t=>{frames.delete(id);counts.animationCallbacks++;fn(t)});frames.add(id);return id; };
    window.cancelAnimationFrame = id => { frames.delete(id);caf(id); };
    for (const [name,active,callbacks] of [['MutationObserver','activeMutationObservers','mutationCallbacks'],['ResizeObserver','activeResizeObservers','resizeCallbacks']]) {
        const Native=window[name];
        window[name]=class extends Native {
            active=false;
            constructor(fn){ super((...args)=>{counts[callbacks]++;fn(...args)}); }
            observe(...args){ super.observe(...args);if(!this.active){this.active=true;counts[active]++;} }
            disconnect(){super.disconnect();if(this.active){this.active=false;counts[active]--;}}
        };
    }
    // No strong references to callbacks/DOM: instrumentation must not create leaks.
    window.instrumentMetrics=()=>({...counts,pendingFrames:frames.size,timers:[...timers.values()]});
    window.testFrame=()=>new Promise(resolve=>raf(()=>raf(resolve)));
})();
