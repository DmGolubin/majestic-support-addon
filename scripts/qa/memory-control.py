import json
from pathlib import Path
from playwright.sync_api import sync_playwright
out=Path('artifacts/memory19')
(out/'control.html').write_text('<!doctype html><meta charset="utf-8"><script src="react.js"></script><script src="host.js"></script>',encoding='utf-8')
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    page=browser.new_page()
    page.add_init_script(path='scripts/qa/memory-instrument.js')
    cdp=page.context.new_cdp_session(page);cdp.send('Performance.enable')
    page.goto('http://127.0.0.1:47836/control.html');page.wait_for_load_state('networkidle')
    def measure():
        return {'metrics':{x['name']:x['value'] for x in cdp.send('Performance.getMetrics')['metrics']},'dom':cdp.send('Memory.getDOMCounters'),'heap':cdp.send('Runtime.getHeapUsage'),'instrument':page.evaluate('instrumentMetrics()')}
    cdp.send('HeapProfiler.collectGarbage');cdp.send('HeapProfiler.collectGarbage')
    rows=[measure()]
    for _ in range(2):
        page.wait_for_timeout(30000);rows.append(measure())
    (out/'control-results.json').write_text(json.dumps(rows,indent=2),encoding='utf-8')
    print(json.dumps({'taskSeconds':rows[-1]['metrics']['TaskDuration']-rows[0]['metrics']['TaskDuration'],'duration':rows[-1]['metrics']['Timestamp']-rows[0]['metrics']['Timestamp']}),flush=True)
    browser.close()
