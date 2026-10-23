"""A24 offline source UI sidecar. No installs, network APIs, native UI or sends.

python -u scripts/qa/a24-ui-regression.py [NEW_RUN_DIRECTORY]
Use --prepare to build only. Use --final --freeze-notice TEXT only after the
parent explicitly confirms the relevant source freeze. Exploratory runs can
record pending interfaces; pending coverage is never counted as a pass.

Reuses A23's pure browser helpers and fake AudioContext through AST extraction
without executing its build/tests. Actual Host, ContextMenu, Dialogs, Store bind
logic and sound controller run against mocked host/API/diagnostic boundaries.
"""
import argparse
import ast
import json
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
ALLOWED = (ROOT / "scripts/qa/runs/a24-ui").resolve()
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("directory", nargs="?")
parser.add_argument("--prepare", action="store_true")
parser.add_argument("--final", action="store_true")
parser.add_argument("--freeze-notice")
args = parser.parse_args()
if args.final and (args.prepare or not args.freeze_notice):
    parser.error("--final requires an explicit parent --freeze-notice and cannot be --prepare")
RUN = (Path(args.directory) if args.directory else ALLOWED / datetime.now().strftime("%Y%m%d-%H%M%S")).resolve()
if not RUN.is_relative_to(ALLOWED) or RUN == ALLOWED or RUN.exists():
    raise RuntimeError("Use a NEW child directory of scripts/qa/runs/a24-ui")

checks, errors, blocked, screenshots, pending = [], [], [], [], []
scenario_name = ""
helpers = {"settle", "screenshot", "check", "rect", "fits", "picker", "settings", "storage", "titles", "fresh"}
tree = ast.parse((ROOT / "scripts/qa/a23-ui-regression.py").read_text(encoding="utf-8"))
nodes = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in helpers]
assert {node.name for node in nodes} == helpers
exec(compile(ast.Module(body=nodes, type_ignores=[]), "<A23 browser helpers>", "exec"))
FAKE_AUDIO = next(ast.literal_eval(node.value) for node in tree.body
                  if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "FAKE_AUDIO" for t in node.targets))
FAKE_AUDIO = FAKE_AUDIO.replace("setValueAtTime(value){this.value=value}",
                               "setValueAtTime(value){this.value=value;a23AudioEvents.push({event:'gain',value})}")


def source_hashes():
    # Native transport/log implementation is mocked and intentionally excluded.
    files = list((ROOT / "src/vencord/ui").glob("*"))
    files += [ROOT / path for path in [
        "src/core/state.ts", "src/core/keys.ts", "src/core/ticketSound.ts",
        "src/core/rank.ts", "src/core/types.ts", "src/core/diagnosticJournal.ts",
        "src/vencord/styles.css", "betterdiscord/adapter.css", "betterdiscord/ServiceSettings.tsx",
        "scripts/qa/q17-ui-harness.mjs", "scripts/qa/a23-ui-regression.py",
        "scripts/qa/a24-ui-regression.py"]]
    return {p.relative_to(ROOT).as_posix(): sha256(p.read_bytes()).hexdigest() for p in sorted(files) if p.is_file()}


before_hashes = source_hashes()
subprocess.run(["node", "scripts/qa/q17-ui-harness.mjs", str(RUN), "--a24"], cwd=ROOT, check=True)
(RUN / "a24-contract.json").write_text(json.dumps({
    "phase": "prepared" if args.prepare else "final" if args.final else "exploratory",
    "freezeNotice": args.freeze_notice,
    "existingA23Coverage": ["global sound upload/test/stop/mute and persistence", "tabs/personal/general-first",
                          "drag/pin/eight handles/close-reopen and delayed writes", "Ctrl-click insertion options",
                          "continuous diagnostics and short-report label", "320/427/desktop layouts"],
    "addedBoundaries": ["actual Host selection with mocked panel state", "actual ContextMenu and Dialogs",
                       "actual Store for bind collision and persistence", "real sound controller with fake AudioContext"],
    "integrationContracts": ["per-parent-channel sound UI selectors", "stale panel state and notice integration"],
    "sourceHashes": before_hashes,
}, ensure_ascii=False, indent=2), encoding="utf-8")
if args.prepare:
    print("Prepared fixture and scenario contracts; no browser acceptance or final run performed.")
    sys.exit(0)

MAJESTIC = "696711470783922247"
RO = "1534231644842754090"
SOUND_KEY = "SupportTemplates_ticketSound_v1"
AUDIO_KEY = "SupportTemplates_ticketSoundAudio_v1"


def missing(page, name, reason):
    pending.append({"scenario": scenario_name, "name": name, "reason": reason,
                    "screenshot": screenshot(page, "pending-" + str(len(pending) + 1))})
    print("PENDING " + scenario_name + " / " + name + ": " + reason, flush=True)


def open_bind(page, tab, title, how="right-click", capture=None):
    page.locator(".vc-stx-tabs").get_by_role("button", name=re.compile("^" + re.escape(tab))).click()
    row = page.locator(".vc-stx-it").filter(has=page.get_by_text(title, exact=True))
    if how == "right-click":
        row.click(button="right")
    else:
        action_button = row.get_by_role("button", name=f"Действия с шаблоном «{title}»", exact=True)
        if how == "keyboard":
            action_button.focus()
            action_button.press("Enter")
        else:
            action_button.click()
    menu = page.get_by_role("menu")
    menu.wait_for()
    if capture:
        viewport = page.viewport_size
        check(page, tab + " row action menu fits viewport",
              fits(rect(menu), viewport["width"], viewport["height"]), rect(menu))
        screenshot(page, capture)
    action = menu.get_by_role("menuitem", name=re.compile(r"(?:Назначить|Изменить).*(?:клавиш|бинд)"))
    action.click()
    dialog = page.get_by_role("dialog", name=re.compile("Сочетание клавиш"))
    dialog.wait_for()
    return dialog


def binds_scenario(page, width, height):
    picker(page)
    for tab, title, ident, key in [("Все", "QAneedle помощь", "0", "F6"),
                                    ("Мои", "QAneedle", "5", "F7"),
                                    ("Избранное", "QAneedle", "5", "F8")]:
        dialog = open_bind(page, tab, title, {"Все": "right-click", "Мои": "button", "Избранное": "keyboard"}[tab],
                           f"row-menu-{ident}-{key}-{width}x{height}")
        check(page, tab + " bind dialog identifies selected template and fits viewport",
              title in dialog.inner_text() and fits(rect(dialog), width, height), rect(dialog))
        page.keyboard.press(key)
        dialog.wait_for(state="detached")
        check(page, tab + " binds selected template through real Store",
              page.evaluate("id=>previewStore.bindFor(id)", ident) == key)
    check(page, "binding does not require or change favorites",
          page.evaluate("previewStore.data.favorites") == ["5"])
    dialog = open_bind(page, "Мои", "QAneedle")
    page.keyboard.press("F6")
    dialog.get_by_role("alert").wait_for()
    check(page, "collision preserves both owners until explicit confirmation",
          page.evaluate("previewStore.data.binds") == {"0": "F6", "5": "F8"}, dialog.inner_text())
    screenshot(page, f"bind-collision-{width}x{height}")
    dialog.get_by_role("button", name="Отмена", exact=True).click()
    check(page, "collision cancel preserves existing bindings",
          page.evaluate("previewStore.data.binds") == {"0": "F6", "5": "F8"})
    dialog = open_bind(page, "Мои", "QAneedle")
    page.keyboard.press("F6")
    dialog.get_by_role("button", name="Переназначить", exact=True).click()
    check(page, "confirmed collision transfers combination exactly once",
          page.evaluate("previewStore.data.binds") == {"5": "F6"})
    page.evaluate("()=>previewStore.flush()")
    fresh(page)
    picker(page)
    check(page, "binding survives full reload using real Store persistence",
          page.evaluate("previewStore.data.binds") == {"5": "F6"})
    dialog = open_bind(page, "Мои", "QAneedle")
    page.keyboard.press("Control+c")
    check(page, "reserved combination does not replace binding",
          page.evaluate("previewStore.data.binds") == {"5": "F6"} and dialog.is_visible())
    page.keyboard.press("Backspace")
    dialog.wait_for(state="detached")
    check(page, "Backspace removes selected template binding", page.evaluate("previewStore.data.binds") == {})
    check(page, "bind workflows never insert, compose or send",
          page.evaluate("a23InsertionCalls.length+a23ComposeCalls.length") == 0
          and page.locator("#chat-draft").input_value() == "Не отправлять")
    screenshot(page, f"binds-{width}x{height}")


def retained_scenario(page, width, height):
    picker(page)
    original = titles(page)
    # Transport/controller retention decisions are tested by parent units.
    # Here the actual Host receives the controller's retained-ready snapshot.
    page.evaluate("previewPanel.set({phase:'ready',stale:true,error:'Панель временно недоступна. Используется загруженная библиотека.'})")
    settle(page)
    notice = page.locator(".vc-stx-connection-notice")
    if not notice.count():
        missing(page, "retained-library notice", "Host stale-to-connectionNotice wiring has not landed")
        return
    check(page, "retained-ready library remains searchable without blocking login",
          page.locator(".vc-stx-login").count() == 0 and titles(page) == original
          and notice.is_visible(), notice.inner_text())
    check(page, "retained notice and picker fit narrow viewport",
          fits(rect(page.locator(".vc-stx-win")), width, height)
          and notice.evaluate("e=>e.scrollWidth<=e.clientWidth+1"))
    overlap = notice.evaluate("""e=>{
        const close=document.querySelector('.vc-stx-window-close').getBoundingClientRect();
        const range=document.createRange();range.selectNodeContents(e);
        const lines=[...range.getClientRects()].map(r=>({x:r.x,y:r.y,right:r.right,bottom:r.bottom}));
        return {close:close.toJSON(),lines,overlap:lines.some(r=>r.x<close.right&&r.right>close.left&&r.y<close.bottom&&r.bottom>close.top)};
    }""")
    check(page, "retained notice text is not covered by close button", not overlap["overlap"], overlap)
    close_button = page.get_by_role("button", name="Закрыть окно шаблонов", exact=True)
    settings_button = page.get_by_role("button", name="Мои шаблоны и настройки", exact=True)
    close_box, settings_box = rect(close_button), rect(settings_button)
    controls_overlap = (close_box["x"] < settings_box["right"] and close_box["right"] > settings_box["x"]
                        and close_box["y"] < settings_box["bottom"] and close_box["bottom"] > settings_box["y"])
    center_is_target = """e=>{
        const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));
    }"""
    check(page, "close and settings targets fit viewport without overlapping or obstruction",
          fits(close_box, width, height) and fits(settings_box, width, height) and not controls_overlap
          and close_button.evaluate(center_is_target) and settings_button.evaluate(center_is_target),
          {"close": close_box, "settings": settings_box})
    page.get_by_role("textbox", name="Поиск шаблонов").fill("QAneedle")
    check(page, "search still finds retained common template", titles(page) == ["QAneedle помощь"], titles(page))
    page.locator(".vc-stx-it").first.click(modifiers=["Control"])
    check(page, "retained template can reach insertion observer without any send",
          page.evaluate("a23InsertionCalls.at(-1)?.options.noGreeting") is True
          and page.locator("#chat-draft").input_value() == "Не отправлять")
    screenshot(page, f"retained-{width}x{height}")
    close_button.click()
    check(page, "actual close click hides retained picker", page.locator(".vc-stx-win").count() == 0)
    picker(page)
    check(page, "reopened retained picker keeps notice", notice.is_visible())
    settings_button.click()
    page.get_by_role("dialog", name="Шаблоны и настройки", exact=True).wait_for()
    check(page, "actual settings click opens management and closes picker",
          page.locator(".vc-stx-win").count() == 0
          and fits(rect(page.locator(".vc-stx-management")), width, height))
    picker(page)
    page.evaluate("previewPanel.set({stale:false,error:''})")
    settle(page)
    check(page, "recovery removes stale notice", notice.count() == 0)
    page.evaluate("previewStore.clearPanelCatalog();previewAccess.set({ready:false});previewPanel.set({phase:'offline',stale:false,error:'Доступ отозван'})")
    page.locator(".vc-stx-login").wait_for()
    check(page, "unavailable or revoked library still uses login gate",
          page.locator(".vc-stx-win").count() == 0 and page.evaluate("previewStore.templates.length") == 0)


def channels_scenario(page, width, height):
    settings(page, "Тикеты")
    page.wait_for_function("a23Sound.get().loaded")
    # Selectors finalized against the actual incoming accessible channel groups.
    groups = [page.get_by_role("group", name=re.compile(name)) for name in ["majestic-support", "ro-support"]]
    if any(group.count() != 1 for group in groups):
        missing(page, "per-parent-channel controls", "Awaiting two independently labelled channel groups")
        return
    first, second = groups
    reminder = page.get_by_role("checkbox", name="Напоминать в Discord", exact=True)
    reminder_audio = page.get_by_role("group", name="Аудио личных напоминаний", exact=True)
    new_tickets = page.get_by_role("region", name="Новые тикеты", exact=True)
    assigned = page.get_by_role("region", name="Игрок ждёт ответа", exact=True)
    check(page, "new-ticket and assigned-reminder controls explain distinct purposes",
          "независимо от назначения" in new_tickets.inner_text()
          and "только по назначенным" in assigned.inner_text()
          and reminder_audio.count() == 1)
    check(page, "reminder guidance does not point at channel sounds above",
          "Звук и громкость — выбранные выше" not in assigned.inner_text(), assigned.inner_text())
    reminder_before = reminder.is_checked()
    first.get_by_role("checkbox", name="Звук новых тикетов в этом канале", exact=True).check()
    second.get_by_role("checkbox", name="Звук новых тикетов в этом канале", exact=True).uncheck()
    first.get_by_role("slider").fill("67")
    second.get_by_role("slider").fill("22")
    options = page.evaluate("a23Sound.get().options")
    check(page, "per-channel enabled and volume settings are independent",
          options["channels"][MAJESTIC]["enabled"] is True and options["channels"][MAJESTIC]["volume"] == 67
          and options["channels"][RO]["enabled"] is False and options["channels"][RO]["volume"] == 22, options)
    check(page, "channel edits leave assigned reminder toggle unchanged", reminder.is_checked() == reminder_before)
    reminder.set_checked(not reminder_before)
    check(page, "assigned reminder toggle leaves new-ticket channel options unchanged",
          page.evaluate("a23Sound.get().options") == options)
    reminder_audio.get_by_role("slider").fill("17")
    check(page, "assigned reminder volume changes independently of both channels",
          page.evaluate("a23Sound.get().options.volume") == 17
          and page.evaluate("a23Sound.get().options.channels") == options["channels"])
    file_input = first.locator('input[type="file"]')
    file_input.set_input_files({"name": "a24-majestic.wav", "mimeType": "audio/wav", "buffer": b"RIFF-A24"})
    page.wait_for_function("(id)=>a23Sound.get().channelAudio[id]?.customName==='a24-majestic.wav'", arg=MAJESTIC)
    check(page, "custom sound belongs only to selected parent",
          storage(page, AUDIO_KEY + "_channel_" + MAJESTIC)["name"] == "a24-majestic.wav"
          and storage(page, AUDIO_KEY + "_channel_" + RO) is None)
    second.locator('input[type="file"]').set_input_files({"name": "a24-ro.wav", "mimeType": "audio/wav", "buffer": b"RIFF-A24-RO"})
    page.wait_for_function("(id)=>a23Sound.get().channelAudio[id]?.customName==='a24-ro.wav'", arg=RO)
    check(page, "second parent has independent audio bytes and name",
          storage(page, AUDIO_KEY + "_channel_" + RO)["name"] == "a24-ro.wav"
          and storage(page, AUDIO_KEY + "_channel_" + MAJESTIC)["name"] == "a24-majestic.wav"
          and storage(page, AUDIO_KEY) is None)
    page.evaluate("a23AudioEvents=[]")
    first.get_by_role("button", name=re.compile("Проверить")).click()
    page.wait_for_function("a23AudioEvents.some(e=>e.event==='start'&&e.kind==='custom')")
    check(page, "channel test uses its uploaded source and 67 percent volume",
          page.evaluate("a23AudioEvents.some(e=>e.event==='start'&&e.kind==='custom')&&a23AudioEvents.some(e=>e.event==='gain'&&Math.abs(e.value-.67)<.001)"))
    stop = page.get_by_role("button", name="Остановить звук", exact=True)
    if stop.count():
        stop.first.click()
    first.get_by_role("slider").fill("0")
    before_preview = page.evaluate("a23Sound.get().options")
    preview = first.get_by_role("button", name="Проверить при выключенном звуке (30%)", exact=True)
    check(page, "zero-volume channel explicitly labels 30 percent manual preview",
          preview.is_enabled() and "автоматические сигналы этого канала выключены" in first.inner_text())
    page.evaluate("a23AudioEvents=[]")
    preview.click()
    check(page, "muted channel preview uses 30 percent without altering automatic settings",
          page.evaluate("a23AudioEvents.some(e=>e.event==='gain'&&Math.abs(e.value-.3)<.001)")
          and page.evaluate("a23Sound.get().options") == before_preview)
    if stop.count():
        stop.first.click()
    page.evaluate("a23AudioEvents=[]")
    second.get_by_role("button", name="Проверить при выключенном звуке (22%)", exact=True).click()
    check(page, "disabled second parent previews its own 22 percent custom audio",
          page.evaluate("a23AudioEvents.some(e=>e.event==='gain'&&Math.abs(e.value-.22)<.001)")
          and page.evaluate("a23Sound.get().options.channels")[RO]["enabled"] is False)
    if stop.count():
        stop.first.click()
    first.get_by_role("slider").fill("67")
    saved = storage(page, SOUND_KEY)
    screenshot(page, f"channels-{width}x{height}")
    for label, target in [("majestic-audio", first.locator(".vc-stx-ticket-custom-sound")),
                          ("ro-audio", second.locator(".vc-stx-ticket-custom-sound")),
                          ("assigned-reminders", assigned),
                          ("reminder-audio", reminder_audio)]:
        target.scroll_into_view_if_needed()
        settle(page)
        screenshot(page, f"{label}-{width}x{height}")
    fresh(page)
    settings(page, "Тикеты")
    page.wait_for_function("a23Sound.get().loaded")
    check(page, "channel options and custom name persist across reload",
          page.evaluate("a23Sound.get().options.channels") == saved["channels"]
          and "a24-majestic.wav" in first.inner_text() and "a24-ro.wav" in second.inner_text()
          and page.evaluate("a23Sound.get().options.volume") == 17
          and reminder.is_checked() != reminder_before)
    first.get_by_role("button", name="Вернуть стандартный", exact=True).click()
    page.wait_for_function("(id)=>a23Sound.get().channelAudio[id]?.customName===''", arg=MAJESTIC)
    check(page, "reset clears only selected parent audio",
          storage(page, AUDIO_KEY + "_channel_" + MAJESTIC) is None
          and storage(page, AUDIO_KEY + "_channel_" + RO)["name"] == "a24-ro.wav")
    check(page, "ticket settings has no horizontal overflow",
          page.locator(".vc-stx-tickets").evaluate("e=>e.scrollWidth<=e.clientWidth+1"))


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, timeout=60000)
    for width, height in [(1200, 900), (427, 640), (320, 568)]:
        for title, fn in [("binds", binds_scenario), ("retained library", retained_scenario), ("per-channel sounds", channels_scenario)]:
            scenario_name = f"{title} {width}x{height}"
            context = browser.new_context(viewport={"width": width, "height": height}, offline=True, service_workers="block")
            context.add_init_script(FAKE_AUDIO)

            def route(request_route):
                if request_route.request.url.startswith(("file:", "data:", "blob:")):
                    request_route.continue_()
                else:
                    blocked.append({"scenario": scenario_name, "type": request_route.request.resource_type})
                    request_route.abort()

            def socket(route):
                blocked.append({"scenario": scenario_name, "type": "websocket"})
                route.close()

            context.route("**/*", route)
            context.route_web_socket("**/*", socket)
            page = context.new_page()
            page.set_default_timeout(6000)
            page.on("pageerror", lambda error: errors.append({"scenario": scenario_name, "error": str(error)}))
            try:
                fresh(page)
                check(page, "isolated fresh context", storage(page, "A24_fixture_preferences") is None)
                fn(page, width, height)
            except Exception as error:
                check(page, "scenario completed", False, str(error))
            finally:
                context.close()
    browser.close()

after_hashes = source_hashes()
changed = [key for key in set(before_hashes) | set(after_hashes) if before_hashes.get(key) != after_hashes.get(key)]
checks += [{"name": "no browser errors", "pass": not errors, "detail": errors},
           {"name": "no unexpected network requests", "pass": not blocked, "detail": blocked}]
if args.final:
    checks.append({"name": "frozen UI sources unchanged during run", "pass": not changed, "detail": changed})
report = {"phase": "final" if args.final else "exploratory", "freezeNotice": args.freeze_notice,
          "createdAt": datetime.now(timezone.utc).isoformat(),
          "scope": "Actual source Host/menu/dialog/Store/sound with mocked host/API/panel states, fake AudioContext, and insertion observer. Retention controller authorization and native runtime tested separately.",
          "checks": checks, "pending": pending, "screenshots": screenshots,
          "sourceHashesBefore": before_hashes, "sourceHashesAfter": after_hashes, "changedSources": changed}
(RUN / "regression.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps({"passed": sum(c["pass"] for c in checks), "failed": sum(not c["pass"] for c in checks),
                  "pending": len(pending), "report": str(RUN / "regression.json")}), flush=True)
sys.exit(1 if any(not c["pass"] for c in checks) or (args.final and pending) else 2 if pending else 0)
