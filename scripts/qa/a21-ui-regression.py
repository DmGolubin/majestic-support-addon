"""A21 offline source-component acceptance.

Run: python -u scripts/qa/a21-ui-regression.py [NEW_RUN_DIRECTORY]
Builds the existing Q17 harness unless the supplied directory is a fresh Q17
build. Writes only new evidence under scripts/qa/runs/a21-* (or runs/a21-ui/*).
Exit 1 means an acceptance check failed; inspect a21-results.json and screenshots.
No release bundles, Discord processes, accounts, or network services are used.
"""
import hashlib
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
RUN = (Path(sys.argv[1]) if len(sys.argv) > 1 else
       ROOT / "scripts/qa/runs/a21-ui" / datetime.now().strftime("%Y%m%d-%H%M%S")).resolve()
ALLOWED = ROOT / "scripts/qa/runs"
if not RUN.is_relative_to(ALLOWED) or not RUN.relative_to(ALLOWED).parts[0].startswith("a21-"):
    raise RuntimeError("Use an A21 directory under scripts/qa/runs")
if (RUN / "a21-results.json").exists() or (RUN / "a21-instrumentation.json").exists():
    raise RuntimeError("Evidence is immutable: use a fresh run directory")
if not RUN.exists():
    subprocess.run(["node", "scripts/qa/q17-ui-harness.mjs", str(RUN)], cwd=ROOT, check=True)


def digest(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


sources = list((ROOT / "src/vencord/ui").glob("*.tsx"))
sources += list((ROOT / "src/vencord/ui").glob("*.css"))
sources += [ROOT / name for name in [
    "src/vencord/styles.css", "src/vencord/buildDisplay.ts",
    "scripts/qa/q17-ui-harness.mjs", "betterdiscord/adapter.css",
    "betterdiscord/ServiceSettings.tsx"]]
hashes = {p.relative_to(ROOT).as_posix(): digest(p) for p in sources}
bundle = RUN / "app.js"
code = bundle.read_text(encoding="utf-8")
original_hash = digest(bundle)
start = code.index("// stub:panel")
end = code.index("// stub:state", start)
stub = code[start:end]
patches = {
    "var reloadPanel = async () => {\n  };": """var reloadPanel = async () => {
    window.a21Reloads = (window.a21Reloads || 0) + 1;
    if (window.a21FailReload) throw Error("A21 fixture reload failure");
    panel.set({phase:"ready", error:""});
  };""",
    "var retryPanelPreferences = async () => {\n  };": """var retryPanelPreferences = async () => {
    window.a21PreferenceRetries = (window.a21PreferenceRetries || 0) + 1;
    panel.set({preferencesError:""});
  };""",
    "window.lastMutation = req;": """window.lastMutation = req;
    if (window.a21HoldWrite) await new Promise(resolve => { window.a21ReleaseWrite = resolve; });"""
}
for old, new in patches.items():
    if stub.count(old) != 1:
        raise RuntimeError("Q17 stub shape changed; refusing to patch: " + old)
    stub = stub.replace(old, new)
bundle.write_text(code[:start] + stub + code[end:], encoding="utf-8")
(RUN / "a21-instrumentation.json").write_text(json.dumps({
    "scope": "Only generated // stub:panel functions instrumented; product components unchanged",
    "originalBundleSha256": original_hash, "instrumentedBundleSha256": digest(bundle),
    "patches": patches, "sourceHashes": hashes
}, ensure_ascii=False, indent=2), encoding="utf-8")

checks, errors, blocked, screenshots = [], [], [], []
current = ""


def settle(page):
    page.evaluate("() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")


def shot(page, name):
    filename = re.sub(r"[^a-zA-Z0-9_-]", "-", name) + ".png"
    page.screenshot(path=str(RUN / filename))
    if filename not in screenshots:
        screenshots.append(filename)
    return filename


def check(page, name, passed, detail=None):
    row = {"name": current + " / " + name, "pass": bool(passed), "detail": detail}
    if not passed:
        row["screenshot"] = shot(page, "failure-" + str(len(checks) + 1))
    checks.append(row)
    print(("PASS " if passed else "FAIL ") + row["name"], flush=True)


def measure(loc):
    return loc.evaluate("""e => { const b=e.getBoundingClientRect(), s=getComputedStyle(e);
      return {x:b.x,y:b.y,width:b.width,height:b.height,right:b.right,bottom:b.bottom,
        clientWidth:e.clientWidth,scrollWidth:e.scrollWidth,clientHeight:e.clientHeight,
        scrollHeight:e.scrollHeight,display:s.display,fontSize:s.fontSize,
        borderTopWidth:s.borderTopWidth,background:s.backgroundColor,
        backdropFilter:s.backdropFilter}; }""")


def fits(box, width, height):
    return box["x"] >= -1 and box["y"] >= -1 and box["right"] <= width + 1 and box["bottom"] <= height + 1


def fresh(page, distribution, width=1200, height=900):
    page.set_viewport_size({"width": width, "height": height})
    page.goto((RUN / "index.html").as_uri() + "?distribution=" + distribution,
              wait_until="networkidle")
    page.locator(".vc-stx-management").wait_for()
    settle(page)


def tab(page, name):
    page.get_by_role("button", name=name, exact=True).click()
    settle(page)


def background(page):
    # Avoid Q17's debug controls, titlebar, and the centered product dialog.
    page.mouse.click(3, page.viewport_size["height"] // 2)
    settle(page)


def account_case(page, dist):
    fresh(page, dist)
    tab(page, "Настройки")
    account = page.get_by_role("region", name="Аккаунт и синхронизация", exact=True)
    check(page, "normal connected account", account.get_by_role("status").inner_text() == "Подключён"
          and "Preview account" in account.inner_text())
    b = measure(account)
    check(page, "compact account styling", b["height"] < 220 and b["borderTopWidth"] == "1px", b)
    servers = account.locator(".vc-stx-supported-server")
    names = servers.all_inner_texts()
    check(page, "three supported servers only", names == ["Majestic", "Россия Онлайн", "Tech"], names)
    icons = servers.locator(":scope > img, :scope > .vc-stx-pi")
    icon_info = icons.evaluate_all("""els=>els.map(e=>({w:e.getBoundingClientRect().width,
      h:e.getBoundingClientRect().height,loaded:e.tagName!=="IMG" || e.complete && e.naturalWidth>0}))""")
    check(page, "supported server fallback icons render at 18px",
          len(icon_info) == 3 and all(i["loaded"] and i["w"] == 18 and i["h"] == 18 for i in icon_info), icon_info)
    identity = page.locator(".vc-stx-settings > .vc-stx-hint").first
    label = ("SupportTemplates Lite" if dist == "standalone" else "SupportTemplates") + " · 1.0.1 · тестовая"
    check(page, "common short build label with technical tooltip",
          identity.inner_text() == label and "1.0.1-canary.21" in identity.get_attribute("title")
          and "UI fixture" in identity.get_attribute("title"), identity.inner_text())
    check(page, "normal account omits verbose status panels",
          account.locator(".vc-stx-local-note").count() == 0
          and account.get_by_role("button").all_text_contents() == ["Выйти"])
    shot(page, dist + "-general")
    page.evaluate("previewPanel.set({phase:'offline'})")
    settle(page)
    retry = account.get_by_role("button", name="Повторить", exact=True)
    check(page, "offline status exposes retry", account.get_by_role("status").inner_text() == "Нет связи"
          and retry.is_enabled())
    page.evaluate("window.a21FailReload=true")
    retry.click()
    account.get_by_role("alert").wait_for()
    check(page, "failed retry remains offline and retryable",
          page.evaluate("window.a21Reloads") == 1 and retry.is_enabled()
          and "Не удалось выполнить действие" in account.get_by_role("alert").inner_text())
    shot(page, dist + "-offline-retry")
    page.evaluate("window.a21FailReload=false")
    retry.click()
    page.wait_for_function("previewPanel.get().phase === 'ready'")
    settle(page)
    check(page, "successful mock retry restores normal status",
          page.evaluate("window.a21Reloads") == 2 and account.get_by_role("status").inner_text() == "Подключён"
          and account.get_by_role("alert").count() == 0)
    page.evaluate("previewPanel.set({preferencesError:'write'})")
    account.get_by_role("button", name="Повторить сохранение", exact=True).click()
    settle(page)
    check(page, "preferences retry calls stub and clears error",
          page.evaluate("window.a21PreferenceRetries") == 1 and account.get_by_role("alert").count() == 0)


def close_case(page, dist):
    fresh(page, dist)
    backdrop = page.locator(".vc-stx-management-backdrop")
    check(page, "blur backdrop excludes default top 36px",
          measure(backdrop)["y"] == 36 and measure(backdrop)["backdropFilter"] == "blur(4px)", measure(backdrop))
    page.locator(".vc-stx-management > header b").click()
    check(page, "inside click does not close", page.locator(".vc-stx-management").count() == 1)
    # Low stacking level intentionally models native chrome below the product host.
    page.evaluate("""() => {
      for (let i=0;i<3;i++) {
        const e=document.createElement('button');e.id='a21-chrome-'+i;
        e.textContent=['Minimize','Maximize','Close'][i];
        e.style.cssText=`position:fixed;right:${i*90}px;top:0;height:32px;width:88px;z-index:1`;
        e.onclick=()=>window.a21ChromeClicks=(window.a21ChromeClicks||0)+1;
        document.body.append(e);
      }
    }""")
    for height in [36, 52, 28]:
        page.evaluate("(h)=>document.documentElement.style.setProperty('--custom-app-top-bar-height',h+'px')", height)
        settle(page)
        for i in range(3):
            page.mouse.click(1200 - i * 90 - 44, 20)
        check(page, f"chrome buttons clickable at y20 with topbar {height}",
              page.evaluate("window.a21ChromeClicks") == [36, 52, 28].index(height) * 3 + 3
              and page.locator(".vc-stx-management").count() == 1 and measure(backdrop)["y"] == height)
    shot(page, dist + "-native-chrome")
    background(page)
    check(page, "clean background closes", page.locator(".vc-stx-management").count() == 0)
    fresh(page, dist)
    tab(page, "Настройки")
    prefix = page.get_by_role("textbox", name="Префикс команды")
    prefix.fill("!")
    background(page)
    check(page, "dirty background opens confirmation",
          page.locator(".vc-stx-close-confirm").count() == 1
          and page.locator(".vc-stx-management").count() == 1 and prefix.input_value() == "!")
    shot(page, dist + "-dirty-confirm")
    page.get_by_role("button", name="Вернуться", exact=True).click()
    check(page, "return keeps draft", prefix.input_value() == "!" and page.locator(".vc-stx-close-confirm").count() == 0)
    background(page)
    page.get_by_role("button", name="Закрыть без сохранения", exact=True).click()
    check(page, "explicit discard closes without saving", page.locator(".vc-stx-management").count() == 0
          and page.evaluate("previewStore.data.prefix") == ";")


def busy_case(page, dist):
    fresh(page, dist)
    page.get_by_role("button", name="Добавить шаблон", exact=True).click()
    title = page.get_by_role("textbox", name="Название", exact=True)
    title.fill("A21 local fixture draft")
    page.get_by_role("textbox", name="Текст шаблона", exact=True).fill("Offline fixture only")
    background(page)
    check(page, "personal dirty background confirmation", page.locator(".vc-stx-close-confirm").count() == 1)
    page.get_by_role("button", name="Вернуться", exact=True).click()
    page.evaluate("window.a21HoldWrite=true")
    page.get_by_role("button", name="Сохранить на панели", exact=True).click()
    page.wait_for_function("typeof window.a21ReleaseWrite === 'function'")
    settle(page)
    background(page)
    check(page, "pending save blocks background close and confirmation",
          page.locator(".vc-stx-management").count() == 1
          and page.locator(".vc-stx-close-confirm").count() == 0 and title.input_value() == "A21 local fixture draft")
    check(page, "pending save disables header close and tab changes",
          page.locator(".vc-stx-management > header button").is_disabled()
          and all(b.is_disabled() for b in page.locator(".vc-stx-settings-nav button").all()))
    page.locator(".vc-stx-management").press("Escape")
    check(page, "pending save ignores Escape", page.locator(".vc-stx-management").count() == 1
          and page.locator(".vc-stx-close-confirm").count() == 0)
    shot(page, dist + "-busy-guard")
    page.evaluate("window.a21ReleaseWrite()")
    page.get_by_role("button", name="Добавить шаблон", exact=True).wait_for()
    background(page)
    check(page, "background closes after save resolves", page.locator(".vc-stx-management").count() == 0)


def menu_case(page, dist, width=1200, height=900):
    fresh(page, dist, width, height)
    page.evaluate("previewUi.set({management:false,windowOpen:true})")
    menu = page.locator(".vc-stx-win")
    menu.wait_for()
    settle(page)
    count = menu.locator(".vc-stx-n")
    check(page, "single top total counter", count.count() == 1 and count.inner_text() == "6 шаблонов"
          and menu.locator(".vc-stx-proj .vc-stx-n").count() == 1, count.all_inner_texts())
    category = page.get_by_role("combobox", name="Категория шаблонов")
    category.click()
    labels = page.get_by_role("option").all_inner_texts()
    expected = ["Все категории", "Частые проблемы", "Навигация", "Проблемы с Rockstar Launcher",
                "Общий перечень проблем", "Мои шаблоны"]
    check(page, "category options have no counts", sorted(labels) == sorted(expected), labels)
    page.get_by_role("option", name="Частые проблемы", exact=True).click()
    settle(page)
    check(page, "category counter uses filtered N из total", count.inner_text() == "2 из 6", count.inner_text())
    search = page.get_by_role("textbox", name="Поиск шаблонов")
    search.fill("Legacy")
    settle(page)
    check(page, "combined filter counter", count.inner_text() == "1 из 6", count.inner_text())
    search.fill("zzzzmissing")
    settle(page)
    check(page, "zero result counter", count.inner_text() == "0 из 6", count.inner_text())
    search.fill("")
    page.get_by_role("button", name="Сбросить категорию", exact=True).click()
    menu.get_by_role("button", name="Недавние", exact=True).click()
    settle(page)
    check(page, "recent counter", count.inner_text() == "2 из 6", count.inner_text())
    menu.get_by_role("button", name=re.compile("^Избранное")).click()
    settle(page)
    check(page, "favorites counter", count.inner_text() == "0 из 6", count.inner_text())
    menu.get_by_role("button", name="Все", exact=True).click()
    settle(page)
    check(page, "reset restores total and no duplicate category counters",
          count.count() == 1 and count.inner_text() == "6 шаблонов"
          and menu.locator(".vc-stx-filter-count, .vc-stx-sec i, .vc-stx-sec .vc-stx-n").count() == 0)
    footer = menu.locator(".vc-stx-foot")
    box, foot = measure(menu), measure(footer)
    check(page, "menu fits viewport", fits(box, width, height), box)
    check(page, "footer compact styled and no clipped shortcuts",
          foot["display"] == "flex" and foot["borderTopWidth"] == "1px"
          and foot["scrollWidth"] <= foot["clientWidth"] + 1 and foot["height"] <= 42
          and footer.locator(":scope > span").count() == 4, foot)
    shot(page, f"{dist}-menu-{width}x{height}")


def layout_case(page, dist, width, height):
    fresh(page, dist, width, height)
    boxes = []
    for name in ["Мои шаблоны", "Настройки", "Тикеты"]:
        tab(page, name)
        box = measure(page.locator(".vc-stx-management"))
        content = measure(page.locator(".vc-stx-settings"))
        boxes.append(box)
        check(page, name + " stays inside viewport", fits(box, width, height), box)
        check(page, name + " no horizontal overflow", content["scrollWidth"] <= content["clientWidth"] + 1, content)
    check(page, "stable dimensions across three tabs",
          all(abs(b["width"]-boxes[0]["width"]) < 1 and abs(b["height"]-boxes[0]["height"]) < 1 for b in boxes), boxes)
    tab(page, "Настройки")
    shot(page, f"{dist}-settings-{width}x{height}")
    page.locator(".vc-stx-prefix-control").scroll_into_view_if_needed()
    check(page, "last general control reachable after scroll",
          fits(measure(page.locator(".vc-stx-prefix-control")), width, height),
          measure(page.locator(".vc-stx-prefix-control")))


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
    page.set_default_timeout(5000)
    page.on("pageerror", lambda e: errors.append({"scenario": current, "error": str(e)}))
    for dist in ["betterdiscord", "vencord", "standalone"]:
        cases = [("account", lambda: account_case(page, dist)),
                 ("backdrop", lambda: close_case(page, dist)),
                 ("busy", lambda: busy_case(page, dist)),
                 ("menu desktop", lambda: menu_case(page, dist)),
                 ("menu narrow", lambda: menu_case(page, dist, 427, 320))]
        for w, h in [(1200, 900), (640, 480), (427, 320), (320, 480)]:
            cases.append((f"layout {w}x{h}", lambda w=w, h=h: layout_case(page, dist, w, h)))
        for name, run in cases:
            current = dist + " " + name
            try:
                run()
            except Exception as exc:
                check(page, "scenario completed", False, str(exc))
    current = "environment"
    check(page, "no uncaught browser errors", not errors, errors)
    check(page, "no unexpected network attempts", not blocked, blocked)
    changed = [name for name, sha in hashes.items() if digest(ROOT / name) != sha]
    check(page, "source snapshot unchanged during run", not changed, changed)
    result = {
        "createdAt": datetime.now(timezone.utc).isoformat(), "browser": browser.version,
        "scope": "Q17 source-component fixture with A21 stub-only instrumentation",
        "network": {"offline": True, "serviceWorkers": "block", "httpAndWebSocketDeny": True, "blocked": blocked},
        "limits": [
            "Not real Discord, Electron/native window chrome, or packaged distribution acceptance.",
            "Three distribution query values share one source bundle and mocked stores/API.",
            "Retry success and pending save are controlled API stubs, not backend integration.",
            "GuildStore returns null: bundled fallback server icons checked; live CDN icons untested.",
            "Viewport dimensions model available CSS space, not actual Electron zoom.",
            "Mock window controls are DOM buttons: tests hit testing at y=20, not native OS behavior."
        ],
        "passed": sum(c["pass"] for c in checks), "failed": sum(not c["pass"] for c in checks),
        "checks": checks, "errors": errors, "screenshots": screenshots, "sourceHashes": hashes
    }
    (RUN / "a21-results.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    report = [f"# A21 source UI regression\n\n{result['passed']} passed; {result['failed']} failed.\n",
              "## Failures\n"]
    report += [f"- {c['name']}: {json.dumps(c['detail'], ensure_ascii=False)} "
               f"([screenshot]({c['screenshot']}))" for c in checks if not c["pass"]]
    report += ["\n## Limits\n"] + ["- " + limit for limit in result["limits"]]
    (RUN / "a21-report.md").write_text("\n".join(report), encoding="utf-8")
    browser.close()
print(f"{result['passed']} passed; {result['failed']} failed. Evidence: {RUN}", flush=True)
sys.exit(1 if result["failed"] else 0)
