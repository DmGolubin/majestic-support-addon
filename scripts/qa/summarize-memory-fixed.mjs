// Compact, reproducible evidence; raw synthetic runs remain in ignored QA runs/.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const [hourFile, shortDir, output, unitFile = 'artifacts/memory19/fix-unit-results-final.json'] = process.argv.slice(2);
if (!hourFile || !shortDir || !output) throw Error('Usage: node scripts/qa/summarize-memory-fixed.mjs <hour JSON> <short runs dir> <output JSON> [unit JSON]');
if (fs.existsSync(output)) throw Error('Refusing to overwrite prior evidence');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const mib = bytes => Math.round(bytes / 1048576 * 1000) / 1000;
const hour = read(hourFile);
if (hour.status === 'running') throw Error('Do not publish an incomplete soak');
const compact = row => ({label:row.label, elapsed:row.soakElapsed ?? row.elapsed, cycle:row.cycle,
    heapMiB:mib(row.heap.usedSize), dom:row.dom, host:row.app.host,
    phase:row.phase, idleMode:row.idleMode, panelPhase:row.app.phase, refs:row.app.refs,
    elements:row.app.elements, roots:row.app.roots, mounts:row.app.mounts,
    settingsListeners:row.app.settingsListeners, instrumentation:row.app.instrument});
const summarize = file => {
    const r = read(file);
    return {file, sha256:sha(file), status:r.status, failure:r.failure ?? null, errors:r.errors,
        externalRequests:r.externalRequests, assertionCount:r.assertions.length, failedAssertions:r.assertions.filter(x=>x.pass !== true),
        samples:r.samples.map(compact)};
};
const idle = {};
for (const mode of ['closed','picker','settings']) {
    const intervals = hour.idleIntervals.filter(x=>x.mode===mode);
    if (!intervals.length || intervals.some(x => !Number.isFinite(x.seconds) || x.seconds <= 0
        || !Number.isFinite(x.taskSeconds) || x.taskSeconds < 0 || !Number.isFinite(x.mainThreadPercent))) throw Error(`Incomplete idle measurements: ${mode}`);
    const seconds = intervals.reduce((n,x)=>n+x.seconds,0);
    const tasks = intervals.reduce((n,x)=>n+x.taskSeconds,0);
    idle[mode] = {seconds, taskMs:tasks*1000, meanMainThreadPercent:tasks/seconds*100,
        maxIntervalMainThreadPercent:Math.max(...intervals.map(x=>x.mainThreadPercent))};
}
const rows = hour.samples.filter(x=>x.label==='cycles-closed');
const tail = rows.slice(Math.floor(rows.length/2));
function range(list) {
    if (!list.length || list.some(x => !Number.isFinite(x.heap.usedSize) || x.heap.usedSize < 0)) throw Error('Incomplete heap measurements');
    return {minMiB:mib(Math.min(...list.map(x=>x.heap.usedSize))),maxMiB:mib(Math.max(...list.map(x=>x.heap.usedSize)))};
}
const end = hour.samples.find(x=>x.label==='soak-end');
if (!end) throw Error('Missing soak-end measurement');
const result = {schemaVersion:1, provenance:hour.provenance, browser:hour.browser,
    limits:hour.limits, coverage:hour.coverage, status:hour.status, realSoakSeconds:hour.realSoakSeconds,
    totalDurationSeconds:hour.durationSeconds, completedCycles:hour.completedCycles,
    warmupCycles:hour.warmupCyclesExcluded, idle, closedCycleHeap:range(rows), latterHalfClosedHeap:range(tail),
    baseline:compact(hour.baseline), lastLive:compact(end), fixtureAtEnd:end.app.fixture,
    events:hour.events, hour:summarize(hourFile), short:{},
    interpretation:'Post-GC JS heap includes React and mock host. TaskDuration is renderer main-thread duty, not all Discord CPU. Local BetterDiscord bundle; native storage/updater and real Discord not covered.'};
for (const [dir,file] of [['faults','fault-results.json'],['smoke','soak-results.json'],['debug','debug-results.json'],['control','control-results.json'],['observers','observer-origins.json'],['fixture','fixture-results.json']]) {
    const full = path.join(shortDir,dir,file);
    result.short[dir]=summarize(full);
}
const unit = read(unitFile);
result.unitTests={file:unitFile,sha256:sha(unitFile),passed:unit.numPassedTests,failed:unit.numFailedTests,total:unit.numTotalTests,files:unit.testResults.length,success:unit.success};
const passed = r => r.status === 'pass' && r.assertionCount > 0 && !r.failedAssertions.length
    && Array.isArray(r.errors) && !r.errors.length && Array.isArray(r.externalRequests) && !r.externalRequests.length;
result.status = [result.hour, ...Object.values(result.short)].every(passed)
    && unit.success === true && unit.numFailedTests === 0 && unit.numPassedTests > 0
    && unit.numTotalTests === unit.numPassedTests && unit.testResults.length > 0 ? 'pass' : 'fail';
fs.writeFileSync(output, JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({status:result.status,seconds:result.realSoakSeconds,cycles:result.completedCycles,idle,closed:result.closedCycleHeap,latterHalf:result.latterHalfClosedHeap,failures:result.hour.failedAssertions},null,2));
process.exitCode = result.status === 'pass' ? 0 : 1;
