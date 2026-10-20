"""A26 offline UI checks: independent personal reminders and responsive width.

Existing installed Python Playwright only. --prepare bundles source fixtures;
ordinary runs are exploratory. --final requires --freeze-notice from owners.
All output goes to a NEW directory beneath scripts/qa/runs/a26-ui.
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
ALLOWED = (ROOT / "scripts/qa/runs/a26-ui").resolve()
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
    raise RuntimeError("Use a NEW child directory of scripts/qa/runs/a26-ui")

checks, errors, blocked, screenshots, pending = [], [], [], [], []
scenario_name = ""
helpers = {
    "a23-ui-regression.py": {"settle", "screenshot", "check", "rect", "fits", "picker", "settings", "storage", "fresh"},
    "a25-ui-regression.py": {"pointer_drag", "horizontal_fit", "scroll_settings_target", "controls_clear",
                           "tab_order", "placement_menu", "personal_colors", "diagnostics", "missing"},
}
for filename, names in helpers.items():
    tree = ast.parse((ROOT / "scripts/qa" / filename).read_text(encoding="utf-8"))
    nodes = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names]
    assert {n.name for n in nodes} == names
    exec(compile(ast.Module(body=nodes, type_ignores=[]), filename + " pure helpers", "exec"))
    if filename.startswith("a23"):
        FAKE_AUDIO = next(ast.literal_eval(n.value) for n in tree.body
                          if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "FAKE_AUDIO" for t in n.targets))
FAKE_AUDIO = (FAKE_AUDIO
              .replace("setValueAtTime(value){this.value=value}",
                       "setValueAtTime(value){this.value=value;a23AudioEvents.push({event:'gain',value})}")
              .replace("return {duration:window.a23Duration??2}", "return {duration:window.a23Duration??2,fixtureBytes:bytes.byteLength}")
              .replace("event:'start',kind:this.kind", "event:'start',kind:this.kind,bytes:this.buffer?.fixtureBytes"))
MAJESTIC, RO = "696711470783922247", "1534231644842754090"
PROJECTS = ["majestic", "russia-online"]
SOUND_KEY = "SupportTemplates_ticketSound_v1"
AUDIO_KEY = "SupportTemplates_ticketSoundAudio_v1"
LEGACY_VOLUME = 83.9506172839506
SEED = f"""
if(!localStorage.getItem('A26_fixture_seeded')) {{
 const channel={{enabled:false,volume:{LEGACY_VOLUME},cooldownMs:3000,quietWhenVisible:true}};
 localStorage.setItem('{SOUND_KEY}',JSON.stringify({{...channel,channelIds:['{MAJESTIC}','{RO}'],
   channels:{{'{MAJESTIC}':channel,'{RO}':{{...channel,enabled:true}}}}}}));
 localStorage.setItem('{AUDIO_KEY}',JSON.stringify({{version:1,name:'a26-legacy.wav',data:btoa('RIFF-A26-LEGACY')}}));
 localStorage.setItem('A26_fixture_seeded','true');
}}
"""


def source_hashes():
    files = list((ROOT / "src/vencord/ui").glob("*"))
    files += list((ROOT / "src/vencord/styles").glob("*.css")) + list((ROOT / "src/core").glob("*.ts"))
    files += [ROOT / p for p in ["src/vencord/styles.css", "betterdiscord/adapter.css", "betterdiscord/ServiceSettings.tsx",
                                "scripts/qa/q17-ui-harness.mjs", "scripts/qa/a23-ui-regression.py",
                                "scripts/qa/a25-ui-regression.py", "scripts/qa/a26-ui-regression.py"]]
    return {p.relative_to(ROOT).as_posix(): sha256(p.read_bytes()).hexdigest() for p in sorted(set(files)) if p.is_file()}


before = source_hashes()
subprocess.run(["node", "scripts/qa/q17-ui-harness.mjs", str(RUN), "--a26"], cwd=ROOT, check=True)
contract = {"phase": "prepared" if args.prepare else "final" if args.final else "exploratory",
            "freezeNotice": args.freeze_notice,
            "real": ["TicketSettings", "ReminderSettings", "sound controller", "Store", "Settings", "Window", "PanelPersonalLibrary"],
            "mocked": ["AudioContext", "Discord stores", "global reminder API", "native diagnostic folder", "panel", "insertion"],
            "fixtures": {"legacyVolume": LEGACY_VOLUME, "legacySound": "a26-legacy.wav",
                         "missingStorageKey": "undefined; explicit standard reset remains null",
                         "globalDiscordEnabled": True, "projects": PROJECTS, "longRussianChannelNames": True},
            "viewports": [[1200, 900], [900, 720], [427, 640], [320, 568]], "sourceHashes": before}
(RUN / "a26-contract.json").write_text(json.dumps(contract, ensure_ascii=False, indent=2), encoding="utf-8")
if args.prepare:
    print("A26 fixture prepared; no final browser acceptance.")
    sys.exit(0)


def project_options(page):
    return page.evaluate("a23Sound.get().options.reminders")


def audio_record(page, project):
    return storage(page, AUDIO_KEY + "_reminder_" + project)


def stop_audio(page):
    button = page.get_by_role("button", name="Остановить звук", exact=True)
    if button.count():
        button.click()
    page.wait_for_function("!a23Sound.get().testing&&!a23Sound.get().playing")


def preview(page, card, volume, byte_count):
    page.evaluate("a23AudioEvents=[]")
    card.get_by_role("button", name="Проверить звук", exact=True).click()
    page.wait_for_function("a23AudioEvents.some(e=>e.event==='start')")
    events = page.evaluate("a23AudioEvents")
    check(page, f"manual preview selects own {byte_count}-byte custom fixture and {volume} percent gain",
          any(e["event"] == "start" and e.get("kind") == "custom" and e.get("bytes") == byte_count for e in events)
          and any(e["event"] == "gain" and abs(e["value"] - volume / 100) < .001 for e in events), events)
    stop_audio(page)


def reminders_scenario(page, width, height):
    settings(page, "Тикеты")
    page.wait_for_function("a23Sound.get().loaded")
    section = page.get_by_role("region", name="Личные напоминания", exact=True)
    cards = [section.get_by_role("group", name="Личные напоминания · " + name, exact=True)
             for name in ["Majestic", "Россия Онлайн"]]
    if any(card.count() != 1 for card in cards):
        missing(page, "independent personal reminder cards")
        return
    majestic, ro = cards
    master = section.get_by_role("checkbox", name="Напоминать в Discord", exact=True)
    channels_before = page.evaluate("a23Sound.get().options.channels")
    channel_audio_before = page.evaluate("a23Sound.get().channelAudio")
    check(page, "two new-ticket and two personal cards are present",
          page.locator(".vc-stx-ticket-channel").count() == 4)
    check(page, "legacy personal volume and audio migrate to both projects independently of old new-ticket mute",
          project_options(page) == {p: {"enabled": True, "volume": LEGACY_VOLUME} for p in PROJECTS}
          and all(page.evaluate("(p)=>a23Sound.get().reminderAudio[p].customName", p) == "a26-legacy.wav" for p in PROJECTS)
          and master.is_checked(), project_options(page))
    page.wait_for_function("!a23Sound.get().loadingSound")
    tickets = page.locator(".vc-stx-tickets")
    geometry = tickets.evaluate("""e=>{const p=e.parentElement,r=e.getBoundingClientRect(),s=getComputedStyle(p);
        return {width:r.width,available:p.clientWidth-parseFloat(s.paddingLeft)-parseFloat(s.paddingRight),
          maxWidth:getComputedStyle(e).maxWidth};}""")
    check(page, "ticket content uses all available settings width",
          abs(geometry["width"] - geometry["available"]) <= 1, geometry)
    for region_name in ["Новые тикеты", "Личные напоминания"]:
        region = page.get_by_role("region", name=region_name, exact=True)
        grid = region.locator(".vc-stx-ticket-card-grid")
        check(page, region_name + " grid occupies section width", abs(rect(grid)["width"] - rect(region)["width"]) <= 1)
        scroll_settings_target(region)
        screenshot(page, f"{'new-tickets' if region_name == 'Новые тикеты' else 'personal-reminders'}-{width}x{height}")
    for project, card in zip(PROJECTS, cards):
        size = card.evaluate("""e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);
            const inner=e.clientWidth-parseFloat(s.paddingLeft)-parseFloat(s.paddingRight);
            return {card:r.width,inner,volume:e.querySelector('.vc-stx-ticket-volume').getBoundingClientRect().width,
              audio:e.querySelector('.vc-stx-ticket-custom-sound').getBoundingClientRect().width,
              checkboxDirection:getComputedStyle(e.querySelector('.vc-stx-check')).flexDirection};}""")
        check(page, project + " volume and custom controls fill card width with aligned labels",
              abs(size["volume"] - size["inner"]) <= 1 and abs(size["audio"] - size["inner"]) <= 1
              and size["checkboxDirection"] == "row" and horizontal_fit(card) and not controls_clear(card), size)
        check(page, project + " legacy percent is rounded and threshold is populated",
              card.get_by_role("slider").get_attribute("aria-valuetext") == "84%"
              and ("15 мин" if project == "majestic" else "20 мин") in card.inner_text())
    majestic.get_by_role("checkbox", name="Напоминания этого сервера", exact=True).uncheck()
    majestic.get_by_role("slider").fill("26")
    majestic.get_by_role("slider").press("ArrowRight")
    ro.get_by_role("slider").fill("61")
    check(page, "project enable and controlled volumes change independently",
          project_options(page) == {"majestic": {"enabled": False, "volume": 27},
                                    "russia-online": {"enabled": True, "volume": 61}}, project_options(page))
    check(page, "local edits do not call global API or alter new-ticket settings",
          page.evaluate("window.a26ReminderApiCalls??[]") == [] and master.is_checked()
          and page.evaluate("a23Sound.get().options.channels") == channels_before)
    files = {"majestic": b"RIFF-A26-MAJESTIC-CUSTOM", "russia-online": b"RIFF-A26-RO-INDEPENDENT-CUSTOM"}
    for project, card in zip(PROJECTS, cards):
        card.locator('input[type="file"]').set_input_files(
            {"name": "a26-" + project + ".wav", "mimeType": "audio/wav", "buffer": files[project]})
        page.wait_for_function("(p)=>a23Sound.get().reminderAudio[p]?.customName==='a26-'+p+'.wav'", arg=project)
        check(page, project + " upload persists its own audio record",
              audio_record(page, project)["name"] == "a26-" + project + ".wav")
    ro_record = audio_record(page, "russia-online")
    check(page, "both custom records are independent and leave legacy/new-ticket audio intact",
          audio_record(page, "majestic")["data"] != ro_record["data"]
          and storage(page, AUDIO_KEY)["name"] == "a26-legacy.wav"
          and page.evaluate("a23Sound.get().channelAudio") == channel_audio_before)
    preview(page, majestic, 27, len(files["majestic"]))
    preview(page, ro, 61, len(files["russia-online"]))
    master.uncheck()
    check(page, "global API master remains a distinct setting",
          page.evaluate("window.a26ReminderApiCalls") == [{"discordEnabled": False}]
          and project_options(page)["russia-online"]["enabled"] is True
          and all("Общий переключатель напоминаний выключен." in card.inner_text() for card in cards))
    majestic.get_by_role("slider").fill("0")
    check(page, "zero-volume muted preview remains explicit and usable with master off",
          "Проверка: 30%, без включения напоминаний." in majestic.inner_text()
          and majestic.get_by_role("button", name="Проверить звук", exact=True).is_enabled())
    before_preview = project_options(page)
    preview(page, majestic, 30, len(files["majestic"]))
    check(page, "manual fallback preview never unmutes project or global API",
          project_options(page) == before_preview and not master.is_checked()
          and page.evaluate("window.a26ReminderApiCalls") == [{"discordEnabled": False}])
    ro.get_by_role("checkbox", name="Напоминания этого сервера", exact=True).uncheck()
    check(page, "RO can be muted without changing Majestic volume", project_options(page)["russia-online"]["enabled"] is False
          and project_options(page)["majestic"]["volume"] == 0)
    scroll_settings_target(section)
    screenshot(page, f"personal-master-off-{width}x{height}")
    for project, card in zip(PROJECTS, cards):
        scroll_settings_target(card.locator(".vc-stx-ticket-custom-sound"))
        screenshot(page, f"personal-custom-{project}-{width}x{height}")
    saved = storage(page, SOUND_KEY)
    fresh(page)
    settings(page, "Тикеты")
    page.wait_for_function("a23Sound.get().loaded")
    check(page, "local mutes volumes files and global toggle survive full reload",
          page.evaluate("a23Sound.get().options") == saved and not master.is_checked()
          and all(page.evaluate("(p)=>a23Sound.get().reminderAudio[p].customName", p) == "a26-" + p + ".wav" for p in PROJECTS))
    majestic.get_by_role("button", name="Вернуть стандартный", exact=True).click()
    page.wait_for_function("a23Sound.get().reminderAudio.majestic.customName===''")
    check(page, "reset changes only Majestic and explicitly persists standard sound",
          audio_record(page, "majestic") is None and audio_record(page, "russia-online") == ro_record)
    fresh(page)
    settings(page, "Тикеты")
    page.wait_for_function("a23Sound.get().loaded")
    check(page, "explicit standard survives reload without inheriting legacy audio again",
          page.evaluate("a23Sound.get().reminderAudio.majestic.customName") == ""
          and page.evaluate("a23Sound.get().reminderAudio['russia-online'].customName") == "a26-russia-online.wav")
    ro.get_by_role("button", name="Вернуть стандартный", exact=True).click()
    page.wait_for_function("a23Sound.get().reminderAudio['russia-online'].customName===''")
    check(page, "RO reset also leaves legacy and new-ticket audio unchanged",
          audio_record(page, "russia-online") is None and storage(page, AUDIO_KEY)["name"] == "a26-legacy.wav"
          and page.evaluate("a23Sound.get().channelAudio") == channel_audio_before)
    options_before_master = project_options(page)
    master.check()
    check(page, "reenabling master does not overwrite local project mutes or volumes",
          master.is_checked() and project_options(page) == options_before_master
          and page.evaluate("window.a26ReminderApiCalls") == [{"discordEnabled": True}])
    check(page, "all ticket controls stay within horizontal bounds without overlaps",
          horizontal_fit(tickets) and not controls_clear(tickets)
          and not re.search(r"\d+[.,]\d{3,}", tickets.inner_text()), controls_clear(tickets))


def compact_controls(page, width, height):
    tab_order(page, width, height)
    check(page, "reorder help is concise while keyboard shortcuts remain implemented",
          "Alt" not in page.locator("#stx-tab-order-help").inner_text()
          and page.locator('[aria-label="Порядок вкладок"] [aria-keyshortcuts]').count() == 4)
    placement_menu(page, width, height)


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, timeout=60000)
    for width, height in contract["viewports"]:
        for name, scenario in [("personal reminders", reminders_scenario), ("compact controls", compact_controls),
                               ("personal colors", personal_colors), ("diagnostics", diagnostics)]:
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
                check(page, "fresh context isolates stored preferences", storage(page, "A24_fixture_preferences") is None)
                scenario(page, width, height)
                check(page, "no insertion compose or sends",
                      page.evaluate("a23InsertionCalls.length+a23ComposeCalls.length") == 0
                      and page.locator("#chat-draft").input_value() == "Не отправлять")
            except Exception as error:
                check(page, "scenario completed", False, str(error))
            finally:
                context.close()
    browser.close()

after = source_hashes()
changed = [p for p in set(before) | set(after) if before.get(p) != after.get(p)]
checks += [{"name": "no browser errors", "pass": not errors, "detail": errors},
           {"name": "no unexpected external requests", "pass": not blocked, "detail": blocked}]
if args.final:
    checks.append({"name": "frozen tracked sources unchanged", "pass": not changed, "detail": changed})
report = {"phase": contract["phase"], "freezeNotice": args.freeze_notice,
          "createdAt": datetime.now(timezone.utc).isoformat(), "checks": checks, "pending": pending,
          "screenshots": screenshots, "sourceHashesBefore": before, "sourceHashesAfter": after,
          "changedSources": changed, "fixtures": contract["fixtures"], "mockedBoundaries": contract["mocked"]}
(RUN / "regression.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps({"passed": sum(c["pass"] for c in checks), "failed": sum(not c["pass"] for c in checks),
                  "pending": len(pending), "report": str(RUN / "regression.json")}), flush=True)
sys.exit(1 if any(not c["pass"] for c in checks) or (args.final and pending) else 2 if pending else 0)
