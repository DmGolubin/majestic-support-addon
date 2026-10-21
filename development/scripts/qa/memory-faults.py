"""Lifecycle regressions against the exact supplied bundle; owns its server."""
import json
from memory_common import parser, configure, Run, check, save, cleanup_assertions
p = parser('Independent startup, stop, ref retention, churn and restart regressions')
args = p.parse_args()
name = 'fault-results.json'
result = configure(args, name)
try:
    with Run(args, result) as run:
        def snap(page, cdp, label):
            row = run.measure(page, cdp, label)
            result['samples'].append(row)
            save(args, name, result)
            return row
        page, cdp = run.fresh()
        run.stop(page)
        snap(page, cdp, 'fault-start-before')
        page.evaluate('''()=>{const bus=BdApi.Webpack.getModule(()=>true), subscribe=bus.subscribe;
          window.injectedMountFailures=0;
          window.injectMountFailure=()=>{let seen=0;bus.subscribe=function(type,fn){subscribe.call(this,type,fn);if(type==='CHANNEL_SELECT'&&++seen===2){injectedMountFailures++;bus.subscribe=subscribe;throw Error('Injected mount failure')}}};}''')
        for _ in range(10):
            page.evaluate('async()=>{injectMountFailure();await instance.start();await instance.retiring;await testFrame()}')
        check(result, 'all-startup-faults-exercised', page.evaluate('injectedMountFailures') == 10)
        cleanup_assertions(result, snap(page, cdp, 'fault-start-after-10'))
        page.context.close()

        page, cdp = run.fresh()
        error = page.evaluate('''()=>{const bus=BdApi.Webpack.getModule(()=>true), unsubscribe=bus.unsubscribe;
          window.injectedStopFailures=0;
          bus.unsubscribe=function(type,fn){if(type==='LOGOUT'){injectedStopFailures++;bus.unsubscribe=unsubscribe;throw Error('Injected unsubscribe failure')}return unsubscribe.call(this,type,fn)};
          try{instance.stop();return null}catch(e){return e.message}}''')
        page.evaluate('async()=>{await instance.retiring;await testFrame()}')
        check(result, 'transient-stop-does-not-throw', error is None, error)
        check(result, 'transient-stop-fault-exercised', page.evaluate('injectedStopFailures') == 1)
        cleanup_assertions(result, snap(page, cdp, 'transient-stop'))
        page.context.close()

        page, cdp = run.fresh()
        page.evaluate('''()=>{const bus=BdApi.Webpack.getModule(()=>true), unsubscribe=bus.unsubscribe;
          window.cleanupAttempts=0;window.restoreUnsubscribe=()=>{bus.unsubscribe=unsubscribe};
          bus.unsubscribe=function(type,fn){if(type==='CHANNEL_SELECT'){cleanupAttempts++;throw Error('Injected permanent unsubscribe failure')}return unsubscribe.call(this,type,fn)};}''')
        run.stop(page)
        stopped = snap(page, cdp, 'permanent-stop')
        attempts = page.evaluate('cleanupAttempts')
        check(result, 'permanent-stop-bounded-retries', 2 <= attempts <= 8, attempts)
        page.evaluate('async()=>{await instance.start();await instance.retiring;await testFrame()}')
        blocked = snap(page, cdp, 'permanent-restart-blocked')
        check(result, 'permanent-cleanup-blocks-remount', blocked['app']['roots']==0 and blocked['app']['mounts']==0)
        check(result, 'permanent-cleanup-no-duplicate-subscriptions', blocked['app']['host']['fluxListeners']<=stopped['app']['host']['fluxListeners'])
        page.evaluate('async()=>{restoreUnsubscribe();await instance.start();await testFrame()}')
        check(result, 'repaired-host-can-restart', page.evaluate('document.querySelectorAll("#vc-stx-host").length')==1)
        run.stop(page)
        cleanup_assertions(result, snap(page, cdp, 'permanent-repaired-stopped'))
        page.context.close()

        page, cdp = run.fresh()
        run.connect(page)
        page.evaluate('async()=>{harness.captureWindowTarget(document.querySelector(".editor"));harness.ui.set({windowOpen:true});await testFrame()}')
        page.locator('.vc-stx-sinput').fill('fixture')
        page.evaluate('testFrame()')
        snap(page, cdp, 'search-visible-before-close')
        page.evaluate('async()=>{harness.ui.set({windowOpen:false});await testFrame();document.querySelector(".channelTextArea_test").remove();await testFrame()}')
        closed = snap(page, cdp, 'closed-detached-targets')
        refs = closed['app']['refs']
        check(result, 'close-releases-visible-items', refs['visibleCount']==0, refs)
        check(result, 'close-releases-targets', refs['windowTargetConnected'] is None, refs)
        run.stop(page)
        cleanup_assertions(result, snap(page, cdp, 'targets-stopped'))
        page.context.close()

        page, cdp = run.fresh()
        page.evaluate('testFrame()')
        before = snap(page, cdp, 'churn-before')
        page.evaluate('async()=>{const node=document.createElement("div");document.body.append(node);for(let i=0;i<120;i++){node.replaceChildren(document.createElement("span"));await testFrame()}node.remove();await testFrame()}')
        after = snap(page, cdp, 'churn-after')
        callbacks = lambda row: row['app']['instrument']['callbacks'].get('plugin:animation', 0)
        delta = callbacks(after)-callbacks(before)
        check(result, 'unrelated-dom-zero-plugin-raf', delta==0, delta)
        run.stop(page)
        cleanup_assertions(result, snap(page, cdp, 'churn-stopped'))
        page.context.close()

        page, cdp = run.fresh()
        run.stop(page)
        baseline = snap(page, cdp, 'restart-baseline')
        for n in range(30):
            page.evaluate('async()=>{await instance.start();await testFrame();harness.ui.set({management:true});await testFrame();harness.ui.set({management:false});await testFrame();instance.stop();await instance.retiring;await testFrame()}')
            if (n+1)%10==0:
                row = snap(page, cdp, 'restart-stopped-'+str(n+1))
                cleanup_assertions(result, row)
                check(result, 'restart-dom-bounded', row['dom']['nodes']<=baseline['dom']['nodes']+10, row['dom'])
        page.evaluate('async()=>{await instance.start();await testFrame()}')
        for n in range(100):
            page.evaluate('async()=>{const el=document.createElement("div");document.body.append(el);const root=testReactDOM.createRoot(el);root.render(instance.getSettingsPanel());await testFrame();root.unmount();el.remove();await testFrame()}')
            if (n+1)%25==0:
                row = snap(page, cdp, 'bd-settings-'+str(n+1))
                check(result, 'bd-settings-subscription-released', row['app']['settingsListeners']==0)
        run.stop(page)
        cleanup_assertions(result, snap(page, cdp, 'bd-settings-stopped'))
        result['restartCycles']=30
        result['bdSettingsCycles']=100
        check(result, 'no-unhandled-errors', not result['errors'], result['errors'])
        check(result, 'no-external-requests', not result['externalRequests'], result['externalRequests'])
except BaseException as e:
    result['failure'] = type(e).__name__ + ': ' + str(e)
    check(result, 'completed', False, result['failure'])
finally:
    result['status']='pass' if result['assertions'] and all(x['pass'] for x in result['assertions']) else 'fail'
    save(args, name, result)
    print(json.dumps({'status':result['status'],'failed':[a for a in result['assertions'] if not a['pass']], 'output':str(args.out/name)}), flush=True)
raise SystemExit(0 if result['status']=='pass' else 1)
