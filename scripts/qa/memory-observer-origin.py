"""Attribute residual observer accounting without retaining observer/DOM objects."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright
from memory_server import server

with server(), sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.add_init_script('''(() => {
      const Native = MutationObserver, records = [];
      window.MutationObserver = class extends Native {
        constructor(fn) { super(fn); records.push({ref:new WeakRef(this),stack:new Error().stack}); }
        observe(...args) { super.observe(...args); this.active=true; }
        disconnect() { super.disconnect(); this.active=false; }
      };
      window.observerOrigins=()=>records.map(r=>({alive:!!r.ref.deref(),active:r.ref.deref()?.active??false,stack:r.stack}));
    })();''')
    page.goto('http://127.0.0.1:47836/index.html')
    page.wait_for_load_state('networkidle')
    page.evaluate('async()=>{await started;await harness.connectPanel()}')
    page.wait_for_function('harness.panel.get().phase === "ready"')
    page.evaluate('async()=>{harness.ui.set({windowOpen:true});await new Promise(r=>setTimeout(r,100))}')
    page.locator('.vc-stx-menu-settings').click()
    page.evaluate('async()=>{instance.stop();await instance.retiring}')
    cdp=page.context.new_cdp_session(page)
    cdp.send('HeapProfiler.collectGarbage')
    result=page.evaluate('observerOrigins()')
    Path('artifacts/memory19/observer-origins.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps(result))
    browser.close()
