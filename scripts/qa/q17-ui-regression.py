"""Q17 UI browser acceptance. Real source components; mocked host/API/insertion.

Usage: python -u scripts/qa/q17-ui-regression.py scripts/qa/runs/q17-ui/BUILD
Effective zoom is physical viewport / scale in CSS pixels;
this tests layout under reduced CSS space, not Discord's Electron zoom setting.
"""
import json
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

fixture = Path(sys.argv[1]).resolve()
output = fixture / 'regression.json'
if output.exists():
    raise RuntimeError('Refusing to overwrite evidence; prepare a fresh fixture')
checks, errors = [], []
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


def check(name, ok, detail=None):
    checks.append({'name': name, 'pass': bool(ok), 'detail': detail})
    print(('PASS ' if ok else 'FAIL ') + name, flush=True)


def bounds(loc, width, height):
    b = loc.bounding_box()
    return b and b['x'] >= -1 and b['y'] >= -1 and b['x'] + b['width'] <= width + 1 and b['y'] + b['height'] <= height + 1


def overflow(loc):
    return loc.evaluate('e=>({width:e.clientWidth,scroll:e.scrollWidth})')


def focused(page, selector):
    return page.evaluate('(s)=>document.activeElement.matches(s)', selector)


def settle(page):
    page.evaluate('()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')


def open_picker(page):
    page.evaluate('previewUi.set({management:false,windowOpen:true})')
    page.locator('.vc-stx-win').wait_for()
    settle(page)


def fresh(page, distribution='betterdiscord'):
    page.goto((fixture / 'index.html').as_uri() + '?distribution=' + distribution, wait_until='domcontentloaded')
    page.locator('.vc-stx-management').wait_for()


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, timeout=60000)
    page = browser.new_page(viewport={'width': 1200, 'height': 900}, offline=True, service_workers='block')
    page.set_default_timeout(7000)
    page.on('pageerror', lambda e: errors.append(str(e)))
    # The fixture is strictly offline; unexpected network requests cannot reach a service.
    page.route('**/*', local_only)
    page.route_web_socket('**/*', reject_websocket)
    try:
        fresh(page)
        page.evaluate("previewUi.set({management:false});document.getElementById('chat-draft').focus()")
        open_picker(page)
        search = page.get_by_role('textbox', name='Поиск шаблонов')
        search.press('Escape')
        settle(page)
        check('picker Escape restores chat focus', focused(page, '#chat-draft'))
        open_picker(page)
        page.get_by_role('button', name='Закрыть окно шаблонов', exact=True).click()
        settle(page)
        check('picker close button restores chat focus', focused(page, '#chat-draft'))

        page.evaluate('previewUi.set({management:true})')
        page.get_by_role('button', name='Настройки', exact=True).click()
        prefix = page.get_by_role('textbox', name='Префикс команды')
        prefix.fill('!')
        prefix.press('Escape')
        check('dirty Escape focuses safe return action', focused(page, '.vc-stx-close-actions button:first-child'))
        page.get_by_role('button', name='Вернуться', exact=True).click()
        check('return restores draft field focus and value', focused(page, '#stx-prefix-input') and prefix.input_value() == '!')
        prefix.press('Escape')
        page.get_by_role('button', name='Вернуться', exact=True).press('Escape')
        check('Escape cancels dirty confirmation without closing settings', page.locator('.vc-stx-close-confirm').count() == 0 and page.locator('.vc-stx-management').count() == 1 and prefix.input_value() == '!')
        # Reset explicitly if testing the old UI, so independent checks still run.
        if page.locator('.vc-stx-close-confirm').count():
            page.get_by_role('button', name='Вернуться', exact=True).click()
        prefix.press('Escape')
        page.get_by_role('button', name='Закрыть без сохранения', exact=True).click()
        page.evaluate('previewUi.set({management:true})')
        page.get_by_role('button', name='Настройки', exact=True).click()
        check('explicit discard leaves saved prefix unchanged', prefix.input_value() == ';')
        page.locator('#chat-text').dblclick(position={'x': 15, 'y': 8})
        check('settings permits chat text selection', page.evaluate('String(getSelection()).length') > 0)
        page.locator('#chat-draft').fill('Local unsent draft')
        page.locator('#chat-draft').press('Escape')
        check('chat Escape leaves settings and draft intact', page.locator('.vc-stx-management').count() == 1 and page.locator('#chat-draft').input_value() == 'Local unsent draft')

        fresh(page)
        open_picker(page)
        search = page.get_by_role('textbox', name='Поиск шаблонов')
        page.mouse.move(1, 400)
        search.press('Tab')
        check('Tab reaches settings without inserting', focused(page, '.vc-stx-menu-settings') and page.evaluate('window.insertions||0') == 0)
        page.keyboard.press('Shift+Tab')
        check('Shift Tab returns to search', focused(page, '.vc-stx-sinput'))
        search.press('Alt+ArrowDown')
        category = page.get_by_role('combobox', name='Категория шаблонов')
        check('Alt Down opens category filter', category.get_attribute('aria-expanded') == 'true')
        category.press('ArrowDown')
        category.press('Enter')
        check('category Enter selects without inserting', category.get_attribute('aria-expanded') == 'false' and page.evaluate('window.insertions||0') == 0)
        category.press('Enter')
        category.press('Escape')
        check('category Escape closes only dropdown', category.get_attribute('aria-expanded') == 'false' and page.locator('.vc-stx-win').count() == 1)
        search.focus()
        search.press('Enter')
        search.press('Shift+Enter')
        check('Enter and Shift Enter dispatch distinct actions once', page.evaluate('[window.insertions,window.compositions]') == [1, 1])
        page.keyboard.down('Shift')
        check('held Shift previews', page.locator('.vc-stx-win > .vc-stx-pre').count() == 1)
        page.keyboard.up('Shift')
        check('released Shift hides transient preview', page.locator('.vc-stx-win > .vc-stx-pre').count() == 0)
        search.fill('zzzzmissing')
        check('no-results state visible', page.get_by_text('Ничего не найдено', exact=True).count() == 1)
        search.press('Escape')
        check('first Escape clears search', search.input_value() == '' and page.locator('.vc-stx-win').count() == 1)
        page.locator('#chat-text').dblclick(position={'x': 15, 'y': 8})
        check('picker permits chat selection without closing', page.evaluate('String(getSelection()).length') > 0 and page.locator('.vc-stx-win').count() == 1)

        fresh(page)
        open_picker(page)
        picker = page.locator('.vc-stx-win')
        before = picker.bounding_box()
        grip = page.get_by_role('button', name='Изменить размер окна', exact=True)
        g = grip.bounding_box()
        page.mouse.move(g['x'] + 8, g['y'] + 8)
        page.mouse.down()
        page.mouse.move(g['x'] - 92, g['y'] - 72, steps=6)
        page.mouse.up()
        after = picker.bounding_box()
        check('pointer resize grows width and height', after['width'] == before['width'] + 100 and after['height'] == before['height'] + 80, [before, after])
        grip.press('Shift+ArrowLeft')
        check('Shift arrow resize uses 40px step without preview', picker.bounding_box()['width'] == after['width'] + 40 and page.locator('.vc-stx-win > .vc-stx-pre').count() == 0)
        persisted = picker.bounding_box()
        page.get_by_role('button', name='Закрыть окно шаблонов', exact=True).click()
        open_picker(page)
        page.wait_for_function('(w)=>document.querySelector(".vc-stx-win").getBoundingClientRect().width===w', arg=persisted['width'])
        check('resize persists across reopen', picker.bounding_box()['height'] == persisted['height'])
        g = grip.bounding_box()
        page.mouse.move(g['x'] + 8, g['y'] + 8)
        page.mouse.down()
        page.mouse.move(g['x'] - 32, g['y'] - 22, steps=4)
        page.keyboard.press('Escape')
        page.mouse.up()
        check('Escape cancels in-progress resize', picker.bounding_box()['width'] == persisted['width'] and page.locator('.vc-stx-win').count() == 1)

        for distribution, label in [('betterdiscord', 'BetterDiscord'), ('vencord', 'Vencord (полный набор плагинов)'), ('standalone', 'Отдельная сборка (только SupportTemplates)')]:
            for physical in [(1200, 900), (640, 480)]:
                for scale in [1, 1.25, 1.5]:
                    width, height = (round(x / scale) for x in physical)
                    page.set_viewport_size({'width': width, 'height': height})
                    fresh(page, distribution)
                    ident = f'{distribution} {physical[0]}x{physical[1]} {scale*100:g}%'
                    management = page.locator('.vc-stx-management')
                    boxes = []
                    for tab in ['Мои шаблоны', 'Настройки', 'Тикеты']:
                        page.get_by_role('button', name=tab, exact=True).click()
                        boxes.append(management.bounding_box())
                        o = overflow(page.locator('.vc-stx-settings'))
                        check(ident + ' ' + tab + ' fits', bounds(management, width, height) and o['scroll'] <= o['width'] + 1, o)
                    check(ident + ' fixed dimensions across tabs and identity', all(x['width'] == boxes[0]['width'] and x['height'] == boxes[0]['height'] for x in boxes) and label in management.inner_text(), boxes[0])
                    if physical == (640, 480) and scale == 1.5:
                        page.get_by_role('button', name='Настройки', exact=True).click()
                        page.locator('.vc-stx-diagnostics').scroll_into_view_if_needed()
                        page.screenshot(path=str(fixture / f'{distribution}-150-settings.png'))
                    open_picker(page)
                    check(ident + ' picker clamps', bounds(page.locator('.vc-stx-win'), width, height), page.locator('.vc-stx-win').bounding_box())
                    if physical == (640, 480) and scale == 1.5:
                        page.screenshot(path=str(fixture / f'{distribution}-150-picker.png'))

        page.set_viewport_size({'width': 427, 'height': 320})
        fresh(page)
        page.evaluate("previewPersonal.set({catalog:{...previewPersonal.get().catalog,personalRecords:previewPersonal.get().catalog.personalRecords.map(t=>({...t,title:'ОченьДлинноеНазвание'.repeat(12)})),folderRecords:[{id:'long',version:'v1',title:'ДлиннаяПапка'.repeat(15),project:'mj',position:0}]}})")
        o = overflow(page.locator('.vc-stx-settings'))
        check('long template and folder names do not widen settings', o['scroll'] <= o['width'] + 1, o)
        page.get_by_role('combobox', name='Фильтр папок').click()
        page.get_by_role('combobox', name='Фильтр папок').press('End')
        check('long dropdown option stays in viewport', bounds(page.get_by_role('listbox'), 427, 320))
        page.get_by_role('combobox', name='Фильтр папок').press('Escape')
        page.get_by_role('button', name='Добавить шаблон', exact=True).click()
        title = page.get_by_role('textbox', name='Название', exact=True)
        title.fill('Q17 local fixture')
        page.get_by_role('textbox', name='Текст шаблона', exact=True).fill('Текст черновика')
        title.focus()
        title.press('Escape')
        page.get_by_role('button', name='Вернуться', exact=True).click()
        check('personal draft survives window close cancellation', title.input_value() == 'Q17 local fixture' and focused(page, 'input[maxlength="160"]'))
        save = page.get_by_role('button', name='Сохранить на панели', exact=True)
        save.scroll_into_view_if_needed()
        check('small editor save action reachable', bounds(save, 427, 320))
        page.evaluate("window.failWrite='offline'")
        save.click()
        page.get_by_role('button', name='Повторить сохранение', exact=True).wait_for()
        check('failed mocked save keeps draft', title.input_value() == 'Q17 local fixture' and page.get_by_role('textbox', name='Текст шаблона', exact=True).input_value() == 'Текст черновика')
        page.screenshot(path=str(fixture / 'editor-error-150.png'))
        # An uncertain write locks its fields deliberately. Close from the header.
        page.locator('.vc-stx-management > header button').click()
        page.get_by_role('button', name='Вернуться', exact=True).click()
        check('uncertain write survives close cancellation', title.input_value() == 'Q17 local fixture' and title.is_disabled())

        fresh(page)
        page.get_by_role('button', name='Настройки', exact=True).click()
        page.evaluate("previewPanel.set({phase:'error',error:'Ошибка'.repeat(70)})")
        o = overflow(page.locator('.vc-stx-settings'))
        check('long error wraps without horizontal overflow', o['scroll'] <= o['width'] + 1, o)
        page.screenshot(path=str(fixture / 'long-error.png'))
        for phase in ['idle', 'connecting', 'pending', 'loading', 'offline', 'error']:
            page.evaluate('(phase)=>{previewUi.set({management:false,windowOpen:true});previewPanel.set({phase,error:phase==="error"?"Ошибка подключения":"",code:"ABCD-EFGH",url:"https://example.invalid/mock"})}', phase)
            login = page.locator('.vc-stx-login')
            login.wait_for()
            check('login ' + phase + ' fits small viewport', bounds(login, 427, 320))
            login.focus()
            login.press('Tab')
            check('login ' + phase + ' Tab focuses action', focused(page, '.vc-stx-login button'))
        login.evaluate("e=>e.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',isComposing:true,bubbles:true}))")
        settle(page)
        check('login composing Escape is ignored', page.locator('.vc-stx-login').count() == 1)

        fresh(page)
        page.evaluate('previewPersonal.set({catalog:{...previewPersonal.get().catalog,personalRecords:[],folderRecords:[]}})')
        check('personal empty state', 'пока нет' in page.locator('.vc-stx-panel-personal').inner_text().lower())
        page.evaluate('previewStore.templates.length=0;previewTick.set({v:1})')
        open_picker(page)
        check('picker empty library state', page.get_by_text('В библиотеке пока нет шаблонов.', exact=True).count() == 1)

        page.evaluate('previewUi.set({management:false,windowOpen:false});previewService(true)')
        service = page.locator('#service')
        for width in [600, 480, 384, 320]:
            page.set_viewport_size({'width': width, 'height': 480})
            for phase in ['idle', 'loading', 'error', 'ready']:
                page.evaluate('(phase)=>previewPanel.set({phase})', phase)
                o = overflow(service)
                check(f'BD service {width}px {phase} no horizontal overflow', o['scroll'] <= o['width'] + 1, o)
        recording = page.get_by_role('checkbox', name='Записывать диагностику на 24 часа')
        recording.check()
        check('BD DiagnosticControls recording state updates', recording.is_checked() and 'Запись идёт' in service.inner_text())
        page.get_by_role('button', name='Скачать диагностику', exact=True).click()
        check('DiagnosticControls reports mocked download success', 'Файл передан в загрузки' in service.inner_text() and page.evaluate('window.previewDownloads') == 1)
        page.evaluate('window.failDownload=true')
        page.get_by_role('button', name='Скачать диагностику', exact=True).click()
        check('DiagnosticControls reports mocked download failure', 'Не удалось скачать файл' in service.inner_text())
        page.get_by_role('button', name='Очистить журнал', exact=True).click()
        page.get_by_role('button', name='Отмена', exact=True).click()
        check('DiagnosticControls clear cancellation', page.get_by_role('button', name='Удалить журнал', exact=True).count() == 0)
        page.get_by_role('button', name='Очистить журнал', exact=True).click()
        page.get_by_role('button', name='Удалить журнал', exact=True).click()
        check('DiagnosticControls explicit clear', page.get_by_role('button', name='Удалить журнал', exact=True).count() == 0)
        actions = service.locator('.vc-stx-diagnostic-actions').first
        check('diagnostic buttons keep at least 8px separation', actions.evaluate('e=>{const [a,b]=[...e.children].map(x=>x.getBoundingClientRect());return b.top>=a.bottom+8||b.left>=a.right+8}'))
        page.screenshot(path=str(fixture / 'bd-diagnostics.png'), full_page=True)
        page.get_by_role('button', name='Перейти в SupportTemplates', exact=True).press('Enter')
        check('BD service queues opening until native modal unmount', page.get_by_role('button', name='Перейти в SupportTemplates').is_disabled() and page.locator('.vc-stx-management').count() == 0 and 'Done' in service.inner_text())
        page.screenshot(path=str(fixture / 'bd-service-queued.png'))
        page.evaluate('previewService(false)')
        page.locator('.vc-stx-management').wait_for()
        check('BD service unmount opens shared settings', page.locator('.vc-stx-management').count() == 1)
        page.evaluate('previewUi.set({management:false});previewService("inactive")')
        check('BD inactive service disables entry', page.get_by_role('button', name='Перейти в SupportTemplates').is_disabled())
        check('BD inactive DiagnosticControls disables recording but permits export', recording.is_disabled() and page.get_by_role('button', name='Скачать диагностику').is_enabled())
    except Exception as e:
        check('browser scenario completed', False, str(e))
        page.screenshot(path=str(fixture / 'failure.png'))
    finally:
        check('no uncaught browser errors', not errors, errors)
        check('no unexpected network requests', not blocked_requests, blocked_requests)
        output.write_text(json.dumps({'scope': 'Real source React UI; mocked Discord, API, insertion and diagnostics; no installed distribution exercised', 'scaleMethod': 'CSS viewport = physical viewport / effective scale (not deviceScaleFactor-only zoom)', 'checks': checks}, ensure_ascii=False, indent=2), encoding='utf-8')
        browser.close()
print(json.dumps({'passed': sum(c['pass'] for c in checks), 'failed': sum(not c['pass'] for c in checks), 'results': str(output)}))
sys.exit(0 if all(c['pass'] for c in checks) else 1)
