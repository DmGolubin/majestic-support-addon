"""A27 source UI regression, offline Chromium with existing Python Playwright.

Use a NEW scripts/qa/runs/a27-ui directory. --prepare bundles only.
--final requires an owner --freeze-notice and unchanged source hashes.
AudioContext, host toast, Discord scope, panel and insertion are fixture boundaries.
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
ALLOWED = (ROOT / "scripts/qa/runs/a27-ui").resolve()
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
    raise RuntimeError("Use a NEW child directory of scripts/qa/runs/a27-ui")

checks, errors, blocked, screenshots = [], [], [], []
scenario_name = ""
helpers = {
    "a23-ui-regression.py": {"settle", "screenshot", "check", "rect", "fits", "picker", "settings",
                           "storage", "fresh", "pointer_drag", "titles"},
    "a25-ui-regression.py": {"horizontal_fit", "scroll_settings_target", "controls_clear"},
}
for filename, names in helpers.items():
    tree = ast.parse((ROOT / "scripts/qa" / filename).read_text(encoding="utf-8"))
    nodes = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names]
    assert {n.name for n in nodes} == names
    exec(compile(ast.Module(body=nodes, type_ignores=[]), filename + " pure helpers", "exec"))
    if filename.startswith("a23"):
        FAKE_AUDIO = next(ast.literal_eval(n.value) for n in tree.body
                          if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "FAKE_AUDIO" for t in n.targets))
# Long decoded duration and explicit source.onended keep timing deterministic.
# Nothing changes real product playing/testing state directly.
FAKE_AUDIO = ("window.a27Sources=[];window.a23Duration=20;\n" + FAKE_AUDIO
              .replace("this.frequency=new FakeParam()", "this.frequency=new FakeParam();a27Sources.push(this)")
              .replace("if(this.kind==='custom')this.timer=setTimeout(()=>this.onended?.(),5000)", ""))
SEED = """
if(!localStorage.getItem('A27_fixture_seeded')){
 localStorage.setItem('SupportTemplates_ticketSound_v1',JSON.stringify({
 enabled:false,volume:83.9506172839506,cooldownMs:3000,quietWhenVisible:true,
 channelIds:['696711470783922247','1534231644842754090']}));
 localStorage.setItem('A27_fixture_seeded','true');
}
"""


def source_hashes():
    files = list((ROOT / "src/vencord/ui").glob("*")) + list((ROOT / "src/core").glob("*.ts"))
    files += list((ROOT / "src/vencord/styles").glob("*.css"))
    files += [ROOT / p for p in ["src/vencord/styles.css", "betterdiscord/adapter.css",
                                "betterdiscord/ServiceSettings.tsx", "scripts/qa/q17-ui-harness.mjs",
                                "scripts/qa/a23-ui-regression.py", "scripts/qa/a25-ui-regression.py",
                                "scripts/qa/a27-ui-regression.py"]]
    return {p.relative_to(ROOT).as_posix(): sha256(p.read_bytes()).hexdigest()
            for p in sorted(set(files)) if p.is_file()}


before = source_hashes()
subprocess.run(["node", "scripts/qa/q17-ui-harness.mjs", str(RUN), "--a27"], cwd=ROOT, check=True)
contract = {"phase": "prepared" if args.prepare else "final" if args.final else "exploratory",
            "freezeNotice": args.freeze_notice, "viewports": [[1200, 900], [900, 720], [427, 640], [320, 568]],
            "real": ["Window", "WindowPlacement", "ContextMenu", "Store", "guard.poolOf", "PanelPersonalLibrary",
                     "TicketSettings", "ReminderSettings", "sound controller", "previewTicketReminderNotification"],
            "mocked": ["AudioContext", "platform.toast", "Discord scope", "panel API/catalog", "insertion"],
            "toastBoundary": {"realController": True, "realHost": False},
            "catalog": "Authorized personalVisibleIn=['mj','ro']; source project retained; separate MJ/RO FAQ. Parser acceptance belongs to unit tests.",
            "sourceHashes": before}
(RUN / "a27-contract.json").write_text(json.dumps(contract, ensure_ascii=False, indent=2), encoding="utf-8")
if args.prepare:
    print("A27 fixture prepared; no final browser acceptance.")
    sys.exit(0)


def placement(page, width, height):
    picker(page)
    win = page.locator(".vc-stx-win")
    grip = page.get_by_role("button", name="Переместить окно", exact=True)
    pin = page.get_by_role("button", name="Закрепить окно", exact=True)
    for name, control in [("grip", grip), ("pin", pin)]:
        control.hover()
        settle(page)
        style = control.evaluate("""e=>({hover:e.matches(':hover'),background:getComputedStyle(e).backgroundColor,
          image:getComputedStyle(e).backgroundImage,label:e.getAttribute('aria-label')})""")
        check(page, name + " actual pointer hover stays transparent and accessible",
              style["hover"] and style["background"] in ["rgba(0, 0, 0, 0)", "transparent"]
              and style["image"] == "none" and bool(style["label"]), style)
        screenshot(page, f"placement-hover-{name}-{width}x{height}")
    start = rect(win)
    pointer_drag(page, grip, -12, 20)
    moved = rect(win)
    check(page, "pointer drag still moves window", any(abs(start[k] - moved[k]) > 1 for k in ["x", "y"]))
    pin.click()
    check(page, "pin still locks pointer movement and resize", grip.is_disabled()
          and pin.get_attribute("aria-pressed") == "true" and page.locator(".vc-stx-frame-resize").count() == 0)
    pin.click()
    page.get_by_role("button", name="Сбросить положение и размер окна", exact=True).click()
    rows = page.locator(".vc-stx-it")
    check(page, "template rows contain no duplicate action button",
          rows.count() > 0 and rows.locator("button,[role=button]").count() == 0)
    rows.first.click(button="right")
    menu = page.get_by_role("menu")
    menu.wait_for()
    check(page, "actual right click retains row actions without insertion",
          menu.get_by_role("menuitem", name="Вставить", exact=True).count() == 1
          and fits(rect(menu), width, height)
          and page.evaluate("a23InsertionCalls.length+a23ComposeCalls.length") == 0)
    screenshot(page, f"row-rightclick-{width}x{height}")
    menu.press("Escape")
    check(page, "Escape closes menu", menu.count() == 0)
    for shortcut in ["Shift+F10", "ContextMenu"]:
        page.locator(".vc-stx-search-row input").press(shortcut)
        menu.wait_for()
        check(page, shortcut + " opens selected-row actions without insertion",
              menu.get_by_role("menuitem", name="Вставить", exact=True).count() == 1
              and page.evaluate("a23InsertionCalls.length") == 0)
        menu.press("Escape")


def personal(page, width, height):
    picker(page)
    tab = page.locator(".vc-stx-tabs").get_by_role("button", name="Мои", exact=True)
    tab.click()
    for project, label in [("mj", "Majestic"), ("ro", "Россия Онлайн")]:
        page.get_by_role("radio", name=re.compile(label)).click()
        settle(page)
        check(page, project + " shows both authorized personal templates",
              set(titles(page)) == {"MJpersonalneedle", "ROpersonalneedle"}, titles(page))
        search = page.locator(".vc-stx-search-row input")
        search.fill("ROpersonalneedle" if project == "mj" else "MJpersonalneedle")
        settle(page)
        check(page, project + " searches foreign-source personal template", len(titles(page)) == 1, titles(page))
        search.fill("")
        screenshot(page, f"personal-project-{project}-{width}x{height}")
        page.locator(".vc-stx-tabs").get_by_role("button", name="Все", exact=True).click()
        settle(page)
        check(page, project + " default All keeps FAQ scoped", titles(page) == [project.upper() + "teamonly FAQ"], titles(page))
        page.evaluate("previewStore.setShowPersonalInAll(true)")
        settle(page)
        check(page, project + " optional All adds both personal but no foreign team FAQ",
              set(titles(page)) == {project.upper() + "teamonly FAQ", "MJpersonalneedle", "ROpersonalneedle"}, titles(page))
        page.evaluate("previewStore.setShowPersonalInAll(false)")
        tab.click()
    # Actual Discord scope changes are host boundaries; use the same real pool.
    for scope in ["mj", "ro"]:
        page.evaluate("(s)=>a27SetScope(s)", scope)
        settle(page)
        check(page, scope + " fixed server scope retains personal availability",
              set(titles(page)) == {"MJpersonalneedle", "ROpersonalneedle"}, titles(page))
    page.evaluate("a27SetScope(null)")
    settle(page)
    check(page, "off-scope does not expose templates", not titles(page))
    page.evaluate("a27SetScope('all')")
    settings(page, "Мои шаблоны")
    for project, title in [("mj", "MJpersonalneedle"), ("ro", "ROpersonalneedle")]:
        page.locator(".vc-stx-pp-card").filter(has_text=title).click()
        form = page.locator(".vc-stx-pp-editor")
        select = form.get_by_role("combobox", name="Проект", exact=True)
        check(page, title + " editor keeps source project and removes shared checkbox",
              ("Majestic" if project == "mj" else "Россия Онлайн") in select.inner_text()
              and form.get_by_role("checkbox", name="Общий для двух проектов", exact=True).count() == 0)
        form.get_by_label("Название", exact=True).fill(title + " edited")
        form.get_by_role("button", name="Сохранить на панели", exact=True).click()
        page.wait_for_function("!!window.lastMutation")
        mutation = page.evaluate("window.lastMutation")
        check(page, title + " edit targets original source project at mocked API boundary",
              mutation["body"]["project"] == ("majestic" if project == "mj" else "russia-online")
              and mutation["body"]["shared"] is False
              and mutation["path"] == "/personal-templates/" + ("701" if project == "mj" else "702"), mutation)
        page.evaluate("window.lastMutation=null")
    screenshot(page, f"personal-library-{width}x{height}")


def playback(page, width, height):
    settings(page, "Тикеты")
    page.wait_for_function("a23Sound.get().loaded")
    tickets = page.locator(".vc-stx-tickets")
    section = page.get_by_role("region", name="Личные напоминания", exact=True)
    card = section.get_by_role("group", name="Личные напоминания · Majestic", exact=True)
    check(page, "redundant preview caption and master helper removed",
          "Проверка:" not in tickets.inner_text() and "Общий переключатель для всех серверов" not in tickets.inner_text())
    master = section.get_by_role("checkbox", name="Напоминать в Discord", exact=True)
    master.uncheck()
    card.get_by_role("slider").fill("0")
    card.get_by_role("checkbox", name="Напоминания этого сервера", exact=True).uncheck()
    play = card.get_by_role("button", name="Проверить звук", exact=True)
    check(page, "muted zero preview title communicates fallback without visible caption",
          play.is_enabled() and play.get_attribute("title") == "Проверить на 30%, не включая уведомления")
    card.locator("input[type=file]").set_input_files({"name": "a27-preview.wav", "mimeType": "audio/wav", "buffer": b"RIFF-A27-CUSTOM"})
    page.wait_for_function("a23Sound.get().reminderAudio.majestic.customName==='a27-preview.wav'")
    options = page.evaluate("a23Sound.get().options")
    play.click()
    page.wait_for_function("a23Sound.get().playing")
    row = page.locator(".vc-stx-ticket-playback-row")
    status = row.get_by_role("status")
    stop = row.get_by_role("button", name="Остановить звук", exact=True)
    scroll_settings_target(row)
    page.wait_for_timeout(650)
    check(page, "custom playing row persists before source ended",
          page.evaluate("a23Sound.get().playing") and status.inner_text().strip() == "Свой звук"
          and stop.is_visible() and stop.inner_text().strip() == "Остановить")
    status_box, stop_box = rect(status), rect(stop)
    check(page, "playback status and Stop align without overlap or horizontal overflow",
          horizontal_fit(row) and status_box["right"] <= stop_box["x"] + 1
          and abs(status_box["y"] + status_box["height"]/2 - stop_box["y"] - stop_box["height"]/2) <= 2,
          {"status": status_box, "stop": stop_box})
    screenshot(page, f"playing-custom-{width}x{height}")
    page.evaluate("()=>a27Sources.filter(s=>s.kind==='custom'&&s.onended).forEach(s=>s.onended())")
    page.wait_for_function("!a23Sound.get().playing")
    check(page, "actual ended callback clears Stop and changes status",
          stop.count() == 0 and status.inner_text().strip() == "Проверка завершена")
    play.click()
    page.wait_for_function("a23Sound.get().playing")
    stop.click()
    check(page, "Stop ends playback and updates status", not page.evaluate("a23Sound.get().playing")
          and status.inner_text().strip() == "Остановлено")
    check(page, "manual preview leaves automatic settings untouched", page.evaluate("a23Sound.get().options") == options)
    button = section.get_by_role("button", name="Показать уведомление", exact=True)
    for phase in ["ready", "idle"]:
        if phase == "idle":
            page.evaluate("previewReminders.set({phase:'idle',settings:null})")
        baseline = page.evaluate("({storage:{...localStorage},audio:a23AudioEvents.length,api:window.a26ReminderApiCalls??[]})")
        page.evaluate("window.a23Toasts=[]")
        button.click()
        capture = page.evaluate("({calls:a23Toasts,boundary:a27ToastBoundary})")
        check(page, phase + " preview calls real helper and captures mocked host toast",
              capture == {"calls": [["Тестовое уведомление: Игрок ждёт ответа в назначенном вам тикете", "message"]],
                          "boundary": {"kind": "platform.toast", "realController": True, "realHost": False}}, capture)
        check(page, phase + " preview has no audio API receipt or settings side effects",
              page.evaluate("({storage:{...localStorage},audio:a23AudioEvents.length,api:window.a26ReminderApiCalls??[]})") == baseline)
        scroll_settings_target(button)
        screenshot(page, f"notification-preview-{phase}-{width}x{height}")
    check(page, "ticket UI remains within bounds", horizontal_fit(tickets) and not controls_clear(tickets))


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, timeout=60000)
    for width, height in contract["viewports"]:
        for name, scenario in [("placement", placement), ("personal", personal), ("playback", playback)]:
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
                check(page, "fresh context isolates stored preferences", storage(page, "A24_fixture_preferences") is None)
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
          "changedSources": changed, "toastBoundary": contract["toastBoundary"], "mockedBoundaries": contract["mocked"]}
(RUN / "regression.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
failed = sum(not c["pass"] for c in checks)
print(json.dumps({"passed": len(checks)-failed, "failed": failed, "report": str(RUN / "regression.json")}), flush=True)
sys.exit(1 if failed else 0)
