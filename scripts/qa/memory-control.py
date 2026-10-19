"""No-plugin control with the same React, fixture and instrumentation."""
import json
import time
from memory_common import parser, configure, Run, check, save
p=parser('Passive no-plugin control; owns server/browser and blocks external traffic')
p.add_argument('--seconds',type=int,default=60)
args=p.parse_args()
name='control-results.json'
result=configure(args,name)
try:
    with Run(args,result) as run:
        page,cdp=run.fresh(control=True)
        result['samples'].append(run.measure(page,cdp,'control-start'))
        elapsed=0
        while elapsed<args.seconds:
            wait=min(30,args.seconds-elapsed)
            page.wait_for_timeout(wait*1000)
            elapsed+=wait
            result['samples'].append(run.measure(page,cdp,'control-idle'))
            save(args,name,result)
        check(result,'no-errors',not result['errors'],result['errors'])
        check(result,'no-external-requests',not result['externalRequests'],result['externalRequests'])
        check(result,'no-plugin-observers',all(not any(k.startswith('plugin:') and v for k,v in r['app']['instrument']['activeObserversByOwner'].items()) for r in result['samples']))
        result['status']='pass' if all(x['pass'] for x in result['assertions']) else 'fail'
except Exception as e:
    result.update(status='fail',failure=str(e))
finally:
    save(args,name,result)
    print(json.dumps({'status':result['status'],'output':str(args.out/name)}),flush=True)
raise SystemExit(0 if result['status']=='pass' else 1)
