import json
from pathlib import Path
from playwright.sync_api import sync_playwright

out=Path('artifacts/memory19')
result={}
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    def fresh():
        page=browser.new_page(viewport={'width':1200,'height':900})
        page.add_init_script(path='scripts/qa/memory-instrument.js')
        page.goto('http://127.0.0.1:47836/index.html');page.wait_for_load_state('networkidle')
        page.evaluate('started')
        return page
    def metrics(page):
        return page.evaluate('({host:hostMetrics(),instrument:instrumentMetrics(),roots:document.querySelectorAll("#vc-stx-host").length,refs:harness.refs()})')
    page=fresh()
    page.evaluate('async()=>{instance.stop();await instance.retiring;await testFrame()}')
    result['faultStartBefore']=metrics(page)
    page.evaluate('''()=>{const bus=BdApi.Webpack.getModule(()=>true);const subscribe=bus.subscribe;
      window.injectMountFailure=()=>{let seen=0;bus.subscribe=function(type,fn){subscribe.call(this,type,fn);if(type==='CHANNEL_SELECT'&&++seen===2){bus.subscribe=subscribe;throw Error('Injected mount failure')}}};}''')
    for _ in range(10):
        page.evaluate('async()=>{injectMountFailure();await instance.start();await instance.retiring;await testFrame()}')
    result['faultStartAfter10']=metrics(page)
    page.close()
    page=fresh()
    result['faultStopBefore']=metrics(page)
    result['faultStopError']=page.evaluate('''()=>{const bus=BdApi.Webpack.getModule(()=>true);const unsubscribe=bus.unsubscribe;
      bus.unsubscribe=function(type,fn){if(type==='LOGOUT'){bus.unsubscribe=unsubscribe;throw Error('Injected unsubscribe failure')}return unsubscribe.call(this,type,fn)};
      try{instance.stop();return null}catch(e){return e.message}}''')
    page.wait_for_timeout(100)
    result['faultStopAfter']=metrics(page)
    page.evaluate('async()=>{instance.stop();await instance.retiring;await testFrame()}')
    result['faultStopAfterRetry']=metrics(page)
    page.close()
    page=fresh()
    page.evaluate('async()=>{await harness.connectPanel();await testFrame();harness.captureWindowTarget(document.querySelector(".editor"));harness.ui.set({windowOpen:true});await testFrame()}')
    page.locator('.vc-stx-sinput').fill('fixture')
    page.evaluate('testFrame()')
    result['searchVisibleBeforeClose']=metrics(page)
    page.evaluate('async()=>{harness.rememberComposeTarget();harness.ui.set({windowOpen:false,compose:[]});await testFrame();document.querySelector(".channelTextArea_test").remove();await testFrame()}')
    result['closedDetachedTargets']=metrics(page)
    page.evaluate('async()=>{instance.stop();await instance.retiring;await testFrame()}')
    result['targetsAfterStop']=metrics(page)
    page.close()
    # Background DOM churn with all plugin windows closed.
    page=fresh()
    result['churnBefore']=metrics(page)
    page.evaluate('async()=>{const node=document.createElement("div");document.body.append(node);for(let i=0;i<120;i++){node.replaceChildren(document.createElement("span"));await testFrame()}node.remove();await testFrame()}')
    result['churnAfter']=metrics(page)
    browser.close()
(out/'fault-results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(result,ensure_ascii=False),flush=True)
