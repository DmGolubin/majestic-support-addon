"""A29 source UI browser acceptance. No installed clients, API, sends or actual audio.

Existing Python Playwright; fresh scripts/qa/runs/a29-ui child only.
--final requires explicit --freeze-notice and unchanged source hashes.
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
ALLOWED = (ROOT / "scripts/qa/runs/a29-ui").resolve()
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
    raise RuntimeError("Use a NEW child directory of scripts/qa/runs/a29-ui")
checks, errors, blocked, screenshots = [], [], [], []
scenario_name = ""
for filename, names in {
    "a23-ui-regression.py": {"settle", "screenshot", "check", "rect", "fits", "settings", "fresh"},
    "a25-ui-regression.py": {"horizontal_fit", "controls_clear", "scroll_settings_target"},
}.items():
    tree = ast.parse((ROOT / "scripts/qa" / filename).read_text(encoding="utf-8"))
    nodes = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names]
    assert {n.name for n in nodes} == names
    exec(compile(ast.Module(body=nodes, type_ignores=[]), filename + " helpers", "exec"))
    if filename.startswith("a23"):
        FAKE_AUDIO = next(ast.literal_eval(n.value) for n in tree.body
                          if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "FAKE_AUDIO" for t in n.targets))


def source_hashes():
    files = list((ROOT / "src/vencord/ui").glob("*")) + list((ROOT / "src/core").glob("*.ts"))
    files += list((ROOT / "src/vencord/styles").glob("*.css"))
    files += [ROOT / p for p in [
        "src/vencord/styles.css", "src/vencord/buildDisplay.ts", "src/vencord/reminderNavigation.ts",
        "betterdiscord/adapter.css", "betterdiscord/ServiceSettings.tsx", "betterdiscord/shims/common.ts",
        "distribution/config.json", "scripts/qa/q17-ui-harness.mjs", "scripts/qa/a29-ui-regression.py",
        "scripts/qa/a23-ui-regression.py", "scripts/qa/a25-ui-regression.py"]]
    return {p.relative_to(ROOT).as_posix(): sha256(p.read_bytes()).hexdigest()
            for p in sorted(set(files)) if p.is_file()}


before = source_hashes()
subprocess.run(["node", "scripts/qa/q17-ui-harness.mjs", str(RUN), "--a29"], cwd=ROOT, check=True)
contract = {
    "phase": "prepared" if args.prepare else "final" if args.final else "exploratory",
    "freezeNotice": args.freeze_notice, "viewports": [[900, 720], [360, 640]],
    "real": ["Host", "NativeServiceSettings", "BD ServiceSettings", "BuildIdentity", "TicketSettings",
             "ReminderSettings", "ticketReminders adapter", "assignment/settings parsers", "reminderNavigation",
             "reminderNoticeStore", "ReminderNotifications", "ticketSound controller"],
    "mocked": ["delivery scheduler/receipt engine (manual callback driver)", "in-memory panel GET/PATCH",
               "Discord channel/permission stores and navigation capture", "AudioContext (no audible output)",
               "native diagnostics/folder", "insertion"],
    "sourceHashes": before,
    "version": json.loads((ROOT / "distribution/config.json").read_text())["version"],
}
(RUN / "contract.json").write_text(json.dumps(contract, ensure_ascii=False, indent=2), encoding="utf-8")
if args.prepare:
    print("A29 prepared only")
    sys.exit(0)


def wait_empty(page):
    page.wait_for_function("document.querySelectorAll('.vc-stx-reminder-notice').length===0")


def layout(page, width, height):
    cards = page.locator(".vc-stx-reminder-notice")
    boxes = cards.evaluate_all("""els=>els.map(e=>{const r=e.getBoundingClientRect();return {
      x:r.x,y:r.y,right:r.right,bottom:r.bottom,scroll:e.scrollWidth,client:e.clientWidth,
      accent:getComputedStyle(e).borderLeftColor}})""")
    check(page, "cards stay in viewport without horizontal overflow",
          all(fits(b, width, height) and b["scroll"] <= b["client"] + 1 for b in boxes), boxes)
    check(page, "card controls do not overlap", all(not controls_clear(cards.nth(i)) for i in range(cards.count())))
    check(page, "dismiss controls are pointer reachable",
          cards.locator(".vc-stx-reminder-dismiss").evaluate_all("""els=>els.every(e=>{
            const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})"""))
    return boxes


def previews(page, width, height):
    settings(page, "Тикеты")
    personal = page.locator('section[aria-label="Личные напоминания"]')
    before_side_effects = page.evaluate("JSON.stringify([a29Api,a23AudioEvents,{...localStorage},a29Navigation])")
    for label in ["Majestic", "Россия Онлайн"]:
        group = page.get_by_role("group", name="Личные напоминания · " + label, exact=True)
        group.get_by_role("button", name="Показать уведомление", exact=True).click()
        page.get_by_role("region", name="Тест · " + label, exact=True).wait_for()
        check(page, label + " preview opens from actual pointer click", page.locator(".vc-stx-reminder-test").count() == 1)
        layout(page, width, height)
        screenshot(page, f"single-project-preview-{'mj' if label=='Majestic' else 'ro'}-{width}")
        page.get_by_role("button", name="Закрыть уведомление · " + label, exact=True).click()
        wait_empty(page)
    # Transient cards can overlay the next settings button. Test simultaneous
    # previews via the real keyboard action, without forced pointer clicks.
    for label in ["Majestic", "Россия Онлайн"]:
        group = page.get_by_role("group", name="Личные напоминания · " + label, exact=True)
        button = group.get_by_role("button", name="Показать уведомление", exact=True)
        button.focus()
        button.press("Enter")
    check(page, "per-project previews use actual adapter without API/audio/storage/navigation",
          before_side_effects == page.evaluate("JSON.stringify([a29Api,a23AudioEvents,{...localStorage},a29Navigation])"))
    check(page, "previews explicitly marked and no ticket navigation button",
          page.locator(".vc-stx-reminder-test").count() == 2 and page.locator(".vc-stx-reminder-open").count() == 0)
    colors = [b["accent"] for b in layout(page, width, height)]
    check(page, "project accents distinguish MJ and RO", colors == ["rgb(238, 84, 124)", "rgb(94, 174, 239)"], colors)
    screenshot(page, f"project-previews-settings-{width}")
    page.evaluate("previewUi.set({management:false})")
    settle(page)
    layout(page, width, height)
    screenshot(page, f"project-previews-chat-{width}")
    for label in ["Majestic", "Россия Онлайн"]:
        page.get_by_role("button", name="Закрыть уведомление · " + label, exact=True).click()
    wait_empty(page)
    check(page, "dismiss each preview independently", page.locator(".vc-stx-reminder-notices").count() == 0)
    page.evaluate("a29Stop()")
    settings(page, "Тикеты")
    for label in ["Majestic", "Россия Онлайн"]:
        button = personal.get_by_role("button", name="Показать уведомление · " + label, exact=True)
        button.focus()
        button.press("Enter")
    check(page, "unconnected fallback exposes both local previews", page.locator(".vc-stx-reminder-test").count() == 2)
    page.evaluate("a29Notices.clearReminderNotifications();previewUi.set({management:false})")
    # Store timer runs against monotonic time; advancing clock never hits a real service.
    page.clock.install()
    page.evaluate("for(let i=0;i<5;i++)a29Notices.showReminderNotification(i%2?'majestic':'russia-online')")
    settle(page)
    check(page, "bounded stack retains only three notices", page.locator(".vc-stx-reminder-notice").count() == 3)
    layout(page, width, height)
    screenshot(page, f"bounded-preview-stack-{width}")
    page.clock.fast_forward(46000)
    wait_empty(page)
    check(page, "preview TTL removes notices", page.locator(".vc-stx-reminder-notices").count() == 0)


def delivery(page, width, height):
    page.evaluate("previewUi.set({management:false,windowOpen:false})")
    for project, label, guild in [
        ("majestic", "Majestic", "530693013622489088"),
        ("russia-online", "Россия Онлайн", "1089530150540034181"),
    ]:
        page.evaluate("a29Bind()")
        played = page.evaluate("project=>a29Deliver(project)", project)
        check(page, f"{label} adapter creates actual card after simulated audio scheduling", played)
        card = page.get_by_role("region", name=label, exact=True)
        card.wait_for()
        check(page, "real delivery has no test marker", card.locator(".vc-stx-reminder-test").count() == 0)
        layout(page, width, height)
        screenshot(page, f"assigned-{project}-{width}")
        prior = page.evaluate("a29Api.length")
        page.evaluate("a29Pending=true")
        button = card.get_by_role("button", name="Открыть назначенный тикет · " + label, exact=True)
        button.click()
        check(page, "click waits on fresh assignment read and disables repeat action",
              button.is_disabled() and button.inner_text() == "Проверяем тикет…"
              and page.evaluate("a29Api.length") == prior + 1
              and page.evaluate("a29Api.at(-1)") == {"method": "GET", "path": "/tickets/assigned"})
        page.evaluate("a29Notices.activateReminderNotification(a29Notices.reminderNotifications.get().items[0].id)")
        check(page, "duplicate activation while pending does not read again", page.evaluate("a29Api.length") == prior + 1)
        screenshot(page, f"pending-{project}-{width}")
        page.evaluate("a29Release()")
        wait_empty(page)
        check(page, "fresh matching assignment invokes exact host route",
              page.evaluate("a29Navigation.at(-1)") == f"/channels/{guild}/323456789012345678")

    for invalid in ["assignment", "permission", "channel", "error", "stale"]:
        page.evaluate("a29Bind()")
        page.evaluate("a29Deliver('majestic')")
        count = page.evaluate("a29Navigation.length")
        page.evaluate("""kind=>{
          if(kind==='assignment')a29Assigned.tickets[0].waitingCycleId='different-cycle';
          if(kind==='permission')a29Permission=false;
          if(kind==='channel')a29Channel.guild_id='1089530150540034181';
          if(kind==='error')a29GetFailure=true;
          if(kind==='stale')a29Assigned.checkedAt=new Date(Date.now()-80000).toISOString();
        }""", invalid)
        page.get_by_role("button", name="Открыть назначенный тикет · Majestic", exact=True).click()
        error = page.locator(".vc-stx-reminder-error")
        error.wait_for()
        check(page, invalid + " cannot navigate and shows actionable generic error",
              page.evaluate("a29Navigation.length") == count
              and error.inner_text() == "Тикет недоступен. Повторите проверку."
              and "PRIVATE_FIXTURE_DETAIL" not in page.locator("body").inner_text())
        layout(page, width, height)
        if invalid == "assignment":
            screenshot(page, f"unavailable-ticket-{width}")
    page.evaluate("a29Bind()")
    page.evaluate("a29Deliver('russia-online',false)")
    check(page, "absent validated destination has no click action",
          page.locator(".vc-stx-reminder-open").count() == 0
          and page.get_by_text("Переход к тикету недоступен", exact=True).is_visible())
    screenshot(page, f"no-destination-{width}")
    page.evaluate("a29Bind()")
    page.evaluate("a29Deliver('majestic')")
    page.evaluate("a29Valid=false")
    wait_empty(page)
    check(page, "revoked binding clears card", page.locator(".vc-stx-reminder-notice").count() == 0)


def host_settings(page, width, height):
    # These are fixture-only chat placeholders, not host settings or product CSS.
    # Real Discord settings hides chat; do not let fixture text cover the title.
    page.add_style_tag(content="#chat-text,#chat-draft{visibility:hidden}")
    for host in ["betterdiscord", "native"]:
        page.evaluate("host=>{previewUi.set({management:false,windowOpen:false});previewPanel.set({phase:'ready'});previewService(host)}", host)
        wrapper = page.locator(".vc-stx-host-settings")
        wrapper.wait_for()
        check(page, host + " version preserves full release string",
              page.locator("#service .vc-stx-build-identity").inner_text() == "SupportTemplates · Версия " + contract["version"])
        check(page, host + " ready has no redundant connection status/card",
              wrapper.locator(".vc-stx-host-action [role=status]").count() == 0
              and wrapper.get_by_text("Подключение", exact=True).count() == 0)
        logs = wrapper.locator(".vc-stx-diagnostics")
        css = logs.evaluate("e=>{const s=getComputedStyle(e);return {background:s.backgroundColor,radius:s.borderRadius,border:s.borderTopWidth}}")
        check(page, host + " diagnostics is flat with separator", css == {"background": "rgba(0, 0, 0, 0)", "radius": "0px", "border": "1px"}, css)
        check(page, host + " responsive controls fit", horizontal_fit(wrapper) and not controls_clear(wrapper)
              and rect(wrapper)["right"] <= width + 1)
        screenshot(page, f"host-{host}-ready-{width}")
        page.evaluate("previewPanel.set({phase:'offline'})")
        check(page, host + " offline retains clear status", wrapper.get_by_role("status").inner_text() == "Нет связи с панелью")
        page.evaluate("previewPanel.set({phase:'ready'})")
        wrapper.get_by_role("button", name="Открыть папку логов", exact=True).click()
        check(page, host + " folder calls no-argument fixture only", page.evaluate("a25FolderArguments.at(-1)") == [])
        wrapper.get_by_role("button", name="Открыть SupportTemplates", exact=True).click()
        check(page, host + " queues until host panel unmounts",
              page.locator(".vc-stx-management").count() == 0
              and wrapper.get_by_role("button", name="Открыть SupportTemplates", exact=True).is_disabled())
        text = wrapper.locator(".vc-stx-host-handoff").inner_text()
        check(page, host + " handoff tells user how to close host settings",
              ("Done (Готово)" if host == "betterdiscord" else "Закройте настройки Discord") in text)
        screenshot(page, f"host-{host}-handoff-{width}")
        page.evaluate("previewService(false)")
        page.locator(".vc-stx-management").wait_for()
        check(page, host + " opens management after unmount", page.locator(".vc-stx-management").is_visible())
    page.evaluate("previewUi.set({management:false});previewService('inactive')")
    button = page.get_by_role("button", name="Открыть SupportTemplates", exact=True)
    check(page, "inactive BD disables open and recording",
          button.is_disabled() and page.locator(".vc-stx-record-toggle input").is_disabled())


def retained_cards(page, width, height):
    page.evaluate("previewUi.set({management:false})")
    page.clock.install()
    page.evaluate("a29Deliver('majestic')")
    page.evaluate("window.a29First=structuredClone(a29Assigned)")
    page.evaluate("a29Deliver('russia-online')")
    page.clock.fast_forward(6000)
    check(page, "P2 older card survives replacement of delivery snapshot validity",
          page.locator(".vc-stx-reminder-notice").count() == 2)
    layout(page, width, height)
    screenshot(page, f"retained-two-project-cards-{width}")
    page.evaluate("""()=>{
      a29Assigned.tickets.push(...a29First.tickets);
      a29Channel.guild_id='530693013622489088';
    }""")
    page.get_by_role("button", name="Открыть назначенный тикет · Majestic", exact=True).click()
    page.wait_for_function("a29Navigation.length===1")
    check(page, "older card still fresh-validates and opens its exact ticket",
          page.evaluate("a29Navigation[0]") == "/channels/530693013622489088/323456789012345678"
          and page.get_by_role("region", name="Россия Онлайн", exact=True).count() == 1)
    page.evaluate("a29SetReminderSound('russia-online',{enabled:false})")
    page.clock.fast_forward(1100)
    wait_empty(page)
    check(page, "project mute cancels its retained notification", page.locator(".vc-stx-reminder-notice").count() == 0)


def new_tickets(page, width, height):
    settings(page, "Тикеты")
    toggles = page.get_by_role("checkbox", name="Звук новых тикетов", exact=True)
    for i in range(toggles.count()):
        toggles.nth(i).check()
    check(page, "both new-ticket channels enabled through actual controlled checkboxes",
          toggles.count() == 2 and all(toggles.nth(i).is_checked() for i in range(2)))
    page.evaluate("previewUi.set({management:false})")
    page.wait_for_function("a23AudioEvents.some(e=>e.event==='resume')")
    for i, (parent, guild) in enumerate([
        ("696711470783922247", "530693013622489088"),
        ("1534231644842754090", "1089530150540034181"),
    ]):
        count = page.evaluate("a23AudioEvents.filter(e=>e.event==='start').length")
        snowflake = page.evaluate("i=>(((BigInt(Date.now())-1420070400000n)<<22n)+BigInt(i)).toString()", i)
        event = {"newlyCreated": True, "channel": {"id": snowflake, "parent_id": parent, "guild_id": guild}}
        page.evaluate("event=>a23Dispatch('THREAD_CREATE',event)", event)
        page.wait_for_function("count=>a23AudioEvents.filter(e=>e.event==='start').length>count", arg=count)
        check(page, "new ticket schedules fake audio without toast or personal card",
              page.evaluate("(window.a23Toasts??[]).length") == 0 and page.locator(".vc-stx-reminder-notice").count() == 0)
        after = page.evaluate("a23AudioEvents.filter(e=>e.event==='start').length")
        page.evaluate("event=>a23Dispatch('THREAD_CREATE',event)", event)
        settle(page)
        check(page, "duplicate event does not replay", page.evaluate("a23AudioEvents.filter(e=>e.event==='start').length") == after)


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, timeout=60000)
    for width, height in contract["viewports"]:
        for name, scenario in [("previews", previews), ("delivery", delivery), ("retained cards", retained_cards),
                               ("host", host_settings), ("new tickets", new_tickets)]:
            scenario_name = f"{name} {width}x{height}"
            context = browser.new_context(viewport={"width": width, "height": height}, offline=True, service_workers="block")
            context.add_init_script(FAKE_AUDIO)

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
                page.evaluate("a29Ready")
                page.wait_for_function("a23Sound.get().loaded && previewReminders.get().phase==='ready'")
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
    checks.append({"name": "frozen UI sources unchanged", "pass": not changed, "detail": changed})
report = {"phase": contract["phase"], "freezeNotice": args.freeze_notice,
          "createdAt": datetime.now(timezone.utc).isoformat(), "checks": checks, "screenshots": screenshots,
          "sourceHashesBefore": before, "sourceHashesAfter": after, "changedSources": changed,
          "mockedBoundaries": contract["mocked"]}
(RUN / "regression.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
failed = sum(not c["pass"] for c in checks)
print(json.dumps({"passed": len(checks)-failed, "failed": failed, "report": str(RUN / "regression.json")}), flush=True)
sys.exit(1 if failed else 0)
