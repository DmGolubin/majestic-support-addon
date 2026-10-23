"""Bounded Chromium QA of QuickCSS with an in-memory Vencord preload mock.

No Discord/Electron instance or real settings are used. With --script, load the
unchanged HTML as a data URL, then use DevTools evaluation to emulate trusted
webContents.executeJavaScript. This does not validate Electron IPC/preload wiring.
Only an existing Python Playwright installation/browser is used; never installed.
Reports/screenshots go to a NEW directory below scripts/qa/runs.
"""

import argparse
import asyncio
import base64
import hashlib
import importlib.metadata
import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

RUNS = Path(__file__).resolve().parent / "runs"
TOTAL_SECONDS = 150
CASE_SECONDS = 45
STEP_MS = 7000
MAX_EVENTS = 250
INITIAL = ("/* Mock preload QuickCSS QA */\n"
           ":root { --qa-accent: red; }\n"
           ".qa-fixture { color: var(--qa-accent); }\n/* qa-edit: */")
REJECTION = "QA_INITIAL_CSS_REJECTED"

# Observation only: native Worker execution and messaging are preserved. No
# editor/model globals, filesystem APIs, fetches, or exposed Python bindings.
INIT = r"""(() => {
 const config = __CONFIG__;
 const state = {getCss:0, getTheme:0, saves:[], saveCount:0, lastCss:null,
   workers:[], workerErrors:[], csp:[], overflow:0, pagehide:0};
 const push = (list, value) => { if(list.length < 250) list.push(value); else state.overflow++; };
 Object.defineProperty(window, '__quickcssQa', {value:state});
 window.getCurrentCss = () => {
   state.getCss++;
   return config.reject ? Promise.reject(new Error(config.rejection)) : Promise.resolve(config.css);
 };
 window.getTheme = () => { state.getTheme++; return config.theme; };
 window.setCss = css => {
   if(typeof css !== 'string') throw new TypeError('Mock setCss requires a string');
   state.saveCount++; state.lastCss = css.slice(0, 16384);
   push(state.saves, {css:state.lastCss, time:performance.now()});
 };
 addEventListener('securitypolicyviolation', e => push(state.csp, {
   directive:e.effectiveDirective, blockedURI:e.blockedURI.slice(0, 300)}));
 addEventListener('pagehide', () => state.pagehide++);
 const NativeWorker = window.Worker;
 window.Worker = new Proxy(NativeWorker, {construct(target, args, newTarget) {
   const worker = Reflect.construct(target, args, newTarget);
   const row = {url:String(args[0]).slice(0,300), name:args[1]?.name || '',
     methods:[], received:0, terminateCalls:0};
   push(state.workers, row);
   const post = worker.postMessage;
   worker.postMessage = function(...values) {
     const msg = values[0];
     const candidates = [msg?.method, ...(Array.isArray(msg?.args) ? msg.args.slice(0,3) : [])];
     for(const method of candidates) {
       if(typeof method === 'string' && /^(\$?[a-zA-Z]+)$/.test(method) &&
          method.length < 80 && !row.methods.includes(method)) push(row.methods, method);
     }
     return Reflect.apply(post, this, values);
   };
   const terminate = worker.terminate;
   worker.terminate = function(...values) {
     row.terminateCalls++;
     return Reflect.apply(terminate, this, values);
   };
   worker.addEventListener('message', () => row.received++);
   worker.addEventListener('error', e => push(state.workerErrors, String(e.message).slice(0,2000)));
   return worker;
 }});
})();"""

SNAPSHOT = r"""() => {
 const editor = document.querySelector('#container .monaco-editor');
 const status = document.querySelector('#status');
 const box = el => { if(!el) return null; const r=el.getBoundingClientRect();
   return {x:r.x,y:r.y,width:r.width,height:r.height}; };
 return {protocol:location.protocol, origin:location.origin,
   scripts:document.scripts.length, editors:document.querySelectorAll('.monaco-editor').length,
   csp:[...document.querySelectorAll('meta[http-equiv]')].filter(
     e=>e.httpEquiv.toLowerCase()==='content-security-policy').map(e=>e.content),
   editorClass:editor?.className || '', background:editor ? getComputedStyle(editor).backgroundColor : '',
   container:box(document.querySelector('#container')), editor:box(editor),
   status:status ? {text:status.textContent.trim(),role:status.getAttribute('role'),
     visible:!!(status.getClientRects().length && getComputedStyle(status).visibility!=='hidden')} : null,
   lines:[...document.querySelectorAll('#container .view-lines .view-line')].map(e=>e.textContent).join('\n'),
   qa:window.__quickcssQa};
}"""


def brief(value, limit=2000):
    return re.sub(r"data:[^\s\"']+", "[data URL omitted]", str(value))[:limit]


def check(row, name, passed, detail=None, required=True):
    row["assertions"].append({"name": name, "pass": bool(passed),
                              "required": required, "detail": detail})
    if not passed:
        print(f"{'FAIL' if required else 'NOTE'} {row.get('name', 'suite')}: {name}: {brief(detail)}", flush=True)
    return bool(passed)


def record(row, key, value):
    if len(row[key]) < MAX_EVENTS:
        row[key].append(value)
    else:
        row["droppedEvents"] += 1


async def wait_check(page, row, name, expression, arg=None, required=True):
    try:
        await page.wait_for_function(expression, arg=arg, timeout=STEP_MS, polling=100)
        return check(row, name, True, required=required)
    except Exception as exc:
        return check(row, name, False, brief(exc), required)


async def screenshot(page, row, out, label):
    target = out / f"{row['name']}-{label}.png"
    try:
        await page.screenshot(path=str(target), timeout=3000, full_page=False)
        row["screenshots"].append(target.name)
    except Exception as exc:
        check(row, f"screenshot-{label}", False, brief(exc))


async def scenario(browser, url, script, out, theme, reject, report):
    name = ("dark" if theme == "vs-dark" else "light") + ("-rejection" if reject else "")
    row = {"name": name, "theme": theme, "rejectInitialCss": reject, "assertions": [],
           "console": [], "pageErrors": [], "requests": [], "responses": [],
           "blockedRoutes": [], "webSockets": [], "workers": [], "screenshots": [],
           "droppedEvents": 0}
    report["cases"].append(row)
    context = None
    page = None
    start = time.monotonic()
    print(f"START {name}", flush=True)
    try:
        async with asyncio.timeout(CASE_SECONDS):
            context = await browser.new_context(viewport={"width": 1100, "height": 760},
                                                offline=True, service_workers="block",
                                                bypass_csp=False, accept_downloads=False,
                                                color_scheme="dark" if theme == "vs-dark" else "light")
            context.set_default_timeout(STEP_MS)
            context.set_default_navigation_timeout(15000)

            async def block_route(route):
                # data/blob are local browser resources. Everything else is blocked.
                if route.request.url.startswith(("data:", "blob:", "about:")):
                    await route.continue_()
                else:
                    record(row, "blockedRoutes", brief(route.request.url))
                    await route.abort("blockedbyclient")

            async def block_socket(socket):
                record(row, "webSockets", brief(socket.url))
                # Never call connect_to_server(): routing holds the connection locally.
                await socket.close(code=1008, reason="QuickCSS QA blocks network")

            await context.route("**/*", block_route)
            if not hasattr(context, "route_web_socket"):
                raise RuntimeError("Installed Playwright lacks route_web_socket; refusing to load input")
            await context.route_web_socket("**/*", block_socket)
            context.on("request", lambda request: record(row, "requests", {
                "url": brief(request.url), "type": request.resource_type})
                if not request.url.startswith(("data:", "blob:", "about:")) else None)
            context.on("response", lambda response: record(row, "responses", {
                "url": brief(response.url), "status": response.status})
                if not response.url.startswith(("data:", "blob:", "about:")) else None)
            context.on("console", lambda message: record(row, "console", {
                "type": message.type, "text": brief(message.text),
                "location": {**message.location, "url": brief(message.location.get("url", ""))}}))
            await context.add_init_script(script=INIT.replace("__CONFIG__", json.dumps({
                "css": INITIAL, "theme": theme, "reject": reject, "rejection": REJECTION})))
            page = await context.new_page()
            page.on("pageerror", lambda error: record(row, "pageErrors", brief(error)))

            def worker_started(worker):
                item = {"url": brief(worker.url), "closed": False}
                record(row, "workers", item)
                worker.on("close", lambda _: item.update(closed=True))

            page.on("worker", worker_started)
            await page.goto(url, wait_until="load")
            before = await page.evaluate(SNAPSHOT)
            check(row, "actual-data-url", before["protocol"] == "data:" and before["origin"] == "null")
            if script is not None:
                row["beforeInjection"] = before
                check(row, "inert-before-trusted-injection", before["scripts"] == 0 and
                      before["editors"] == 0 and before["qa"]["getCss"] == 0 and
                      before["qa"]["getTheme"] == 0 and before["qa"]["saveCount"] == 0 and
                      not before["qa"]["workers"], before)
                check(row, "split-csp-script-src-none", any(re.search(
                    r"(?:^|;)\s*script-src\s+'none'\s*(?:;|$)", csp) for csp in before["csp"]), before["csp"])
                # Intentional trusted native-injection emulation, not a script tag
                # or eval wrapper in the document. CSP remains enabled throughout.
                await page.evaluate(script)

            if reject:
                await wait_check(page, row, "rejection-alert-visible", """() => {
                    const e=document.querySelector('#status'); if(!e) return false;
                    const r=e.getBoundingClientRect();
                    return e.getAttribute('role')==='alert' && !!e.textContent.trim() &&
                      getComputedStyle(e).visibility!=='hidden' && r.width>0 && r.height>0 &&
                      r.top>=0 && r.left>=0 && r.bottom<=innerHeight && r.right<=innerWidth;
                }""")
                # Short bounded observation catches accidentally continued initialization.
                await page.wait_for_timeout(300)
                snap = await page.evaluate(SNAPSHOT)
                row["rejectionState"] = snap
                check(row, "rejection-no-editor", snap["editors"] == 0, snap["editors"])
                check(row, "rejection-read-attempted", snap["qa"]["getCss"] > 0)
                check(row, "rejection-no-save", snap["qa"]["saveCount"] == 0)
                await screenshot(page, row, out, "status")
            else:
                editor = page.get_by_role("textbox", name=re.compile(r"^QuickCSS\b"))
                # Monaco 0.57 uses a zero-size native EditContext input. The
                # rendered editor must be visible; its keyboard target need
                # only be attached and focusable.
                await page.locator("#container .monaco-editor").wait_for(state="visible")
                await editor.wait_for(state="attached")
                snap = await page.evaluate(SNAPSHOT)
                row["ready"] = snap
                check(row, "one-editor", snap["editors"] == 1 and await editor.count() == 1)
                check(row, "mock-bridge-initialized", snap["qa"]["getCss"] > 0 and snap["qa"]["getTheme"] > 0)
                compact = lambda value: re.sub(r"[\s\u200b]+", "", value)
                check(row, "initial-css-rendered", compact(snap["lines"]) == compact(INITIAL), snap["lines"])
                expected_class = "vs-dark" if theme == "vs-dark" else "vs"
                check(row, "editor-theme", expected_class in snap["editorClass"].split(),
                      {"class": snap["editorClass"], "background": snap["background"]})
                check(row, "no-load-error-status", snap["status"] is not None and
                      (not snap["status"]["visible"] or not snap["status"]["text"]), snap["status"])
                await screenshot(page, row, out, "ready")
                modifier = "Meta" if sys.platform == "darwin" else "Control"
                await page.locator("#container .view-lines").click(position={"x": 60, "y": 10})
                await page.keyboard.press("Meta+ArrowDown" if modifier == "Meta" else "Control+End")
                await page.keyboard.press("ArrowLeft")
                await page.keyboard.press("ArrowLeft")
                await page.keyboard.type("x", delay=20)
                edited = INITIAL[:-2] + "x" + INITIAL[-2:]
                await wait_check(page, row, "keyboard-edit-autosaved", "css => __quickcssQa.lastCss === css", edited)
                await page.keyboard.press(f"{modifier}+z")
                await wait_check(page, row, "keyboard-undo-autosaved", "css => __quickcssQa.lastCss === css", INITIAL)
                await page.set_viewport_size({"width": 640, "height": 480})
                await wait_check(page, row, "resize-layout", """() => {
                    const c=document.querySelector('#container')?.getBoundingClientRect();
                    const e=document.querySelector('#container .monaco-editor')?.getBoundingClientRect();
                    return c && e && e.width>100 && e.height>100 && e.width<700 &&
                      Math.abs(c.width-e.width)<4 && Math.abs(c.height-e.height)<4 &&
                      e.right<=innerWidth+2 && e.bottom<=innerHeight+2;
                }""")
                await editor.blur()
                check(row, "editor-blurs", await editor.evaluate("e => document.activeElement !== e"))
                await editor.focus()
                check(row, "editor-refocuses", await editor.evaluate("e => document.activeElement === e"))
                await screenshot(page, row, out, "resized")

                async def replace_text(text):
                    await editor.focus()
                    await page.keyboard.press(f"{modifier}+a")
                    # Native text input avoids auto-closing braces in test fixtures.
                    await page.keyboard.insert_text(text)

                await replace_text(".qa-diagnostic { qa-invalid-property: 1; }")
                await wait_check(page, row, "diagnostic-fixture-autosaved",
                                 "css => __quickcssQa.lastCss === css",
                                 ".qa-diagnostic { qa-invalid-property: 1; }")
                diagnostic = await wait_check(page, row, "css-diagnostic", """() =>
                    !!document.querySelector('.monaco-editor .squiggly-warning, .monaco-editor .squiggly-error')""")
                row["diagnosticDecorations"] = await page.evaluate("""() =>
                    [...document.querySelectorAll('.monaco-editor [class*=squiggly]')]
                    .slice(0,30).map(e=>({class:e.className, text:e.textContent.slice(0,300)}))""")
                await screenshot(page, row, out, "diagnostic")
                await replace_text(".qa-diagnostic { color: red; }")
                await wait_check(page, row, "css-diagnostic-clears", """() =>
                    !document.querySelector('.monaco-editor .squiggly-warning, .monaco-editor .squiggly-error')""")
                await replace_text(".qa-complete { col")
                await page.keyboard.press("Control+Space")
                completion = await wait_check(page, row, "css-color-completion", """() =>
                    [...document.querySelectorAll('.suggest-widget .label-name')].some(e =>
                      e.textContent.trim()==='color' && e.getBoundingClientRect().height>0)""")
                if completion:
                    await screenshot(page, row, out, "completion")
                await page.keyboard.press("Escape")
                await replace_text(INITIAL)
                await wait_check(page, row, "restored-css-autosaved", "css => __quickcssQa.lastCss === css", INITIAL)
                snap = await page.evaluate(SNAPSHOT)
                workers = snap["qa"]["workers"]
                check(row, "native-blob-worker-started", bool(row["workers"]) and bool(workers) and
                      all(worker["url"].startswith("blob:") for worker in workers), workers)
                check(row, "css-worker-functional", any(worker["received"] > 0 for worker in workers)
                      and (diagnostic or completion), workers)
                row["beforePagehide"] = snap
                await page.evaluate("() => dispatchEvent(new PageTransitionEvent('pagehide', {persisted:false}))")
                await wait_check(page, row, "synthetic-pagehide-terminates-workers", """() =>
                    __quickcssQa.workers.length>0 && __quickcssQa.workers.every(w=>w.terminateCalls>0)""",
                    required=False)
    except Exception as exc:
        check(row, "scenario-completed", False, brief(exc))
        if page is not None and not page.is_closed():
            await screenshot(page, row, out, "failure")
    finally:
        if page is not None and not page.is_closed():
            try:
                row["final"] = await asyncio.wait_for(page.evaluate(SNAPSHOT), 3)
            except Exception as exc:
                check(row, "final-observation", False, brief(exc))
        if context is not None:
            try:
                await asyncio.wait_for(context.close(), 3)
            except Exception as exc:
                check(row, "context-cleanup", False, brief(exc))
        state = row.get("final", {}).get("qa", {})
        check(row, "zero-network-attempts", not any(row[key] for key in
              ("requests", "blockedRoutes", "webSockets")), {key: row[key] for key in
              ("requests", "blockedRoutes", "webSockets")})
        check(row, "zero-external-responses", not row["responses"], row["responses"])
        check(row, "zero-page-errors", not row["pageErrors"], row["pageErrors"])
        errors = [event for event in row["console"] if event["type"] == "error" and
                  not (reject and REJECTION in event["text"])]
        check(row, "zero-unexpected-console-errors", not errors, errors)
        fallback = [event for event in row["console"] if re.search(
            r"could not create.*worker|falling back.*main thread", event["text"], re.I)]
        check(row, "no-worker-fallback", not fallback, fallback)
        check(row, "zero-worker-errors", not state.get("workerErrors"), state.get("workerErrors"))
        check(row, "zero-csp-violations", not state.get("csp"), state.get("csp"))
        check(row, "complete-event-capture", not row["droppedEvents"] and not state.get("overflow", 0))
        row["workerCount"] = len(row["workers"])
        row["elapsedSeconds"] = round(time.monotonic() - start, 3)
        row["status"] = "failed" if any(not a["pass"] and a["required"] for a in row["assertions"]) else "passed"
        print(f"{row['status'].upper()} {name}: {row['workerCount']} workers, {row['elapsedSeconds']}s", flush=True)


async def run(report, url, script, out):
    playwright = browser = None
    try:
        from playwright.async_api import async_playwright
        report["playwrightVersion"] = importlib.metadata.version("playwright")
        async with asyncio.timeout(TOTAL_SECONDS):
            playwright = await async_playwright().start()
            browser = await playwright.chromium.launch(headless=True, timeout=15000, args=[
                "--disable-background-networking", "--disable-component-update", "--disable-sync",
                "--disable-domain-reliability", "--no-pings", "--no-first-run",
                "--host-resolver-rules=MAP * ~NOTFOUND"])
            report["browserVersion"] = browser.version
            for reject in (False, True):
                for theme in ("vs-dark", "vs-light"):
                    await scenario(browser, url, script, out, theme, reject, report)
    except Exception as exc:
        check(report, "suite-completed", False, brief(exc))
    finally:
        for label, owner, method in (("browser", browser, "close"), ("playwright", playwright, "stop")):
            if owner is not None:
                try:
                    await asyncio.wait_for(getattr(owner, method)(), 5)
                except Exception as exc:
                    check(report, f"{label}-cleanup", False, brief(exc))
    check(report, "all-four-cases-executed", len(report["cases"]) == 4, len(report["cases"]))


def input_file(parser, path, label):
    if not path.is_absolute():
        parser.error(f"{label} must be an absolute local file path")
    try:
        path = path.resolve(strict=True)
        if not path.is_file() or path.stat().st_size > 32 * 1024 * 1024:
            parser.error(f"{label} must be a regular file of at most 32 MiB")
        data = path.read_bytes()
        if not data:
            parser.error(f"{label} is empty")
        return data, {"path": str(path), "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    except OSError as exc:
        parser.error(f"{label}: {exc}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--html", required=True, type=Path, help="Absolute packaged HTML file")
    parser.add_argument("--script", type=Path, help="Absolute packaged JS file for trusted injection after load")
    parser.add_argument("--out", required=True, type=Path, help="NEW report directory below scripts/qa/runs")
    args = parser.parse_args()
    html, provenance = input_file(parser, args.html, "--html")
    script = script_provenance = None
    if args.script is not None:
        payload, script_provenance = input_file(parser, args.script, "--script")
        try:
            script = payload.decode("utf-8-sig")
        except UnicodeDecodeError as exc:
            parser.error(f"--script must be UTF-8: {exc}")
    out = args.out.resolve()
    root = RUNS.resolve()
    if out == root or not out.is_relative_to(root):
        parser.error(f"--out must be a NEW child directory of {root}")
    try:
        out.mkdir(parents=True, exist_ok=False)
    except OSError as exc:
        parser.error(f"Refusing to reuse/overwrite --out: {exc}")
    url = "data:text/html;base64," + base64.b64encode(html).decode("ascii")
    report = {"schemaVersion": 1, "name": "QuickCSS", "status": "running",
              "startedAt": datetime.now(timezone.utc).isoformat(), "html": provenance,
              "script": script_provenance, "dataUrlBytes": len(url),
              "qaSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              "mode": "mock-preload-trusted-injection" if script is not None else "mock-preload-inline",
              "scope": "Chromium with in-memory mock bridge; no real Electron, Discord, IPC or persisted settings",
              "limits": {"suiteSeconds": TOTAL_SECONDS, "caseSeconds": CASE_SECONDS,
                         "stepMilliseconds": STEP_MS, "cleanupSecondsPerContext": 3,
                         "cleanupSecondsPerProcess": 5, "eventsPerCategory": MAX_EVENTS},
              "lifecycleScope": "Synthetic pagehide observation; no two-minute idle recycle or Electron lifecycle test",
              "assertions": [], "cases": []}
    start = time.monotonic()
    try:
        check(report, "electron-data-url-under-2MiB", len(url) < 2 * 1024 * 1024,
              len(url), required=script is not None)
        asyncio.run(run(report, url, script, out))
    except KeyboardInterrupt:
        check(report, "not-interrupted", False, "Interrupted by user")
    except Exception as exc:
        check(report, "runner-completed", False, brief(exc))
    finally:
        assertions = report["assertions"] + [a for row in report["cases"] for a in row["assertions"]]
        failed = [a for a in assertions if a["required"] and not a["pass"]]
        report["status"] = "failed" if failed else "passed"
        report["summary"] = {"assertions": len(assertions), "failed": len(failed),
                             "observationsFailed": sum(not a["pass"] and not a["required"] for a in assertions),
                             "workers": sum(row.get("workerCount", 0) for row in report["cases"])}
        report["elapsedSeconds"] = round(time.monotonic() - start, 3)
        report["finishedAt"] = datetime.now(timezone.utc).isoformat()
        with (out / "report.json").open("x", encoding="utf-8") as stream:
            json.dump(report, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
    print(f"{report['status'].upper()}: {report['summary']}; report: {out / 'report.json'}", flush=True)
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
