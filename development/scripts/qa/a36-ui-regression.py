"""A36 grouped reminder acceptance against real source, offline Chromium only.

--prepare builds the fixture without claiming acceptance. Use --final only after
the production owners freeze. All evidence stays in ignored runs/a36-ui children.
No dependencies installed, real tickets opened, API writes or audible output.
"""
import argparse
import ast
import json
import re
import subprocess
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
mode = parser.add_mutually_exclusive_group()
mode.add_argument("--prepare", action="store_true")
mode.add_argument("--final", action="store_true")
args = parser.parse_args()
RUN = ROOT / "scripts/qa/runs/a36-ui" / datetime.now().strftime("%Y%m%d-%H%M%S-%f")
checks, errors, blocked, screenshots = [], [], [], []
scenario_name = ""
tree = ast.parse((ROOT / "scripts/qa/a23-ui-regression.py").read_text(encoding="utf-8"))
names = {"settle", "screenshot", "check", "rect", "fits", "fresh"}
nodes = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names]
assert {n.name for n in nodes} == names
exec(compile(ast.Module(body=nodes, type_ignores=[]), "a23 pure helpers", "exec"))
FAKE_AUDIO = next(ast.literal_eval(n.value) for n in tree.body if isinstance(n, ast.Assign)
                  and any(isinstance(t, ast.Name) and t.id == "FAKE_AUDIO" for t in n.targets))


def source_hashes():
    files = [p for p in (ROOT / "src").rglob("*") if p.suffix in {".ts", ".tsx", ".css"}]
    files += list((ROOT / "betterdiscord").glob("*.tsx")) + list((ROOT / "betterdiscord/shims").glob("*.ts"))
    files += [ROOT / p for p in ["betterdiscord/adapter.css", "distribution/config.json",
              "scripts/qa/q17-ui-harness.mjs", "scripts/qa/a23-ui-regression.py", "scripts/qa/a36-ui-regression.py"]]
    return {p.relative_to(ROOT).as_posix(): sha256(p.read_bytes()).hexdigest() for p in sorted(set(files))}


# Only test inputs/callbacks are added. Actual store, component, CSS, ProjectIcon,
# bounded retention, timers, action guards and React event handlers remain real.
DRIVER = r"""()=>{
 const store=window.a29Notices;
 window.a36={calls:[],opened:[],releases:{},valid:{},ids:{},events:[]};
 for(const type of ['focusin','focusout','pointerenter','pointerleave'])document.addEventListener(type,e=>{
  if(e.target?.matches?.('.vc-stx-reminder-notice,.vc-stx-reminder-open,#chat-draft'))
   a36.events.push({type,target:e.target.className||e.target.id,at:performance.now()});
 },true);
 window.a36Add=({project='majestic',key,label,waitingMs=300000,pending=false,fail=false,test=false})=>{
  a36.valid[key]=true;
  store.showReminderNotification(project,{valid:()=>a36.valid[key],test,
   ticket:{key,label:label??key,waitingMs},
   open:async current=>{
    a36.calls.push(key);
    if(pending)await new Promise(resolve=>a36.releases[key]=resolve);
    if(!current()||fail)return false;
    a36.opened.push(key);return true;
   }});
  const item=store.reminderNotifications.get().items.at(-1);
  if(item)a36.ids[key]=item.id;
 };
 window.a36Reset=()=>{store.clearReminderNotifications();a36.calls=[];a36.opened=[];a36.valid={};a36.releases={};a36.ids={}};
 previewUi.set({management:false,windowOpen:false});
}"""
before = source_hashes()
subprocess.run(["node", "scripts/qa/q17-ui-harness.mjs", str(RUN), "--a29"], cwd=ROOT, check=True)
(RUN / "fixture-driver.js").write_text(DRIVER, encoding="utf-8")
contract = {"phase": "prepared" if args.prepare else "final" if args.final else "exploratory",
            "version": json.loads((ROOT / "distribution/config.json").read_text())["version"],
            "viewports": [[320, 640], [900, 720], [1100, 820]], "sourceHashesBefore": before,
            "limits": ["Source React components, not installed Discord or packaged release",
                       "A29 API/host stores/delivery scheduler/native bridges mocked",
                       "Guarded local action callbacks instead of real ticket navigation",
                       "Fake audio; no sound. Chromium CSS pixels, no native DPI validation",
                       "TTL advanced with Playwright clock; wall-clock timing not benchmarked"]}
(RUN / "contract.json").write_text(json.dumps(contract, ensure_ascii=False, indent=2), encoding="utf-8")
if args.prepare:
    print(json.dumps({"prepared": str(RUN), "acceptance": False}))
    raise SystemExit(0)


def group(page, project="majestic"):
    return page.locator(".vc-stx-reminder-notice-" + ("mj" if project == "majestic" else "ro"))


def add(page, key, project="majestic", **options):
    page.evaluate("a36Add", {"key": key, "project": project, **options})
    settle(page)


def layout(page, width, height, label):
    cards = page.locator(".vc-stx-reminder-notice")
    boxes = cards.evaluate_all("""els=>els.map(e=>{const r=e.getBoundingClientRect();return {
      x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height,
      scroll:e.scrollWidth,client:e.clientWidth}})""")
    check(page, label + " cards fit viewport without horizontal overflow",
          bool(boxes) and all(fits(b, width, height) and b["scroll"] <= b["client"] + 1 for b in boxes), boxes)
    check(page, label + " cards do not overlap", all(a["bottom"] <= b["y"] + 1 or b["bottom"] <= a["y"] + 1
          for i, a in enumerate(boxes) for b in boxes[i+1:]))
    icons = cards.locator("img.vc-stx-pi").evaluate_all("""els=>els.map(e=>{
      const r=e.getBoundingClientRect(),card=e.closest('.vc-stx-reminder-notice').getBoundingClientRect();
      return {loaded:e.complete&&e.naturalWidth>0,src:e.currentSrc.split(':')[0],
        width:r.width,height:r.height,declared:parseFloat(e.style.width),
        inside:r.x>=card.x&&r.right<=card.right&&r.y>=card.y&&r.bottom<=card.bottom};})""")
    check(page, label + " actual embedded project images retain square dimensions/alignment", len(icons) == len(boxes)
          and all(i["loaded"] and i["src"] == "data" and i["width"] >= 16 and abs(i["width"]-i["height"]) < 1
                  and abs(i["width"]-i["declared"]) < 1 and i["inside"] for i in icons), icons)
    check(page, label + " group dismiss controls are reachable", cards.locator(".vc-stx-reminder-dismiss").evaluate_all("""els=>els.every(e=>{
      const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})"""))


def grouping(page, width, height):
    for project in ["majestic", "russia-online"]:
        page.evaluate("a36Reset()")
        add(page, "101", project, waitingMs=420000)
        card = group(page, project)
        check(page, project + " single has direct action and no list toggle", card.count() == 1
              and card.locator(".vc-stx-reminder-open").count() == 1 and card.locator(".vc-stx-reminder-toggle").count() == 0)
        check(page, project + " ticket metadata reaches store", page.evaluate("a29Notices.reminderNotifications.get().items[0].waitingMinutes") == 7)
        layout(page, width, height, project + " single")
        screenshot(page, f"single-{project}-{width}")
        add(page, "102", project)
        add(page, "103", project)
        toggle = card.locator(".vc-stx-reminder-toggle")
        check(page, project + " three arrivals stay one collapsed card", card.count() == 1
              and toggle.get_attribute("aria-expanded") == "false" and not card.locator(".vc-stx-reminder-list").is_visible())
        toggle.click()
        check(page, project + " three tickets expand on user action", toggle.get_attribute("aria-expanded") == "true"
              and card.locator(".vc-stx-reminder-list .vc-stx-reminder-open").count() == 3)
        layout(page, width, height, project + " three expanded")
        screenshot(page, f"three-{project}-{width}")
        toggle.click()
        for key in ["104", "105", "106", "107"]:
            add(page, key, project)
        check(page, project + " more than three remain collapsed on arrival", toggle.get_attribute("aria-expanded") == "false"
              and page.evaluate("a29Notices.reminderNotifications.get().items.length") == 7)
        toggle.click()
        rows = card.locator(".vc-stx-reminder-list .vc-stx-reminder-open")
        check(page, project + " expanded list retains seven distinct actions", rows.count() == 7)
        list_box = card.locator(".vc-stx-reminder-list").evaluate("e=>({height:e.getBoundingClientRect().height,scroll:e.scrollHeight,client:e.clientHeight})")
        check(page, project + " long list is bounded and scrollable", list_box["height"] <= 261
              and list_box["scroll"] > list_box["client"], list_box)
        layout(page, width, height, project + " seven expanded")
        screenshot(page, f"seven-{project}-{width}")
        # Match rendered action to its label, rather than assuming list sort order.
        target = rows.filter(has=page.get_by_text("103", exact=True))
        check(page, project + " ticket row is individually identifiable", target.count() == 1)
        target.click()
        page.wait_for_function("a36.opened.length===1")
        check(page, project + " row invokes matching guarded callback only", page.evaluate("[a36.calls,a36.opened]") == [["103"], ["103"]])
        rows.filter(has=page.get_by_text("107", exact=True)).click()
        page.wait_for_function("a36.opened.length===2")
        check(page, project + " last row remains reachable through list scrolling", page.evaluate("a36.opened") == ["103", "107"])
    page.evaluate("a36Reset()")
    for project, prefix in [("majestic", "2"), ("russia-online", "3")]:
        for i in range(3):
            add(page, prefix + str(i), project)
    mj, ro = group(page), group(page, "russia-online")
    check(page, "both servers arrive as compact collapsed groups", mj.locator(".vc-stx-reminder-toggle").get_attribute("aria-expanded") == "false"
          and ro.locator(".vc-stx-reminder-toggle").get_attribute("aria-expanded") == "false")
    page.evaluate("()=>Promise.all(document.getAnimations().filter(a=>a.effect.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))")
    filename = f"both-groups-compact-{width}.png"
    page.locator(".vc-stx-reminder-notices").screenshot(path=str(RUN / filename))
    screenshots.append(filename)
    mj.locator(".vc-stx-reminder-toggle").click()
    check(page, "two servers expand independently", mj.locator(".vc-stx-reminder-list").is_visible()
          and ro.locator(".vc-stx-reminder-toggle").get_attribute("aria-expanded") == "false")
    layout(page, width, height, "two servers")
    screenshot(page, f"two-servers-{width}")
    filename = f"both-groups-expanded-{width}.png"
    page.locator(".vc-stx-reminder-notices").screenshot(path=str(RUN / filename))
    screenshots.append(filename)
    mj.locator(".vc-stx-reminder-dismiss").click()
    check(page, "group close preserves other server", mj.count() == 0 and ro.count() == 1
          and page.evaluate("a29Notices.reminderNotifications.get().items.length") == 3)
    # Drive validity changes through the real timer, not direct React state edits.
    page.evaluate("a36.valid['30']=false")
    page.clock.fast_forward(1100)
    check(page, "three to two preserves group toggle", page.evaluate("a29Notices.reminderNotifications.get().items.length") == 2
          and ro.locator(".vc-stx-reminder-toggle").count() == 1)
    page.evaluate("a36.valid['31']=false")
    page.clock.fast_forward(1100)
    check(page, "two to one restores direct action", ro.locator(".vc-stx-reminder-toggle").count() == 0
          and ro.locator(".vc-stx-reminder-open").count() == 1)
    page.evaluate("a36.valid['32']=false")
    page.clock.fast_forward(1100)
    check(page, "one to zero removes group", page.locator(".vc-stx-reminder-notice").count() == 0)


def keyboard(page, width, height):
    add(page, "401")
    add(page, "402")
    card = group(page)
    toggle = card.locator(".vc-stx-reminder-toggle")
    page.locator("#chat-draft").focus()
    reached = False
    for _ in range(10):
        page.keyboard.press("Tab")
        if toggle.evaluate("e=>document.activeElement===e"):
            reached = True
            break
    check(page, "Tab reaches group toggle", reached)
    page.keyboard.press("Enter")
    check(page, "Enter expands group", toggle.get_attribute("aria-expanded") == "true")
    row = card.locator(".vc-stx-reminder-list .vc-stx-reminder-open").first
    reached = False
    for _ in range(5):
        page.keyboard.press("Tab")
        if row.evaluate("e=>document.activeElement===e"):
            reached = True
            break
    check(page, "Tab reaches first ticket row", reached)
    page.keyboard.press("Escape")
    check(page, "Escape collapses list and restores toggle focus", toggle.get_attribute("aria-expanded") == "false"
          and toggle.evaluate("e=>document.activeElement===e"))
    page.keyboard.press("Enter")
    row.focus()
    label = re.search(r"40[12]", row.inner_text()).group()
    page.keyboard.press("Enter")
    page.wait_for_function("a36.opened.length===1")
    check(page, "Enter activates only focused ticket", page.evaluate("a36.opened") == [label])
    layout(page, width, height, "keyboard remaining single")


def lifecycle(page, width, height):
    add(page, "501", pending=True)
    button = group(page).locator(".vc-stx-reminder-open")
    button.click()
    check(page, "pending action disables duplicate click", button.is_disabled())
    page.evaluate("a29Notices.activateReminderNotification(a36.ids['501'])")
    check(page, "duplicate activation calls handler once", page.evaluate("a36.calls") == ["501"])
    group(page).locator(".vc-stx-reminder-dismiss").click()
    page.evaluate("a36.releases['501']()")
    settle(page)
    check(page, "dismiss during pending invalidates callback without resurrection", page.evaluate("a36.opened.length") == 0
          and group(page).count() == 0)
    add(page, "502", pending=True)
    group(page).locator(".vc-stx-reminder-open").click()
    page.mouse.move(2, 2)
    page.locator("#chat-draft").focus()
    page.clock.fast_forward(46000)
    expiry_detail = page.evaluate("({items:a29Notices.reminderNotifications.get().items,focus:document.activeElement.outerHTML,events:a36.events})")
    page.evaluate("a36.releases['502']()")
    settle(page)
    check(page, "expiry during pending invalidates callback", page.evaluate("a36.opened.length") == 0 and group(page).count() == 0, expiry_detail)
    add(page, "503")
    group(page).hover()
    page.clock.fast_forward(46000)
    check(page, "pointer interaction pauses TTL", group(page).count() == 1)
    page.mouse.move(2, 2)
    group(page).locator(".vc-stx-reminder-open").focus()
    page.clock.fast_forward(46000)
    check(page, "keyboard focus pauses TTL", group(page).count() == 1)
    page.locator("#chat-draft").focus()
    page.clock.fast_forward(46000)
    check(page, "TTL resumes after pointer and focus leave", group(page).count() == 0)
    add(page, "504", fail=True)
    group(page).locator(".vc-stx-reminder-open").click()
    group(page).get_by_role("alert").wait_for()
    check(page, "failed guarded action stays retryable", group(page).locator(".vc-stx-reminder-open").is_enabled()
          and page.evaluate("a36.opened.includes('504')") is False)
    layout(page, width, height, "action failure")
    screenshot(page, f"action-failure-{width}")


def ordering_focus(page, width, height):
    add(page, "601", waitingMs=125000)
    add(page, "602", waitingMs=170000)
    card = group(page)
    card.locator(".vc-stx-reminder-toggle").click()
    card.hover()
    labels = card.locator(".vc-stx-reminder-ticket-label")
    check(page, "precise wait sorts older ticket first despite equal rounded minutes",
          labels.all_text_contents() == ["602", "601"], labels.all_text_contents())
    for elapsed, advance in [(10, 10000), (55, 45000)]:
        page.clock.fast_forward(advance)
        settle(page)
        check(page, f"row order stable at {elapsed}s with hover held", labels.all_text_contents() == ["602", "601"],
              {"labels": labels.all_text_contents(), "waiting": card.locator(".vc-stx-reminder-wait").all_text_contents()})
    check(page, "elapsed waiting minutes refresh while interaction pauses expiry",
          card.locator(".vc-stx-reminder-wait").all_text_contents() == ["3 мин", "3 мин"])
    screenshot(page, f"stable-wait-order-{width}")
    page.evaluate("a36Reset()")
    add(page, "701")
    add(page, "702")
    card.locator(".vc-stx-reminder-toggle").click()
    row = card.locator(".vc-stx-reminder-list .vc-stx-reminder-open").filter(has=page.get_by_text("701", exact=True))
    row.focus()
    page.mouse.move(2, 2)
    check(page, "dedup fixture starts focused on keyed row with pointer outside", row.evaluate("e=>document.activeElement===e")
          and not card.evaluate("e=>e.matches(':hover')"))
    old_id = page.evaluate("a36.ids['701']")
    add(page, "701")
    check(page, "same-key replacement removes old focused DOM node without navigation",
          page.evaluate("a36.ids['701']") != old_id and row.count() == 1
          and page.evaluate("a36.calls.length") == 0 and not card.evaluate("e=>e.contains(document.activeElement)"))
    page.locator("#chat-draft").focus()
    settle(page)
    page.clock.fast_forward(46000)
    settle(page)
    check(page, "replaced row leaves no orphan focus TTL and never steals external focus", card.count() == 0
          and page.locator("#chat-draft").evaluate("e=>document.activeElement===e"))
    # A validity-based removal must also release a now-nonexistent row's focus.
    add(page, "703")
    add(page, "704")
    card.locator(".vc-stx-reminder-toggle").click()
    card.locator(".vc-stx-reminder-list .vc-stx-reminder-open").filter(has=page.get_by_text("703", exact=True)).focus()
    page.mouse.move(2, 2)
    page.evaluate("a36.valid['703']=false")
    page.clock.fast_forward(1100)
    settle(page)
    check(page, "invalidated focused row leaves one direct action without stealing focus",
          card.locator(".vc-stx-reminder-toggle").count() == 0 and card.locator(".vc-stx-reminder-open").count() == 1
          and not card.evaluate("e=>e.contains(document.activeElement)"))
    page.locator("#chat-draft").focus()
    page.clock.fast_forward(46000)
    settle(page)
    check(page, "remaining notice expires after focused row removal", card.count() == 0
          and page.locator("#chat-draft").evaluate("e=>document.activeElement===e"))


with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True, timeout=60000)
    for width, height in contract["viewports"]:
        for name, scenario in [("groups", grouping), ("keyboard", keyboard), ("lifecycle", lifecycle), ("order/focus", ordering_focus)]:
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
            # Install before module initialization creates any timers. Mixing
            # pre-install native handles with the virtual clock invalidates TTL QA.
            page.clock.install()
            page.set_default_timeout(4000)
            page.on("pageerror", lambda error: errors.append({"scenario": scenario_name, "error": str(error)}))
            try:
                fresh(page)
                page.evaluate("a29Ready")
                page.evaluate(DRIVER)
                baseline = page.evaluate("JSON.stringify([a29Api,a23AudioEvents,{...localStorage},a29Navigation])")
                scenario(page, width, height)
                check(page, "no API/audio/storage/navigation side effects", baseline == page.evaluate("JSON.stringify([a29Api,a23AudioEvents,{...localStorage},a29Navigation])"))
                check(page, "no insertion/compose or draft changes", page.evaluate("a23InsertionCalls.length+a23ComposeCalls.length") == 0
                      and page.locator("#chat-draft").input_value() == "Не отправлять")
            except Exception as error:
                check(page, "scenario completed", False, str(error))
            finally:
                context.close()
    browser.close()
after = source_hashes()
changed = sorted(p for p in set(before) | set(after) if before.get(p) != after.get(p))
checks += [{"name": "no browser errors", "pass": not errors, "detail": errors},
           {"name": "no external requests", "pass": not blocked, "detail": blocked},
           {"name": "source inputs unchanged", "pass": not changed, "detail": changed}]
report = {**contract, "createdAt": datetime.now(timezone.utc).isoformat(), "checks": checks,
          "screenshots": screenshots, "sourceHashesAfter": after, "changedSources": changed}
(RUN / "regression.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
failed = sum(not c["pass"] for c in checks)
print(json.dumps({"passed": len(checks)-failed, "failed": failed, "report": str(RUN / "regression.json")}), flush=True)
raise SystemExit(1 if failed else 0)
