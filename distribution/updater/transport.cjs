'use strict';
const https = require('node:https');
const { assert, fail } = require('./validation.cjs');

const CDN = new Set(['release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com']);
function validateUrl(value, { repo, role, tag, name, redirected = false }) {
    let url;
    try { url = new URL(value); } catch { fail('INVALID_URL'); }
    assert(url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash, 'UNSAFE_URL');
    if (role === 'api') {
        assert(url.hostname === 'api.github.com' && url.pathname === `/repos/${repo}/releases`, 'UNSAFE_URL');
        assert(/^\?per_page=100&page=[1-3]$/.test(url.search), 'UNSAFE_URL');
    } else if (url.hostname === 'github.com') {
        assert(url.pathname === `/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}` && !url.search, 'UNSAFE_URL');
    } else {
        assert(redirected && CDN.has(url.hostname), 'UNSAFE_URL');
    }
    return url.href;
}
function defaultTransport(url, { signal }) {
    return new Promise((resolve, reject) => {
        const request = https.get(url, {
            signal,
            headers: { 'User-Agent': 'SupportTemplates-Updater/1', Accept: 'application/json, application/octet-stream', 'Accept-Encoding': 'identity' }
        }, response => resolve({ status: response.statusCode, headers: response.headers, body: response }));
        request.on('error', reject);
    });
}
function abortError() { const error = new Error('ABORTED'); error.code = 'ABORTED'; return error; }
function abortable(promise, signal) {
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
        const abort = () => reject(abortError());
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
}
// Every redirect and body byte shares a single wall-clock deadline and byte cap.
async function receive(url, options) {
    const { transport = defaultTransport, signal, timeoutMs, maxBytes, onChunk, expectedSize } = options;
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    let body;
    try {
        for (let redirects = 0; ; redirects++) {
            url = validateUrl(url, { ...options, redirected: redirects > 0 });
            const response = await abortable(transport(url, { signal: controller.signal }), controller.signal);
            body = response.body;
            const headers = Object.fromEntries(Object.entries(response.headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
            if ([301, 302, 303, 307, 308].includes(response.status)) {
                body?.destroy?.();
                assert(redirects < 5 && typeof headers.location === 'string', 'REDIRECT_LIMIT');
                url = new URL(headers.location, url).href;
                continue;
            }
            if (response.status !== 200) { const e = new Error('HTTP_STATUS'); e.code = 'HTTP_STATUS'; e.status = response.status; throw e; }
            assert(!headers['content-encoding'] || headers['content-encoding'] === 'identity', 'ENCODING_REFUSED');
            if (headers['content-length'] !== undefined) {
                assert(/^\d+$/.test(String(headers['content-length'])), 'INVALID_CONTENT_LENGTH');
                const length = Number(headers['content-length']);
                assert(Number.isSafeInteger(length) && length <= maxBytes && (expectedSize === undefined || length === expectedSize), 'SIZE_MISMATCH');
            }
            assert(body && typeof body[Symbol.asyncIterator] === 'function', 'INVALID_BODY');
            let total = 0;
            const iterator = body[Symbol.asyncIterator]();
            for (;;) {
                const { value, done } = await abortable(iterator.next(), controller.signal);
                if (done) break;
                assert(Buffer.isBuffer(value) || value instanceof Uint8Array, 'INVALID_BODY');
                const chunk = Buffer.from(value);
                total += chunk.length;
                assert(total <= maxBytes && (expectedSize === undefined || total <= expectedSize), 'SIZE_MISMATCH');
                await onChunk(chunk);
            }
            assert(expectedSize === undefined || total === expectedSize, 'SIZE_MISMATCH');
            return total;
        }
    } finally {
        clearTimeout(timer); signal?.removeEventListener('abort', abort); body?.destroy?.(); controller.abort();
    }
}
async function json(url, options) {
    const chunks = [];
    await receive(url, { ...options, onChunk: async chunk => { chunks.push(chunk); } });
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('INVALID_JSON'); }
}
module.exports = { defaultTransport, validateUrl, receive, json };
