import json, time, argparse
from pathlib import Path
from playwright.sync_api import sync_playwright
from memory_server import server

parser=argparse.ArgumentParser()
parser.add_argument('--cycles',type=int,default=500)
parser.add_argument('--idle-seconds',type=int,default=180)
args=parser.parse_args()
out=Path('artifacts/memory19')
results={'cycles':args.cycles,'idleSecondsPerState':args.idle_seconds,'samples':[],'errors':[],'externalRequests':[]}
start=time.monotonic()

with server(), sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    page=browser.new_page(viewport={'width':1200,'height':900})
    page.add_init_script(path='scripts/qa/memory-instrument.js')
    page.on('pageerror',lambda e:results['errors'].append(str(e)))
    def route(r):
        if r.request.url.startswith('http://127.0.0.1:47836/'):
            r.continue_()
        else:
            results['externalRequests'].append(r.request.url.split('?')[0]);r.abort()
    page.route('**/*',route)
    cdp=page.context.new_cdp_session(page)
    cdp.send('Performance.enable')
    def performance():
        return {m['name']:m['value'] for m in cdp.send('Performance.getMetrics')['metrics']}
    def save():
        (out/'soak-results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
    def sample(label,number=0):
        before=performance()
        cdp.send('HeapProfiler.collectGarbage')
        cdp.send('HeapProfiler.collectGarbage')
        row={'label':label,'cycle':number,'elapsed':time.monotonic()-start,'beforeGC':before,'afterGC':performance(),
            'heap':cdp.send('Runtime.getHeapUsage'),'dom':cdp.send('Memory.getDOMCounters'),
            'app':page.evaluate('({host:hostMetrics(),instrument:instrumentMetrics(),ui:harness.ui.get(),elements:document.querySelectorAll("*").length,fonts:document.fonts.size,settingsListeners:instance.settingsListeners.size})')}
        results['samples'].append(row);save()
        print(json.dumps({'label':label,'cycle':number,'heapMiB':round(row['heap']['usedSize']/1048576,3),'dom':row['dom'],'resources':row['app']['host']},ensure_ascii=False),flush=True)
        return row
    page.goto('http://127.0.0.1:47836/index.html')
    page.wait_for_load_state('networkidle')
    page.evaluate('async()=>{await started;await harness.connectPanel();await testFrame()}')
    page.wait_for_function('harness.panel.get().phase === "ready"')
    page.wait_for_timeout(300)
    results['browser']=browser.version
    sample('ready')
    # Drive the real observable to open, then actual UI buttons for settings,
    # tabs, editor and close. Each commit gets two animation frames.
    cycle_js='''async(count)=>{
      const clickText=(root,text)=>{const b=[...root.querySelectorAll('button')].find(b=>b.textContent.trim()===text);if(!b)throw Error('Missing '+text);b.click()};
      for(let i=0;i<count;i++){
        harness.ui.set({windowOpen:true});await testFrame();
        const picker=document.querySelector('.vc-stx-win');if(!picker)throw Error('Picker missing');
        picker.querySelector('.vc-stx-menu-settings').click();await testFrame();
        let settings=document.querySelector('.vc-stx-management');if(!settings)throw Error('Settings missing');
        for(const tab of ['Настройки','Тикеты','Мои шаблоны']){clickText(settings,tab);await testFrame();}
        const card=settings.querySelector('.vc-stx-pp-card');if(!card)throw Error('Personal card missing');card.click();await testFrame();
        if(!settings.querySelector('textarea'))throw Error('Editor missing');
        clickText(settings,'Отмена');await testFrame();
        clickText(settings,'Закрыть');await testFrame();
        if(document.querySelector('.vc-stx-management,.vc-stx-win'))throw Error('Window still mounted');
      }
    }'''
    page.evaluate(cycle_js,20)
    sample('warmup',20)
    for n in range(0,args.cycles,50):
        count=min(50,args.cycles-n)
        page.evaluate(cycle_js,count)
        sample('cycles',n+count)
    for mode in ['closed','picker','settings']:
        page.evaluate('async(mode)=>{harness.ui.set({windowOpen:mode==="picker",management:mode==="settings"});await testFrame()}',mode)
        sample('idle-'+mode+'-start')
        for elapsed in range(0,args.idle_seconds,30):
            page.wait_for_timeout(min(30,args.idle_seconds-elapsed)*1000)
            sample('idle-'+mode,elapsed+min(30,args.idle_seconds-elapsed))
    page.evaluate('async()=>{harness.ui.set({windowOpen:false,management:false});await testFrame();instance.stop();await instance.retiring;await testFrame()}')
    sample('stopped')
    for n in range(30):
        page.evaluate('async()=>{await instance.start();await testFrame();harness.ui.set({management:true});await testFrame();harness.ui.set({management:false});await testFrame();instance.stop();await instance.retiring;await testFrame()}')
        if (n+1)%10==0:sample('restart-stopped',n+1)
    # Native BD settings panel owns a separate root, also test its subscription cleanup.
    page.evaluate('async()=>{await instance.start();await testFrame()}')
    for _ in range(100):
        page.evaluate('async()=>{const el=document.createElement("div");document.body.append(el);const root=testReactDOM.createRoot(el);root.render(instance.getSettingsPanel());await testFrame();root.unmount();el.remove();await testFrame()}')
    page.evaluate('async()=>{instance.stop();await instance.retiring;await testFrame()}')
    sample('host-settings-stopped',100)
    results['durationSeconds']=time.monotonic()-start
    save()
    browser.close()
