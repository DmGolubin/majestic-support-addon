import fs from 'node:fs';
const dir = 'artifacts/memory19';
const read = name => JSON.parse(fs.readFileSync(`${dir}/${name}`, 'utf8'));
const soak = read('soak-results.json');
const mib = bytes => Number((bytes / 1048576).toFixed(3));
const processSamples = fs.readFileSync(`${dir}/canary-processes.jsonl`, 'utf8').trim().split(/\r?\n/).map(line=>JSON.parse(line.replace(/^\uFEFF/,'')));
if (processSamples.length < 2 || processSamples.some((s, i) => !Number.isFinite(s.elapsedSeconds) || s.elapsedSeconds < 0
    || (i > 0 && s.elapsedSeconds <= processSamples[i - 1].elapsedSeconds)
    || !Number.isInteger(s.logicalProcessors) || s.logicalProcessors <= 0 || s.logicalProcessors !== processSamples[0].logicalProcessors
    || !Array.isArray(s.processes) || !s.processes.length || (s.errors !== undefined && (!Array.isArray(s.errors) || s.errors.length))
    || s.processes.some(p => !Number.isInteger(p.pid) || p.pid <= 0 || ['privateBytes','cpuSeconds','handles'].some(k => !Number.isFinite(p[k]) || p[k] < 0)))) {
    throw Error('Incomplete or mixed process samples: require one increasing timeline with readable processes');
}
const totals = processSamples.map(s=>({seconds:s.elapsedSeconds,private:s.processes.reduce((n,p)=>n+p.privateBytes,0),cpu:s.processes.reduce((n,p)=>n+p.cpuSeconds,0),handles:s.processes.reduce((n,p)=>n+p.handles,0),pids:s.processes.map(p=>p.pid).sort((a,b)=>a-b).join(',')}));
const first=totals[0],last=totals.at(-1),seconds=last.seconds-first.seconds;
const stablePids=totals.every(x=>x.pids===first.pids);
if (stablePids && totals.some((s, i) => i > 0 && s.cpu < totals[i - 1].cpu)) throw Error('Process CPU counters reset; this is not one stable process lifetime');
const result={
  publishedBundle:read('provenance.json'),browser:soak.browser,durationSeconds:soak.durationSeconds??null,
  cycles:soak.samples.filter(x=>['warmup','cycles'].includes(x.label)).map(x=>({cycle:x.cycle,label:x.label,heapMiB:mib(x.heap.usedSize),...x.dom,observers:x.app.instrument.activeMutationObservers,flux:x.app.host.fluxListeners})),
  idle:{},errors:soak.errors,externalRequests:soak.externalRequests,
  canary:{durationSeconds:seconds,samples:totals.length,processes:processSamples[0].processes.length,stablePids,privateMiBStart:mib(first.private),privateMiBEnd:mib(last.private),privateMiBMin:mib(Math.min(...totals.map(x=>x.private))),privateMiBMax:mib(Math.max(...totals.map(x=>x.private))),handlesStart:first.handles,handlesEnd:last.handles,
    cpuOneCorePercent:stablePids?(last.cpu-first.cpu)/seconds*100:null,cpuMachinePercent:stablePids?(last.cpu-first.cpu)/seconds*100/processSamples[0].logicalProcessors:null,controlledIdle:false},
  teardown:soak.samples.filter(x=>x.label.includes('stopped')).map(x=>({label:x.label,cycle:x.cycle,heapMiB:mib(x.heap.usedSize),dom:x.dom,app:x.app})),
  faultCases:read('fault-results.json')
};
for(const mode of ['closed','picker','settings']){
  const samples=soak.samples.filter(x=>x.label.startsWith('idle-'+mode));
  if(samples.length<2)continue;
  let tasks=0,time=0;
  for(let i=1;i<samples.length;i++){tasks+=samples[i].beforeGC.TaskDuration-samples[i-1].afterGC.TaskDuration;time+=samples[i].beforeGC.Timestamp-samples[i-1].afterGC.Timestamp;}
  const begin=samples[0],end=samples.at(-1);
  result.idle[mode]={seconds:time,mainThreadTaskMs:tasks*1000,mainThreadPercent:tasks/time*100,heapMiBStart:mib(begin.heap.usedSize),heapMiBEnd:mib(end.heap.usedSize),heapMiBMin:mib(Math.min(...samples.map(x=>x.heap.usedSize))),heapMiBMax:mib(Math.max(...samples.map(x=>x.heap.usedSize))),domStart:begin.dom,domEnd:end.dom,
    observerCallbacks:end.app.instrument.mutationCallbacks-begin.app.instrument.mutationCallbacks,animationCallbacks:end.app.instrument.animationCallbacks-begin.app.instrument.animationCallbacks,
    timersAtEnd:end.app.instrument.timers,apiStart:begin.app.host.apiCalls,apiEnd:end.app.host.apiCalls};
}
if(fs.existsSync(`${dir}/control-results.json`)){
 const samples=read('control-results.json'),a=samples[0],b=samples.at(-1);
 result.control={seconds:b.metrics.Timestamp-a.metrics.Timestamp,mainThreadTaskMs:(b.metrics.TaskDuration-a.metrics.TaskDuration)*1000,heapMiBStart:mib(a.heap.usedSize),heapMiBEnd:mib(b.heap.usedSize)};
}
if(fs.existsSync(`${dir}/debug-results.json`)){
 const debug=read('debug-results.json');
 const a=debug.samples.find(x=>x.label==='debug-idle-start'),b=debug.samples.find(x=>x.label==='debug-idle-end');
 const seconds=b.beforeGC.Timestamp-a.afterGC.Timestamp,tasks=b.beforeGC.TaskDuration-a.afterGC.TaskDuration;
 result.debug={errors:debug.errors,seconds,mainThreadTaskMs:tasks*1000,mainThreadPercent:tasks/seconds*100,samples:debug.samples.map(x=>({label:x.label,heapMiB:mib(x.heap.usedSize),dom:x.dom,instrument:x.instrument}))};
}
result.observerAttribution=read('observer-origins.json');
result.measurementNotes=['Raw observer counts include Playwright InjectedScript observer; separately attributed with WeakRef and construction stacks.','Renderer TaskDuration is test-page main-thread duty, not whole-machine CPU.','15-second interval is the mock SSE heartbeat.','Post-GC heap includes React and mock host; retained DOM after stop is stable across tested restarts, not fully released.'];
fs.writeFileSync(`${dir}/summary.json`,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({durationSeconds:result.durationSeconds,cycles:result.cycles.at(-1),idle:result.idle,canary:result.canary,errors:result.errors,control:result.control},null,2));
