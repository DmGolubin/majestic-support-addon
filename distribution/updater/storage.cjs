'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { assert, fail } = require('./validation.cjs');

async function safePath(target) {
    assert(path.isAbsolute(target), 'ABSOLUTE_PATH_REQUIRED');
    if (process.platform === 'win32') assert(/^[A-Za-z]:\\/.test(target) && !target.slice(2).includes(':'), 'LOCAL_PATH_REQUIRED');
    let current = path.resolve(target);
    for (;;) {
        try { assert(!(await fs.lstat(current)).isSymbolicLink(), 'SYMLINK_REFUSED'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
}
async function prepare(root) {
    await safePath(root);
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    await safePath(root);
}
const NONCE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
async function lockOwner(file) {
    let owner;
    try { owner = await readJson(file); } catch { fail('UPDATER_BUSY'); }
    if (!owner) return null;
    assert(owner.schema === 1 && Number.isSafeInteger(owner.pid) && owner.pid > 0 && NONCE.test(owner.nonce), 'UPDATER_BUSY');
    return owner;
}
async function acquire(root, lock, preparedOwner, probeProcess, visited = new Set()) {
    await safePath(lock);
    try { await fs.link(preparedOwner, lock); return; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const observed = await lockOwner(lock);
    if (observed) {
        try { probeProcess(observed.pid, 0); fail('UPDATER_BUSY'); }
        catch (error) { if (error.code !== 'ESRCH') fail('UPDATER_BUSY'); }
        // A recovery mutex is keyed to this exact dead owner's nonce, never to a
        // reusable lock name. A late contender cannot erase a replacement owner.
        // Recovery mutexes themselves use this same crash-recoverable protocol.
        const recovery = path.join(root, `.recover-${observed.nonce}`);
        assert(!visited.has(recovery) && recovery !== lock, 'UPDATER_BUSY');
        const ancestors = new Set(visited); ancestors.add(lock);
        await acquire(root, recovery, preparedOwner, probeProcess, ancestors);
        try {
            const current = await lockOwner(lock);
            if (current?.nonce === observed.nonce && current.pid === observed.pid) await fs.unlink(lock);
        } finally { await fs.unlink(recovery); }
    }
    // One retry per lock, no sleeps or age-based stealing. The finite chain of
    // crashed recovery owners is traversed once; cycles mean corrupt metadata.
    try { await fs.link(preparedOwner, lock); }
    catch (error) { if (error.code === 'EEXIST') fail('UPDATER_BUSY'); throw error; }
}
async function locked(root, operation, { probeProcess = (pid, signal) => process.kill(pid, signal) } = {}) {
    await prepare(root);
    const lock = path.join(root, '.lock');
    const nonce = randomUUID();
    const preparedOwner = path.join(root, `.owner-${nonce}.tmp`);
    // Persist before publishing: hard-link creation is atomic and exclusive.
    // A crash can leave an orphan .owner file, never an ownerless active lock.
    await writeDurable(preparedOwner, JSON.stringify({ schema: 1, pid: process.pid, nonce }));
    try {
        await acquire(root, lock, preparedOwner, probeProcess);
        try { return await operation(); }
        finally { await fs.unlink(lock); }
    } finally { await fs.unlink(preparedOwner); }
}
async function writeDurable(file, bytes) {
    await safePath(file);
    const handle = await fs.open(file, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
}
async function atomicJson(file, object) {
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
        await writeDurable(temp, JSON.stringify(object));
        await safePath(file);
        await fs.rename(temp, file);
    } finally { await fs.unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}
async function readJson(file) {
    await safePath(file);
    let handle;
    try { handle = await fs.open(file, 'r'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    try {
        const stat = await handle.stat();
        assert(stat.isFile() && stat.size <= 1024 * 1024, 'INVALID_RECORD');
        // Read one extra byte so a concurrently growing local record stays bounded.
        const bytes = Buffer.alloc(1024 * 1024 + 1);
        let total = 0;
        while (total < bytes.length) {
            const { bytesRead } = await handle.read(bytes, total, bytes.length - total, total);
            if (!bytesRead) break;
            total += bytesRead;
        }
        assert(total <= 1024 * 1024, 'INVALID_RECORD');
        return JSON.parse(bytes.subarray(0, total).toString('utf8'));
    } finally { await handle.close(); }
}
async function verify(file, asset) {
    await safePath(file);
    const handle = await fs.open(file, 'r');
    try {
        const stat = await handle.stat();
        assert(stat.isFile() && stat.size === asset.size, 'SIZE_MISMATCH');
        const hash = createHash('sha256');
        const buffer = Buffer.alloc(64 * 1024);
        let total = 0;
        for (;;) {
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
            if (!bytesRead) break;
            total += bytesRead;
            assert(total <= asset.size, 'SIZE_MISMATCH');
            hash.update(buffer.subarray(0, bytesRead));
        }
        assert(total === asset.size, 'SIZE_MISMATCH');
        assert(hash.digest('hex') === asset.sha256, 'HASH_MISMATCH');
    } finally { await handle.close(); }
}
module.exports = { safePath, prepare, locked, writeDurable, atomicJson, readJson, verify };
