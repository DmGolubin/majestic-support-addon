"""Read-only browser reproduction against the Q17 source fixture, never Discord."""
import json
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

fixture = Path(sys.argv[1]).resolve()
out = fixture / (sys.argv[2] if len(sys.argv) > 2 else 'exploration.json')
if out.exists():
    raise RuntimeError('Preserve previous evidence: use a new fixture')
results = {}
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
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1200, 'height': 900}, offline=True, service_workers='block')
    page.route('**/*', local_only)
    page.route_web_socket('**/*', reject_websocket)
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto((fixture / 'index.html').as_uri())
    page.locator('.vc-stx-management').wait_for()
    results['initial'] = page.locator('.vc-stx-management').inner_text()
    page.evaluate("previewUi.set({management:false});document.getElementById('chat-draft').focus()")
    page.evaluate('previewUi.set({windowOpen:true})')
    page.get_by_role('textbox', name='Поиск шаблонов').wait_for()
    page.get_by_role('textbox', name='Поиск шаблонов').press('Escape')
    results['pickerCloseFocus'] = page.evaluate('({tag:document.activeElement.tagName,id:document.activeElement.id})')
    page.evaluate('previewUi.set({management:true})')
    page.get_by_role('button', name='Настройки', exact=True).click()
    prefix = page.get_by_role('textbox', name='Префикс команды')
    prefix.fill('!')
    prefix.press('Escape')
    results['closeConfirmFocus'] = page.evaluate('({tag:document.activeElement.tagName,id:document.activeElement.id})')
    page.get_by_role('button', name='Вернуться', exact=True).click()
    results['returnFocus'] = page.evaluate('({tag:document.activeElement.tagName,id:document.activeElement.id})')
    for width, height in [(640, 480), (512, 384), (427, 320), (360, 300)]:
        page.set_viewport_size({'width': width, 'height': height})
        page.evaluate('previewUi.set({management:false,windowOpen:true})')
        page.locator('.vc-stx-win').wait_for()
        results[f'picker{width}x{height}'] = page.locator('.vc-stx-win').evaluate('e=>({rect:e.getBoundingClientRect().toJSON(),list:e.querySelector(".vc-stx-list").getBoundingClientRect().toJSON(),overflow:e.scrollHeight-e.clientHeight})')
        page.screenshot(path=str(fixture / f'{out.stem}-picker-{width}.png'))
    page.set_viewport_size({'width': 427, 'height': 320})
    page.evaluate('previewUi.set({management:true,windowOpen:false})')
    page.get_by_role('button', name='Настройки', exact=True).click()
    page.evaluate("previewPanel.set({phase:'error',error:'Ошибка'.repeat(70)})")
    results['longError'] = page.locator('.vc-stx-settings').evaluate('e=>({width:e.clientWidth,scroll:e.scrollWidth})')
    page.locator('.vc-stx-form-error').scroll_into_view_if_needed()
    page.screenshot(path=str(fixture / f'{out.stem}-long-error.png'))
    page.evaluate("previewUi.set({management:false,windowOpen:true});previewPanel.set({phase:'loading',error:''})")
    page.locator('.vc-stx-login').wait_for()
    page.locator('.vc-stx-login').evaluate("e=>e.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',isComposing:true,bubbles:true}))")
    page.evaluate('()=>new Promise(r=>requestAnimationFrame(r))')
    results['composingEscapeKeepsLogin'] = page.locator('.vc-stx-login').count() == 1
    page.evaluate('previewUi.set({management:false,windowOpen:false});previewService(true)')
    page.get_by_role('button', name='Перейти в SupportTemplates').wait_for()
    results['serviceOverflow'] = page.locator('#service').evaluate('e=>({width:e.clientWidth,scroll:e.scrollWidth})')
    page.screenshot(path=str(fixture / f'{out.stem}-service.png'))
    results['errors'] = errors
    results['blockedRequests'] = blocked_requests
    out.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(results, ensure_ascii=True, indent=2))
    browser.close()
sys.exit(1 if errors or blocked_requests else 0)
