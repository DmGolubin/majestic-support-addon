"""Offline source-component acceptance for Vencord and standalone native settings."""
import json
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

fixture = Path(sys.argv[1]).resolve()
output = fixture / 'native-service-results.json'
if output.exists():
    raise RuntimeError('Use a fresh fixture; preserve previous results')
checks, errors, blocked = [], [], []

def check(name, ok, detail=None):
    checks.append({'name': name, 'pass': bool(ok), 'detail': detail})

def local_only(route):
    if route.request.url.startswith(('file:', 'data:', 'blob:')):
        route.continue_()
    else:
        blocked.append(route.request.resource_type)
        route.abort()

def reject_websocket(route):
    blocked.append('websocket')
    route.close()

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    try:
        for variant in ['vencord', 'standalone']:
            for width in [320, 720]:
                page = browser.new_page(viewport={'width': width, 'height': 900}, offline=True, service_workers='block')
                page.route('**/*', local_only)
                page.route_web_socket('**/*', reject_websocket)
                page.set_default_timeout(7000)
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.goto((fixture / 'index.html').as_uri() + '?' + variant)
                service = page.locator('.vc-stx-native-settings')
                service.wait_for()
                label = variant + '-' + str(width)
                check(label + '-no-editor', service.locator('textarea,.vc-stx-settings-nav').count() == 0)
                geometry = service.evaluate("e=>({position:getComputedStyle(e).position,pointer:getComputedStyle(e).pointerEvents,color:getComputedStyle(e).getPropertyValue('--stx-tx'),overflow:document.documentElement.scrollWidth>innerWidth+1,width:e.getBoundingClientRect().width})")
                check(label + '-embedded-styled-no-overflow', geometry['position'] != 'fixed' and geometry['pointer'] != 'none' and bool(geometry['color'].strip()) and not geometry['overflow'], geometry)
                check(label + '-identity', ('Vencord' in service.inner_text()) if variant == 'vencord' else ('только SupportTemplates' in service.inner_text()))
                check(label + '-diagnostics', service.get_by_role('checkbox', name='Записывать диагностику').is_enabled())
                service.get_by_role('button', name='Перейти в SupportTemplates').click()
                check(label + '-deferred', page.evaluate('handoffs.length') == 0 and service.get_by_text('Закройте настройки Discord', exact=False).is_visible())
                page.screenshot(path=str(fixture / (label + '.png')), full_page=True)
                page.evaluate('serviceFixture.close()')
                service.wait_for(state='detached')
                check(label + '-handoff-on-close', page.evaluate('handoffs') == [{'management': True, 'windowOpen': False, 'menu': None, 'inline': None}])
                page.close()
        page = browser.new_page(offline=True, service_workers='block')
        page.route('**/*', local_only)
        page.route_web_socket('**/*', reject_websocket)
        page.set_default_timeout(7000)
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto((fixture / 'index.html').as_uri())
        page.get_by_role('button', name='Перейти в SupportTemplates').click()
        page.evaluate('serviceFixture.stop()')
        page.locator('#vc-stx-host').wait_for(state='detached')
        page.evaluate('serviceFixture.close()')
        page.locator('.vc-stx-native-settings').wait_for(state='detached')
        check('stop-cancels-queued-handoff', page.evaluate('handoffs.length') == 0)
    except BaseException as error:
        check('completed', False, str(error))
    finally:
        browser.close()
check('no-browser-errors', not errors, errors)
check('no-external-network', not blocked, blocked)
output.write_text(json.dumps({'checks': checks, 'limitation': 'Offline React source fixture, not actual Discord/Vencord focus trap.'}, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'passed': sum(c['pass'] for c in checks), 'failed': sum(not c['pass'] for c in checks), 'output': str(output)}))
sys.exit(0 if checks and all(c['pass'] for c in checks) else 1)
