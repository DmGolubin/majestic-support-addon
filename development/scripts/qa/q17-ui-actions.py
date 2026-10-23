"""Targeted editor/footer visual evidence; all mutations stay inside the UI fixture."""
import json
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

fixture = Path(sys.argv[1]).resolve()
out = fixture / 'editor-actions.json'
if out.exists():
    raise RuntimeError('Do not overwrite prior runs')
results = []
blocked_requests = []


def local_only(route):
    if route.request.url.startswith(('file:', 'data:', 'blob:')):
        route.continue_()
    else:
        blocked_requests.append(route.request.resource_type)
        route.abort()


def reject_websocket(route):
    blocked_requests.append('websocket')
    route.close()


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, timeout=60000)
    page = browser.new_page(offline=True, service_workers='block')
    page.route('**/*', local_only)
    page.route_web_socket('**/*', reject_websocket)
    page.set_default_timeout(7000)
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    for width, height in [(427, 320), (1200, 900)]:
        page.set_viewport_size({'width': width, 'height': height})
        page.goto((fixture / 'index.html').as_uri(), wait_until='domcontentloaded')
        page.add_style_tag(content='.review-controls { display:none !important; }')
        page.get_by_role('button', name='Добавить шаблон', exact=True).click()
        page.get_by_role('textbox', name='Название', exact=True).fill('Проверка действий редактора')
        body = page.get_by_role('textbox', name='Текст шаблона', exact=True)
        body.fill(('Длинный черновик. Строка должна оставаться внутри области прокрутки.\n') * 30)
        # Native textarea resizing changes its inline height. Model that geometry
        # explicitly to stress the scroll container; this is not a text insertion API.
        body.evaluate('e=>e.style.height="550px"')
        save = page.get_by_role('button', name='Сохранить на панели', exact=True)
        save.scroll_into_view_if_needed()
        page.evaluate("window.failWrite='offline'")
        save.click()
        retry = page.get_by_role('button', name='Повторить сохранение', exact=True)
        retry.wait_for()
        retry.scroll_into_view_if_needed()
        page.evaluate('()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
        metrics = page.locator('.vc-stx-pp-editor').evaluate('''e=>{
            const footer=e.querySelector('.vc-stx-pp-editor-footer');
            const body=e.querySelector('.vc-stx-pp-editor-body');
            const area=e.querySelector('textarea');
            const b=body.getBoundingClientRect(),f=footer.getBoundingClientRect(),t=area.getBoundingClientRect();
            const actions=[...footer.querySelectorAll('button')].map(x=>({label:x.textContent,rect:x.getBoundingClientRect().toJSON()}));
            return {body:b.toJSON(),footer:f.toJSON(),textarea:t.toJSON(),bodyOverflow:getComputedStyle(body).overflowY,actions,
                noBodyFooterOverlap:b.bottom<=f.top+1,
                actionsVisible:actions.every(x=>x.rect.top>=0&&x.rect.bottom<=innerHeight&&x.rect.left>=0&&x.rect.right<=innerWidth)};
        }''')
        metrics.update({'viewport': [width, height], 'retainedDraft': body.input_value().startswith('Длинный черновик.')})
        metrics['pass'] = metrics['noBodyFooterOverlap'] and metrics['actionsVisible'] and metrics['retainedDraft']
        results.append(metrics)
        page.screenshot(path=str(fixture / f'editor-actions-{width}x{height}.png'))
        # Show the dirty-close actions in the same small viewport.
        page.locator('.vc-stx-management > header button').click()
        confirm = page.locator('.vc-stx-close-confirm')
        confirm.wait_for()
        page.screenshot(path=str(fixture / f'draft-close-{width}x{height}.png'))
        page.get_by_role('button', name='Вернуться', exact=True).click()
        results[-1]['returnFocus'] = page.evaluate('document.activeElement.matches(".vc-stx-management > header button")')
        results[-1]['pass'] = results[-1]['pass'] and results[-1]['returnFocus']
    out.write_text(json.dumps({'results': results, 'errors': errors, 'blockedRequests': blocked_requests, 'limit': 'Source fixture, not Discord; write failure mocked; textarea resize geometry simulated'}, ensure_ascii=False, indent=2), encoding='utf-8')
    browser.close()
print(json.dumps({'passed': bool(results) and all(r['pass'] for r in results) and not errors and not blocked_requests, 'report': str(out)}))
sys.exit(0 if results and all(r['pass'] for r in results) and not errors and not blocked_requests else 1)
