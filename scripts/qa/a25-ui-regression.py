"""A25 offline UI evidence using existing Python Playwright and q17 source fixture.

Use --prepare to bundle fixtures only, or an ordinary run for exploratory checks.
--final requires a truthful --freeze-notice from the source owners. Every run
uses a fresh child of scripts/qa/runs/a25-ui. No network, sends or actual audio.
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
ALLOWED = (ROOT / "scripts/qa/runs/a25-ui").resolve()
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("directory", nargs="?")
parser.add_argument("--prepare", action="store_true")
parser.add_argument("--final", action="store_true")
parser.add_argument("--freeze-notice")
parser.add_argument("--diagnostics-only", action="store_true", help="Exploratory diagnostics subset; prohibited for final runs")
args = parser.parse_args()
if args.final and (args.prepare or args.diagnostics_only or not args.freeze_notice):
    parser.error("--final requires --freeze-notice and all scenarios, without --prepare")
RUN = (Path(args.directory) if args.directory else ALLOWED / datetime.now().strftime("%Y%m%d-%H%M%S")).resolve()
if RUN.exists() or RUN == ALLOWED or not RUN.is_relative_to(ALLOWED):
    raise RuntimeError("Use a NEW child directory of scripts/qa/runs/a25-ui")

checks, errors, blocked, screenshots, pending = [], [], [], [], []
scenario_name = ""
tree = ast.parse((ROOT / "scripts/qa/a23-ui-regression.py").read_text(encoding="utf-8"))
helpers = {"settle", "screenshot", "check", "rect", "fits", "picker", "settings", "storage", "fresh"}
nodes = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in helpers]
assert {n.name for n in nodes} == helpers
exec(compile(ast.Module(body=nodes, type_ignores=[]), "<A23 pure browser helpers>", "exec"))
FAKE_AUDIO = next(ast.literal_eval(n.value) for n in tree.body
                  if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "FAKE_AUDIO" for t in n.targets))
FAKE_AUDIO = FAKE_AUDIO.replace("setValueAtTime(value){this.value=value}",
                               "setValueAtTime(value){this.value=value;a23AudioEvents.push({event:'gain',value})}")
MAJESTIC, RO = "696711470783922247", "1534231644842754090"
SOUND_KEY = "SupportTemplates_ticketSound_v1"
LEGACY_VOLUME = 83.9506172839506
SEED = f"""
if(!localStorage.getItem('A25_fixture_seeded')) {{
 const channel={{enabled:false,volume:{LEGACY_VOLUME},cooldownMs:3000,quietWhenVisible:true}};
 const sound={{...channel,channelIds:['{MAJESTIC}','{RO}'],
   channels:{{'{MAJESTIC}':channel,'{RO}':{{...channel,enabled:true}}}}}};
 localStorage.setItem('{SOUND_KEY}',JSON.stringify(sound));
 localStorage.setItem('A25_fixture_seeded','true');
}}
"""


def source_hashes():
    files = list((ROOT / "src/vencord/ui").glob("*"))
    files += list((ROOT / "src/vencord/styles").glob("*.css"))
    files += list((ROOT / "src/core").glob("*.ts"))
    files += [ROOT / p for p in ["src/vencord/styles.css", "betterdiscord/adapter.css",
                                "betterdiscord/ServiceSettings.tsx", "scripts/qa/q17-ui-harness.mjs",
                                "scripts/qa/a23-ui-regression.py", "scripts/qa/a25-ui-regression.py"]]
    return {p.relative_to(ROOT).as_posix(): sha256(p.read_bytes()).hexdigest() for p in sorted(set(files)) if p.is_file()}


def search_provenance(hashes):
    path = "src/core/search.ts"
    return {"path": path, "sha256": hashes[path],
            "modifiedAtUtc": datetime.fromtimestamp((ROOT / path).stat().st_mtime, timezone.utc).isoformat()}


before = source_hashes()
search_before = search_provenance(before)
subprocess.run(["node", "scripts/qa/q17-ui-harness.mjs", str(RUN), "--a25"], cwd=ROOT, check=True)
contract = {
    "phase": "prepared" if args.prepare else "final" if args.final else "exploratory",
    "freezeNotice": args.freeze_notice,
    "scenarioSelection": "diagnostics only" if args.diagnostics_only else "all",
    "fixtures": {"storedVolume": LEGACY_VOLUME, "seedOncePerIsolatedContext": True,
                 "longRussianChannelNames": True, "personalCardColors": ["red", "amber", "blue", None]},
    "realComponents": ["Host", "Settings", "Window", "WindowPlacement", "PanelPersonalLibrary",
                       "ColorPicker", "TicketSettings", "DiagnosticControls", "Store", "sound controller"],
    "mockBoundaries": ["Discord stores", "panel transport", "native diagnostic folder action",
                       "diagnostic storage", "AudioContext", "template insertion"],
    "sourceHashes": before,
    "searchSource": search_before,
}
(RUN / "a25-contract.json").write_text(json.dumps(contract, ensure_ascii=False, indent=2), encoding="utf-8")
if args.prepare:
    print("A25 fixture prepared; no final acceptance run.")
    sys.exit(0)


def missing(page, name):
    pending.append({"scenario": scenario_name, "name": name})
    screenshot(page, "pending-" + str(len(pending)))
    print("PENDING " + scenario_name + " / " + name, flush=True)


def pointer_drag(page, source, target=None, dx=0, dy=0):
    source.scroll_into_view_if_needed()
    a = rect(source)
    x, y = a["x"] + a["width"] / 2, a["y"] + a["height"] / 2
    if target is not None:
        b = rect(target)
        end_x, end_y = b["x"] + b["width"] / 2, b["y"] + b["height"] / 2
    else:
        end_x, end_y = x + dx, y + dy
    page.mouse.move(x, y)
    page.mouse.down()
    page.mouse.move(x + 3, y + 3)
    page.mouse.move(end_x, end_y, steps=16)
    page.mouse.move(end_x, end_y)
    page.mouse.up()
    settle(page)


def horizontal_fit(locator):
    return locator.evaluate("e=>e.scrollWidth<=e.clientWidth+1")


def scroll_settings_target(locator):
    # Position the screenshot below the real sticky nav, without changing CSS.
    locator.evaluate("""e=>{
        const panel=e.closest('.vc-stx-settings');
        const nav=panel.querySelector('.vc-stx-settings-nav');
        panel.scrollTop+=e.getBoundingClientRect().top-nav.getBoundingClientRect().bottom-10;
    }""")


def controls_clear(locator):
    # Compare sibling interactive controls, excluding hidden file overlays and
    # wrappers; wrapped rows may be tall but must not paint over one another.
    return locator.evaluate("""root=>{
        const controls=[...root.querySelectorAll('button,input[type=range],input[type=checkbox]')]
          .filter(e=>e.getClientRects().length).map(e=>({name:e.getAttribute('aria-label')||e.textContent,
            rect:e.getBoundingClientRect()}));
        const collisions=[];
        for(let i=0;i<controls.length;i++)for(let j=i+1;j<controls.length;j++){
          const a=controls[i],b=controls[j],x=Math.min(a.rect.right,b.rect.right)-Math.max(a.rect.left,b.rect.left),
            y=Math.min(a.rect.bottom,b.rect.bottom)-Math.max(a.rect.top,b.rect.top);
          if(x>1&&y>1)collisions.push([a.name,b.name,x,y]);
        }return collisions;
    }""")


def tab_order(page, width, height):
    settings(page)
    group = page.locator('[aria-label="Порядок вкладок"]')
    chips = group.locator('[draggable="true"]')
    if chips.count() != 4:
        missing(page, "four compact draggable settings chips")
        return
    group.scroll_into_view_if_needed()
    check(page, "tab ordering is compact and fits horizontally",
          rect(group)["height"] <= 160 and horizontal_fit(group), rect(group))
    initial = page.evaluate("previewStore.data.windowTabOrder")
    pointer_drag(page, chips.nth(0), chips.nth(1))
    reordered = page.evaluate("previewStore.data.windowTabOrder")
    check(page, "actual pointer drag reorders settings tabs",
          reordered == [initial[1], initial[0], *initial[2:]], reordered)
    page.evaluate("()=>previewStore.flush()")
    screenshot(page, f"tab-order-drag-{width}x{height}")
    fresh(page)
    settings(page)
    check(page, "drag order survives full reload", page.evaluate("previewStore.data.windowTabOrder") == reordered)
    chips.first.focus()
    chips.first.press("Alt+ArrowRight")
    check(page, "Alt Right keyboard reorder updates actual Store",
          page.evaluate("previewStore.data.windowTabOrder") == initial)
    page.evaluate("()=>previewStore.flush()")
    fresh(page)
    settings(page)
    check(page, "keyboard order survives reload", page.evaluate("previewStore.data.windowTabOrder") == initial)
    group.scroll_into_view_if_needed()
    screenshot(page, f"tab-order-keyboard-{width}x{height}")
    picker(page)
    main = page.locator(".vc-stx-tabs [draggable=true]")
    pointer_drag(page, main.nth(0), main.nth(1))
    check(page, "main picker drag shares settings order",
          page.evaluate("previewStore.data.windowTabOrder") == reordered)
    settings(page)
    check(page, "settings reflects picker reorder", chips.first.inner_text().strip().startswith("Мои"))


def placement_menu(page, width, height):
    picker(page)
    controls = page.locator(".vc-stx-placement")
    pin = controls.locator("button[aria-pressed]")
    reset = controls.get_by_role("button", name=re.compile("Сброс|Вернуть"))
    if pin.count() != 1 or reset.count() != 1 or not pin.get_attribute("aria-label"):
        missing(page, "accessible SVG pin/reset controls")
        return
    for label, control in [("pin", pin), ("reset", reset)]:
        check(page, label + " is an accessible icon button",
              control.locator("svg").count() > 0 and control.inner_text().strip() == ""
              and bool(control.get_attribute("aria-label")) and bool(control.get_attribute("title")))
    check(page, "placement toolbar avoids old long instruction",
          "Шаблоны ·" not in controls.inner_text() and horizontal_fit(controls))
    window = page.locator(".vc-stx-win")
    start = rect(window)
    pointer_drag(page, page.get_by_role("button", name="Переместить окно", exact=True), dy=20, dx=-20)
    moved = rect(window)
    check(page, "SVG grip still moves window with actual pointer",
          any(abs(start[k] - moved[k]) > 1 for k in ["x", "y"]), {"start": start, "moved": moved})
    pin.click()
    page.wait_for_function("JSON.parse(localStorage.getItem('SupportTemplates_windowPlacement_v1'))?.pinned")
    check(page, "pin announces pressed and disables movement and resize",
          pin.get_attribute("aria-pressed") == "true"
          and page.get_by_role("button", name="Переместить окно", exact=True).is_disabled()
          and page.locator(".vc-stx-frame-resize").count() == 0)
    fresh(page)
    picker(page)
    check(page, "icon pin and geometry survive reload", pin.get_attribute("aria-pressed") == "true"
          and all(abs(rect(window)[k] - moved[k]) <= 1 for k in ["x", "y", "width", "height"]))
    reset.focus()
    reset.press("Enter")
    page.wait_for_function("localStorage.getItem('SupportTemplates_windowPlacement_v1')==='null'")
    check(page, "keyboard reset clears position and unpins", pin.get_attribute("aria-pressed") == "false")
    action = page.locator(".vc-stx-it").first.locator('button[aria-haspopup="menu"]')
    action.hover()
    check(page, "row menu SVG has purposeful tooltip and accessible name",
          action.get_attribute("title") == "Действия шаблона"
          and "шаблон" in action.get_attribute("aria-label").lower()
          and action.locator("svg").count() > 0)
    screenshot(page, f"placement-icons-{width}x{height}")
    action.click()
    menu = page.get_by_role("menu")
    menu.wait_for()
    check(page, "row menu remains usable and fits", fits(rect(menu), width, height)
          and menu.get_by_role("menuitem", name=re.compile("сочетание клавиш")).count() == 1)
    screenshot(page, f"row-menu-{width}x{height}")


def personal_colors(page, width, height):
    settings(page, "Мои шаблоны")
    cards = page.locator(".vc-stx-pp-card")
    check(page, "real personal library renders populated cards", cards.count() == 4)
    expected = {"red": "rgb(239, 68, 68)", "amber": "rgb(245, 158, 11)", "blue": "rgb(59, 130, 246)"}
    for color, rgb in expected.items():
        swatch = cards.locator(f'.vc-stx-pp-card-color [data-color="{color}"]')
        if swatch.count() != 1:
            missing(page, color + " visible personal-card swatch")
            continue
        swatch.scroll_into_view_if_needed()
        info = swatch.evaluate("""e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();
            return {color:s.backgroundColor,width:r.width,height:r.height,opacity:s.opacity,
              label:e.parentElement.textContent.trim(),radius:s.borderRadius};}""")
        check(page, color + " personal card has visible labelled 10px RGB swatch",
              info["color"] == rgb and info["width"] == 10 and info["height"] == 10
              and info["opacity"] == "1" and bool(info["label"]), info)
    check(page, "uncoloured card has no misleading colour chip",
          cards.filter(has=page.get_by_text("Общий ответ", exact=True)).locator(".vc-stx-pp-card-color").count() == 0)
    check(page, "card metadata wraps without horizontal overflow",
          all(horizontal_fit(cards.nth(i)) for i in range(cards.count())))
    cards.first.scroll_into_view_if_needed()
    screenshot(page, f"personal-colors-{width}x{height}")


def ticket_controls(page, width, height):
    settings(page, "Тикеты")
    page.wait_for_function("a23Sound.get().loaded")
    cards = page.locator(".vc-stx-ticket-channel")
    reminder = page.get_by_role("group", name="Аудио личных напоминаний", exact=True)
    check(page, "actual legacy fractional values reached the real controller",
          page.evaluate("a23Sound.get().options.volume") == LEGACY_VOLUME
          and all(page.evaluate("(id)=>a23Sound.get().options.channels[id].volume", ident) == LEGACY_VOLUME
                  for ident in [MAJESTIC, RO]))
    for index in range(2):
        card = cards.nth(index)
        slider = card.get_by_role("slider")
        check(page, f"channel {index} has long populated Russian name",
              len(card.get_attribute("aria-label") or "") > 80, card.get_attribute("aria-label"))
        check(page, f"channel {index} rounds visible and accessible percentage",
              "84%" in card.inner_text() and slider.get_attribute("aria-valuetext") == "84%"
              and not re.search(r"\d+[.,]\d{3,}", card.inner_text()))
        check(page, f"channel {index} controls fit without overlap", horizontal_fit(card)
              and not controls_clear(card), controls_clear(card))
        alignment = card.evaluate("""e=>{
            const box=e.querySelector('label.vc-stx-check'),file=e.querySelector('.vc-stx-sound-file');
            const range=e.querySelector('input[type=range]').getBoundingClientRect();
            const select=e.querySelector('.vc-stx-select>button').getBoundingClientRect();
            return {checkboxDirection:getComputedStyle(box).flexDirection,
              checkboxAlign:getComputedStyle(box).alignItems,fileDirection:getComputedStyle(file).flexDirection,
              rangeY:range.y,selectY:select.y,rangeHeight:range.height,selectHeight:select.height};
        }""")
        check(page, f"channel {index} overrides inherited label layout and aligns range with pause",
              alignment["checkboxDirection"] == "row" and alignment["checkboxAlign"] == "flex-start"
              and alignment["fileDirection"] == "row"
              and abs(alignment["rangeY"] - alignment["selectY"]) <= 1
              and alignment["rangeHeight"] == alignment["selectHeight"], alignment)
        check(page, f"channel {index} test button is short and consistent",
              card.get_by_role("button", name="Проверить звук", exact=True).count() == 1)
        scroll_settings_target(card)
        screenshot(page, f"ticket-channel-{index}-{width}x{height}")
        scroll_settings_target(card.locator(".vc-stx-ticket-custom-sound"))
        screenshot(page, f"ticket-actions-{index}-{width}x{height}")
    check(page, "reminder uses rounded accessible legacy volume",
          reminder.get_by_role("slider").get_attribute("aria-valuetext") == "84%"
          and not re.search(r"\d+[.,]\d{3,}", reminder.inner_text()))
    raw_options = page.evaluate("a23Sound.get().options")
    cards.first.get_by_role("button", name="Проверить звук", exact=True).click()
    page.wait_for_function("a23AudioEvents.some(e=>e.event==='start')")
    check(page, "legacy fractional preview is rounded in displayed status without rewriting options",
          not re.search(r"\d+[.,]\d{3,}", page.locator(".vc-stx-tickets").inner_text())
          and page.evaluate("a23Sound.get().options") == raw_options)
    page.get_by_role("button", name="Остановить звук", exact=True).click()
    page.evaluate("a23AudioEvents=[]")
    first = cards.first.get_by_role("slider")
    first.fill("27")
    first.focus()
    first.press("ArrowRight")
    check(page, "controlled range keyboard update reaches channel store and label",
          page.evaluate("(id)=>a23Sound.get().options.channels[id].volume", MAJESTIC) == 28
          and first.get_attribute("aria-valuetext") == "28%")
    reminder_slider = reminder.get_by_role("slider")
    reminder_slider.scroll_into_view_if_needed()
    b = rect(reminder_slider)
    page.mouse.click(b["x"] + b["width"] * .45, b["y"] + b["height"] / 2)
    changed = page.evaluate("a23Sound.get().options.volume")
    check(page, "actual pointer range edit updates controlled reminder value",
          changed != LEGACY_VOLUME and float(reminder_slider.input_value()) == changed
          and changed == int(changed), changed)
    second_initial = page.evaluate("(id)=>a23Sound.get().options.channels[id].volume", RO)
    cards.first.get_by_role("button", name="Проверить звук", exact=True).click()
    page.wait_for_function("a23AudioEvents.some(e=>e.event==='start')")
    check(page, "muted channel preview retains automatic setting and uses selected gain",
          page.evaluate("(id)=>a23Sound.get().options.channels[id].enabled", MAJESTIC) is False
          # Standard oscillator uses a 0.3 amplitude multiplier (custom audio does not).
          and page.evaluate("a23AudioEvents.some(e=>e.event==='gain'&&Math.abs(e.value-.084)<.001)"),
          page.evaluate("a23AudioEvents"))
    check(page, "playback status does not expose raw fractional percentage",
          not re.search(r"\d+[.,]\d{3,}", page.locator(".vc-stx-tickets").inner_text()))
    stop = page.get_by_role("button", name="Остановить звук", exact=True)
    if stop.count():
        stop.click()
    saved = storage(page, SOUND_KEY)
    reminder.scroll_into_view_if_needed()
    screenshot(page, f"ticket-reminder-{width}x{height}")
    fresh(page)
    settings(page, "Тикеты")
    page.wait_for_function("a23Sound.get().loaded")
    check(page, "controlled edits persist without changing the other parent",
          page.evaluate("a23Sound.get().options") == saved
          and page.evaluate("(id)=>a23Sound.get().options.channels[id].volume", RO) == second_initial)
    check(page, "ticket page avoids horizontal overflow", horizontal_fit(page.locator(".vc-stx-tickets")))


def diagnostics(page, width, height):
    settings(page)
    region = page.get_by_role("region", name="Диагностика", exact=True)
    region.scroll_into_view_if_needed()
    button = region.get_by_role("button", name="Открыть папку логов", exact=True)
    if not button.count():
        missing(page, "concise diagnostics with open-folder action")
        return
    check(page, "diagnostics removes obsolete actions and full path prose",
          region.get_by_role("button", name=re.compile("Скачать|Очистить")).count() == 0
          and "C:/Users" not in region.inner_text()
          and len(region.inner_text()) < 650, region.inner_text())
    check(page, "diagnostic actions fit without overlap", horizontal_fit(region)
          and not controls_clear(region), controls_clear(region))
    page.evaluate("window.a25FolderPending=true")
    button.click()
    opening = region.get_by_role("button", name="Открываем…", exact=True)
    check(page, "folder opening displays disabled pending action",
          opening.is_disabled() and page.evaluate("window.a25FolderOpens") == 1)
    page.evaluate("a25FolderPending=false;a25FolderRelease()")
    button.wait_for()
    check(page, "open folder calls only the no-argument boundary stub",
          page.evaluate("window.a25FolderArguments") == [[]] and button.is_enabled())
    toggle = region.get_by_role("checkbox")
    previous = toggle.is_checked()
    toggle.set_checked(not previous)
    check(page, "diagnostic recording toggle is controlled", toggle.is_checked() != previous)
    toggle.set_checked(previous)
    scroll_settings_target(region)
    screenshot(page, f"diagnostics-{width}x{height}")
    page.evaluate("window.a25FolderFailure=true")
    button.click()
    error = region.get_by_role("alert").filter(has_text="Не удалось открыть папку логов")
    error.wait_for()
    check(page, "folder failure is generic actionable and retry remains available",
          "перезапустите Discord" in error.inner_text() and "fixture folder unavailable" not in region.inner_text()
          and button.is_enabled() and horizontal_fit(region), error.inner_text())
    scroll_settings_target(region)
    screenshot(page, f"diagnostics-folder-error-{width}x{height}")
    page.evaluate("window.a25FolderFailure=false")
    button.click()
    error.wait_for(state="detached")
    check(page, "successful folder retry clears error", page.evaluate("window.a25FolderOpens") == 3)
    page.evaluate("window.failDiagnosticFile=true;window.a25DiagnosticStatus={localError:true,deliveryLost:5}")
    retry = region.get_by_role("button", name="Повторить сохранение", exact=True)
    retry.wait_for()
    check(page, "file error and confirmed history warning remain visible",
          region.get_by_role("alert").count() == 3
          and "5" in region.get_by_role("alert").filter(has_text="неподтверждённые").inner_text()
          and horizontal_fit(region), region.inner_text())
    scroll_settings_target(region)
    screenshot(page, f"diagnostics-save-warning-{width}x{height}")
    retry.click()
    retry.wait_for(state="detached")
    check(page, "retry saving invokes stub but does not hide unresolved history warning",
          page.evaluate("window.a25DiagnosticRetries") == 1
          and region.get_by_role("alert").filter(has_text="неподтверждённые").is_visible())
    page.evaluate("window.a25DiagnosticStatus={initializing:true}")
    page.wait_for_function("document.querySelector('.vc-stx-record-toggle input').disabled")
    check(page, "initializing disables recording only and keeps folder access",
          toggle.is_disabled() and button.is_enabled())
    page.evaluate("window.a25DiagnosticStatus={};previewUi.set({management:false,windowOpen:false});previewService('inactive')")
    service = page.locator("#service").get_by_role("region", name="Диагностика", exact=True)
    service.wait_for()
    check(page, "inactive plugin service retains folder access while recording is disabled",
          service.get_by_role("checkbox").is_disabled()
          and service.get_by_role("button", name="Открыть папку логов", exact=True).is_enabled())


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, timeout=60000)
    for width, height in [(1200, 900), (427, 640), (320, 568)]:
        for name, scenario in [("tabs", tab_order), ("placement and menu", placement_menu),
                               ("personal colors", personal_colors), ("ticket settings", ticket_controls),
                               ("diagnostics", diagnostics)]:
            if args.diagnostics_only and name != "diagnostics":
                continue
            scenario_name = f"{name} {width}x{height}"
            context = browser.new_context(viewport={"width": width, "height": height},
                                          offline=True, service_workers="block")
            context.add_init_script(FAKE_AUDIO + SEED)

            def route(r):
                if r.request.url.startswith(("file:", "data:", "blob:")):
                    r.continue_()
                else:
                    blocked.append({"scenario": scenario_name, "type": r.request.resource_type})
                    r.abort()

            def socket(r):
                blocked.append({"scenario": scenario_name, "type": "websocket"})
                r.close()

            context.route("**/*", route)
            context.route_web_socket("**/*", socket)
            page = context.new_page()
            page.set_default_timeout(6000)
            page.on("pageerror", lambda error: errors.append({"scenario": scenario_name, "error": str(error)}))
            try:
                fresh(page)
                check(page, "context has no previous preference edits", storage(page, "A24_fixture_preferences") is None)
                scenario(page, width, height)
                check(page, "no template insertions, compose or sends",
                      page.evaluate("a23InsertionCalls.length+a23ComposeCalls.length") == 0
                      and page.locator("#chat-draft").input_value() == "Не отправлять")
            except Exception as error:
                check(page, "scenario completed", False, str(error))
            finally:
                context.close()
    browser.close()

after = source_hashes()
search_after = search_provenance(after)
changed = [p for p in set(before) | set(after) if before.get(p) != after.get(p)]
checks += [{"name": "no browser errors", "pass": not errors, "detail": errors},
           {"name": "no unexpected network requests", "pass": not blocked, "detail": blocked}]
if args.final:
    checks.append({"name": "frozen tracked sources unchanged", "pass": not changed, "detail": changed})
report = {"phase": contract["phase"], "freezeNotice": args.freeze_notice,
          "scenarioSelection": contract["scenarioSelection"],
          "createdAt": datetime.now(timezone.utc).isoformat(), "checks": checks, "pending": pending,
          "screenshots": screenshots, "sourceHashesBefore": before, "sourceHashesAfter": after,
          "searchSourceBefore": search_before, "searchSourceAfter": search_after,
          "changedSources": changed, "fixtures": contract["fixtures"], "mockBoundaries": contract["mockBoundaries"]}
(RUN / "regression.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps({"passed": sum(c["pass"] for c in checks), "failed": sum(not c["pass"] for c in checks),
                  "pending": len(pending), "report": str(RUN / "regression.json")}), flush=True)
sys.exit(1 if any(not c["pass"] for c in checks) or (args.final and pending) else 2 if pending else 0)
