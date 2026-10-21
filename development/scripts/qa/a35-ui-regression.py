"""A35 offline source UI acceptance; existing Python Playwright, no installs.

Run with --final only after production owners confirm freeze. Every run hashes
inputs before bundling and after acceptance; a changed input always fails.
Only the channel store is augmented in a disposable copy of the A29 harness.
"""
import argparse
import ast
import json
import re
import subprocess
import tempfile
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--final", action="store_true")
args = parser.parse_args()
RUN = ROOT / "scripts/qa/runs/a35-ui" / datetime.now().strftime("%Y%m%d-%H%M%S-%f")
checks, errors, blocked, screenshots = [], [], [], []
scenario_name = ""

# Reuse pure helper definitions, never execute older suites or their setup.
tree = ast.parse((ROOT / "scripts/qa/a23-ui-regression.py").read_text(encoding="utf-8"))
names = {"settle", "screenshot", "check", "rect", "fits", "picker", "settings", "fresh", "pointer_drag"}
nodes = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names]
assert {n.name for n in nodes} == names
exec(compile(ast.Module(body=nodes, type_ignores=[]), "a23 helpers", "exec"))
FAKE_AUDIO = next(ast.literal_eval(n.value) for n in tree.body if isinstance(n, ast.Assign)
                  and any(isinstance(t, ast.Name) and t.id == "FAKE_AUDIO" for t in n.targets))


def source_hashes():
    files = [p for p in (ROOT / "src").rglob("*") if p.suffix in {".ts", ".tsx", ".css"}]
    files += list((ROOT / "betterdiscord").glob("*.tsx")) + list((ROOT / "betterdiscord/shims").glob("*.ts"))
    files += [ROOT / p for p in ["betterdiscord/adapter.css", "distribution/config.json",
              "scripts/qa/q17-ui-harness.mjs", "scripts/qa/a23-ui-regression.py", "scripts/qa/a35-ui-regression.py"]]
    return {p.relative_to(ROOT).as_posix(): sha256(p.read_bytes()).hexdigest() for p in sorted(set(files))}


before = source_hashes()
harness = (ROOT / "scripts/qa/q17-ui-harness.mjs").read_text(encoding="utf-8")
root_line = next(line for line in harness.splitlines() if line.startswith("const root="))
harness = harness.replace(root_line, "const root=" + json.dumps(ROOT.as_posix()) + ";", 1)
augmentation = """
stubs.common += `
const a35OriginalChannel=ChannelStore.getChannel;
ChannelStore.getChannel=id=>id==='1562132664499175564'
 ?(window.a35SampleChannel===undefined?{id,guild_id:'1089530150540034181',name:'offline-sample'}:window.a35SampleChannel)
 :a35OriginalChannel(id);
`;
"""
assert harness.count("const hostImport =") == 1
harness = harness.replace("const hostImport =", augmentation + "\nconst hostImport =", 1)
with tempfile.TemporaryDirectory(prefix="stx-a35-harness-") as tmp:
    script = Path(tmp) / "fixture.mjs"
    script.write_text(harness, encoding="utf-8")
    subprocess.run(["node", str(script), str(RUN), "--a29"], cwd=ROOT, check=True)
(RUN / "channel-fixture.txt").write_text(augmentation, encoding="utf-8")
version = json.loads((ROOT / "distribution/config.json").read_text())["version"]


def focused_search(page):
    return page.get_by_role("textbox", name="Поиск шаблонов", exact=True).evaluate("e=>document.activeElement===e")


def peek(page, label):
    # Move away: prove restored input focus suffices, not a coincidental hover.
    page.mouse.move(3, 3)
    page.keyboard.down("Shift")
    settle(page)
    preview = page.locator(".vc-stx-win .vc-stx-pre")
    check(page, label + " Shift shows full preview", preview.is_visible() and preview.locator(".vc-stx-body").is_visible())
    check(page, label + " preview has selected template text", "Приветствую" in preview.inner_text())
    page.keyboard.up("Shift")
    settle(page)
    check(page, label + " release hides preview and retains search focus", preview.count() == 0 and focused_search(page))


def shift_geometry(page, width, height):
    picker(page)
    win = page.locator(".vc-stx-win")
    peek(page, "initial")
    grip = page.get_by_role("button", name="Переместить окно", exact=True)
    prior = rect(win)
    pointer_drag(page, grip, -24, -30)
    after = rect(win)
    check(page, "drag changes position and restores search focus", abs(after["x"]-prior["x"]) > 10
          and abs(after["y"]-prior["y"]) > 10 and focused_search(page), {"before": prior, "after": after})
    peek(page, "after drag")
    for edge, dx, dy in [("n", 0, 12), ("s", 0, -12), ("w", 12, 0), ("e", -12, 0),
                         ("nw", -12, -12), ("ne", 12, -12), ("sw", -12, 12), ("se", 12, 12)]:
        prior = rect(win)
        pointer_drag(page, page.locator(".edge-" + edge), dx, dy)
        after = rect(win)
        changed = (not dx or abs(after["width"]-prior["width"]) >= 8) and (not dy or abs(after["height"]-prior["height"]) >= 8)
        check(page, edge + " resizes and restores search focus", changed and focused_search(page)
              and fits(after, width, height), {"before": prior, "after": after})
        peek(page, "after " + edge)
    page.keyboard.down("Shift")
    screenshot(page, f"shift-after-eight-resizes-{width}")
    page.keyboard.up("Shift")
    page.get_by_role("textbox", name="Поиск шаблонов", exact=True).fill("MJteamonly")
    settle(page)
    check(page, "search still accepts input after gestures", page.locator(".vc-stx-it").count() == 1
          and "MJteamonly FAQ" in page.locator(".vc-stx-it").inner_text())


def hosts(page, width, height):
    page.add_style_tag(content="#chat-text,#chat-draft{visibility:hidden}")
    for host in ["native", "betterdiscord", "inactive"]:
        page.evaluate("host=>{previewUi.set({management:false,windowOpen:false});previewService(host)}", host)
        wrapper = page.locator(".vc-stx-host-settings")
        wrapper.wait_for()
        for phase in ["ready", "offline", "idle"]:
            page.evaluate("phase=>previewPanel.set({phase})", phase)
            settle(page)
            text = wrapper.inner_text()
            check(page, host + " " + phase + " has no Open/login-status UI",
                  wrapper.get_by_role("button", name="Открыть SupportTemplates", exact=True).count() == 0
                  and wrapper.locator(".vc-stx-host-action,.vc-stx-host-handoff").count() == 0
                  and not re.search("Нет связи с панелью|Войти|Подключить|Выполнен вход|Аккаунт", text), text)
        check(page, host + " diagnostics retained", wrapper.get_by_role("checkbox", name="Записывать логи").is_visible()
              and wrapper.get_by_role("button", name="Открыть папку логов", exact=True).is_enabled())
        check(page, host + " version matches source", page.locator("#service .vc-stx-build-identity").inner_text()
              == "SupportTemplates · Версия " + version)
        check(page, host + " fits viewport", wrapper.evaluate("e=>e.scrollWidth<=e.clientWidth+1")
              and rect(wrapper)["right"] <= width + 1)
        if host == "inactive":
            check(page, "disabled BD recording remains disabled", wrapper.get_by_role("checkbox").is_disabled())
        screenshot(page, f"settings-{host}-{width}")


def ro_sample(page, width, height):
    settings(page, "Тикеты")
    majestic = page.get_by_role("group", name="Личные напоминания · Majestic", exact=True)
    majestic.get_by_role("button", name="Показать уведомление", exact=True).click()
    mj_card = page.get_by_role("region", name="Тест · Majestic", exact=True)
    check(page, "Majestic sample has no misleading RO ticket action", mj_card.locator(".vc-stx-reminder-open").count() == 0
          and mj_card.get_by_text("Тестовый тикет для этого проекта не задан", exact=True).is_visible())
    mj_card.get_by_role("button", name="Закрыть уведомление · Majestic", exact=True).click()
    group = page.get_by_role("group", name="Личные напоминания · Россия Онлайн", exact=True)
    before_effects = page.evaluate("JSON.stringify([a29Api,a23AudioEvents,{...localStorage},a29Navigation])")
    group.get_by_role("button", name="Показать уведомление", exact=True).click()
    card = page.get_by_role("region", name="Тест · Россия Онлайн", exact=True)
    card.wait_for()
    button = card.get_by_role("button", name="Открыть тестовый тикет · Россия Онлайн", exact=True)
    check(page, "RO sample shows Open ticket", button.is_visible() and button.inner_text() == "Открыть тикет")
    check(page, "sample has no API/audio/storage/navigation side effects", before_effects ==
          page.evaluate("JSON.stringify([a29Api,a23AudioEvents,{...localStorage},a29Navigation])"))
    check(page, "sample fits viewport", fits(rect(card), width, height) and card.evaluate("e=>e.scrollWidth<=e.clientWidth+1"))
    screenshot(page, f"ro-sample-{width}")
    # Offline captured router only: no Discord or real ticket opened.
    button.click()
    page.wait_for_function("a29Navigation.length===1")
    check(page, "sample routes to exact configured RO fixture", page.evaluate("a29Navigation") ==
          ["/channels/1089530150540034181/1562132664499175564"])
    # Manual fixed-route preview delegates actual access to Discord. Cached host
    # state must neither block it nor redirect it to another guild/channel.
    for count, local_state in enumerate(["missing-channel", "wrong-guild", "permission"], start=2):
        page.evaluate("""kind=>{
          a29Notices.clearReminderNotifications();a29Permission=kind!=='permission';
          a35SampleChannel=kind==='missing-channel'?null:{id:'1562132664499175564',guild_id:kind==='wrong-guild'?'530693013622489088':'1089530150540034181'};
        }""", local_state)
        group.get_by_role("button", name="Показать уведомление", exact=True).click()
        card.get_by_role("button", name="Открыть тестовый тикет · Россия Онлайн", exact=True).click()
        page.wait_for_function("count=>a29Navigation.length===count", arg=count)
        check(page, local_state + " does not block or redirect manual sample", page.evaluate("a29Navigation") ==
              ["/channels/1089530150540034181/1562132664499175564"] * count)
    check(page, "navigation never reads or mutates API or plays audio", page.evaluate("JSON.stringify([a29Api,a23AudioEvents,{...localStorage}])")
          == json.dumps(json.loads(before_effects)[:3], ensure_ascii=False, separators=(",", ":")))


with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True, timeout=60000)
    for width, height in [(1100, 820), (900, 720)]:
        for name, scenario in [("shift", shift_geometry), ("settings", hosts), ("RO sample", ro_sample)]:
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
            page.set_default_timeout(5000)
            page.on("pageerror", lambda error: errors.append({"scenario": scenario_name, "error": str(error)}))
            try:
                fresh(page)
                page.evaluate("a29Ready")
                page.wait_for_function("a23Sound.get().loaded && previewReminders.get().phase==='ready'")
                scenario(page, width, height)
                check(page, "no insertion/compose or draft changes", page.evaluate("a23InsertionCalls.length+a23ComposeCalls.length") == 0
                      and page.locator("#chat-draft").input_value() == "Не отправлять")
            except Exception as error:
                check(page, "scenario completed", False, str(error))
            finally:
                context.close()
    browser.close()
after = source_hashes()
changed = [p for p in set(before) | set(after) if before.get(p) != after.get(p)]
checks += [{"name": "no browser errors", "pass": not errors, "detail": errors},
           {"name": "no external requests", "pass": not blocked, "detail": blocked},
           {"name": "source inputs unchanged", "pass": not changed, "detail": sorted(changed)}]
report = {"phase": "final" if args.final else "exploratory", "version": version,
          "createdAt": datetime.now(timezone.utc).isoformat(), "checks": checks, "screenshots": screenshots,
          "sourceHashesBefore": before, "sourceHashesAfter": after, "changedSources": sorted(changed),
          "fixtureHarnessHash": sha256(harness.encode()).hexdigest(),
          "limits": ["Source components, not packaged client or real Discord", "A29 mocked API/stores/native bridge and delivery engine",
                     "Router captured only; no ticket opened", "Fake AudioContext; no sound", "Chromium headless at CSS desktop sizes, no native DPI validation"]}
(RUN / "regression.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
failed = sum(not c["pass"] for c in checks)
print(json.dumps({"passed": len(checks)-failed, "failed": failed, "report": str(RUN / "regression.json")}), flush=True)
raise SystemExit(1 if failed else 0)
