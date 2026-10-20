"""A22 offline diagnostics UI acceptance using the existing Q17 source harness.

Run: python -u scripts/qa/a22-ui-regression.py [NEW_RUN_DIRECTORY]
Only creates a fresh scripts/qa/runs/a22-ui/* evidence directory. Product and
existing QA scripts are unchanged. Generated diagnostics stub instrumentation
exposes the real in-memory journal and allows a long fixture path; disk/download
remain mocks. No release build, installed client or network service is used.
"""
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
ALLOWED = ROOT / "scripts/qa/runs/a22-ui"
RUN = (Path(sys.argv[1]) if len(sys.argv) > 1 else
       ALLOWED / datetime.now().strftime("%Y%m%d-%H%M%S")).resolve()
if not RUN.is_relative_to(ALLOWED) or RUN == ALLOWED or RUN.exists():
    raise RuntimeError("Use a fresh directory under scripts/qa/runs/a22-ui")


def digest(path):
    return sha256(path.read_bytes()).hexdigest()


source_files = list((ROOT / "src/vencord/ui").glob("*.tsx"))
source_files += list((ROOT / "src/vencord/ui").glob("*.css"))
source_files += [ROOT / name for name in [
    "src/core/diagnosticJournal.ts", "src/core/diagnosticPersistence.ts",
    "src/vencord/ui/diagnostics.ts", "src/vencord/styles.css",
    "src/vencord/diagnosticFileNative.ts", "betterdiscord/adapter.css",
    "scripts/qa/q17-ui-harness.mjs", "scripts/qa/a22-ui-regression.py"]]
hashes = {p.relative_to(ROOT).as_posix(): digest(p) for p in source_files}
subprocess.run(["node", "scripts/qa/q17-ui-harness.mjs", str(RUN)], cwd=ROOT, check=True)
bundle = RUN / "app.js"
code = bundle.read_text(encoding="utf-8")
original_hash = digest(bundle)
start = code.index("// stub:diagnostics")
end = code.index("\n  // ", start + len("// stub:diagnostics"))
stub = code[start:end]
anchor = "var setRecording ="
if stub.count(anchor) != 1:
    raise RuntimeError("Q17 diagnostics stub changed; refusing instrumentation")
stub = stub.replace(anchor, "window.a22Journal = diagnosticJournal;\n  " + anchor)
stub, replacements = re.subn(
    r'path: ("C:/Users/Tester/[^"]+SupportTemplates-diagnostics\.txt")',
    r'path: window.a22DiagnosticPath || \1', stub)
if replacements != 1:
    raise RuntimeError("Q17 diagnostics path stub changed; refusing instrumentation")
bundle.write_text(code[:start] + stub + code[end:], encoding="utf-8")
(RUN / "a22-instrumentation.json").write_text(json.dumps({
    "scope": "Only generated stub:diagnostics: journal exposure and optional path override",
    "originalBundleSha256": original_hash, "instrumentedBundleSha256": digest(bundle),
    "sourceHashes": hashes
}, indent=2), encoding="utf-8")

checks, errors, console_errors, blocked, screenshots = [], [], [], [], []
current = ""


def settle(page):
    page.evaluate("() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")


def shot(page, name):
    filename = re.sub(r"[^a-zA-Z0-9_-]", "-", name) + ".png"
    page.screenshot(path=str(RUN / filename))
    screenshots.append(filename)
    return filename


def check(page, name, passed, detail=None):
    row = {"name": current + " / " + name, "pass": bool(passed), "detail": detail}
    if not passed:
        row["screenshot"] = shot(page, "failure-" + str(len(checks) + 1))
    checks.append(row)
    print(("PASS " if passed else "FAIL ") + row["name"], flush=True)
    if not passed:
        print(str(detail), flush=True)


def measure(locator):
    return locator.evaluate("""e => {const b=e.getBoundingClientRect();return {
      x:b.x,y:b.y,right:b.right,bottom:b.bottom,width:b.width,height:b.height,
      clientWidth:e.clientWidth,scrollWidth:e.scrollWidth,
      lineHeight:parseFloat(getComputedStyle(e).lineHeight),
      overflowWrap:getComputedStyle(e).overflowWrap};}""")


def fits(box, width, height):
    return box["x"] >= -1 and box["right"] <= width + 1 and box["y"] >= -1 and box["bottom"] <= height + 1


def fresh(page, dist, width=1200, height=1000):
    page.set_viewport_size({"width": width, "height": height})
    page.goto((RUN / "index.html").as_uri() + "?distribution=" + dist, wait_until="networkidle")
    page.get_by_role("button", name="Настройки", exact=True).click()
    settle(page)
    return page.get_by_role("region", name="Диагностика", exact=True)


def refresh(page):
    # The production control polls storage status every 2s. Remounting via tabs
    # also reads it without modifying the component or waiting an arbitrary delay.
    page.get_by_role("button", name="Тикеты", exact=True).click()
    page.get_by_role("button", name="Настройки", exact=True).click()
    settle(page)


def snapshot(page):
    return page.evaluate("a22Journal.snapshot()")


def functional(page, dist):
    section = fresh(page, dist)
    toggle = section.get_by_role("checkbox", name="Записывать диагностику", exact=True)
    deadline = section.locator("p").filter(has_text="Автоматическое отключение")
    initial = snapshot(page)
    deadline_text = deadline.inner_text()
    check(page, "diagnostics is last section after Quick Input", page.evaluate("""() => {
      const e=document.querySelector('.vc-stx-diagnostics');
      return e.parentElement.lastElementChild===e &&
        !!e.previousElementSibling.querySelector('#stx-input-settings');}"""))
    check(page, "default checkbox checked and recording status explicit",
          toggle.is_checked() and "Запись идёт" in section.inner_text())
    check(page, "four-day notice and fixed 96-hour deadline",
          "включена автоматически на четыре дня с первого запуска" in section.inner_text()
          # The first event can occur just after the campaign deadline is set.
          and 4 * 86400000 - 1000 <= initial["campaignUntil"] - initial["events"][0]["time"] <= 4 * 86400000
          and "Перезапуск Discord не продлевает срок" in deadline_text,
          {"text": deadline_text, "remainingFromFirstEventMs": initial["campaignUntil"] - initial["events"][0]["time"]})
    check(page, "actual fixture path and automatic-save status visible",
          section.locator("code").inner_text().endswith("SupportTemplates-diagnostics.txt")
          and "Файл сохраняется автоматически" in section.inner_text())
    check(page, "privacy and no-auto-upload notices",
          "Тексты сообщений, шаблонов, полей, токены" in section.inner_text()
          and "никуда не отправляется автоматически" in section.inner_text())
    section.locator("h3").scroll_into_view_if_needed()
    shot(page, dist + "-default")
    toggle.uncheck()
    off = snapshot(page)
    check(page, "off stops recording without changing deadline",
          not toggle.is_checked() and off["until"] == 0
          and off["campaignUntil"] == initial["campaignUntil"]
          and "Запись выключена" in section.inner_text())
    page.evaluate("a22Journal.record('ui.state',{count:7},true)")
    check(page, "off rejects new journal events", len(snapshot(page)["events"]) == len(off["events"]))
    refresh(page)
    check(page, "off survives settings remount", not toggle.is_checked())
    page.clock.fast_forward(3600000)
    toggle.check()
    check(page, "re-enable one hour later does not extend deadline",
          toggle.is_checked() and snapshot(page)["until"] == initial["campaignUntil"]
          and deadline.inner_text() == deadline_text, snapshot(page)["campaignUntil"])
    page.evaluate("window.failDiagnosticFile=true")
    refresh(page)
    check(page, "file error is explicit and retry available",
          "Не удалось сохранить диагностику в файл" in section.get_by_role("alert").inner_text()
          and section.get_by_role("button", name="Повторить сохранение").is_enabled())
    section.get_by_role("button", name="Повторить сохранение").scroll_into_view_if_needed()
    shot(page, dist + "-file-error")
    section.get_by_role("button", name="Повторить сохранение").click()
    check(page, "retry clears stub file error and restores save status",
          page.evaluate("window.failDiagnosticFile") is False
          and section.get_by_role("alert").count() == 0
          and "Файл сохраняется автоматически" in section.inner_text())
    before_clear = snapshot(page)
    section.get_by_role("button", name="Очистить журнал", exact=True).click()
    check(page, "clear opens confirmation without clearing",
          "Удалить сохранённые события?" in section.inner_text()
          and snapshot(page)["events"] == before_clear["events"])
    section.get_by_role("button", name="Отмена", exact=True).click()
    check(page, "cancel preserves events", snapshot(page)["events"] == before_clear["events"]
          and "Удалить сохранённые события?" not in section.inner_text())
    section.get_by_role("button", name="Очистить журнал", exact=True).click()
    section.get_by_role("button", name="Удалить журнал", exact=True).scroll_into_view_if_needed()
    shot(page, dist + "-clear-confirmation")
    section.get_by_role("button", name="Удалить журнал", exact=True).click()
    cleared = snapshot(page)
    check(page, "confirm clears only events, preserving active state and deadline",
          cleared["events"] == [] and toggle.is_checked()
          and cleared["campaignUntil"] == initial["campaignUntil"])
    section.get_by_role("button", name="Скачать диагностику").click()
    check(page, "manual download invokes stub and shows confirmation",
          page.evaluate("window.previewDownloads") == 1
          and "Файл передан в загрузки" in section.get_by_role("status").inner_text())
    page.evaluate("window.failDownload=true")
    section.get_by_role("button", name="Скачать диагностику").click()
    check(page, "manual download failure visible and retryable",
          "Не удалось скачать файл" in section.get_by_role("status").inner_text()
          and section.get_by_role("button", name="Скачать диагностику").is_enabled())
    page.evaluate("window.failDownload=false")
    section.get_by_role("button", name="Скачать диагностику").click()
    check(page, "manual download recovers", page.evaluate("window.previewDownloads") == 2)
    page.evaluate("a22Journal.record('ui.state',{count:77},true)")
    retained = snapshot(page)["events"]
    page.clock.fast_forward(4 * 86400000)
    refresh(page)
    check(page, "expired campaign unchecks and disables checkbox",
          toggle.is_disabled() and not toggle.is_checked()
          and "Тестовый период завершён" in section.inner_text()
          and "Запись завершена:" in section.inner_text())
    check(page, "expiry keeps recorded campaign history", snapshot(page)["events"] == retained)
    page.clock.fast_forward(2 * 86400000)
    refresh(page)
    check(page, "history remains available two days later", snapshot(page)["events"] == retained)
    section.get_by_role("button", name="Скачать диагностику").click()
    check(page, "manual download remains available after expiry", page.evaluate("window.previewDownloads") == 3)
    section.locator("h3").scroll_into_view_if_needed()
    shot(page, dist + "-expired")


def narrow(page, dist, width, height):
    section = fresh(page, dist, width, height)
    prefix = ("C:/Users/Tester/AppData/Roaming/BetterDiscord/SupportTemplates/"
              if dist == "betterdiscord" else
              "C:/Users/Tester/AppData/Local/" + ("SupportTemplates/channels/canary/data/diagnostics/" if dist == "standalone" else "Vencord/diagnostics/"))
    long_path = prefix + "a" * 128 + "/SupportTemplates-diagnostics.txt"
    page.evaluate("(path)=>window.a22DiagnosticPath=path", long_path)
    refresh(page)
    code = section.locator("code")
    code.scroll_into_view_if_needed()
    settle(page)
    box = measure(code)
    dialog = measure(page.locator(".vc-stx-management"))
    check(page, "long path displayed intact from storage stub", code.inner_text() == long_path)
    check(page, "long path wraps without horizontal overflow",
          box["overflowWrap"] == "anywhere" and box["height"] > box["lineHeight"] * 2
          and box["scrollWidth"] <= box["clientWidth"] + 1 and box["right"] <= width,
          box)
    check(page, "dialog and scrolled path fit viewport",
          fits(dialog, width, height) and fits(box, width, height), {"dialog": dialog, "path": box})
    check(page, "diagnostics container has no horizontal overflow",
          section.evaluate("e=>e.scrollWidth<=e.clientWidth+1"))
    shot(page, f"{dist}-path-{width}x{height}")
    button = section.get_by_role("button", name="Очистить журнал", exact=True)
    button.scroll_into_view_if_needed()
    button.click()
    confirm = section.get_by_role("button", name="Удалить журнал", exact=True)
    confirm.scroll_into_view_if_needed()
    check(page, "clear confirmation reachable at narrow width", fits(measure(confirm), width, height))
    shot(page, f"{dist}-actions-{width}x{height}")
    section.get_by_role("button", name="Отмена", exact=True).click()
    section.get_by_role("button", name="Скачать диагностику").click()
    check(page, "narrow manual download clickable", page.evaluate("window.previewDownloads") == 1)
    page.evaluate("window.failDiagnosticFile=true")
    refresh(page)
    retry = section.get_by_role("button", name="Повторить сохранение")
    retry.scroll_into_view_if_needed()
    check(page, "narrow retry fits and is reachable", fits(measure(retry), width, height))
    shot(page, f"{dist}-retry-{width}x{height}")
    retry.click()
    check(page, "narrow retry clears error", section.get_by_role("alert").count() == 0)


def deny(route):
    if route.request.url.startswith(("file:", "data:", "blob:")):
        route.continue_()
    else:
        blocked.append({"url": route.request.url, "type": route.request.resource_type})
        route.abort()


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, timeout=60000)
    context = browser.new_context(offline=True, service_workers="block")
    context.route("**/*", deny)

    def deny_socket(route):
        blocked.append({"url": route.url, "type": "websocket"})
        route.close()

    context.route_web_socket("**/*", deny_socket)
    page = context.new_page()
    page.clock.install()
    page.set_default_timeout(5000)
    page.on("pageerror", lambda e: errors.append({"scenario": current, "error": str(e)}))
    page.on("console", lambda m: console_errors.append({"scenario": current, "text": m.text}) if m.type == "error" else None)
    for dist in ["standalone", "betterdiscord", "vencord"]:
        cases = [("functional", lambda: functional(page, dist))]
        for width, height in [(320, 480), (427, 320)]:
            cases.append((f"layout {width}x{height}", lambda w=width, h=height: narrow(page, dist, w, h)))
        for name, run in cases:
            current = dist + " " + name
            try:
                run()
            except Exception as exc:
                check(page, "scenario completed", False, str(exc))
    current = "environment"
    check(page, "no uncaught browser errors", not errors, errors)
    check(page, "no browser console errors", not console_errors, console_errors)
    check(page, "no network attempts", not blocked, blocked)
    changed = [name for name, value in hashes.items() if digest(ROOT / name) != value]
    check(page, "source unchanged during run", not changed, changed)
    result = {
        "createdAt": datetime.now(timezone.utc).isoformat(), "browser": browser.version,
        "passed": sum(c["pass"] for c in checks), "failed": sum(not c["pass"] for c in checks),
        "checks": checks, "errors": errors, "consoleErrors": console_errors, "blocked": blocked,
        "screenshots": screenshots, "sourceHashes": hashes,
        "limits": [
            "Q17 source fixture; no real Discord, native file persistence or packaged release.",
            "Real DiagnosticJournal in memory; file errors, retry and download use existing Q17 stubs.",
            "Three distribution query values share the same source bundle.",
            "Long profile paths are injected fixture values, not verified native output paths.",
            "Settings remount checked; cross-process/reload persistence belongs to journal/native tests.",
            "No network: offline browser context; HTTP/WebSocket routes blocked; service workers blocked.",
            "Deadline behavior uses Playwright's clock installed before startup, not a four-day live run."
        ]
    }
    (RUN / "a22-results.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    report = [f"# A22 diagnostics source UI acceptance\n\n{result['passed']} passed; {result['failed']} failed.\n",
              "## Failures\n"]
    report += [f"- {c['name']}: {c['detail']} ([image]({c['screenshot']}))" for c in checks if not c["pass"]]
    report += ["\n## Scope and limits\n"] + ["- " + value for value in result["limits"]]
    report += ["\n## Screenshots\n"] + [f"- [{name}]({name})" for name in screenshots]
    (RUN / "a22-report.md").write_text("\n".join(report), encoding="utf-8")
    browser.close()
print(f"{result['passed']} passed; {result['failed']} failed. Evidence: {RUN}", flush=True)
sys.exit(1 if result["failed"] else 0)
