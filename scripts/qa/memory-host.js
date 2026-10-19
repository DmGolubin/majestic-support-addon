// Test host only: synthetic account/catalog; no real Discord or panel connection.
(() => {
window.module = { exports: {} };
window.process = { platform: 'linux', env: {} };
window.Buffer = { byteLength: text => new TextEncoder().encode(text).byteLength };
window.require = name => {
    if (['fs', 'crypto', 'path'].includes(name)) return {};
    if (name === 'electron') return { clipboard: { writeText() {} }, shell: { openExternal() {} } };
    throw Error('Unexpected host module: ' + name);
};
window.open = () => null;
const flux = new Map(), changeListeners = new Set(), saved = new Map();
const apiCalls = {}, resources = { streams: 0, toasts: 0 };
const channel = { id: '123456789012345678', name: 'memory-fixture', guild_id: '530693013622489088' };
const accountId = '123456789012345678', connectionId = '11111111-1111-4111-8111-111111111111';
const scopes = ['profile:read', 'faq:read', 'personal:read', 'folders:read', 'sync:read', 'personal:write', 'folders:write'];
const listen = { addChangeListener: fn => changeListeners.add(fn), removeChangeListener: fn => changeListeners.delete(fn) };
const stores = {
    ChannelStore: { getChannel: () => channel, ...listen }, SelectedChannelStore: { getChannelId: () => channel.id },
    SelectedGuildStore: { getGuildId: () => channel.guild_id }, GuildStore: { getGuild: () => ({ name: 'Fixture' }) },
    UserStore: { getCurrentUser: () => ({ id: accountId }), ...listen }, AccessibilityStore: {}, LocaleStore: {}, ThemeStore: {}
};
const dispatch = {
    subscribe(type, fn) { if (!flux.has(type)) flux.set(type, new Set()); flux.get(type).add(fn); },
    unsubscribe(type, fn) { flux.get(type)?.delete(fn); },
    dispatch(event) { for (const fn of flux.get(event.type) ?? []) fn(event); }
};
window.BdApi = {
    React: testReact, ReactDOM: testReactDOM,
    Webpack: { getStore: name => stores[name], getModule: filter => filter(dispatch) ? dispatch : undefined },
    Data: { load: (_name, key) => saved.get(key), save: (_name, key, value) => saved.set(key, structuredClone(value)) },
    Plugins: { folder: '/fixture/plugins' }, UI: { showToast() { resources.toasts++; } },
    DOM: { addStyle(name, css) { const el = document.createElement('style'); el.id = name; el.textContent = css; document.head.append(el); }, removeStyle(name) { document.getElementById(name)?.remove(); } },
    Net: { async fetch(url, options = {}) {
        const endpoint = new URL(url).pathname.replace('/api/plugin/v1', '');
        apiCalls[endpoint] = (apiCalls[endpoint] ?? 0) + 1;
        const now = new Date().toISOString();
        const json = value => Response.json(value);
        if (endpoint === '/oauth/device_authorization') return json({ device_code: 'fixture-device', user_code: 'TEST-CODE', verification_uri: 'https://panel.majestic-rp.tech/connect', verification_uri_complete: 'https://panel.majestic-rp.tech/connect?user_code=TEST-CODE', expires_in: 600, interval: 1 });
        if (endpoint === '/oauth/token') return json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', token_type: 'Bearer', expires_in: 900, scope: scopes.join(' '), connectionId });
        if (endpoint === '/me') return json({ schemaVersion: 1, accountId, connectionId, name: 'Memory fixture', projects: ['majestic', 'russia-online'], scopes, permissionsRevision: '1', minimumPluginVersion: '1.0.0', serverTime: now });
        if (endpoint === '/snapshot') return json({ schemaVersion: 1, accountId, projects: ['majestic', 'russia-online'], permissionsRevision: '1', revision: '1', serverTime: now,
            faq: Array.from({ length: 134 }, (_, i) => ({ id: (i < 69 ? 'majestic:' : 'russia-online:') + (i + 1), version: '1', title: 'Template fixture ' + i, text: '**Приветствую!**\n[[greeting:end]]\n\n' + 'Проверьте настройки игры. '.repeat(45), format: 'text', projects: [i < 69 ? 'majestic' : 'russia-online'], category: 'Category ' + i % 5, tags: [], status: 'actual', updatedAt: now })),
            personal: [{ id: '1', version: '1', title: 'Personal fixture', text: 'Fixture personal answer', format: 'text', projects: ['majestic'], shared: false, command: null, color: null, folderId: null, updatedAt: now }], folders: [], trash: [], colorLabels: {}, limits: { title: 160, text: 20000, folderTitle: 120, command: 40, colors: ['red','blue'], trashDays: 7 } });
        if (endpoint === '/sync/events') {
            let timer, closed = false, controller;
            const close = () => { if (closed) return; closed = true; clearInterval(timer); resources.streams--; options.signal?.removeEventListener('abort', close); try { controller.close(); } catch {} };
            const body = new ReadableStream({ start(c) { controller = c; resources.streams++; c.enqueue(new TextEncoder().encode(': heartbeat\n\n')); timer = setInterval(() => c.enqueue(new TextEncoder().encode(': heartbeat\n\n')), 15000); options.signal?.addEventListener('abort', close, { once: true }); }, cancel: close });
            return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
        }
        return new Response('Unavailable fixture endpoint', { status: 404 });
    } }
};
window.hostMetrics = () => ({ fluxListeners: [...flux.values()].reduce((sum, x) => sum + x.size, 0), storeListeners: changeListeners.size, savedKeys: saved.size, ...resources, apiCalls: { ...apiCalls } });
})();
