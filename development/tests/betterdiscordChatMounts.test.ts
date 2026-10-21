import { describe, expect, it, vi } from "vitest";
import { bdRequire, loadAdapter } from "./betterdiscordHarness";

const { JSDOM } = bdRequire("jsdom");
function fixture(channel: any = { id: "1", guild_id: "530693013622489088" }) {
    const w = new JSDOM('<body><section id="messages"></section><div class="channelTextArea_test"><div data-slate-editor="true"></div><div class="buttons_test"></div></div></body>', { url: 'https://discord.com' }).window;
    const frames = new Map<number, () => void>(); let seq = 0;
    const roots: any[] = [], listeners = new Set();
    let observer: any;
    const bus = { dispatch() {}, subscribe: vi.fn((_t, f) => { listeners.add(f); }), unsubscribe: vi.fn((_t, f) => { listeners.delete(f); }) };
    const host = { React: { createElement: () => ({}) }, ReactDOM: { createRoot: vi.fn(() => { const root = { render: vi.fn(), unmount: vi.fn() }; roots.push(root); return root; }) },
        Webpack: { getModule: () => bus, getStore: (name: string) => name === "ChannelStore" ? { getChannel: () => channel } : { getChannelId: () => "1" } } };
    const { mountChatButtons } = loadAdapter("chatMounts.ts", {}, { BdApi: host, document: w.document, Element: w.Element,
        requestAnimationFrame: (f: any) => { frames.set(++seq, f); return seq; }, cancelAnimationFrame: (n: number) => frames.delete(n),
        MutationObserver: class { observe = vi.fn(); disconnect = vi.fn(); constructor(public callback: any) { observer = this; } } });
    return { w, host, bus, roots, frames, listeners, mount: () => mountChatButtons(() => null), observer: () => observer,
        mutate: (target: any, added: any[] = [], removed: any[] = []) => observer.callback([{ target, addedNodes: added, removedNodes: removed }]),
        flush: () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(f => f()); } };
}

describe("BetterDiscord composer resource lifecycle", () => {
    it.each([1, 3])("mounts the template button in private channel type %s", type => {
        const f = fixture({ id: "1", type }), stop = f.mount();
        expect(f.w.document.querySelector('.stx-bd-button-mount')).not.toBeNull(); stop();
    });
    it.each([null, { id: "1" }, { id: "1", type: 0 }, { id: "1", guild_id: "unsupported", type: 1 }])("does not mount for an unknown or unsupported channel %j", channel => {
        const f = fixture(channel), stop = f.mount();
        expect(f.w.document.querySelector('.stx-bd-button-mount')).toBeNull(); stop();
    });
    it("rolls back subscription and observer if subscribe registers then throws", () => {
        const f = fixture();
        f.bus.subscribe.mockImplementationOnce((_t, fn) => { f.listeners.add(fn); throw Error("subscribe failure"); });
        expect(f.mount).toThrow("subscribe failure");
        expect(f.listeners.size).toBe(0);
        expect(f.observer().disconnect).toHaveBeenCalled();
        expect(f.frames.size).toBe(0);
    });
    it("removes partial mount when createRoot throws", () => {
        const f = fixture(); f.host.ReactDOM.createRoot.mockImplementationOnce(() => { throw Error("root failure"); });
        expect(f.mount).toThrow("root failure");
        expect(f.w.document.querySelector('.stx-bd-button-mount')).toBeNull();
        expect(f.listeners.size).toBe(0);
        expect(f.observer().disconnect).toHaveBeenCalled();
    });
    it("does not schedule scans for messages or own button rendering", () => {
        const f = fixture(), stop = f.mount();
        const message = f.w.document.createElement('div'); message.textContent = 'new message';
        for (let i = 0; i < 120; i++) f.mutate(f.w.document.getElementById('messages'), [message]);
        const node = f.w.document.querySelector('.stx-bd-button-mount');
        f.mutate(node, [f.w.document.createElement('button')]);
        expect(f.frames.size).toBe(0); stop();
    });
    it("remounts replaced toolbar and detects new or removed composers", () => {
        const f = fixture(), stop = f.mount(), area = f.w.document.querySelector('[class*=channelTextArea]');
        const old = area.querySelector('[class*=buttons]'), toolbar = f.w.document.createElement('div'); toolbar.className = 'buttons_new'; old.replaceWith(toolbar);
        f.mutate(area, [toolbar], [old]); expect(f.frames.size).toBe(1); f.flush();
        expect(toolbar.querySelector('.stx-bd-button-mount')).not.toBeNull();
        const next = area.cloneNode(true); f.w.document.body.append(next); f.mutate(f.w.document.body, [next]); f.flush();
        expect(f.w.document.querySelectorAll('.stx-bd-button-mount').length).toBe(2);
        area.remove(); f.mutate(f.w.document.body, [], [area]); f.flush();
        expect(f.roots[1].unmount).toHaveBeenCalled(); stop();
    });
    it("continues cleanup after unmount throws and retries transient unsubscribe", () => {
        const f = fixture(), stop = f.mount();
        f.roots[0].unmount.mockImplementationOnce(() => { throw Error('unmount failure'); });
        f.bus.unsubscribe.mockImplementationOnce(() => { throw Error('unsubscribe failure'); });
        stop(); stop();
        expect(f.listeners.size).toBe(0);
        expect(f.w.document.querySelector('.stx-bd-button-mount')).toBeNull();
        expect(f.frames.size).toBe(0);
    });
    it("does not accumulate generations when the host keeps refusing unsubscribe", () => {
        const f = fixture(), stop = f.mount();
        const unsubscribe = f.bus.unsubscribe.getMockImplementation()!;
        f.bus.unsubscribe.mockImplementation(() => { throw Error('host unavailable'); });
        stop();
        expect(f.mount).toThrow('subscription still active');
        expect(f.listeners.size).toBe(1);
        for (const fn of f.listeners) (fn as () => void)();
        expect(f.frames.size).toBe(0);
        f.bus.unsubscribe.mockImplementation(unsubscribe);
        const recovered = f.mount(); expect(f.listeners.size).toBe(1);
        recovered(); expect(f.listeners.size).toBe(0);
    });
    it("releases resources if an asynchronous composer replacement fails to mount", () => {
        const f = fixture(), stop = f.mount(), area = f.w.document.querySelector('[class*=channelTextArea]');
        const replacement = area.cloneNode(true); area.replaceWith(replacement);
        f.host.ReactDOM.createRoot.mockImplementationOnce(() => { throw Error('replacement root failure'); });
        f.mutate(f.w.document.body, [replacement], [area]);
        f.flush();
        expect(f.listeners.size).toBe(0); expect(f.frames.size).toBe(0);
        expect(f.w.document.querySelector('.stx-bd-button-mount')).toBeNull();
        expect(f.observer().disconnect).toHaveBeenCalled(); stop();
    });
    it("does not recursively unsubscribe when host cleanup re-enters stop", () => {
        const f = fixture(), stop = f.mount();
        let attempts = 0;
        f.bus.unsubscribe.mockImplementation((_type, fn) => {
            if (++attempts > 2) throw Error('recursive unsubscribe');
            stop(); f.listeners.delete(fn);
        });
        stop();
        expect(attempts).toBe(1);
        expect(f.listeners.size).toBe(0);
    });
});
