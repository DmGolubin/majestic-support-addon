"""Offline A38 browser regression. No live Discord, network, sends or audio.

python -u scripts/qa/a38-keyboard-regression.py [--final] [--widths 320 900 1100]
--final waits for 30 seconds of unchanged fixture dependencies; every run checks
their hashes before build and after execution. Unrelated product files are excluded.
Evidence is in a new ignored runs/a38-keyboard directory.
Requires installed Python Playwright/Chromium and betterdiscord/node_modules.
"""
import argparse
import json
import re
import subprocess
import time
import traceback
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--final', action='store_true')
parser.add_argument('--widths', type=int, nargs='+', default=[320, 900, 1100])
parser.add_argument('--hosts', nargs='+', choices=['native', 'betterdiscord'], default=['native', 'betterdiscord'])
args = parser.parse_args()
RUN = ROOT / 'scripts/qa/runs/a38-keyboard' / (datetime.now().strftime('%Y%m%d-%H%M%S-%f') + ('-final' if args.final else '-draft'))
checks, errors, blocked, screenshots = [], [], [], []
scenario = ''


def source_hashes(paths=None):
    if paths is None:
        files = [p for p in (ROOT / 'src').rglob('*') if p.suffix in {'.ts', '.tsx', '.css'}]
        files += [ROOT / p for p in ['betterdiscord/adapter.css', 'scripts/qa/a38-keyboard-regression.mjs', 'scripts/qa/a38-keyboard-regression.py']]
    else:
        files = [ROOT / p for p in paths]
    return {p.relative_to(ROOT).as_posix(): sha256(p.read_bytes()).hexdigest() if p.exists() else None for p in sorted(files)}


before_all = source_hashes()
subprocess.run(['node', 'scripts/qa/a38-keyboard-regression.mjs', str(RUN)], cwd=ROOT, check=True)
provenance = json.loads((RUN / 'provenance.json').read_text(encoding='utf-8'))
dependency_paths = sorted(set(provenance['inputHashes']) | {
    'scripts/qa/a38-keyboard-regression.mjs', 'scripts/qa/a38-keyboard-regression.py'})
before = {p: before_all.get(p) for p in dependency_paths}
if args.final:
    previous, since = source_hashes(dependency_paths), time.monotonic()
    print(f'Waiting for 30 seconds of stability across {len(dependency_paths)} actual fixture dependencies', flush=True)
    while time.monotonic() - since < 30:
        time.sleep(3)
        current = source_hashes(dependency_paths)
        if current != previous:
            previous, since = current, time.monotonic()
            print('Fixture dependency changed; restarting stability interval', flush=True)
    # Never exercise a bundle that no longer matches its prebuild snapshot.
    if previous != before:
        changed = [p for p in dependency_paths if previous.get(p) != before.get(p)]
        (RUN / 'results.json').write_text(json.dumps({'aborted':True, 'reason':'Fixture dependency changed during build/stability interval; rerun in a new directory', 'changedSources':changed}, indent=2))
        raise RuntimeError('Fixture inputs changed after bundling: ' + ', '.join(changed))
(RUN / 'screenshots').mkdir()

# Route interception is a second barrier. Product audio modules are not imported.
HOST_GUARDS = """
window.a38External=[];
window.fetch=(...args)=>{a38External.push(['fetch',String(args[0])]);return Promise.reject(Error('Offline A38 fixture'))};
window.XMLHttpRequest=class{open(...args){a38External.push(['xhr',...args]);throw Error('Offline A38 fixture')}};
window.WebSocket=class{constructor(url){a38External.push(['websocket',url]);throw Error('Offline A38 fixture')}};
window.AudioContext=window.webkitAudioContext=class{constructor(){a38External.push(['audio']);throw Error('Offline A38 fixture')}};
HTMLMediaElement.prototype.play=function(){a38External.push(['media']);return Promise.reject(Error('Offline A38 fixture'))};
"""


def settle(page):
    page.evaluate('()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')


def shot(page, name):
    name = re.sub(r'[^a-zA-Z0-9_-]', '-', scenario + '-' + name) + '.png'
    filename = 'screenshots/' + name
    page.screenshot(path=str(RUN / filename))
    screenshots.append(filename)
    return filename


def check(page, name, passed, detail=None):
    row = {'name': scenario + ' / ' + name, 'pass': bool(passed), 'detail': detail}
    if not passed:
        row['screenshot'] = shot(page, 'FAIL-' + str(len(checks) + 1))
    checks.append(row)
    print(('PASS ' if passed else 'FAIL ') + row['name'], flush=True)
    if not passed:
        print(json.dumps(detail, ensure_ascii=False), flush=True)


def search(page):
    return page.get_by_role('textbox', name='Поиск шаблонов', exact=True)


def action(page, no_greeting=False):
    return page.get_by_role('button', name='Вставить без приветствия' if no_greeting else 'Вставить шаблон', exact=True)


def rows(page):
    return page.locator('.vc-stx-it')


def selected(page):
    return page.locator('.vc-stx-it.sel .vc-stx-nm').inner_text()


def rect(locator):
    return locator.evaluate('e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}}')


def fits(r, width, height=800):
    return r['x'] >= -1 and r['y'] >= -1 and r['right'] <= width + 1 and r['bottom'] <= height + 1


def clear_calls(page):
    page.evaluate('()=>{a38.calls=[];a38.compose=[];a38.draftKeys=[]}')


def calls(page):
    return page.evaluate('a38.calls')


def open_picker(page):
    page.evaluate('()=>{a38Ui.set({windowOpen:true,management:false,dialog:null,menu:null,compose:[]})}')
    search(page).wait_for()
    settle(page)


def fresh(page, host):
    page.goto((RUN / host / 'index.html').as_uri(), wait_until='networkidle')
    search(page).wait_for()
    settle(page)


def map_shortcuts(page, label, expected=None):
    visible = page.evaluate('a38Visible()')
    titles = rows(page).locator('.vc-stx-nm').all_text_contents()
    badges = rows(page).evaluate_all("es=>es.map(e=>Array.from(e.querySelectorAll('.vc-stx-kb')).map(b=>b.textContent).filter(t=>/^Alt\\+/.test(t)))")
    wanted = [[f'Alt+{i+1}'] if i < 9 else [] for i in range(len(titles))]
    check(page, label + ' committed shortcut order equals rendered DOM order', titles == [t['title'] for t in visible], visible)
    check(page, label + ' exactly Alt+1..9 badges in continuous DOM order', badges == wanted, badges)
    if expected is not None:
        check(page, label + ' independently expected template order', [t['id'] for t in visible] == expected, visible)
    page.evaluate('a38.keepOpen=true')
    for i in range(9):
        search(page).focus()
        clear_calls(page)
        page.keyboard.press(f'Alt+Digit{i+1}')
        settle(page)
        got = calls(page)
        wanted = [{'id': visible[i]['id'], 'options': {'via': f'alt-{i+1}'}}] if i < len(visible) else []
        check(page, label + f' Alt+{i+1} inserts corresponding row once or ignores absent row', got == wanted, got)
    search(page).focus()
    clear_calls(page)
    page.keyboard.press('Alt+Digit0')
    check(page, label + ' Alt+0 does not insert', calls(page) == [])


def mapping(page, host, width):
    fresh(page, host)
    check(page, 'window fits viewport', fits(rect(page.locator('.vc-stx-win')), width), rect(page.locator('.vc-stx-win')))
    check(page, 'footer labels are visible and do not overflow', page.locator('.vc-stx-actions').evaluate('e=>e.scrollWidth<=e.clientWidth+1')
          and action(page).is_visible() and action(page, True).is_visible())
    expected = ['f06','f02','f10','f01','f12','f09','f08','f00','f04','f03','f05','f07','f11','f13']
    check(page, 'All includes Recent section between Favorites and categories', page.locator('.vc-stx-sec').all_text_contents()[:2] == ['Избранное', 'Недавние'])
    shot(page, 'all-recent-section')
    map_shortcuts(page, 'All including Recent section', expected)
    rows(page).nth(8).scroll_into_view_if_needed()
    shot(page, 'all-alt9-scroll')

    page.locator('.vc-stx-tab').filter(has_text='Мои').click()
    settle(page)
    map_shortcuts(page, 'Personal', ['p02','p07','p00','p04','p06','p08','p01','p03','p05','p09'])

    page.evaluate("a38Preferences({favorites:['p09','f07','f03','p01','f11','f00','p04','f12','p08','f02']})")
    page.locator('.vc-stx-tab').filter(has_text='Избранное').click()
    settle(page)
    map_shortcuts(page, 'Favorites', ['p09','f07','f03','p01','f11','f00','p04','f12','p08','f02'])

    page.locator('.vc-stx-tab').filter(has_text='Недавние').click()
    settle(page)
    shot(page, 'recent-tab')
    map_shortcuts(page, 'Recent tab', ['f10','f01','f06','p02','f12','f09','f08','p07','f11','f02'])
    page.locator('.vc-stx-tab').get_by_text('Все', exact=True).click()
    search(page).fill('Ответ')
    settle(page)
    map_shortcuts(page, 'Search results')
    search(page).fill('')
    page.get_by_role('combobox', name='Категория шаблонов').click()
    page.get_by_role('option', name='Игра', exact=True).click()
    settle(page)
    map_shortcuts(page, 'Category filtered All', ['f00','f12','f02','f10','f06','f08','f04'])
    page.get_by_role('button', name='Сбросить категорию', exact=True).click()
    search(page).fill('Plainbody')
    settle(page)
    map_shortcuts(page, 'Single result', ['f13'])
    search(page).fill('qzxvnevermatch99331')
    settle(page)
    check(page, 'empty results disable both footer buttons', rows(page).count() == 0 and action(page).is_disabled() and action(page, True).is_disabled())
    map_shortcuts(page, 'Empty result', [])
    clear_calls(page)
    page.keyboard.press('Enter')
    page.keyboard.press('Control+Enter')
    page.keyboard.press('Shift+Enter')
    check(page, 'empty Enter variants neither insert nor compose', calls(page) == [] and page.evaluate('a38.compose.length') == 0)


def insertion(page, host, width):
    fresh(page, host)
    for key, options in [('Enter', {'via':'window-enter','noGreeting':False}), ('Control+Enter', {'via':'window-enter','noGreeting':True})]:
        open_picker(page)
        clear_calls(page)
        page.keyboard.press(key)
        settle(page)
        check(page, key + ' requests selected template with correct greeting mode', calls(page) == [{'id':'f06','options':options}], calls(page))
        check(page, key + ' mocked insertion closes Window and transfers focus to mock draft', page.locator('.vc-stx-win').count() == 0 and page.locator('#chat-draft').evaluate('e=>e===document.activeElement'))
    open_picker(page)
    clear_calls(page)
    page.keyboard.press('Shift+Enter')
    settle(page)
    check(page, 'Shift+Enter adds selected template to compose only', calls(page) == [] and page.evaluate('a38.compose') == ['f06'])
    page.evaluate('a38Ui.set({compose:[]})')
    for no_greeting in [False, True]:
        open_picker(page)
        clear_calls(page)
        action(page, no_greeting).click()
        settle(page)
        check(page, 'footer click ' + str(no_greeting) + ' uses selected row and correct mode', calls(page) == [{'id':'f06','options':{'via':'window-button','noGreeting':no_greeting}}], calls(page))

    open_picker(page)
    search(page).fill('Plainbody')
    settle(page)
    check(page, 'no greeting template disables only noGreeting footer with explanation', action(page).is_enabled() and action(page, True).is_disabled()
          and action(page, True).get_attribute('title') == 'В этом шаблоне нет приветствия')
    shot(page, 'disabled-no-greeting')
    clear_calls(page)
    b = rect(action(page, True))
    page.mouse.click(b['x'] + b['width']/2, b['y'] + b['height']/2)
    check(page, 'disabled noGreeting button ignores real pointer click', calls(page) == [])
    action(page).focus()
    page.keyboard.press('Tab')
    check(page, 'disabled noGreeting button is skipped by native Tab', not action(page, True).evaluate('e=>e===document.activeElement'))
    search(page).focus()
    page.keyboard.press('Control+Enter')
    settle(page)
    check(page, 'Ctrl+Enter on no greeting template still requests noGreeting safely', calls(page) == [{'id':'f13','options':{'via':'window-enter','noGreeting':True}}], calls(page))

    fresh(page, host)
    # Pointer movement must update footer target; a synthetic zero-delta move must not.
    page.mouse.move(1, 1)
    target = rows(page).nth(2)
    target.hover()
    settle(page)
    check(page, 'real mouse movement changes selection to hovered Recent row', selected(page).startswith('Ответ 10'), selected(page))
    rows(page).nth(1).dispatch_event('mousemove', {'movementX':0,'movementY':0})
    settle(page)
    check(page, 'synthetic zero-movement mouse event preserves selected row', selected(page).startswith('Ответ 10'), selected(page))
    shot(page, 'mouse-selected-recent-row-footer')
    clear_calls(page)
    action(page).click()
    check(page, 'footer insert follows row selected by mouse', calls(page) == [{'id':'f10','options':{'via':'window-button','noGreeting':False}}], calls(page))
    open_picker(page)
    rows(page).nth(2).hover()
    settle(page)
    clear_calls(page)
    action(page, True).click()
    check(page, 'footer noGreeting follows row selected by mouse', calls(page) == [{'id':'f10','options':{'via':'window-button','noGreeting':True}}], calls(page))
    open_picker(page)
    rows(page).filter(has_text='Plainbody').hover()
    settle(page)
    check(page, 'hovering no greeting row updates disabled footer state', selected(page).startswith('Plainbody') and action(page, True).is_disabled(), selected(page))
    # Keyboard selection can take over after pointer selection; the footer follows it.
    page.mouse.move(1, 1)
    search(page).focus()
    page.keyboard.press('ArrowUp')
    settle(page)
    check(page, 'keyboard ArrowUp restores greeting-enabled footer after mouse selection', selected(page).startswith('Ответ 11') and action(page, True).is_enabled(), selected(page))
    clear_calls(page)
    action(page, True).click()
    check(page, 'footer follows subsequent keyboard selection', calls(page) == [{'id':'f11','options':{'via':'window-button','noGreeting':True}}], calls(page))


def native_keys(page, host, width):
    fresh(page, host)
    for no_greeting in [False, True]:
        for key in ['Enter', 'Space']:
            open_picker(page)
            clear_calls(page)
            action(page, no_greeting).focus()
            if not no_greeting and key == 'Enter':
                shot(page, 'native-footer-keyboard-focus')
            page.keyboard.down(key)
            page.keyboard.down(key)  # Chromium marks a held key repeat.
            page.keyboard.up(key)
            settle(page)
            check(page, f'footer {no_greeting} native {key} activates once despite held repeat', calls(page) == [{'id':'f06','options':{'via':'window-button','noGreeting':no_greeting}}], calls(page))
            check(page, f'footer {no_greeting} native {key} does not leak held Enter/Space to draft', page.evaluate("a38.draftKeys.filter(e=>e.key==='Enter'||e.key===' ').length") == 0, page.evaluate('a38.draftKeys'))
    open_picker(page)
    clear_calls(page)
    page.keyboard.down('Enter')
    page.keyboard.down('Enter')
    page.keyboard.up('Enter')
    check(page, 'search held Enter inserts once and swallows draft repeat', len(calls(page)) == 1 and page.evaluate("a38.draftKeys.filter(e=>e.key==='Enter').length") == 0, calls(page))

    for no_greeting in [False, True]:
        for key in ['Enter', 'Space']:
            open_picker(page)
            # Pin preview through the actual search key handler, then focus its native button.
            page.keyboard.press('ArrowRight')
            settle(page)
            preview = page.locator('.vc-stx-win > .vc-stx-pre')
            button = preview.get_by_role('button', name='Без приветствия' if no_greeting else re.compile('^Вставить'))
            button.focus()
            clear_calls(page)
            page.keyboard.down(key)
            page.keyboard.down(key)
            page.keyboard.up(key)
            settle(page)
            expected = {'via':'preview', **({'noGreeting':True} if no_greeting else {})}
            check(page, f'preview {no_greeting} native {key} activates once without Window Enter interception', calls(page) == [{'id':'f06','options':expected}], calls(page))
            check(page, f'preview {no_greeting} native {key} protects mock draft from repeats', page.evaluate("a38.draftKeys.filter(e=>e.key==='Enter'||e.key===' ').length") == 0)
            page.evaluate('a38Store.setPreviewOpen(false)')

    open_picker(page)
    clear_calls(page)
    page.locator('.vc-stx-tab').get_by_text('Мои', exact=True).focus()
    page.keyboard.press('Enter')
    settle(page)
    check(page, 'native tab Enter changes view without insertion', page.locator('.vc-stx-tab.on').inner_text() == 'Мои' and calls(page) == [])
    page.locator('.vc-stx-tab').get_by_text('Все', exact=True).focus()
    page.keyboard.press('Space')
    settle(page)
    check(page, 'native tab Space changes view without insertion', page.locator('.vc-stx-tab.on').inner_text() == 'Все' and calls(page) == [])
    combo = page.get_by_role('combobox', name='Категория шаблонов')
    combo.focus()
    page.keyboard.press('Enter')
    page.keyboard.press('ArrowDown')
    page.keyboard.press('Enter')
    settle(page)
    check(page, 'category native Enter selects filter without insertion', calls(page) == [] and combo.inner_text() != 'Все категории', combo.inner_text())
    page.get_by_role('button', name='Сбросить категорию', exact=True).focus()
    page.keyboard.press('Enter')
    settle(page)
    check(page, 'reset category native Enter clears filter without insertion', calls(page) == [] and combo.inner_text() == 'Все категории')
    search(page).focus()
    page.keyboard.press('Tab')
    check(page, 'ordinary Tab moves focus to settings without inserting', page.get_by_role('button', name='Мои шаблоны и настройки', exact=True).evaluate('e=>e===document.activeElement') and calls(page) == [])
    page.get_by_role('button', name='Закрыть окно шаблонов', exact=True).focus()
    page.keyboard.press('Enter')
    settle(page)
    check(page, 'native close Enter closes without inserting and clears visible mapping', page.locator('.vc-stx-win').count() == 0 and page.evaluate('a38Visible()') == [] and calls(page) == [])
    page.locator('#chat-draft').focus()
    page.keyboard.press('Alt+Digit1')
    check(page, 'closed window Alt+1 uses Favorites independently of last visible rows', calls(page) == [{'id':'f06','options':{'via':'alt-1'}}], calls(page))


def peek(page, label, capture=False):
    page.mouse.move(1, 1)
    page.keyboard.down('Shift')
    settle(page)
    preview = page.locator('.vc-stx-win > .vc-stx-pre')
    check(page, label + ' Shift opens selected text preview', preview.is_visible() and preview.locator('h4').inner_text() == selected(page))
    if capture:
        shot(page, 'shift-' + label)
    page.keyboard.up('Shift')
    settle(page)
    check(page, label + ' Shift release hides temporary preview', preview.count() == 0)


def drag(page, loc, dx, dy):
    b = rect(loc)
    x, y = b['x']+b['width']/2, b['y']+b['height']/2
    page.mouse.move(x,y)
    page.mouse.down()
    page.mouse.move(x+dx,y+dy,steps=8)
    page.mouse.up()
    settle(page)


def geometry(page, host, width):
    fresh(page, host)
    peek(page, 'initial')
    win = page.locator('.vc-stx-win')
    initial = rect(win)
    drag(page, page.get_by_role('button', name='Переместить окно', exact=True), -16, -30)
    moved = rect(win)
    check(page, 'actual pointer drag moves vertically and restores search focus', abs(initial['y']-moved['y']) >= 20 and search(page).evaluate('e=>e===document.activeElement'), {'before':initial,'after':moved})
    peek(page, 'after-drag', True)
    for edge, dx, dy in [('n',0,12),('s',0,-12),('w',12,0),('e',-12,0),('nw',-12,-12),('ne',12,-12),('sw',-12,12),('se',12,12)]:
        prior = rect(win)
        drag(page, page.locator('.edge-' + edge), dx, dy)
        after = rect(win)
        changed = abs(prior['height']-after['height']) > 4 or abs(prior['width']-after['width']) > 4
        # 320px has a clamped horizontal width; still test the real pointer/focus path.
        check(page, edge + ' resize changes geometry (or horizontal 320px clamp), fits and returns search focus', (changed or width == 320 and not dy)
              and fits(after,width) and search(page).evaluate('e=>e===document.activeElement'), {'before':prior,'after':after,'changed':changed})
        peek(page, 'after-resize-' + edge, edge == 'se')
    check(page, 'footer remains unclipped after resizing', page.locator('.vc-stx-actions').evaluate('e=>e.scrollWidth<=e.clientWidth+1'))


with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)
    browser_version = browser.version
    for host in args.hosts:
        meta = json.loads((RUN / host / 'metafile.json').read_text())
        actual_adapter = any(p.replace('\\','/').endswith('betterdiscord/adapter.css') for p in meta['inputs'])
        checks.append({'name':host+' / adapter.css present only in BetterDiscord build','pass':actual_adapter == (host == 'betterdiscord')})
        for width in args.widths:
            context = browser.new_context(viewport={'width':width,'height':800}, device_scale_factor=1, reduced_motion='reduce')
            context.add_init_script(HOST_GUARDS)
            context.route(re.compile(r'^https?://'), lambda route: (blocked.append(route.request.url), route.abort()))
            page = context.new_page()
            page.set_default_timeout(5000)
            page.on('pageerror', lambda error: errors.append({'scenario':scenario,'error':str(error)}))
            for name, fn in [('mapping',mapping),('insertion',insertion),('native-keys',native_keys),('geometry',geometry)]:
                scenario = f'{host}-{width}-{name}'
                try:
                    fn(page, host, width)
                    check(page, 'no attempted external IO or audio', page.evaluate('a38External') == [], page.evaluate('a38External'))
                except Exception as error:
                    check(page, 'scenario completed without exception', False, str(error))
                    (RUN / f'{scenario}-exception.txt').write_text(traceback.format_exc(), encoding='utf-8')
            context.close()
    browser.close()

after = source_hashes(dependency_paths)
changes = sorted(p for p in before.keys() | after.keys() if before.get(p) != after.get(p))
checks.extend([
    {'name':'run / actual fixture dependency hashes stable throughout build and browser checks','pass':not changes,'detail':changes},
    {'name':'run / no browser JavaScript errors','pass':not errors,'detail':errors},
    {'name':'run / no external HTTP requests','pass':not blocked,'detail':blocked},
])
result = {'createdAt':datetime.now(timezone.utc).isoformat(),'final':args.final,'browser':'Chromium '+browser_version,
          'viewports':[{'width':w,'height':800} for w in args.widths],'hosts':args.hosts,
          'summary':{'total':len(checks),'passed':sum(c['pass'] for c in checks),'failed':sum(not c['pass'] for c in checks)},
          'checks':checks,'screenshots':screenshots,'errors':errors,'blockedRequests':blocked,
          'sourceHashesBefore':before,'sourceHashesAfter':after,'changedSources':changes,
          'hashScope':'Union of native/BetterDiscord esbuild source dependency graphs, exact global handleKey source file, and both A38 QA scripts. Unrelated files such as panelPreferences persistence are excluded.',
          'limitations':[
              'Source-based offline React fixture, not actual live Discord, installed Vencord/BetterDiscord or release bundles.',
              'Native uses real product CSS without BetterDiscord adapter overrides; BetterDiscord includes adapter.css. No complete Discord host stylesheet or custom theme is reproduced.',
              'Exact global handleKey source slice runs with real Window.visibleItems and keylatch. Channel/access/foreign-input gates, inline handling and dialog trap are fixture boundaries.',
              'Flow insertion and compose are recorded at mocked boundaries. Mock insertion closes Window and transfers focus to mock draft; actual draft text transformation, host submit and account permissions are not tested.',
              'No network, chat sends or audio; requests intercepted and audio constructors blocked. ContextMenu, dialogs, bindings editor and inline are owned by other suites.',
              '320px horizontal resize may clamp at product minimum; vertical geometry and keyboard focus are exercised. Alt+N means ordered rendered rows, including rows scrolled outside the list viewport.',
              'Desktop headless Chromium at device scale 1, height 800; no OS-level hotkey interception, IME platform integration, screen reader or manual visual acceptance claimed.',
          ]}
(RUN / 'results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
(RUN / 'README.md').write_text('# A38 offline keyboard regression\n\n'+json.dumps(result['summary'])+'\n\n'+'\n'.join('- '+x for x in result['limitations'])+'\n\nScreenshots: `screenshots/`. Full assertions and source hashes: `results.json`. Exact handler: `global-handler-source.ts`.\n',encoding='utf-8')
print('RESULT '+str(RUN / 'results.json'),flush=True)
print(json.dumps(result['summary']),flush=True)
raise SystemExit(1 if result['summary']['failed'] else 0)
