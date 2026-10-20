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
const apiCalls = {}, resources = { streams: 0, toasts: 0, openedStreams: 0, closedStreams: 0, peakStreams: 0,
    deviceGrants: 0, refreshAttempts: 0, refreshSuccess: 0, rejectedRefresh: 0, rejectedAccess: 0,
    expiryEvents: 0, networkFailures: 0, networkTransitions: 0, deniedDestinations: 0 };
let offline = false, current = null, generation = 0, deviceCode = null;
const liveStreams = new Set(), consumedRefresh = new Set(), rotations = [];
const mint = reason => {
    generation++;
    const issuedAt = Date.now();
    current = { access: 'fixture-access-' + generation + '-' + crypto.randomUUID(),
        refresh: 'fixture-refresh-' + generation + '-' + crypto.randomUUID(), issuedAt, expiresAt: issuedAt + 900000 };
    rotations.push({ generation, reason, issuedAt, expiresAt: current.expiresAt });
    return { access_token: current.access, refresh_token: current.refresh, token_type: 'Bearer', expires_in: 900, scope: scopes.join(' '), connectionId };
};
window.fixtureNetwork = enabled => {
    offline = !enabled; resources.networkTransitions++;
    if (offline) for (const stream of [...liveStreams]) stream.fail();
};
window.fixtureMetrics = () => ({ offline, generation, rotations: rotations.map(r => ({...r})), consumedRefresh: consumedRefresh.size,
    activeTokenAgeSeconds: current ? (Date.now() - current.issuedAt) / 1000 : null, ...resources });
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
        const parsed = new URL(url);
        if (parsed.origin !== 'https://panel.majestic-rp.tech' || !parsed.pathname.startsWith('/api/plugin/v1/')) {
            resources.deniedDestinations++; throw Error('Unexpected fixture destination');
        }
        const endpoint = parsed.pathname.replace('/api/plugin/v1', '');
        apiCalls[endpoint] = (apiCalls[endpoint] ?? 0) + 1;
        if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        if (offline) { resources.networkFailures++; throw Error('Synthetic network loss'); }
        const now = new Date().toISOString();
        const json = value => Response.json(value);
        if (endpoint === '/oauth/device_authorization') {
            deviceCode = 'fixture-device-' + crypto.randomUUID();
            return json({ device_code: deviceCode, user_code: 'TEST-CODE', verification_uri: 'https://panel.majestic-rp.tech/connect', verification_uri_complete: 'https://panel.majestic-rp.tech/connect?user_code=TEST-CODE', expires_in: 600, interval: 1 });
        }
        if (endpoint === '/oauth/token') {
            const body = JSON.parse(options.body ?? '{}');
            if (body.grant_type === 'refresh_token') {
                resources.refreshAttempts++;
                if (consumedRefresh.has(body.refresh_token)) {
                    current = null;
                    resources.rejectedRefresh++;
                    return Response.json({ code: 'session_revoked', error: 'invalid_grant' }, { status: 401 });
                }
                if (!current || body.refresh_token !== current.refresh) {
                    resources.rejectedRefresh++; return Response.json({error: 'invalid_grant'}, {status: 400});
                }
                consumedRefresh.add(body.refresh_token); resources.refreshSuccess++;
                return json(mint('refresh'));
            }
            if (body.grant_type !== 'urn:ietf:params:oauth:grant-type:device_code' || !deviceCode || body.device_code !== deviceCode)
                return Response.json({error: 'invalid_grant'}, {status: 400});
            deviceCode = null; resources.deviceGrants++;
            return json(mint('device'));
        }
        if (!current || new Headers(options.headers).get('authorization') !== 'Bearer ' + current.access || Date.now() >= current.expiresAt) {
            resources.rejectedAccess++; return Response.json({error: 'invalid_token'}, {status: 401});
        }
        if (endpoint === '/me') return json({ schemaVersion: 1, accountId, connectionId, name: 'Memory fixture', projects: ['majestic', 'russia-online'], scopes, permissionsRevision: '1', minimumPluginVersion: '1.0.0', serverTime: now });
        if (endpoint === '/snapshot') return json({ schemaVersion: 1, accountId, projects: ['majestic', 'russia-online'], permissionsRevision: '1', revision: '1', serverTime: now,
            faq: Array.from({ length: 134 }, (_, i) => ({ id: (i < 69 ? 'majestic:' : 'russia-online:') + (i + 1), version: '1', title: 'Template fixture ' + i, text: '**Приветствую!**\n[[greeting:end]]\n\n' + 'Проверьте настройки игры. '.repeat(45), format: 'text', projects: [i < 69 ? 'majestic' : 'russia-online'], category: 'Category ' + i % 5, tags: [], status: 'actual', updatedAt: now })),
            personal: [{ id: '1', version: '1', title: 'Personal fixture', text: 'Fixture personal answer', format: 'text', projects: ['majestic'], shared: false, command: null, color: null, folderId: null, updatedAt: now }], folders: [], trash: [], colorLabels: {}, limits: { title: 160, text: 20000, folderTitle: 120, command: 40, colors: ['red','blue'], trashDays: 7 } });
        if (endpoint === '/sync/events') {
            let timer, expiryTimer, closed = false, controller;
            const entry = { fail: () => { resources.networkFailures++; finish(true); } };
            const finish = failed => {
                if (closed) return; closed = true; clearInterval(timer); clearTimeout(expiryTimer);
                resources.streams--; resources.closedStreams++; liveStreams.delete(entry);
                options.signal?.removeEventListener('abort', close);
                try { if (failed) controller.error(new Error('Synthetic network loss')); else controller.close(); } catch {}
            };
            const close = () => finish(false);
            const body = new ReadableStream({ start(c) {
                controller = c; resources.streams++; resources.openedStreams++; resources.peakStreams = Math.max(resources.peakStreams, resources.streams);
                liveStreams.add(entry);
                c.enqueue(new TextEncoder().encode(': heartbeat\n\n'));
                timer = setInterval(() => c.enqueue(new TextEncoder().encode(': heartbeat\n\n')), 15000);
                expiryTimer = setTimeout(() => {
                    if (closed) return;
                    resources.expiryEvents++;
                    c.enqueue(new TextEncoder().encode('event: token.expired\ndata: {}\n\n'));
                    close();
                }, Math.max(0, current.expiresAt - Date.now()));
                options.signal?.addEventListener('abort', close, { once: true });
            }, cancel: close });
            return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
        }
        return new Response('Unavailable fixture endpoint', { status: 404 });
    } }
};
window.hostMetrics = () => ({ fluxListeners: [...flux.values()].reduce((sum, x) => sum + x.size, 0), storeListeners: changeListeners.size, savedKeys: saved.size, ...resources, apiCalls: { ...apiCalls } });
})();
