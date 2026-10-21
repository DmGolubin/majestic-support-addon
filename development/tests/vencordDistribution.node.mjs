import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { writeTar, writeZip } from '../distribution/vencord/archive.mjs';
const { PIN, sha, files, readPackage, atomicJson } = createRequire(import.meta.url)('../distribution/vencord/runtime/package.cjs');
const { createAdapter, extract } = createRequire(import.meta.url)('../distribution/vencord/runtime/adapter.cjs');
const { launch, selected } = createRequire(import.meta.url)('../distribution/vencord/runtime/launch.cjs');
const { createUpdater } = createRequire(import.meta.url)('../distribution/updater/index.cjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const oldVersion = '0.1.0-canary.13', newVersion = '0.1.0-canary.14';
function temp(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vencord-distribution-test-'));
    t.after(() => {
        assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
        assert.match(path.basename(dir), /^vencord-distribution-test-/);
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return dir;
}
function put(file, bytes) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); }
const config = version => ({ schema: 1, version, channel: 'canary', releaseRepository: 'owner/release', manifestAsset: 'support-templates-update.json', checkIntervalHours: 6 });
function packageAt(target, version = oldVersion, { engine } = {}) {
    put(path.join(target, 'payload/loader.asar'), 'fixture loader ' + version);
    for (const file of ['patcher.js','preload.js','renderer.js','renderer.css','launch.cjs']) put(path.join(target, 'payload/runtime', file), 'fixture ' + version);
    fs.cpSync(path.join(root, 'distribution/updater'), path.join(target, 'payload/runtime/updater'), { recursive: true });
    if (engine) put(path.join(target, 'payload/runtime/updater/index.cjs'), engine);
    put(path.join(target, 'payload/runtime/release-config.json'), JSON.stringify(config(version)));
    const entries = files(path.join(target, 'payload')).map(file => ({ path: path.relative(target, file).replaceAll('\\','/'), size: fs.statSync(file).size, sha256: sha(fs.readFileSync(file)) }));
    put(path.join(target, 'manifest.json'), JSON.stringify({ schema: 1, product: 'SupportTemplatesVencord', variant: 'vencord-full', upstreamCommit: PIN, version, files: entries }));
    return readPackage(target);
}
function stored(dir, pkg) {
    const target = path.join(dir, 'versions', pkg.manifest.version);
    fs.cpSync(path.join(pkg.root, 'payload'), target, { recursive: true });
    fs.copyFileSync(path.join(pkg.root, 'manifest.json'), path.join(target, 'manifest.json'));
    return readPackage(target, true);
}
function context(assetPath, phase = 'startup') { return { phase, assetPath, version: newVersion, variant: 'vencord', asset: { kind: 'native' } }; }
test('deterministic ZIP/TAR ignores source mtimes and archive output stays readable', { timeout: 30000 }, t => {
    const dir = temp(t), tree = path.join(dir, 'tree'); put(path.join(tree, 'b.txt'), 'second'); put(path.join(tree, 'a.txt'), 'first');
    writeZip(tree, path.join(dir, 'a.zip')); writeTar(tree, path.join(dir, 'a.tar'));
    fs.utimesSync(path.join(tree, 'b.txt'), 100000, 200000);
    writeZip(tree, path.join(dir, 'b.zip')); writeTar(tree, path.join(dir, 'b.tar'));
    assert.equal(sha(fs.readFileSync(path.join(dir,'a.zip'))), sha(fs.readFileSync(path.join(dir,'b.zip'))));
    assert.equal(sha(fs.readFileSync(path.join(dir,'a.tar'))), sha(fs.readFileSync(path.join(dir,'b.tar'))));
    if (process.platform === 'win32') { extract(path.join(dir, 'a.zip'), path.join(dir, 'out')); assert.equal(fs.readFileSync(path.join(dir, 'out/tree/a.txt'),'utf8'), 'first'); }
});
test('manifest rejects tampering, unlisted payload, duplicate/case paths and wrong identity', { timeout: 30000 }, t => {
    for (const kind of ['tamper','extra','traversal','duplicate','variant','pin','size']) {
        const dir = path.join(temp(t), 'pkg'); packageAt(dir);
        const file = path.join(dir, 'manifest.json'), m = JSON.parse(fs.readFileSync(file));
        if (kind === 'tamper') put(path.join(dir, m.files[0].path), 'bad');
        if (kind === 'extra') put(path.join(dir, 'payload/runtime/foreign.js'), 'bad');
        if (kind === 'traversal') m.files[0].path = 'payload/runtime/../outside';
        if (kind === 'duplicate') m.files.push({ ...m.files[0], path: m.files[0].path.toUpperCase() });
        if (kind === 'variant') m.variant = 'standalone';
        if (kind === 'pin') m.upstreamCommit = 'bogus';
        if (kind === 'size') m.files[0].size++;
        put(file, JSON.stringify(m)); assert.throws(() => readPackage(dir), undefined, kind);
    }
});
test('runtime accepts a future valid upstream commit in incoming and stored packages', t => {
    const dir = temp(t), target = path.join(dir, 'pkg');
    packageAt(target, newVersion);
    const manifestPath = path.join(target, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const futureCommit = 'a'.repeat(40);
    assert.notEqual(futureCommit, PIN);
    manifest.upstreamCommit = futureCommit;
    put(manifestPath, JSON.stringify(manifest));
    const incoming = readPackage(target);
    assert.equal(incoming.manifest.upstreamCommit, futureCommit);
    assert.equal(stored(path.join(dir, 'channel'), incoming).manifest.upstreamCommit, futureCommit);
});
test('actual ZIP update publishes immutable complete runtime and a base-bound atomic pointer', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
    const dir = temp(t), channelRoot = path.join(dir, 'channel');
    const base = stored(channelRoot, packageAt(path.join(dir,'base')));
    const update = packageAt(path.join(dir,'update'), newVersion);
    const zip = path.join(dir,'update.zip'); writeZip(update.root, zip);
    const before = sha(fs.readFileSync(path.join(base.root,'runtime/patcher.js')));
    const adapter = createAdapter({ channelRoot, base, startupBarrier: () => true });
    assert.equal((await adapter.apply(context(zip))).applied, true);
    assert.equal(selected(channelRoot,base).manifest.version, newVersion);
    assert.equal(sha(fs.readFileSync(path.join(base.root,'runtime/patcher.js'))), before);
    assert.equal((await adapter.apply(context(zip))).applied, true, 'idempotent retry');
    const changed = { ...base, manifestHash: '0'.repeat(64) }; assert.equal(selected(channelRoot,changed), changed);
});
test('runtime callbacks cannot cross the native startup barrier', async t => {
    const dir = temp(t), base = stored(dir, packageAt(path.join(dir, 'pkg')));
    let called = false;
    const adapter = createAdapter({ channelRoot: dir, base, startupBarrier: () => false, extractArchive() { called = true; } });
    assert.equal((await adapter.apply(context('unused'))).applied, false);
    assert.equal(await adapter.canApplyNative(context('unused')), false);
    assert.equal(called, false);
});
test('incomplete new payload and immutable version collisions preserve old pointer', { timeout: 30000 }, async t => {
    const dir = temp(t), channelRoot = path.join(dir, 'channel'); const base = stored(channelRoot, packageAt(path.join(dir,'base')));
    atomicJson(path.join(channelRoot, 'active.json'), { schema: 1, baseVersion: oldVersion, baseManifestHash: base.manifestHash, version: oldVersion, manifestHash: base.manifestHash });
    const original = fs.readFileSync(path.join(channelRoot,'active.json'));
    const pkg = packageAt(path.join(dir,'new'),newVersion);
    const adapter = createAdapter({ channelRoot, base, startupBarrier: () => true, extractArchive: (_, to) => fs.cpSync(pkg.root, path.join(to, 'release'), { recursive: true }) });
    fs.unlinkSync(path.join(pkg.root, 'payload/runtime/preload.js'));
    await assert.rejects(adapter.apply(context(path.join(dir,'asset.zip'))));
    assert.deepEqual(fs.readFileSync(path.join(channelRoot,'active.json')), original);
    packageAt(pkg.root,newVersion); stored(channelRoot,pkg); put(path.join(channelRoot,'versions',newVersion,'runtime/patcher.js'),'tampered');
    await assert.rejects(adapter.apply(context(path.join(dir,'asset.zip'))));
    assert.deepEqual(fs.readFileSync(path.join(channelRoot,'active.json')), original);
});
test('ZIP traversal and existing extraction targets are refused', { skip: process.platform !== 'win32', timeout: 60000 }, t => {
    const dir=temp(t), tree=path.join(dir,'tree'); put(path.join(tree,'x.txt'),'bad');
    writeZip(tree,path.join(dir,'bad.zip'),'../outside');
    assert.throws(() => extract(path.join(dir,'bad.zip'),path.join(dir,'out')));
    assert.equal(fs.existsSync(path.join(dir,'outside')),false);
    assert.throws(() => extract(path.join(dir,'bad.zip'),tree));
});
test('native starts synchronously; updates prepare only the next startup then poll', async t => {
    const dir=temp(t), log=path.join(dir,'events.json');
    const engine=`const fs=require('fs'); const log=${JSON.stringify(log)}; function mark(x){let a=fs.existsSync(log)?JSON.parse(fs.readFileSync(log)):[];a.push(x);fs.writeFileSync(log,JSON.stringify(a));} exports.createUpdater=opts=>({async applyPending(c){if(c.phase!=='next-startup'||!await opts.adapter.canApplyNative(c))throw Error('barrier');await new Promise(r=>setTimeout(r,10));mark('applied');},start(){mark('poll');},async stop(){mark('stop');}});`;
    const base=stored(path.join(dir,'channel'),packageAt(path.join(dir,'pkg'),oldVersion,{engine}));
    const app=new EventEmitter();
    const pending=launch({channelRoot:path.dirname(path.dirname(base.root)),baseRoot:base.root,app,loadNative(){put(log,JSON.stringify(['native']));}});
    assert.deepEqual(JSON.parse(fs.readFileSync(log)),['native']);
    await pending;
    assert.deepEqual(JSON.parse(fs.readFileSync(log)),['native','applied','poll']); app.emit('will-quit');
    assert.deepEqual(JSON.parse(fs.readFileSync(log)),['native','applied','poll','stop']);
});
test('failed pending update still starts the verified base without relaunch', async t => {
    const dir=temp(t), base=stored(path.join(dir,'channel'),packageAt(path.join(dir,'pkg'),oldVersion,{engine:`exports.createUpdater=()=>({async applyPending(){throw Error('fixture failure')},start(){},async stop(){}})`}));
    let native=0, errors=0;
    await launch({channelRoot:path.dirname(path.dirname(base.root)),baseRoot:base.root,app:new EventEmitter(),loadNative(){native++},onError(){errors++}});
    assert.equal(native,1); assert.equal(errors,1);
});
test('updater never intercepts Electron ready events and native registers listeners synchronously', async t => {
    const dir=temp(t), base=stored(path.join(dir,'channel'),packageAt(path.join(dir,'pkg'),oldVersion,{engine:`exports.createUpdater=()=>({async applyPending(){await new Promise(r=>setTimeout(r,30))},start(){},async stop(){}})`}));
    const app=new EventEmitter(), originalEmit=app.emit, events=[];
    const promise=launch({channelRoot:path.dirname(path.dirname(base.root)),baseRoot:base.root,app,loadNative(){
        app.on('will-finish-launching',()=>events.push('will-finish-launching'));
        app.on('ready',()=>events.push('ready'));
        events.push('native');
    }});
    assert.deepEqual(events,['native']); assert.equal(app.emit,originalEmit);
    app.emit('will-finish-launching'); app.emit('ready');
    await promise;
    assert.deepEqual(events,['native','will-finish-launching','ready']); assert.equal(app.emit,originalEmit);
});
test('quitting during preparation never starts updater polling', async t => {
    const dir=temp(t), log=path.join(dir,'poll');
    const base=stored(path.join(dir,'channel'),packageAt(path.join(dir,'pkg'),oldVersion,{engine:`exports.createUpdater=()=>({async applyPending(){await new Promise(r=>setTimeout(r,30))},start(){require('fs').writeFileSync(${JSON.stringify(log)},'polled')},async stop(){}})`}));
    const app=new EventEmitter();
    const pending=launch({channelRoot:path.dirname(path.dirname(base.root)),baseRoot:base.root,app,loadNative(){}});
    app.emit('will-quit');
    await pending;
    assert.equal(fs.existsSync(log),false);
});
test('next-startup publication does not change loaded files and respects its own gate', async t => {
    const dir=temp(t), channelRoot=path.join(dir,'channel');
    const base=stored(channelRoot,packageAt(path.join(dir,'base')));
    const next=packageAt(path.join(dir,'next'),newVersion);
    const before=fs.readFileSync(path.join(base.root,'runtime/patcher.js'));
    let allowed=false;
    const adapter=createAdapter({channelRoot,base,prepareNextStartup:()=>allowed,extractArchive:(_,to)=>fs.cpSync(next.root,path.join(to,'release'),{recursive:true})});
    const nextContext=context(path.join(dir,'release.zip'),'next-startup');
    assert.equal(await adapter.canApplyNative(nextContext),false);
    assert.equal((await adapter.apply(nextContext)).applied,false);
    allowed=true;
    assert.equal(await adapter.canApplyNative(context(nextContext.assetPath,'runtime')),false);
    assert.equal(await adapter.canApplyNative(nextContext),true);
    assert.equal((await adapter.apply(nextContext)).applied,true);
    assert.deepEqual(fs.readFileSync(path.join(base.root,'runtime/patcher.js')),before);
    assert.equal(selected(channelRoot,base).manifest.version,newVersion);
});
test('real shared engine prepares verified next-startup files offline without changing running native', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
    const dir=temp(t), channelRoot=path.join(dir,'channel'),base=stored(channelRoot,packageAt(path.join(dir,'base')));
    const next=packageAt(path.join(dir,'new'),newVersion), zip=path.join(dir,'release.zip'); writeZip(next.root,zip);
    const bytes=fs.readFileSync(zip), name=`SupportTemplates-vencord-${newVersion}.zip`, tag='v'+newVersion;
    const asset={variant:'vencord',platform:'win32',kind:'native',name,size:bytes.length,sha256:sha(bytes)};
    const manifest=Buffer.from(JSON.stringify({schema:1,product:'SupportTemplates',repository:'owner/release',version:newVersion,channel:'canary',assets:[asset]}));
    const url=n=>`https://github.com/owner/release/releases/download/${tag}/${n}`;
    const releases=Buffer.from(JSON.stringify([{draft:false,tag_name:tag,prerelease:true,assets:[{name:'support-templates-update.json',state:'uploaded',size:manifest.length,browser_download_url:url('support-templates-update.json')},{name,state:'uploaded',size:bytes.length,browser_download_url:url(name)}]}]));
    let network=0,barrier=false;
    const opts={config:config(oldVersion),variant:'vencord',stagingDir:path.join(channelRoot,'updates'),adapter:createAdapter({channelRoot,base,prepareNextStartup:()=>barrier}),transport:async url=>{network++;return {status:200,body:Readable.from([url.includes('api.github.com')?releases:url.endsWith('.json')?manifest:bytes])}}};
    const running=createUpdater(opts); assert.equal((await running.check()).status,'staged');
    assert.equal(fs.existsSync(path.join(channelRoot,'active.json')),false);
    assert.equal((await running.applyPending({phase:'runtime'})).status,'pending-restart'); await running.stop();
    barrier=true;
    const restart=createUpdater({...opts,transport:()=>{throw Error('must apply without network')}});
    const nativeBytes=fs.readFileSync(path.join(base.root,'runtime/patcher.js'));
    assert.equal((await restart.applyPending({phase:'next-startup'})).status,'applied');
    assert.deepEqual(fs.readFileSync(path.join(base.root,'runtime/patcher.js')),nativeBytes);
    assert.equal(selected(channelRoot,base).manifest.version,newVersion); assert.equal(network,3); await restart.stop();
});
test('null repository does not request network and private 404 is harmless', async t => {
    const dir=temp(t); let requests=0;
    const options={variant:'vencord',config:{...config(oldVersion),releaseRepository:null},stagingDir:path.join(dir,'updates'),adapter:{apply:async()=>({applied:false})},transport:async()=>{requests++;return {status:404,body:Readable.from([])}}};
    const disabled=createUpdater(options); assert.equal((await disabled.check()).status,'disabled'); disabled.start(); await disabled.stop(); assert.equal(requests,0);
    const privateRepo=createUpdater({...options,config:config(oldVersion)}); assert.equal((await privateRepo.check()).status,'unavailable'); assert.equal(requests,1); await privateRepo.stop();
});
