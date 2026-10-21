"""Prove synthetic token enforcement independently of the plugin and soak."""
import json
from memory_common import parser, configure, Run, check, save
args = parser('Strict fixture token rotation, rejection and network control checks').parse_args()
name = 'fixture-results.json'
result = configure(args, name)
try:
    with Run(args, result) as run:
        page, cdp = run.fresh(control=True)
        evidence = page.evaluate('''async()=>{
            const base='https://panel.majestic-rp.tech/api/plugin/v1';
            const post=(path,body)=>BdApi.Net.fetch(base+path,{method:'POST',body:JSON.stringify(body)});
            const device=await (await post('/oauth/device_authorization',{})).json();
            const first=await (await post('/oauth/token',{grant_type:'urn:ietf:params:oauth:grant-type:device_code',device_code:device.device_code})).json();
            const second=await (await post('/oauth/token',{grant_type:'refresh_token',refresh_token:first.refresh_token})).json();
            const get=token=>BdApi.Net.fetch(base+'/me',{headers:{Authorization:'Bearer '+token}});
            const stale=await get(first.access_token), fresh=await get(second.access_token);
            const reused=await post('/oauth/token',{grant_type:'refresh_token',refresh_token:first.refresh_token});
            const reuseError=await reused.json(), revoked=await get(second.access_token);
            // Reuse revokes the entire connection. Test offline recovery on a new login.
            const nextDevice=await (await post('/oauth/device_authorization',{})).json();
            const next=await (await post('/oauth/token',{grant_type:'urn:ietf:params:oauth:grant-type:device_code',device_code:nextDevice.device_code})).json();
            fixtureNetwork(false);
            let offlineRejected=false;try{await get(next.access_token)}catch{offlineRejected=true}
            fixtureNetwork(true);
            const recovered=await get(next.access_token);
            return {unique:first.access_token!==second.access_token&&first.refresh_token!==second.refresh_token,
                lifetime:first.expires_in,refreshReuseStatus:reused.status,staleAccessStatus:stale.status,
                refreshReuseCode:reuseError.code,revokedAccessStatus:revoked.status,
                freshAccessStatus:fresh.status,offlineRejected,recoveredStatus:recovered.status,counts:fixtureMetrics()};
        }''')
        result['fixtureEvidence'] = evidence
        check(result,'unique-token-pairs',evidence['unique'])
        check(result,'real-900s-lifetime',evidence['lifetime']==900)
        check(result,'single-use-refresh-revokes-session',evidence['refreshReuseStatus']==401 and evidence['refreshReuseCode']=='session_revoked')
        check(result,'replacement-access-revoked-after-reuse',evidence['revokedAccessStatus']==401)
        check(result,'old-access-invalidated',evidence['staleAccessStatus']==401)
        check(result,'new-access-valid',evidence['freshAccessStatus']==200)
        check(result,'network-loss-enforced',evidence['offlineRejected'])
        check(result,'network-recovery',evidence['recoveredStatus']==200)
        check(result,'no-external-requests',not result['externalRequests'])
        check(result,'no-errors',not result['errors'])
except BaseException as e:
    check(result,'completed',False,str(e))
finally:
    result['status']='pass' if result['assertions'] and all(x['pass'] for x in result['assertions']) else 'fail'
    save(args,name,result)
    print(json.dumps({'status':result['status'],'output':str(args.out/name)}),flush=True)
raise SystemExit(0 if result['status']=='pass' else 1)
