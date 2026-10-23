"""Post-GC observer attribution, using shared WeakRef-only instrumentation."""
import json
from memory_common import parser, configure, Run, check, save, cleanup_assertions
args=parser('Observer ownership after opening settings and stopping').parse_args()
name='observer-origins.json';result=configure(args,name)
try:
    with Run(args,result) as run:
        page,cdp=run.fresh();run.connect(page)
        page.evaluate('async()=>{harness.ui.set({windowOpen:true});await testFrame()}')
        page.locator('.vc-stx-menu-settings').click()
        page.evaluate('testFrame()')
        result['samples'].append(run.measure(page,cdp,'settings-open'))
        run.stop(page)
        row=run.measure(page,cdp,'stopped');result['samples'].append(row);cleanup_assertions(result,row)
        check(result,'no-errors',not result['errors'],result['errors'])
        check(result,'no-external-requests',not result['externalRequests'],result['externalRequests'])
except BaseException as e:
    check(result,'completed',False,str(e))
finally:
    result['status']='pass' if result['assertions'] and all(x['pass'] for x in result['assertions']) else 'fail'
    save(args,name,result);print(json.dumps({'status':result['status'],'output':str(args.out/name)}),flush=True)
raise SystemExit(0 if result['status']=='pass' else 1)
