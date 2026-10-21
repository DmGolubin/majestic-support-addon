"""Owned, offline-only browser/server contexts shared by QA entry points."""
import argparse
import hashlib
import json
import time
import shutil
from contextlib import ExitStack
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright
from memory_server import server

ROOT = Path(__file__).resolve().parents[2]
RUNS = ROOT / 'scripts' / 'qa' / 'runs'

def parser(description):
    p = argparse.ArgumentParser(description=description)
    p.add_argument('--harness', required=True, type=Path, help='Immutable directory made by prepare-memory-harness.mjs')
    p.add_argument('--out', required=True, type=Path, help='New results directory under scripts/qa/runs (never memory19)')
    return p

def configure(args, filename):
    args.harness = args.harness.resolve()
    args.out = args.out.resolve()
    if not args.out.is_relative_to(RUNS.resolve()) or args.out == args.harness:
        raise ValueError('Results must be separate from the harness and under scripts/qa/runs')
    if (args.out / filename).exists():
        raise ValueError('Refusing to overwrite previous results')
    provenance = json.loads((args.harness / 'provenance.json').read_text(encoding='utf-8-sig'))
    actual = hashlib.sha256((args.harness / 'plugin.js').read_bytes()).hexdigest()
    if provenance['pluginSha256'] != actual:
        raise ValueError('Harness plugin hash differs from provenance')
    args.out.mkdir(parents=True, exist_ok=True)
    qa_sources = {}
    for source in Path(__file__).parent.glob('*'):
        if source.suffix in ('.py', '.js', '.mjs'):
            qa_sources[source.name] = hashlib.sha256(source.read_bytes()).hexdigest()
    instrument = ROOT / 'scripts/qa/memory-instrument.js'
    shutil.copyfile(instrument, args.out / 'measurement-instrument.js')
    return {'provenance': provenance, 'qaSourceHashes':qa_sources,
            'harnessAssetHashes':{file.name:hashlib.sha256(file.read_bytes()).hexdigest() for file in args.harness.iterdir() if file.is_file()},
            'arguments':{k:str(v) if isinstance(v,Path) else v for k,v in vars(args).items()},
            'errors': [], 'externalRequests': [], 'assertions': [], 'samples': [], 'status': 'running'}

def check(result, name, condition, detail=None):
    result['assertions'].append({'name': name, 'pass': bool(condition), 'detail': detail})
    return bool(condition)

def save(args, filename, result):
    target = args.out / filename
    temporary = target.with_suffix('.tmp')
    temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(target)

class Run:
    def __init__(self, args, result):
        self.args, self.result = args, result
        self.start = time.monotonic()
        self.stack = ExitStack()
    def __enter__(self):
        try:
            self.url = self.stack.enter_context(server(self.args.harness))
            self.p = self.stack.enter_context(sync_playwright())
            self.browser = self.p.chromium.launch(headless=True, args=['--disable-background-networking'])
            self.stack.callback(self.browser.close)
            self.result['browser'] = self.browser.version
            self.result['serverOrigin'] = self.url
            return self
        except BaseException:
            self.stack.close()
            raise
    def __exit__(self, *exc):
        return self.stack.__exit__(*exc)
    def fresh(self, control=False):
        context = self.browser.new_context(viewport={'width': 1200, 'height': 900}, service_workers='block')
        self.stack.callback(context.close)
        def route(r):
            url = urlsplit(r.request.url)
            if url.scheme == 'http' and url.netloc == urlsplit(self.url).netloc:
                r.continue_()
            else:
                self.result['externalRequests'].append(url.scheme + '://' + url.netloc + url.path)
                r.abort()
        context.route('**/*', route)
        page = context.new_page()
        page.add_init_script(path=str(self.args.out / 'measurement-instrument.js'))
        page.on('pageerror', lambda e: self.result['errors'].append(str(e)))
        cdp = context.new_cdp_session(page)
        cdp.send('Performance.enable')
        page.goto(self.url + ('/control.html' if control else '/index.html'))
        page.wait_for_load_state('networkidle')
        if not control:
            page.evaluate('started')
        return page, cdp
    def connect(self, page):
        page.evaluate('async()=>{await harness.connectPanel();await testFrame()}')
        page.wait_for_function('harness.panel.get().phase === "ready"')
        page.wait_for_function('hostMetrics().streams === 1')
    def stop(self, page):
        page.evaluate('async()=>{harness.ui.set({windowOpen:false,management:false});await testFrame();instance.stop();await instance.retiring;await testFrame()}')
    def measure(self, page, cdp, label, cycle=0):
        def perf():
            return {m['name']: m['value'] for m in cdp.send('Performance.getMetrics')['metrics']}
        before = perf()
        cdp.send('HeapProfiler.collectGarbage')
        cdp.send('HeapProfiler.collectGarbage')
        app = page.evaluate('''() => ({host:hostMetrics(),fixture:fixtureMetrics(),instrument:instrumentMetrics(),
            phase:window.harness?.panel.get().phase??null,refs:window.harness?.refs()??null,
            elements:document.querySelectorAll('*').length,fonts:document.fonts.size,
            roots:document.querySelectorAll('#vc-stx-host').length,
            mounts:document.querySelectorAll('.stx-bd-button-mount').length,
            windows:document.querySelectorAll('.vc-stx-win,.vc-stx-management').length,
            settingsListeners:window.instance?.settingsListeners.size??0,
            resourceEntries:performance.getEntriesByType('resource').length})''')
        return {'label': label, 'cycle': cycle, 'elapsed': time.monotonic() - self.start,
                'wallTime': time.time(), 'beforeGC': before, 'afterGC': perf(),
                'heap': cdp.send('Runtime.getHeapUsage'), 'dom': cdp.send('Memory.getDOMCounters'), 'app': app}

def cleanup_assertions(result, row):
    app, ins = row['app'], row['app']['instrument']
    for key in ['fluxListeners', 'storeListeners', 'streams']:
        check(result, 'stop-' + key, app['host'][key] == 0, app['host'][key])
    for key in ['roots', 'mounts', 'windows', 'settingsListeners', 'fonts']:
        check(result, 'stop-' + key, app[key] == 0, app[key])
    live = {k: v for k, v in ins['activeObserversByOwner'].items() if k.startswith('plugin:')}
    check(result, 'stop-plugin-observers', not any(live.values()), live)
    timers = [t for t in ins['timers'] if t['owner'] in ('plugin', 'fixture')]
    check(result, 'stop-plugin-fixture-timers', not timers, timers)
    check(result, 'stop-plugin-frames', 'plugin' not in ins['framesByOwner'], ins['framesByOwner'])
    refs = app['refs'] or {}
    check(result, 'stop-target-refs', refs.get('windowTargetConnected') is None, refs)
    check(result, 'stop-visible-items', refs.get('visibleCount', 0) == 0, refs)

CYCLE_JS = '''async(count)=>{
 const clickText=(root,text)=>{const b=[...root.querySelectorAll('button')].find(b=>b.textContent.trim()===text);if(!b)throw Error('Missing '+text);b.click()};
 for(let i=0;i<count;i++){
  harness.ui.set({windowOpen:true});await testFrame();
  const picker=document.querySelector('.vc-stx-win');if(!picker)throw Error('Picker missing');
  picker.querySelector('.vc-stx-menu-settings').click();await testFrame();
  const settings=document.querySelector('.vc-stx-management');if(!settings)throw Error('Settings missing');
  for(const tab of ['Настройки','Тикеты','Мои шаблоны']){clickText(settings,tab);await testFrame();}
  const card=settings.querySelector('.vc-stx-pp-card');if(!card)throw Error('Personal card missing');card.click();await testFrame();
  if(!settings.querySelector('textarea'))throw Error('Editor missing');
  clickText(settings,'Отмена');await testFrame();clickText(settings,'Закрыть');await testFrame();
  if(document.querySelector('.vc-stx-management,.vc-stx-win'))throw Error('Window still mounted');
 }
}'''
