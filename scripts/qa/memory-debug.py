import json
from pathlib import Path
from playwright.sync_api import sync_playwright
out=Path('artifacts/memory19')
rows=[]
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    page=browser.new_page(viewport={'width':1200,'height':900})
    page.add_init_script(path='scripts/qa/memory-instrument.js')
    errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    cdp=page.context.new_cdp_session(page);cdp.send('Performance.enable')
    page.goto('http://127.0.0.1:47836/index.html');page.wait_for_load_state('networkidle')
    page.evaluate('async()=>{await started;await harness.connectPanel();await testFrame()}')
    def metrics():
        return {m['name']:m['value'] for m in cdp.send('Performance.getMetrics')['metrics']}
    def snap(label):
        before=metrics()
        cdp.send('HeapProfiler.collectGarbage');cdp.send('HeapProfiler.collectGarbage')
        rows.append({'label':label,'beforeGC':before,'afterGC':metrics(),'heap':cdp.send('Runtime.getHeapUsage'),'dom':cdp.send('Memory.getDOMCounters'),'instrument':page.evaluate('instrumentMetrics()')})
    snap('before-toggles')
    page.evaluate('async()=>{for(let i=0;i<100;i++){harness.setDebugVerbose(true);harness.setDebugEnabled(true);await testFrame();harness.setDebugEnabled(false);await testFrame()}}')
    snap('after-100-toggles')
    page.evaluate('async()=>{harness.setDebugVerbose(true);harness.setDebugEnabled(true);harness.ui.set({windowOpen:true});await testFrame()}')
    snap('debug-idle-start')
    page.wait_for_timeout(60000)
    snap('debug-idle-end')
    page.evaluate('async()=>{harness.setDebugEnabled(false);harness.ui.set({windowOpen:false});await testFrame();instance.stop();await instance.retiring;await testFrame()}')
    snap('debug-stopped')
    (out/'debug-results.json').write_text(json.dumps({'samples':rows,'errors':errors},indent=2),encoding='utf-8')
    print(json.dumps({'errors':errors,'samples':[{'label':r['label'],'heapMiB':r['heap']['usedSize']/1048576,'dom':r['dom']}for r in rows]}),flush=True)
    browser.close()
