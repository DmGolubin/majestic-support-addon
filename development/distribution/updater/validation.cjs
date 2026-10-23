'use strict';

const VARIANTS = ['standalone', 'vencord', 'betterdiscord'];
function fail(code) { const error = new Error(code); error.code = code; throw error; }
function assert(value, code) { if (!value) fail(code); }
function version(value) {
    assert(typeof value === 'string' && value.length <= 128, 'INVALID_VERSION');
    const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
    assert(m, 'INVALID_VERSION');
    const core = m.slice(1, 4).map(Number);
    assert(core.every(Number.isSafeInteger), 'INVALID_VERSION');
    const pre = m[4] ? m[4].split('.') : [];
    assert(pre.every(x => !/^\d+$/.test(x) || x === '0' || !x.startsWith('0')), 'INVALID_VERSION');
    return { core, pre };
}
function compareVersions(a, b) {
    const x = version(a), y = version(b);
    for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] > y.core[i] ? 1 : -1;
    if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
    for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
        const l = x.pre[i], r = y.pre[i];
        if (l === undefined || r === undefined) return l === r ? 0 : l === undefined ? -1 : 1;
        if (l === r) continue;
        const ln = /^\d+$/.test(l), rn = /^\d+$/.test(r);
        if (ln && rn) return l.length === r.length ? (l > r ? 1 : -1) : l.length > r.length ? 1 : -1;
        if (ln !== rn) return ln ? -1 : 1;
        return l > r ? 1 : -1;
    }
    return 0;
}
function inChannel(value, channel) {
    const parsed = version(value);
    return channel === 'stable' ? !parsed.pre.length : channel === 'canary' && parsed.pre[0] === 'canary';
}
function repository(value) {
    assert(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value) && value.length <= 200, 'INVALID_REPOSITORY');
    return value;
}
function assetName(value) {
    assert(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,179}$/.test(value) && !value.includes('..'), 'INVALID_ASSET_NAME');
    assert(!value.endsWith('.') && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value), 'INVALID_ASSET_NAME');
    return value;
}
function validateManifest(m, { repo, channel, variant, baseVersion, maxAssetBytes, releaseVersion }) {
    assert(m && m.schema === 1 && m.product === 'SupportTemplates' && m.repository === repo, 'INVALID_MANIFEST');
    assert(m.channel === channel && inChannel(m.version, channel), 'CHANNEL_MISMATCH');
    if (releaseVersion) assert(m.version === releaseVersion, 'RELEASE_VERSION_MISMATCH');
    assert(Array.isArray(m.assets) && m.assets.length > 0 && m.assets.length <= 12, 'INVALID_ASSETS');
    const seen = new Set();
    for (const a of m.assets) {
        assert(a && VARIANTS.includes(a.variant) && a.platform === 'win32' && ['renderer', 'native'].includes(a.kind), 'INVALID_ASSET');
        assetName(a.name);
        assert(Number.isSafeInteger(a.size) && a.size > 0 && a.size <= maxAssetBytes, 'INVALID_ASSET_SIZE');
        assert(typeof a.sha256 === 'string' && /^[a-f0-9]{64}$/.test(a.sha256), 'INVALID_HASH');
        assert(!seen.has(a.variant), 'DUPLICATE_VARIANT'); seen.add(a.variant);
        if (a.kind === 'renderer' && a.variant !== 'betterdiscord') version(a.baseVersion);
    }
    const asset = m.assets.find(a => a.variant === variant);
    if (asset && asset.kind === 'renderer' && variant !== 'betterdiscord') assert(asset.baseVersion === baseVersion, 'BASE_VERSION_MISMATCH');
    return asset;
}
module.exports = { VARIANTS, fail, assert, version, compareVersions, inChannel, repository, assetName, validateManifest };
