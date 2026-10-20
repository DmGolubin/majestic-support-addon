"""A23 offline browser acceptance, real source UI/controllers and mocked host boundaries.

python -u scripts/qa/a23-ui-regression.py [NEW_DIRECTORY] [--final]
Evidence is exclusively in a fresh scripts/qa/runs/a23-ui/ child. Browser contexts
isolate scenarios; reload deliberately preserves localStorage. Existing installed
Playwright Chromium only, no downloads, external API, native UI or chat sends.
--final waits for an unchanged source fingerprint before building, and fails if
sources change during the run. Pointer gestures use Chromium mouse input.
"""
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
ALLOWED = (ROOT / "scripts/qa/runs/a23-ui").resolve()
FINAL = "--final" in sys.argv
args = [arg for arg in sys.argv[1:] if not arg.startswith("--")]
RUN = (Path(args[0]) if args else ALLOWED / datetime.now().strftime("%Y%m%d-%H%M%S")).resolve()
if not RUN.is_relative_to(ALLOWED) or RUN == ALLOWED or RUN.exists():
    raise RuntimeError("Use a NEW child directory of scripts/qa/runs/a23-ui")


def source_hashes():
    files = set((ROOT / "src/core").glob("*.ts"))
    files.update((ROOT / "src/vencord/ui").glob("*"))
    files.update((ROOT / "betterdiscord").glob("*.tsx"))
    files.update(ROOT / name for name in [
        "src/vencord/styles.css", "betterdiscord/adapter.css",
        "scripts/qa/q17-ui-harness.mjs", "scripts/qa/a23-ui-regression.py"])
    return {p.relative_to(ROOT).as_posix(): sha256(p.read_bytes()).hexdigest()
            for p in sorted(files) if p.is_file()}


if FINAL:
    baseline, stable_since = source_hashes(), time.monotonic()
    print("Waiting for 30 seconds of source stability before FINAL build", flush=True)
    while time.monotonic() - stable_since < 30:
        time.sleep(5)
        current_hashes = source_hashes()
        if current_hashes != baseline:
            baseline, stable_since = current_hashes, time.monotonic()
            print("Source changed; restarting stability interval", flush=True)

before_hashes = source_hashes()
subprocess.run(["node", "scripts/qa/q17-ui-harness.mjs", str(RUN), "--a23"],
               cwd=ROOT, check=True)

# No actual audio output. The real product sound controller still validates files,
# persists bytes/options, schedules sources, stops them and publishes status/errors.
FAKE_AUDIO = r"""
window.a23AudioEvents=[];
class FakeParam {
  setValueAtTime(value){this.value=value}
  exponentialRampToValueAtTime(value){this.value=value}
}
class FakeSource {
  constructor(kind,ctx){this.kind=kind;this.ctx=ctx;this.frequency=new FakeParam()}
  connect(){} disconnect(){}
  start(){a23AudioEvents.push({event:'start',kind:this.kind});
    if(this.kind==='custom')this.timer=setTimeout(()=>this.onended?.(),5000)}
  stop(when){a23AudioEvents.push({event:'stop',kind:this.kind});
    clearTimeout(this.timer);if(when>this.ctx.currentTime)this.timer=setTimeout(()=>this.onended?.(),(when-this.ctx.currentTime)*1000);
    else queueMicrotask(()=>this.onended?.())}
}
window.AudioContext=class {
  constructor(){this.state='suspended';this.currentTime=0;this.destination={}}
  async resume(){this.state='running';a23AudioEvents.push({event:'resume'})}
  async close(){this.state='closed'}
  async decodeAudioData(bytes){a23AudioEvents.push({event:'decode',bytes:bytes.byteLength});
    if(window.a23DecodeFailure)throw Error('fixture decode failure');
    return {duration:window.a23Duration??2}}
  createGain(){return {gain:new FakeParam(),connect(){},disconnect(){}}}
  createBufferSource(){return new FakeSource('custom',this)}
  createOscillator(){return new FakeSource('standard',this)}
};
"""
checks, errors, blocked, screenshots = [], [], [], []
scenario_name = ""
POSITION_KEY = "SupportTemplates_windowPlacement_v1"
SIZE_KEY = "SupportTemplates_windowSize_v1"


def settle(page):
    page.evaluate("()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))")


def screenshot(page, name):
    filename = re.sub(r"[^a-zA-Z0-9_-]", "-", name) + ".png"
    page.evaluate("()=>Promise.all(document.getAnimations().filter(a=>a.effect.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))")
    page.screenshot(path=str(RUN / filename))
    screenshots.append(filename)
    return filename


def check(page, name, passed, detail=None):
    row = {"name": scenario_name + " / " + name, "pass": bool(passed), "detail": detail}
    if not passed:
        row["screenshot"] = screenshot(page, "failure-" + str(len(checks) + 1))
    checks.append(row)
    print(("PASS " if passed else "FAIL ") + row["name"], flush=True)
    if not passed:
        print(str(detail), flush=True)


def rect(locator):
    return locator.evaluate("e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}}")


def same(a, b):
    return all(abs(a[k] - b[k]) <= 1 for k in ["x", "y", "width", "height"])


def fits(b, width, height):
    return b["x"] >= -1 and b["y"] >= -1 and b["right"] <= width + 1 and b["bottom"] <= height + 1


def picker(page):
    page.evaluate("previewUi.set({management:false,windowOpen:true})")
    page.locator(".vc-stx-win").wait_for()
    settle(page)


def settings(page, tab="Настройки"):
    page.evaluate("previewUi.set({management:true,windowOpen:false})")
    page.locator(".vc-stx-settings-nav").get_by_role("button", name=tab, exact=True).click()
    settle(page)


def storage(page, key):
    return page.evaluate("key=>JSON.parse(localStorage.getItem(key)||'null')", key)


def pointer_drag(page, locator, dx, dy):
    b = rect(locator)
    x, y = b["x"] + b["width"] / 2, b["y"] + b["height"] / 2
    page.mouse.move(x, y)
    page.mouse.down()
    page.mouse.move(x + dx, y + dy, steps=12)
    page.mouse.up()
    settle(page)


def tab_labels(page):
    return page.locator(".vc-stx-tab").evaluate_all("els=>els.map(e=>e.textContent.replace(/\\d+$/,''))")


def titles(page):
    return page.locator(".vc-stx-it .vc-stx-nm").all_text_contents()


def fresh(page):
    page.goto((RUN / "index.html").as_uri(), wait_until="domcontentloaded")
    page.locator(".vc-stx-management").wait_for()
    page.add_style_tag(content=".review-controls{display:none!important}")
    settle(page)


def reload_picker(page):
    fresh(page)
    picker(page)


def geometry_scenario(page, width, height):
    picker(page)
    win = page.locator(".vc-stx-win")
    initial = rect(win)
    check(page, "initial window fits viewport", fits(initial, width, height), initial)
    check(page, "default width is desktop 360 or compact 400 clamped to viewport",
          abs(initial["width"] - min(360 if width >= 1000 else 400, width - 16)) <= 1, initial)
    css = win.evaluate("e=>({paddingTop:getComputedStyle(e).paddingTop,closeTop:getComputedStyle(e.querySelector('.vc-stx-window-close')).top})")
    check(page, "placement CSS wins cascade: 28px header padding and 40px close offset",
          css == {"paddingTop": "28px", "closeTop": "40px"}, css)
    check(page, "exactly one drag/pin/reset and eight named handles",
          page.get_by_role("button", name="Переместить окно", exact=True).count() == 1
          and page.get_by_role("button", name="Закрепить", exact=True).count() == 1
          and page.get_by_role("button", name="Сброс", exact=True).count() == 1
          and page.locator(".vc-stx-frame-resize[aria-label]").count() == 8)
    page.get_by_role("button", name="Переместить окно", exact=True).click()
    check(page, "click without dragging does not create placement preference",
          storage(page, POSITION_KEY) is None)
    dx = -90 if initial["x"] > 8 else min(20, width - initial["right"] - 8)
    dy = -50 if initial["y"] > 32 else min(20, height - initial["bottom"] - 8)
    pointer_drag(page, page.get_by_role("button", name="Переместить окно", exact=True), dx, dy)
    moved = rect(win)
    check(page, "actual pointer drag moves window", not same(initial, moved), {"before": initial, "after": moved})
    check(page, "drag persists unpinned placement", storage(page, POSITION_KEY) is not None
          and storage(page, POSITION_KEY)["pinned"] is False, storage(page, POSITION_KEY))
    # At 320px horizontal motion/resize can be clamped; vertical dragging still works.
    check(page, "drag remains in viewport", fits(moved, width, height), moved)
    page.get_by_role("button", name="Закрепить", exact=True).click()
    pinned = rect(win)
    pointer_drag(page, page.get_by_role("button", name="Переместить окно", exact=True), 50, 40)
    # Real pointer attempts at all former edge/corner locations while pinned.
    for fx, fy in [(0, .5), (1, .5), (.5, 0), (.5, 1), (0, 0), (1, 0), (0, 1), (1, 1)]:
        x = pinned["x"] + 2 + (pinned["width"] - 4) * fx
        y = pinned["y"] + 2 + (pinned["height"] - 4) * fy
        page.mouse.move(x, y)
        page.mouse.down()
        page.mouse.move(x - 12, y - 12, steps=3)
        page.mouse.up()
    settle(page)
    check(page, "pin locks pointer movement and all edge resizing", same(pinned, rect(win))
          and page.get_by_role("button", name="Переместить окно", exact=True).is_disabled()
          and page.locator(".vc-stx-frame-resize").count() == 0, rect(win))
    page.get_by_role("button", name="Закрыть окно шаблонов", exact=True).click()
    picker(page)
    check(page, "close/reopen restores geometry and pin", same(pinned, rect(win))
          and page.get_by_role("button", name="Открепить", exact=True).count() == 1)
    reload_picker(page)
    check(page, "full page reload restores persisted geometry and pin", same(pinned, rect(win))
          and page.get_by_role("button", name="Открепить", exact=True).count() == 1, rect(win))
    page.evaluate("previewUi.set({channelRevision:1})")
    settle(page)
    check(page, "fixture channel revision retains pinned geometry", same(pinned, rect(win)))
    if width >= 1000:
        saved_placement = storage(page, POSITION_KEY)
        page.set_viewport_size({"width": 320, "height": 320})
        settle(page)
        check(page, "pinned window clamps on viewport shrink without overwriting saved preference",
              fits(rect(win), 320, 320) and rect(win)["y"] >= 31
              and storage(page, POSITION_KEY) == saved_placement, rect(win))
        page.set_viewport_size({"width": width, "height": height})
        settle(page)
        check(page, "pinned desktop placement returns after viewport restoration", same(pinned, rect(win)), rect(win))
    page.get_by_role("button", name="Открепить", exact=True).click()
    screenshot(page, f"picker-{width}x{height}")
    if width >= 1000:
        for edge, dx, dy in [("n", 0, -24), ("s", 0, 24), ("w", -24, 0), ("e", 24, 0),
                             ("nw", -24, -24), ("ne", 24, -24), ("sw", -24, 24), ("se", 24, 24)]:
            prior = rect(win)
            pointer_drag(page, page.locator(".edge-" + edge), dx, dy)
            after = rect(win)
            horizontal = abs(after["width"] - prior["width"]) >= 15 if dx else abs(after["width"] - prior["width"]) <= 1
            vertical = abs(after["height"] - prior["height"]) >= 15 if dy else abs(after["height"] - prior["height"]) <= 1
            # The opposite edge stays anchored, including east/south handles.
            anchored_x = abs(after["right"] - prior["right"]) <= 1 if "w" in edge else abs(after["x"] - prior["x"]) <= 1
            anchored_y = abs(after["bottom"] - prior["bottom"]) <= 1 if "n" in edge else abs(after["y"] - prior["y"]) <= 1
            check(page, f"pointer resize {edge} changes requested dimensions and anchors opposite edge",
                  horizontal and vertical and anchored_x and anchored_y,
                  {"before": prior, "after": after, "savedSize": storage(page, SIZE_KEY)})
        resized = rect(win)
        reload_picker(page)
        check(page, "resized geometry survives reload", same(resized, rect(win)), {"before": resized, "after": rect(win)})
        drag = page.get_by_role("button", name="Переместить окно", exact=True)
        prior = rect(win)
        drag.focus()
        drag.press("ArrowLeft")
        settle(page)
        check(page, "keyboard drag moves left without triggering row insertion", rect(win)["x"] < prior["x"]
              and abs(rect(win)["y"] - prior["y"]) <= 1 and page.evaluate("a23InsertionCalls.length") == 0,
              {"before": prior, "after": rect(win)})
        prior = rect(win)
        b = rect(drag)
        page.mouse.move(b["x"] + 40, b["y"] + b["height"] / 2)
        page.mouse.down()
        page.mouse.move(b["x"] + 70, b["y"] + 40, steps=5)
        page.keyboard.press("Escape")
        page.mouse.up()
        settle(page)
        check(page, "Escape cancels active drag and restores prior geometry", same(prior, rect(win)))
    else:
        # Small viewports may be at the minimum width/height. Each handle must
        # still honor constraints; shrink only dimensions with available room.
        for edge in ["n", "s", "w", "e", "nw", "ne", "sw", "se"]:
            page.get_by_role("button", name="Сброс", exact=True).click()
            settle(page)
            prior = rect(win)
            dx = 18 if "w" in edge else -18 if "e" in edge else 0
            dy = 18 if "n" in edge else -18 if "s" in edge else 0
            pointer_drag(page, page.locator(".edge-" + edge), dx, dy)
            after = rect(win)
            can_shrink_x = dx != 0 and prior["width"] > min(320, width - 16) + 1
            can_shrink_y = dy != 0 and prior["height"] > min(280, height - 40) + 1
            check(page, f"small viewport pointer resize {edge} honors dimensions and bounds",
                  fits(after, width, height) and after["y"] >= 31
                  and (not can_shrink_x or after["width"] < prior["width"])
                  and (not can_shrink_y or after["height"] < prior["height"]),
                  {"before": prior, "after": after})
    pointer_drag(page, page.get_by_role("button", name="Переместить окно", exact=True), 0, -1500)
    check(page, "upward pointer drag clamps below 32px title bar", abs(rect(win)["y"] - 32) <= 1, rect(win))
    page.get_by_role("button", name="Сброс", exact=True).click()
    settle(page)
    check(page, "reset clears persisted placement", storage(page, POSITION_KEY) is None)


def tabs_scenario(page):
    picker(page)
    check(page, "default All excludes personal", "QAneedle" not in titles(page), titles(page))
    tabs = page.locator(".vc-stx-tabs")
    tabs.get_by_role("button", name="Мои", exact=True).click()
    check(page, "My tab contains only personal template", titles(page) == ["QAneedle"], titles(page))
    for label in ["Избранное", "Недавние"]:
        tabs.get_by_role("button", name=re.compile("^" + label)).click()
        check(page, label + " retains personal when All excludes it", "QAneedle" in titles(page), titles(page))
    tabs.get_by_role("button", name="Мои", exact=True).drag_to(tabs.get_by_role("button", name="Все", exact=True))
    settle(page)
    check(page, "actual browser drag/drop reorders tabs", tab_labels(page)[:2] == ["Мои", "Все"], tab_labels(page))
    reload_picker(page)
    check(page, "dragged tab order survives full reload", tab_labels(page)[:2] == ["Мои", "Все"], tab_labels(page))
    settings(page)
    earlier = page.get_by_role("button", name="Переместить Мои раньше", exact=True)
    later = page.get_by_role("button", name="Переместить Мои позже", exact=True)
    check(page, "accessible order controls disable first/last boundaries", earlier.is_disabled()
          and page.get_by_role("button", name="Переместить Недавние позже", exact=True).is_disabled())
    later.focus()
    later.press("Enter")
    check(page, "keyboard-accessible order change persists", page.evaluate("previewStore.data.windowTabOrder")[:2] == ["all", "personal"])
    page.get_by_role("checkbox", name="Показывать личные шаблоны во Все", exact=True).check()
    picker(page)
    search = page.get_by_role("textbox", name="Поиск шаблонов", exact=True)
    search.fill("QAneedle")
    check(page, "general-first sorts common match before exact personal title",
          titles(page) == ["QAneedle помощь", "QAneedle"], titles(page))
    settings(page)
    page.get_by_role("checkbox", name="Общие шаблоны первыми в поиске", exact=True).uncheck()
    reload_picker(page)
    search.fill("QAneedle")
    check(page, "disabled general-first and personal visibility persist after reload",
          titles(page) == ["QAneedle", "QAneedle помощь"], titles(page))
    # Observer records only the invocation boundary; no real editor insertion/send.
    row = page.locator(".vc-stx-it").first
    row.click(modifiers=["Control"])
    row.click()
    calls = page.evaluate("a23InsertionCalls")
    check(page, "Ctrl+left click passes noGreeting true; plain click false", len(calls) == 2
          and calls[0]["options"] == {"via": "window-click", "noGreeting": True}
          and calls[1]["options"] == {"via": "window-click", "noGreeting": False}, calls)
    check(page, "insertion boundary observer leaves draft unsent and unchanged",
          page.locator("#chat-draft").input_value() == "Не отправлять"
          and page.evaluate("a23ComposeCalls.length") == 0)
    screenshot(page, "tabs-search-controls")


def preview_scenario(page):
    picker(page)
    page.get_by_role("textbox", name="Поиск шаблонов", exact=True).press("ArrowRight")
    page.locator(".vc-stx-pre").wait_for()
    win = page.locator(".vc-stx-win")
    pointer_drag(page, page.get_by_role("button", name="Переместить окно", exact=True), -80, -60)
    list_width = rect(page.locator(".vc-stx-col"))["width"]
    for edge, dx, dy in [("e", 24, 0), ("s", 0, 24), ("w", -24, 0), ("n", 0, -24),
                         ("se", 24, 24), ("ne", 24, -24), ("sw", -24, 24), ("nw", -24, -24)]:
        prior = rect(win)
        pointer_drag(page, page.locator(".edge-" + edge), dx, dy)
        after = rect(win)
        check(page, f"side preview pointer resize {edge} retains list width",
              (not dx or after["width"] > prior["width"] + 15)
              and (not dy or after["height"] > prior["height"] + 15)
              and abs(rect(page.locator(".vc-stx-col"))["width"] - list_width) <= 1
              and fits(after, 1600, 1000), {"before": prior, "after": after})
    resized = rect(win)
    reload_picker(page)
    check(page, "side preview size and open preference survive reload",
          same(resized, rect(win)) and page.locator(".vc-stx-pre").count() == 1)
    screenshot(page, "side-preview-resized")


def gesture_race_scenario(page):
    picker(page)
    win = page.locator(".vc-stx-win")
    drag = page.get_by_role("button", name="Переместить окно", exact=True)
    page.evaluate("window.a23StorageDelay=650")
    for action in ["drag", "resize"]:
        target = drag if action == "drag" else page.locator(".edge-se")
        pointer_drag(page, target, -80 if action == "drag" else 24, -45 if action == "drag" else 24)
        committed = rect(win)
        check(page, action + " fixture write is still pending before rapid remount",
              page.evaluate("a23PendingWrites") > 0)
        page.evaluate("previewUi.set({windowOpen:false})")
        win.wait_for(state="detached")
        picker(page)
        page.wait_for_function("a23PendingWrites===0")
        settle(page)
        check(page, action + " waits for pending storage on immediate close/reopen",
              same(committed, rect(win)), {"before": committed, "after": rect(win)})
    page.evaluate("window.a23StorageDelay=0")
    before = rect(win)
    saved = storage(page, POSITION_KEY)
    b = rect(drag)
    page.mouse.move(b["x"] + 35, b["y"] + b["height"] / 2)
    page.mouse.down()
    page.mouse.move(b["x"] + 60, b["y"] + 30, steps=4)
    settle(page)
    during = rect(win)
    for key in ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]:
        page.keyboard.press(key)
    settle(page)
    check(page, "arrow keys during active pointer drag do not alter geometry or persisted state",
          same(during, rect(win)) and storage(page, POSITION_KEY) == saved,
          {"during": during, "afterKeys": rect(win)})
    page.keyboard.press("Escape")
    page.mouse.up()
    settle(page)
    check(page, "cancel after ignored arrows restores pre-gesture state",
          same(before, rect(win)) and storage(page, POSITION_KEY) == saved)
    page.locator(".vc-stx-it").first.hover()
    page.locator(".vc-stx-tip").wait_for()
    page.evaluate("previewStore.templates[1].text='Updated fixture content';previewTick.set({v:previewTick.get().v+1})")
    page.locator(".vc-stx-tip").wait_for(state="detached")
    check(page, "store revision dismisses stale hover preview without pointer movement",
          page.locator(".vc-stx-tip").count() == 0)


def diagnostics_scenario(page, width, height):
    settings(page)
    diagnostics = page.get_by_role("region", name="Диагностика", exact=True)
    text = diagnostics.inner_text()
    check(page, "continuous diagnostics has no four-day or automatic-expiry copy",
          not re.search(r"четыр[её]|4\s*(?:дня|дней)|автоматическое отключение|тестовый период заверш", text, re.I), text)
    check(page, "diagnostics is directly below quick input",
          diagnostics.evaluate("e=>e.previousElementSibling?.querySelector('#stx-input-settings')?.textContent") == "Быстрый ввод")
    check(page, "diagnostics recording is active", "Запись идёт" in text)
    diagnostics.evaluate("""e=>{
        const pane=e.closest('.vc-stx-settings'),nav=pane.querySelector('.vc-stx-settings-nav');
        pane.scrollTop+=e.getBoundingClientRect().top-nav.getBoundingClientRect().bottom-90
    }""")
    screenshot(page, f"diagnostics-heading-{width}x{height}")
    check(page, "short JSON report is distinguished from full TXT path and archives",
          diagnostics.get_by_role("button", name="Скачать краткий отчёт", exact=True).count() == 1
          and diagnostics.get_by_role("button", name="Скачать диагностику", exact=True).count() == 0
          and bool(re.search(r"JSON.*2\s*000", text))
          and "TXT" in text and "архив" in text
          and diagnostics.locator(".vc-stx-diagnostic-path").inner_text().endswith(".txt"), text)
    diagnostics.get_by_role("button", name="Скачать краткий отчёт", exact=True).click()
    check(page, "download is fixture-only and gives visible feedback",
          page.evaluate("window.previewDownloads") == 1
          and "Краткий отчёт передан в загрузки" in diagnostics.inner_text()
          and "TXT-файл и архивы" in diagnostics.inner_text())
    check(page, "no horizontal overflow in settings", page.locator(".vc-stx-settings").evaluate("e=>e.scrollWidth<=e.clientWidth+1"))
    screenshot(page, f"diagnostics-{width}x{height}")
    # Native log integration remains mocked; exercise the shared service component.
    page.evaluate("previewUi.set({management:false,windowOpen:false});previewService(true)")
    service = page.locator("#service")
    check(page, "BD service diagnostics has no obsolete four-day copy",
          not re.search(r"четыр[её]|4\s*(?:дня|дней)|автоматическое отключение", service.inner_text(), re.I))
    check(page, "BD service uses the same short-report download label",
          service.get_by_role("button", name="Скачать краткий отчёт", exact=True).count() == 1
          and service.get_by_role("button", name="Скачать диагностику", exact=True).count() == 0)


def sound_scenario(page):
    settings(page, "Тикеты")
    page.wait_for_function("a23Sound.get().loaded")
    enabled = page.get_by_role("checkbox", name="Звук при создании тикета", exact=True)
    enabled.check()
    enabled.uncheck()
    page.wait_for_function("JSON.parse(localStorage.getItem('SupportTemplates_ticketSound_v1'))?.enabled===false")
    check(page, "new-ticket switch persists disabled", storage(page, "SupportTemplates_ticketSound_v1")["enabled"] is False)
    picker(page)
    settings(page, "Тикеты")
    check(page, "new-ticket disabled state survives settings remount", not enabled.is_checked())
    upload = page.get_by_label("Выбрать свой звук", exact=True)
    upload.set_input_files({"name": "a23-tone.wav", "mimeType": "audio/wav", "buffer": b"RIFF-A23-fixture-audio"})
    page.wait_for_function("a23Sound.get().customName==='a23-tone.wav' && !a23Sound.get().loadingSound")
    check(page, "custom sound persists name and bytes through actual controller",
          storage(page, "SupportTemplates_ticketSoundAudio_v1")["name"] == "a23-tone.wav")
    test = page.get_by_role("button", name="Проверить свой звук", exact=True)
    test.click()
    page.get_by_role("button", name="Остановить звук", exact=True).wait_for()
    check(page, "manual custom test works while automatic ticket sounds disabled",
          page.evaluate("a23AudioEvents.some(e=>e.event==='start'&&e.kind==='custom')") and not enabled.is_checked())
    page.get_by_role("button", name="Остановить звук", exact=True).click()
    check(page, "stop terminates custom playback and shows status",
          page.evaluate("!a23Sound.get().playing") and "Воспроизведение остановлено" in page.locator(".vc-stx-tickets").inner_text())
    fresh(page)
    settings(page, "Тикеты")
    page.wait_for_function("a23Sound.get().loaded && a23Sound.get().customName==='a23-tone.wav'")
    check(page, "custom audio and disabled preference survive full reload", not enabled.is_checked()
          and page.get_by_role("button", name="Проверить свой звук", exact=True).count() == 1)
    volume = page.get_by_role("slider", name="Громкость нового тикета", exact=True)
    volume.fill("0")
    check(page, "volume zero disables test and publishes mute explanation", test.is_disabled()
          and "Громкость 0%" in page.locator(".vc-stx-tickets").inner_text())
    volume.fill("65")
    page.evaluate("window.a23DecodeFailure=true")
    upload.set_input_files({"name": "invalid.wav", "mimeType": "audio/wav", "buffer": b"invalid-audio"})
    page.get_by_role("alert").filter(has_text="Не удалось прочитать аудио").wait_for()
    check(page, "decode failure shown without replacing previous custom sound",
          page.evaluate("a23Sound.get().customName") == "a23-tone.wav"
          and storage(page, "SupportTemplates_ticketSoundAudio_v1")["name"] == "a23-tone.wav")
    page.evaluate("window.a23DecodeFailure=false")
    page.get_by_role("button", name="Вернуть стандартный", exact=True).click()
    page.wait_for_function("a23Sound.get().customName===''")
    check(page, "reset clears persisted custom bytes", storage(page, "SupportTemplates_ticketSoundAudio_v1") is None)
    page.get_by_role("button", name="Проверить звук", exact=True).click()
    check(page, "standard test schedules fake oscillators via real controller",
          page.evaluate("a23AudioEvents.filter(e=>e.event==='start'&&e.kind==='standard').length") == 3)
    screenshot(page, "sound-controls")


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, timeout=60000)

    def scenario(name, fn, width=1200, height=900):
        global scenario_name
        scenario_name = name
        context = browser.new_context(viewport={"width": width, "height": height},
                                      offline=True, service_workers="block")
        context.add_init_script(FAKE_AUDIO)

        def route(request_route):
            url = request_route.request.url
            if url.startswith(("file:", "data:", "blob:")):
                request_route.continue_()
            else:
                blocked.append({"scenario": name, "type": request_route.request.resource_type})
                request_route.abort()

        context.route("**/*", route)

        def reject_socket(socket):
            blocked.append({"scenario": name, "type": "websocket"})
            socket.close()

        context.route_web_socket("**/*", reject_socket)
        page = context.new_page()
        page.set_default_timeout(6000)
        page.on("pageerror", lambda error: errors.append({"scenario": name, "error": str(error)}))
        try:
            fresh(page)
            check(page, "isolated context starts with no placement/preferences",
                  storage(page, POSITION_KEY) is None and storage(page, "A23_fixture_preferences") is None)
            fn(page)
        except Exception as error:
            check(page, "scenario completed", False, str(error))
        finally:
            context.close()

    for w, h in [(1200, 900), (427, 640), (320, 568), (427, 320)]:
        scenario(f"geometry {w}x{h}", lambda page, w=w, h=h: geometry_scenario(page, w, h), w, h)
    scenario("tabs, preferences and Ctrl-click", tabs_scenario)
    scenario("side preview resizing", preview_scenario, 1600, 1000)
    scenario("post-review gesture and hover regressions", gesture_race_scenario)
    for w, h in [(1200, 900), (427, 640), (320, 568)]:
        scenario(f"diagnostics {w}x{h}", lambda page, w=w, h=h: diagnostics_scenario(page, w, h), w, h)
    scenario("sound real controller / fake AudioContext", sound_scenario)
    browser.close()

after_hashes = source_hashes()
changed = [name for name in sorted(set(before_hashes) | set(after_hashes))
           if before_hashes.get(name) != after_hashes.get(name)]
for name, passed, detail in [
    ("no uncaught browser errors", not errors, errors),
    ("no unexpected network requests", not blocked, blocked),
    ("source stable through build and run", not changed, changed),
]:
    checks.append({"name": name, "pass": passed, "detail": detail})
report = {
    "createdAt": datetime.now(timezone.utc).isoformat(), "phase": "final" if FINAL else "exploratory",
    "scope": "Real source React UI, placement/ranking and sound controllers. Host/API/panel/preference-store/diagnostic I/O are fixtures; real localStorage persistence. Actual browser pointer gestures. Insertion options observed only; no sends. Fake AudioContext, not audible or native-client acceptance.",
    "checks": checks, "screenshots": screenshots,
    "sourceHashesBefore": before_hashes, "sourceHashesAfter": after_hashes,
    "bundleSha256": sha256((RUN / "app.js").read_bytes()).hexdigest(),
}
(RUN / "regression.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
summary = {"passed": sum(c["pass"] for c in checks), "failed": sum(not c["pass"] for c in checks),
           "report": str(RUN / "regression.json"), "changedSources": changed}
print(json.dumps(summary), flush=True)
sys.exit(0 if all(c["pass"] for c in checks) else 1)
