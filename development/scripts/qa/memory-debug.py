"""Debug toggle/idle regression in an isolated offline context."""
import json
from memory_common import parser, configure, Run, check, save, cleanup_assertions
p=parser('Debug toggles and passive debug idle')
p.add_argument('--seconds',type=int,default=60)
args=p.parse_args(); name='debug-results.json'; result=configure(args,name)
try:
    with Run(args,result) as run:
        page,cdp=run.fresh();run.connect(page)
        def snap(label):
            row=run.measure(page,cdp,label);result['samples'].append(row);save(args,name,result);return row
        snap('before-toggles')
        page.evaluate('async()=>{for(let i=0;i<100;i++){harness.setDebugVerbose(true);harness.setDebugEnabled(true);await testFrame();harness.setDebugEnabled(false);await testFrame()}}')
        snap('after-100-toggles')
        page.evaluate('async()=>{harness.setDebugVerbose(true);harness.setDebugEnabled(true);harness.ui.set({windowOpen:true});await testFrame()}')
        snap('debug-idle-start')
        elapsed=0
        while elapsed<args.seconds:
            wait=min(30,args.seconds-elapsed);page.wait_for_timeout(wait*1000);elapsed+=wait;snap('debug-idle')
        page.evaluate('async()=>{harness.setDebugEnabled(false);harness.ui.set({windowOpen:false});await testFrame()}')
        run.stop(page);cleanup_assertions(result,snap('debug-stopped'))
        check(result,'no-errors',not result['errors'],result['errors'])
        check(result,'no-external-requests',not result['externalRequests'],result['externalRequests'])
except BaseException as e:
    check(result,'completed',False,str(e))
finally:
    result['status']='pass' if result['assertions'] and all(x['pass'] for x in result['assertions']) else 'fail'
    save(args,name,result);print(json.dumps({'status':result['status'],'output':str(args.out/name)}),flush=True)
raise SystemExit(0 if result['status']=='pass' else 1)
