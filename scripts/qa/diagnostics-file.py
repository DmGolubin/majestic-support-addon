"""Offline acceptance of file recording, revocation evidence, reload and native host settings."""
import json
from memory_common import parser, configure, Run, check, save, cleanup_assertions, CYCLE_JS

p = parser('File diagnostics and BetterDiscord service settings')
args = p.parse_args()
name = 'diagnostics-results.json'
result = configure(args, name)
KEY = 'SupportTemplates_diagnostics_v1'

def host_settings(page):
    page.evaluate('''async()=>{
        const wrap=document.createElement('section');wrap.id='native-settings-fixture';
        wrap.style.cssText='position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:min(620px,90vw);max-height:85vh;overflow:auto;padding:24px;box-sizing:border-box;border-radius:12px;background:#313338;z-index:1001';
        document.body.append(wrap);window.serviceRoot=testReactDOM.createRoot(wrap);
        serviceRoot.render(instance.getSettingsPanel());await testFrame();
    }''')

try:
    with Run(args, result) as run:
        page, cdp = run.fresh()
        host_settings(page)
        host = page.locator('#native-settings-fixture')
        check(result, 'host-has-no-editor-or-tabs', host.locator('textarea,.vc-stx-settings-nav').count() == 0)
        check(result, 'recording-default-on', host.get_by_role('checkbox', name='Записывать диагностику').is_checked())
        check(result, 'recording-enabled', host.get_by_text('Запись идёт', exact=True).is_visible())
        page.screenshot(path=str(args.out / 'betterdiscord-settings.png'))
        host.get_by_role('button', name='Перейти в SupportTemplates').click()
        check(result, 'transition-instruction', host.get_by_text('Нажмите Done', exact=False).is_visible())
        page.evaluate("async()=>{serviceRoot.unmount();document.getElementById('native-settings-fixture').remove();await testFrame()}")
        check(result, 'management-after-native-close', page.locator('.vc-stx-management').count() == 1)
        page.evaluate('harness.ui.set({management:false})')
        run.connect(page)
        page.evaluate(CYCLE_JS, 50)
        # Real plugin event-stream retry, synthetic network only.
        page.evaluate('fixtureNetwork(false)')
        page.wait_for_timeout(1500)
        page.evaluate('fixtureNetwork(true)')
        page.wait_for_function('hostMetrics().streams === 1', timeout=20000)
        # A real parsed HTTP revocation response, never a direct state mutation.
        page.evaluate('''()=>{const original=BdApi.Net.fetch;BdApi.Net.fetch=(url,options)=>String(url).endsWith('/me')
            ? Promise.resolve(Response.json({code:'session_revoked',message:'PRIVATE_RESPONSE_SENTINEL'}, {status:401})) : original(url,options)}''')
        page.evaluate('harness.connectPanel()')
        page.wait_for_function('harness.panel.get().phase === "error"')
        host_settings(page)
        with page.expect_download() as download:
            page.locator('#native-settings-fixture').get_by_role('button', name='Скачать диагностику').click()
        target = args.out / 'diagnostic-export.json'
        download.value.save_as(target)
        raw = target.read_text(encoding='utf-8')
        report = json.loads(raw)
        check(result, 'revocation-cause-in-export', any(e['event'] == 'auth.terminated' and e['data'].get('code') == 'session_revoked' for e in report['journal']['events']))
        check(result, 'http-status-in-export', any(e['event'] == 'request.failure' and e['data'].get('status') == 401 for e in report['journal']['events']))
        check(result, 'network-failure-in-export', any(e['event'] == 'stream.failure' and e['data'].get('code') == 'network_error' for e in report['journal']['events']))
        check(result, 'no-secrets-or-template-content', all(s not in raw for s in ['fixture-access-', 'fixture-refresh-', 'PRIVATE_RESPONSE_SENTINEL', 'Проверьте настройки игры', 'Template fixture', 'Personal fixture']))
        check(result, 'bounded-history', len(report['journal']['events']) <= 2000)
        check(result, 'bounded-persistence', page.evaluate('(key)=>localStorage.getItem(key).length', KEY) <= 512*1024)
        page.reload(); page.evaluate('started'); host_settings(page)
        check(result, 'recording-survives-reload', page.locator('#native-settings-fixture').get_by_role('checkbox', name='Записывать диагностику').is_checked())
        saved = page.evaluate('(key)=>JSON.parse(localStorage.getItem(key))', KEY)
        check(result, 'cause-survives-reload', any(e['event'] == 'auth.terminated' for e in saved['events']))
        page.locator('#native-settings-fixture').get_by_role('checkbox', name='Записывать диагностику').uncheck()
        page.locator('#native-settings-fixture').get_by_role('button', name='Очистить журнал').click()
        page.locator('#native-settings-fixture').get_by_role('button', name='Удалить журнал', exact=True).click()
        check(result, 'explicit-clear-removes-history', page.evaluate('(key)=>JSON.parse(localStorage.getItem(key)).events.length', KEY) == 0)
        page.evaluate("async()=>{serviceRoot.unmount();document.getElementById('native-settings-fixture').remove();await testFrame()}")
        run.stop(page)
        page.wait_for_timeout(1200) # URL download revocation is bounded to one second.
        row = run.measure(page, cdp, 'diagnostics-stopped'); result['samples'].append(row); cleanup_assertions(result, row)
        check(result, 'no-unhandled-errors', not result['errors'], result['errors'])
        check(result, 'no-external-requests', not result['externalRequests'], result['externalRequests'])
except BaseException as error:
    check(result, 'completed', False, str(error))
finally:
    result['status'] = 'pass' if result['assertions'] and all(x['pass'] for x in result['assertions']) else 'fail'
    save(args, name, result)
    print(json.dumps({'status': result['status'], 'checks': len(result['assertions']), 'failures': [x for x in result['assertions'] if not x['pass']]}), flush=True)
raise SystemExit(0 if result['status'] == 'pass' else 1)
