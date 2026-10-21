"""Focused A28 offline source UI checks; existing Python Playwright only.

Use a NEW scripts/qa/runs/a28-ui child. --prepare bundles only; --final requires
--freeze-notice. No product edits, releases, real network, sends or native UI.
"""
import argparse
import ast
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
ALLOWED = (ROOT / "scripts/qa/runs/a28-ui").resolve()
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("directory", nargs="?")
parser.add_argument("--prepare", action="store_true")
parser.add_argument("--final", action="store_true")
parser.add_argument("--freeze-notice")
args = parser.parse_args()
if args.final and (args.prepare or not args.freeze_notice):
    parser.error("--final requires --freeze-notice and cannot use --prepare")
RUN = (Path(args.directory) if args.directory else ALLOWED / datetime.now().strftime("%Y%m%d-%H%M%S")).resolve()
if RUN.exists() or RUN == ALLOWED or not RUN.is_relative_to(ALLOWED):
    raise RuntimeError("Use a NEW child directory of scripts/qa/runs/a28-ui")

checks, errors, blocked, screenshots = [], [], [], []
scenario_name = ""
for filename, names in {
    "a23-ui-regression.py": {"settle", "screenshot", "check", "rect", "fits", "picker", "settings",
                           "storage", "fresh", "pointer_drag", "same", "titles"},
    "a25-ui-regression.py": {"horizontal_fit", "scroll_settings_target", "controls_clear"},
}.items():
    tree = ast.parse((ROOT / "scripts/qa" / filename).read_text(encoding="utf-8"))
    nodes = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names]
    assert {n.name for n in nodes} == names
    exec(compile(ast.Module(body=nodes, type_ignores=[]), filename + " pure helpers", "exec"))
    if filename.startswith("a23"):
        FAKE_AUDIO = next(ast.literal_eval(n.value) for n in tree.body
                          if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "FAKE_AUDIO" for t in n.targets))

POSITION_KEY = "SupportTemplates_windowPlacement_v1"
SIZE_KEY = "SupportTemplates_windowSize_v1"
# Exact injected boundary value, not a claim about the user's real native path.
LOG_PATH = ("C:\\Users\\Тестировщик\\AppData\\Local\\Packages\\"
            "OpenAI.Codex_abcdefghijklmnopqrstuvwxyz\\LocalCache\\Local\\SupportTemplates\\"
            "channels\\canary\\data\\diagnostics\\discord-profile-with-a-long-identifier\\main.log")
SEED = """
if(!localStorage.getItem('A28_seeded')){
 localStorage.setItem('SupportTemplates_windowPlacement_v1',JSON.stringify({right:80,bottom:80,pinned:true}));
 localStorage.setItem('SupportTemplates_windowSize_v1',JSON.stringify({width:400,height:360,previewWidth:460}));
 localStorage.setItem('A24_fixture_preferences',JSON.stringify({showPersonalInAll:true}));
 localStorage.setItem('A28_seeded','true');
}
window.a25DiagnosticStatus={path:PATH_VALUE,initializing:false,fileError:false,localError:false,deliveryLost:5};
""".replace("PATH_VALUE", json.dumps(LOG_PATH, ensure_ascii=False))


def source_hashes():
    files = list((ROOT / "src/vencord/ui").glob("*")) + list((ROOT / "src/core").glob("*.ts"))
    files += list((ROOT / "src/vencord/styles").glob("*.css"))
    files += [ROOT / p for p in ["src/vencord/styles.css", "betterdiscord/adapter.css",
                                "betterdiscord/ServiceSettings.tsx", "scripts/qa/q17-ui-harness.mjs",
                                "scripts/qa/a23-ui-regression.py", "scripts/qa/a25-ui-regression.py",
                                "scripts/qa/a28-ui-regression.py"]]
    return {p.relative_to(ROOT).as_posix(): sha256(p.read_bytes()).hexdigest()
            for p in sorted(set(files)) if p.is_file()}


before = source_hashes()
subprocess.run(["node", "scripts/qa/q17-ui-harness.mjs", str(RUN), "--a27"], cwd=ROOT, check=True)
contract = {"phase": "prepared" if args.prepare else "final" if args.final else "exploratory",
            "freezeNotice": args.freeze_notice, "viewports": [[900, 720], [427, 640], [320, 568]],
            "real": ["WindowPlacement", "windowPlacement core", "Window", "Settings", "Store", "DiagnosticControls"],
            "mocked": ["native diagnostic status/path/folder", "panel/Discord", "AudioContext", "insertion"],
            "legacyPosition": {"right": 80, "bottom": 80, "pinned": True}, "legacyPersonalInAll": True,
            "diagnosticPath": LOG_PATH, "sourceHashes": before}
(RUN / "a28-contract.json").write_text(json.dumps(contract, ensure_ascii=False, indent=2), encoding="utf-8")
if args.prepare:
    print("A28 prepared; no final browser acceptance.")
    sys.exit(0)


def placement(page, width, height):
    check(page, "fixture begins with persisted legacy pin", storage(page, POSITION_KEY)["pinned"] is True)
    picker(page)
    win = page.locator(".vc-stx-win")
    grip = page.get_by_role("button", name="Переместить окно", exact=True)
    reset = page.get_by_role("button", name="Сбросить положение и размер окна", exact=True)
    check(page, "toolbar has only accessible drag/reset and no pin",
          page.locator(".vc-stx-placement button").count() == 2
          and page.get_by_role("button", name=re.compile("Закрепить|Открепить")).count() == 0
          and grip.is_enabled() and reset.is_enabled())
    check(page, "legacy pin restores coordinates within viewport and leaves all 8 handles",
          abs(rect(win)["bottom"] - (height - 80)) <= 1
          and fits(rect(win), width, height) and page.locator(".vc-stx-frame-resize").count() == 8, rect(win))
    prior = rect(win)
    pointer_drag(page, grip, -12, 20)
    page.wait_for_function("JSON.parse(localStorage.getItem('SupportTemplates_windowPlacement_v1'))?.pinned===false")
    check(page, "legacy pinned window moves with actual pointer and persists unlocked",
          not same(prior, rect(win)) and storage(page, POSITION_KEY)["pinned"] is False)
    for edge, dx, dy in [("n", 0, -10), ("s", 0, 10), ("w", -10, 0), ("e", 10, 0),
                         ("nw", -10, -10), ("ne", 10, -10), ("sw", -10, 10), ("se", 10, 10)]:
        prior = rect(win)
        pointer_drag(page, page.locator(".edge-" + edge), dx, dy)
        after = rect(win)
        horizontal = abs(after["width"] - prior["width"]) >= 8 if dx and width == 900 else True
        vertical = abs(after["height"] - prior["height"]) >= 8 if dy else abs(after["height"] - prior["height"]) <= 1
        check(page, "actual pointer resize " + edge + " remains usable within viewport",
              horizontal and vertical and fits(after, width, height) and after["y"] >= 31,
              {"before": prior, "after": after, "horizontalMayClamp": width < 900})
    saved = rect(win)
    fresh(page)
    picker(page)
    check(page, "moved/resized unlocked geometry persists on reload", same(saved, rect(win)) and grip.is_enabled())
    grip.hover()
    screenshot(page, f"placement-no-pin-{width}x{height}")
    reset.click()
    page.wait_for_function("localStorage.getItem('SupportTemplates_windowPlacement_v1')==='null'")
    check(page, "reset clears position and restores default size", storage(page, SIZE_KEY) ==
          {"width": 360, "height": 500, "previewWidth": 460})
    fresh(page)
    picker(page)
    check(page, "reset remains unlocked after reload", storage(page, POSITION_KEY) is None
          and grip.is_enabled() and page.locator(".vc-stx-frame-resize").count() == 8)


def settings_and_logs(page, width, height):
    settings(page)
    label = "Показывать мои шаблоны во вкладке «Все»"
    switch = page.get_by_role("checkbox", name=label, exact=True)
    check(page, "renamed personal-All switch retains legacy enabled preference",
          switch.count() == 1 and switch.is_checked() and page.evaluate("previewStore.data.showPersonalInAll"))
    line = switch.locator("xpath=../..")
    check(page, "personal-All label explicitly describes the All tab",
          label in line.inner_text()
          and "Выключено — личные шаблоны остаются во вкладке «Мои»." in line.inner_text()
          and horizontal_fit(line), line.inner_text())
    scroll_settings_target(line)
    screenshot(page, f"personal-all-label-{width}x{height}")
    switch.uncheck()
    page.evaluate("()=>previewStore.flush()")
    fresh(page)
    settings(page)
    check(page, "switch off persists after reload", not switch.is_checked()
          and storage(page, "A24_fixture_preferences")["showPersonalInAll"] is False)
    switch.check()
    page.evaluate("()=>previewStore.flush()")
    fresh(page)
    settings(page)
    check(page, "switch on persists after reload", switch.is_checked()
          and storage(page, "A24_fixture_preferences")["showPersonalInAll"] is True)
    logs = page.get_by_role("region", name="Диагностика", exact=True)
    path = logs.get_by_text(LOG_PATH, exact=True)
    check(page, "diagnostics renders exact status path instead of old prose/history warning",
          path.count() == 1 and "Технические события сохраняются" not in logs.inner_text()
          and "неподтверждённые события" not in logs.inner_text(), logs.inner_text())
    if path.count():
        info = path.evaluate("""e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);
          return {height:r.height,lineHeight:parseFloat(s.lineHeight),width:r.width,scroll:e.scrollWidth,client:e.clientWidth,
            whiteSpace:s.whiteSpace,overflowWrap:s.overflowWrap};}""")
        check(page, "long diagnostic path wraps without clipping or horizontal overflow",
              info["height"] > info["lineHeight"] * 1.5 and info["scroll"] <= info["client"] + 1
              and horizontal_fit(logs), info)
    scroll_settings_target(logs)
    screenshot(page, f"diagnostic-path-{width}x{height}")
    logs.get_by_role("button", name="Открыть папку логов", exact=True).click()
    check(page, "open-folder still calls only no-argument host stub",
          page.evaluate("window.a25FolderArguments") == [[]])
    page.evaluate("a25DiagnosticStatus.fileError=true")
    logs.get_by_role("button", name="Повторить сохранение", exact=True).wait_for()
    check(page, "current file failure retains actionable warning and retry",
          logs.get_by_role("alert").count() > 0)
    check(page, "settings controls do not overlap", not controls_clear(logs))


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, timeout=60000)
    for width, height in contract["viewports"]:
        for name, scenario in [("placement", placement), ("settings and logs", settings_and_logs)]:
            scenario_name = f"{name} {width}x{height}"
            context = browser.new_context(viewport={"width": width, "height": height}, offline=True, service_workers="block")
            context.add_init_script(FAKE_AUDIO + SEED)

            def route(r):
                if r.request.url.startswith(("file:", "data:", "blob:")):
                    r.continue_()
                else:
                    blocked.append({"scenario": scenario_name, "type": r.request.resource_type})
                    r.abort()

            context.route("**/*", route)
            context.route_web_socket("**/*", lambda r: (blocked.append({"scenario": scenario_name, "type": "websocket"}), r.close()))
            page = context.new_page()
            page.set_default_timeout(6000)
            page.on("pageerror", lambda error: errors.append({"scenario": scenario_name, "error": str(error)}))
            try:
                fresh(page)
                scenario(page, width, height)
                check(page, "no insertion compose or sends", page.evaluate("a23InsertionCalls.length+a23ComposeCalls.length") == 0
                      and page.locator("#chat-draft").input_value() == "Не отправлять")
            except Exception as error:
                check(page, "scenario completed", False, str(error))
            finally:
                context.close()
    browser.close()

after = source_hashes()
changed = [p for p in set(before) | set(after) if before.get(p) != after.get(p)]
checks += [{"name": "no browser errors", "pass": not errors, "detail": errors},
           {"name": "no external requests", "pass": not blocked, "detail": blocked}]
if args.final:
    checks.append({"name": "frozen sources unchanged", "pass": not changed, "detail": changed})
report = {"phase": contract["phase"], "freezeNotice": args.freeze_notice, "createdAt": datetime.now(timezone.utc).isoformat(),
          "checks": checks, "screenshots": screenshots, "sourceHashesBefore": before, "sourceHashesAfter": after,
          "changedSources": changed, "mockedBoundaries": contract["mocked"]}
(RUN / "regression.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
failed = sum(not c["pass"] for c in checks)
print(json.dumps({"passed": len(checks)-failed, "failed": failed, "report": str(RUN / "regression.json")}), flush=True)
sys.exit(1 if failed else 0)
