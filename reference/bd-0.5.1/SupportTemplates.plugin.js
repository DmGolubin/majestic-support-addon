/**
 * @name SupportTemplates
 * @author you
 * @description Кнопка с шаблонами ответов в строке ввода сообщения. Наборы шаблонов для разных серверов выбираются автоматически. Шаблон вставляется в поле ввода, отправляешь сам.
 * @version 0.5.1
 */

// Необязательно: ссылка на текстовый файл или JSON с шаблонами (формат см. в настройках плагина).
// Если задана, шаблоны подтягиваются при запуске и по кнопке "Обновить с сайта" в настройках.
// Страницы, которые требуют входа в аккаунт, таким способом не загрузятся.
const TEMPLATES_URL = "";

// Открывать окно шаблонов по Ctrl+Alt+T
const OPEN_HOTKEY_ENABLED = true;

// Alt+1 … Alt+9 вставляют 1–9-й шаблон списка (для открытого сервера) без открытия окна
const QUICK_HOTKEYS_ENABLED = true;

// Раскладки для поиска при неверной раскладке клавиатуры (ЙЦУКЕН <-> QWERTY)
const LAYOUT_EN = "qwertyuiop[]asdfghjkl;'zxcvbnm,./`";
const LAYOUT_RU = "йцукенгшщзхъфывапролджэячсмитьбю.ё";
const EN_SHIFTED = { "{": "х", "}": "ъ", ":": "ж", '"': "э", "<": "б", ">": "ю", "~": "ё" };

// Свои клавиши на шаблоны: сочетания, которые назначать нельзя (копирование, вставка и т.п.)
const RESERVED_COMBOS = [
  "Ctrl+KeyC", "Ctrl+KeyV", "Ctrl+KeyX", "Ctrl+KeyA", "Ctrl+KeyZ", "Ctrl+KeyY",
  "Meta+KeyC", "Meta+KeyV", "Meta+KeyX", "Meta+KeyA", "Meta+KeyZ", "Meta+KeyY",
  "Ctrl+KeyP",
];
const MOD_ORDER = ["Ctrl", "Alt", "Shift", "Meta"];
const MODIFIER_CODES = [
  "ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight",
];

// Примеры. Свои шаблоны вставь в настройках плагина.
const DEFAULT_RAW = `### Приветствие (пример, показывается на всех серверах)
**Приветствую!
Благодарим Вас за обращение в службу поддержки.**

## Majestic RP

### Обращение к администрации (пример)
**Приветствую!
Благодарим Вас за обращение в службу поддержки.**

По данному вопросу Вам следует обратиться к игровой Администрации своего сервера в ЛС дискорда или /report находясь в игре.
*Перед тем как написать в ЛС дискорда, проверьте в официальном дискорде роли администратора*

## Россия Онлайн

### Пример шаблона для этого сервера
Здесь текст шаблона для Россия Онлайн.
`;

const PLUGIN_ID = "SupportTemplates";

const CSS = `
.st-btn { display:flex; align-items:center; justify-content:center; width:32px; height:32px; cursor:pointer;
  color:var(--interactive-normal); border-radius:4px; flex:0 0 auto; }
.st-btn:hover { color:var(--interactive-hover); }
.st-pop { position:fixed; z-index:10000; width:440px; max-height:480px; display:flex; flex-direction:column;
  background:var(--background-floating, #111214); border:1px solid var(--background-modifier-accent, #333);
  border-radius:8px; box-shadow:var(--elevation-high, 0 8px 16px rgba(0,0,0,.4)); overflow:hidden; }
.st-search { margin:8px; padding:8px 10px; border-radius:4px; border:none; outline:none;
  background:var(--input-background, #1e1f22); color:var(--text-normal, #dbdee1); font-size:14px; }
.st-tabs { display:flex; gap:6px; padding:0 8px 6px; flex-wrap:wrap; }
.st-tab { padding:3px 10px; border-radius:12px; font-size:12px; cursor:pointer; user-select:none;
  background:var(--background-modifier-hover, #2e3035); color:var(--text-muted, #949ba4);
  transition:background .18s ease, color .18s ease; }
.st-tab.st-tab-on { background:var(--brand-500, #5865f2); color:#fff; }
.st-hint { padding:0 12px 6px; font-size:11px; color:var(--text-muted, #949ba4); }
.st-list { overflow-y:auto; overflow-x:hidden; padding:0 8px 8px; }
@keyframes st-in-right { from { opacity:0; transform:translateX(28px); } to { opacity:1; transform:none; } }
@keyframes st-in-left { from { opacity:0; transform:translateX(-28px); } to { opacity:1; transform:none; } }
.st-list.st-in-right { animation:st-in-right .22s ease-out; }
.st-list.st-in-left { animation:st-in-left .22s ease-out; }
@media (prefers-reduced-motion: reduce) { .st-list.st-in-right, .st-list.st-in-left { animation:none; } }
.st-item { padding:8px 10px; border-radius:4px; cursor:pointer; }
.st-item:hover, .st-item.st-sel { background:var(--background-modifier-hover, #2e3035); }
.st-title { color:var(--header-primary, #fff); font-weight:600; font-size:14px; }
.st-tag { margin-left:8px; font-size:11px; font-weight:400; color:var(--text-muted, #949ba4); }
.st-prev { color:var(--text-muted, #949ba4); font-size:12px; margin-top:2px; white-space:nowrap;
  overflow:hidden; text-overflow:ellipsis; }
.st-count { margin-left:8px; font-size:11px; font-weight:400; color:var(--text-muted, #949ba4); }
.st-item { position:relative; padding-right:34px; }
.st-pin { position:absolute; top:8px; right:8px; width:20px; height:20px; display:flex; align-items:center;
  justify-content:center; border-radius:4px; color:var(--text-muted, #949ba4); opacity:0; cursor:pointer;
  transition:opacity .12s ease, color .12s ease, background .12s ease; }
.st-item:hover .st-pin, .st-item.st-sel .st-pin { opacity:.7; }
.st-pin:hover { opacity:1; color:var(--interactive-hover, #fff); background:var(--background-modifier-selected, #404249); }
.st-pin.st-pinned { opacity:1; color:var(--brand-500, #5865f2); }
.st-key { margin-left:8px; font-size:10px; font-weight:400; padding:0 4px; border-radius:3px;
  color:var(--text-muted, #949ba4); border:1px solid var(--background-modifier-accent, #3f4147); }
.st-hl { background:rgba(250,166,26,.35); color:inherit; border-radius:2px; }
.st-foot { flex:0 0 auto; padding:6px 12px; font-size:11px; color:var(--text-muted, #949ba4);
  border-top:1px solid var(--background-modifier-accent, #333); }
.st-item[data-pin="1"] { cursor:grab; }
.st-item.st-dragging { position:relative; z-index:5; opacity:.92; pointer-events:none;
  background:var(--background-modifier-selected, #404249); box-shadow:0 4px 14px rgba(0,0,0,.45); }
.st-list.st-drag-active, .st-list.st-drag-active * { cursor:grabbing !important; user-select:none; }
.st-item.st-drop-before { box-shadow:0 -2px 0 0 var(--brand-500, #5865f2); }
.st-item.st-drop-after { box-shadow:0 2px 0 0 var(--brand-500, #5865f2); }
@keyframes st-flash { from { background:rgba(88,101,242,.35); } to { background:transparent; } }
.st-item.st-flash { animation:st-flash .6s ease-out; }
.st-bind { display:inline-flex; align-items:center; gap:4px; margin-left:8px; height:16px; padding:0 5px;
  font-size:10px; font-weight:400; border-radius:3px; cursor:pointer; vertical-align:middle;
  color:var(--text-muted, #949ba4); border:1px dashed var(--background-modifier-accent, #3f4147); opacity:0;
  transition:opacity .12s ease, color .12s ease, background .12s ease; }
.st-item:hover .st-bind, .st-item.st-sel .st-bind { opacity:.85; }
.st-bind:hover { opacity:1; color:var(--interactive-hover, #fff); background:var(--background-modifier-selected, #404249); }
.st-bind.st-bound { opacity:1; border-style:solid; border-color:var(--brand-500, #5865f2); color:var(--text-normal, #fff); }
.st-bind.st-rec { opacity:1; color:#fff; background:var(--brand-500, #5865f2); border:1px solid var(--brand-500, #5865f2);
  animation:st-pulse 1s ease-in-out infinite; }
@keyframes st-pulse { 50% { opacity:.65; } }
.st-bind-x { margin-left:2px; opacity:.7; }
.st-bind-x:hover { opacity:1; }
.st-empty { color:var(--text-muted, #949ba4); padding:12px; font-size:13px; }
`;

const ICON =
  '<svg width="24" height="24" viewBox="0 0 24 24"><path fill="currentColor" d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM7 8v2h10V8H7zm0 4v2h7v-2H7z"/></svg>';

const KEYBIND_ICON =
  '<svg width="12" height="12" viewBox="0 0 24 24"><path fill="currentColor" d="M20 5H4c-1.1 0-1.99.9-1.99 2L2 17c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm-9 3h2v2h-2V8zm0 3h2v2h-2v-2zM8 8h2v2H8V8zm0 3h2v2H8v-2zm-1 2H5v-2h2v2zm0-3H5V8h2v2zm9 7H8v-2h8v2zm0-4h-2v-2h2v2zm0-3h-2V8h2v2zm3 3h-2v-2h2v2zm0-3h-2V8h2v2z"/></svg>';

const PIN_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24"><path fill="currentColor" d="M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z"/></svg>';

module.exports = class SupportTemplates {
  // ---------------------------------------------------------------- жизненный цикл

  start() {
    this.raw = this.loadRaw();
    this.templates = this.parseTemplates(this.raw);
    this.usage = this.loadUsage();
    this.pins = this.loadPins();
    this.binds = this.loadBinds();
    this.rebuildBindMap();
    this.recording = null;
    this.drag = null;
    this.pop = null;
    this.tab = "";

    BdApi.DOM.addStyle(PLUGIN_ID, CSS);

    this.observer = new MutationObserver(() => this.scheduleInject());
    this.observer.observe(document.body, { childList: true, subtree: true });
    this.scheduleInject();

    this.onKey = (e) => {
      if (this.recording) { this.recordKey(e); return; } // идёт назначение клавиши шаблону
      if (OPEN_HOTKEY_ENABLED && e.ctrlKey && e.altKey && !e.shiftKey && e.code === "KeyT") {
        e.preventDefault();
        e.stopPropagation();
        if (this.pop) this.close(true);
        else this.open(document.querySelector(".st-btn"));
        return;
      }
      // своя клавиша шаблона (работает и при закрытом окне)
      if (this.bindFire(e)) return;
      // Alt+1…9: быстрая вставка N-го шаблона (окно может быть закрыто)
      if (QUICK_HOTKEYS_ENABLED && e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
        const m = /^Digit([1-9])$/.exec(e.code);
        const inField = !this.pop && e.target && e.target.closest && e.target.closest("input, textarea, select");
        if (m && !inField) {
          e.preventDefault();
          e.stopPropagation();
          this.quickInsert(Number(m[1]) - 1);
          return;
        }
      }
      if (!this.pop) return;
      // Ctrl+P: закрепить / открепить выбранный шаблон
      if (e.ctrlKey && !e.altKey && !e.shiftKey && e.code === "KeyP") {
        e.preventDefault();
        e.stopPropagation();
        this.pinToggle(this.shown && this.shown[this.sel]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.close(true);
      } else if (e.key === "Tab") {
        // Tab / Shift+Tab: переключение между наборами (серверами)
        e.preventDefault();
        e.stopPropagation();
        this.cycleTab(e.shiftKey ? -1 : 1);
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        this.moveSel(e.key === "ArrowDown" ? 1 : -1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        const t = this.shown[this.sel];
        if (t) this.insert(t);
      }
    };
    document.addEventListener("keydown", this.onKey, true);

    this.onDown = (e) => {
      if (this.recording && !(e.target.closest && e.target.closest(".st-bind"))) this.cancelRecording();
      if (!this.pop) return;
      if (this.pop.contains(e.target) || (e.target.closest && e.target.closest(".st-btn"))) return;
      this.close(false);
    };
    document.addEventListener("mousedown", this.onDown, true);

    if (TEMPLATES_URL) this.syncFromUrl(true);
  }

  stop() {
    if (this.observer) this.observer.disconnect();
    if (this.onKey) document.removeEventListener("keydown", this.onKey, true);
    if (this.onDown) document.removeEventListener("mousedown", this.onDown, true);
    this.close(false);
    document.querySelectorAll(".st-btn").forEach((b) => b.remove());
    BdApi.DOM.removeStyle(PLUGIN_ID);
  }

  // ---------------------------------------------------------------- данные

  loadRaw() {
    let raw;
    try { raw = BdApi.Data.load(PLUGIN_ID, "raw"); } catch (_) {}
    if (raw === undefined) try { raw = BdApi.loadData(PLUGIN_ID, "raw"); } catch (_) {}
    return typeof raw === "string" && raw.trim() ? raw : DEFAULT_RAW;
  }

  saveRaw(raw) {
    this.raw = raw;
    this.templates = this.parseTemplates(raw);
    try { BdApi.Data.save(PLUGIN_ID, "raw", raw); return; } catch (_) {}
    try { BdApi.saveData(PLUGIN_ID, "raw", raw); } catch (_) {}
  }

  // ---------------------------------------------------------------- статистика использования

  // Ключ шаблона: группа + название (правка текста шаблона статистику не сбрасывает)
  tkey(t) {
    return (t.group || "") + "||" + t.title;
  }

  loadUsage() {
    let u;
    try { u = BdApi.Data.load(PLUGIN_ID, "usage"); } catch (_) {}
    if (u === undefined) try { u = BdApi.loadData(PLUGIN_ID, "usage"); } catch (_) {}
    return u && typeof u === "object" && !Array.isArray(u) ? u : {};
  }

  saveUsage() {
    try { BdApi.Data.save(PLUGIN_ID, "usage", this.usage); return; } catch (_) {}
    try { BdApi.saveData(PLUGIN_ID, "usage", this.usage); } catch (_) {}
  }

  usageOf(t) {
    return this.usage[this.tkey(t)] || { n: 0, last: 0 };
  }

  bumpUsage(t) {
    const k = this.tkey(t);
    const u = this.usage[k] || { n: 0, last: 0 };
    u.n += 1;
    u.last = Date.now();
    this.usage[k] = u;
    this.saveUsage();
  }

  resetUsage() {
    this.usage = {};
    this.saveUsage();
  }

  // ---------------------------------------------------------------- закрепление

  loadPins() {
    let p;
    try { p = BdApi.Data.load(PLUGIN_ID, "pinned"); } catch (_) {}
    if (p === undefined) try { p = BdApi.loadData(PLUGIN_ID, "pinned"); } catch (_) {}
    return this.normPins(p);
  }

  // Принимает массив ключей (порядок массива = порядок закреплённых) или старый формат {ключ: true}
  normPins(p) {
    const out = [];
    const add = (k) => { if (typeof k === "string" && !out.includes(k)) out.push(k); };
    if (Array.isArray(p)) p.forEach(add);
    else if (p && typeof p === "object") Object.keys(p).forEach((k) => { if (p[k]) add(k); });
    return out;
  }

  savePins() {
    try { BdApi.Data.save(PLUGIN_ID, "pinned", this.pins); return; } catch (_) {}
    try { BdApi.saveData(PLUGIN_ID, "pinned", this.pins); } catch (_) {}
  }

  isPinned(t) {
    return this.pins.includes(this.tkey(t));
  }

  // Новый закреплённый шаблон встаёт в конец списка закреплённых
  togglePin(t) {
    const k = this.tkey(t);
    const i = this.pins.indexOf(k);
    if (i >= 0) this.pins.splice(i, 1);
    else this.pins.push(k);
    this.savePins();
    return i < 0;
  }

  // Перенос закреплённого шаблона from на место рядом с to (до или после)
  movePin(from, to, after) {
    if (from === to) return false;
    const arr = this.pins.filter((k) => k !== from);
    const i = arr.indexOf(to);
    if (i < 0 || !this.pins.includes(from)) return false;
    arr.splice(after ? i + 1 : i, 0, from);
    this.pins = arr;
    this.savePins();
    return true;
  }

  // ---------------------------------------------------------------- свои клавиши

  loadBinds() {
    let b;
    try { b = BdApi.Data.load(PLUGIN_ID, "binds"); } catch (_) {}
    if (b === undefined) try { b = BdApi.loadData(PLUGIN_ID, "binds"); } catch (_) {}
    return this.normBinds(b);
  }

  // {ключ шаблона: "Ctrl+Alt+KeyF"}; отбрасывает некорректные и повторяющиеся сочетания
  normBinds(b) {
    const out = {};
    const seen = new Set();
    if (b && typeof b === "object" && !Array.isArray(b)) {
      Object.keys(b).forEach((k) => {
        const c = b[k];
        if (typeof c === "string" && !this.bindProblem(c) && !seen.has(c)) {
          seen.add(c);
          out[k] = c;
        }
      });
    }
    return out;
  }

  saveBinds() {
    try { BdApi.Data.save(PLUGIN_ID, "binds", this.binds); return; } catch (_) {}
    try { BdApi.saveData(PLUGIN_ID, "binds", this.binds); } catch (_) {}
  }

  rebuildBindMap() {
    this.bindMap = {};
    Object.keys(this.binds).forEach((k) => { this.bindMap[this.binds[k]] = k; });
  }

  // Сочетание строится по физической клавише (e.code), поэтому не зависит от раскладки
  comboFromEvent(e) {
    if (!e.code || MODIFIER_CODES.includes(e.code)) return null;
    const mods = [];
    if (e.ctrlKey) mods.push("Ctrl");
    if (e.altKey) mods.push("Alt");
    if (e.shiftKey) mods.push("Shift");
    if (e.metaKey) mods.push("Meta");
    return [...mods, e.code].join("+");
  }

  codeLabel(c) {
    let m;
    if ((m = /^Key([A-Z])$/.exec(c))) return m[1];
    if ((m = /^Digit(\d)$/.exec(c))) return m[1];
    if ((m = /^Numpad(\d)$/.exec(c))) return "Num" + m[1];
    const map = {
      ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
      Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]",
      Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Backslash: "\\",
      NumpadAdd: "Num+", NumpadSubtract: "Num-", NumpadMultiply: "Num*", NumpadDivide: "Num/",
      NumpadDecimal: "Num.", NumpadEnter: "NumEnter",
    };
    return map[c] || c;
  }

  comboLabel(combo) {
    const parts = String(combo).split("+");
    const code = parts.pop();
    const meta = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || "") ? "Cmd" : "Win";
    return [...parts.map((m) => (m === "Meta" ? meta : m)), this.codeLabel(code)].join("+");
  }

  // "" если сочетание можно назначить, иначе текст причины
  bindProblem(combo) {
    const parts = String(combo).split("+");
    const code = parts.pop();
    const mods = parts;
    if (!code || MODIFIER_CODES.includes(code) || code === "Escape") return "Эту клавишу назначить нельзя";
    const canon = MOD_ORDER.filter((m) => mods.includes(m));
    if (canon.join("+") !== mods.join("+")) return "Неверное сочетание";
    const isF = /^F([1-9]|1\d|2[0-4])$/.test(code);
    if (!isF && !mods.some((m) => m !== "Shift")) return "Нужен Ctrl, Alt или Win вместе с клавишей";
    if (RESERVED_COMBOS.includes(combo) || (OPEN_HOTKEY_ENABLED && combo === "Ctrl+Alt+KeyT")) {
      return "Это сочетание зарезервировано";
    }
    if (QUICK_HOTKEYS_ENABLED && mods.join("+") === "Alt" && /^Digit[1-9]$/.test(code)) {
      return "Alt+1…9 занято быстрой вставкой по номеру";
    }
    return "";
  }

  titleOfKey(k) {
    return String(k).split("||").slice(1).join("||") || String(k);
  }

  // Назначает сочетание шаблону; если оно было у другого шаблона, снимает с него (возвращает его ключ)
  setBind(t, combo) {
    const k = this.tkey(t);
    let stolen = null;
    Object.keys(this.binds).forEach((o) => {
      if (o !== k && this.binds[o] === combo) { stolen = o; delete this.binds[o]; }
    });
    this.binds[k] = combo;
    this.saveBinds();
    this.rebuildBindMap();
    return stolen;
  }

  clearBind(t) {
    delete this.binds[this.tkey(t)];
    this.saveBinds();
    this.rebuildBindMap();
  }

  // Нажатие своей клавиши: вставляет привязанный шаблон. true, если событие обработано.
  bindFire(e) {
    if (!this.bindMap) return false;
    const combo = this.comboFromEvent(e);
    const key = combo && this.bindMap[combo];
    if (!key) return false;
    const inField = !this.pop && e.target && e.target.closest && e.target.closest("input, textarea, select");
    if (inField) return false;
    const t = this.templates.find((x) => this.tkey(x) === key);
    if (!t) return false;
    e.preventDefault();
    e.stopPropagation();
    if (!e.repeat) {
      this.toast("Вставлен шаблон: " + t.title, "info", 1500);
      this.insert(t);
    }
    return true;
  }

  // Режим записи: следующее нажатие становится клавишей шаблона
  recordKey(e) {
    e.preventDefault();
    e.stopPropagation();
    const t = this.recording;
    if (!t || MODIFIER_CODES.includes(e.code)) return; // ждём основную клавишу
    if (e.key === "Escape") { this.cancelRecording(); return; }
    if ((e.key === "Backspace" || e.key === "Delete") && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
      this.clearBind(t);
      this.finishRecording(t);
      this.toast("Клавиша снята", "info", 1500);
      return;
    }
    const combo = this.comboFromEvent(e);
    const problem = combo ? this.bindProblem(combo) : "Эту клавишу назначить нельзя";
    if (problem) { this.toast(problem, "warning", 2500); return; } // остаёмся в режиме записи
    const stolen = this.setBind(t, combo);
    this.finishRecording(t);
    this.toast(
      this.comboLabel(combo) + " → «" + t.title + "»" +
        (stolen ? " (снята с «" + this.titleOfKey(stolen) + "»)" : ""),
      "success", 2500
    );
  }

  finishRecording(t) {
    this.recording = null;
    if (this.pop) this.rerender(t);
  }

  cancelRecording() {
    const t = this.recording;
    this.recording = null;
    if (this.pop) this.rerender(t);
  }

  // Перерисовка списка с сохранением прокрутки и выбранного шаблона
  rerender(keep) {
    const top = this.list.scrollTop;
    this.render(this.input.value, keep);
    this.list.scrollTop = top;
  }

  // ---------------------------------------------------------------- поиск

  // нижний регистр, "ё" = "е"; длина строки не меняется (нужно для подсветки)
  nq(s) {
    s = String(s || "");
    let out = "";
    for (let i = 0; i < s.length; i++) {
      let c = s[i].toLowerCase();
      if (c === "ё") c = "е";
      out += c.length === 1 ? c : s[i];
    }
    return out;
  }

  folded(t) {
    if (t._ft === undefined) {
      t._ft = this.nq(t.title);
      t._fx = this.nq(t.text);
    }
    return t;
  }

  // Релевантность шаблона запросу. Каждое слово запроса должно где-то встретиться
  // (в названии или тексте), иначе -1. Совпадение с началом слова в названии весит больше всего.
  relevance(t, tokens) {
    this.folded(t);
    const title = t._ft;
    const text = t._fx;
    const words = t._fw || (t._fw = title.split(/[^\p{L}\p{N}]+/u));
    let total = 0;
    for (const tok of tokens) {
      if (words.some((w) => w.startsWith(tok))) total += 100;
      else if (title.includes(tok)) total += 60;
      else if (text.includes(tok)) total += 20;
      else return -1;
    }
    if (title.startsWith(tokens.join(" "))) total += 30;
    return total;
  }

  // --- неверная раскладка: "ghj,ktv" -> "проблем" и наоборот
  enToRu(s) {
    let out = "";
    for (const ch of String(s).toLowerCase()) {
      const i = LAYOUT_EN.indexOf(ch);
      out += i >= 0 ? LAYOUT_RU[i] : (EN_SHIFTED[ch] || ch);
    }
    return out;
  }

  ruToEn(s) {
    let out = "";
    for (const ch of String(s).toLowerCase()) {
      const i = LAYOUT_RU.indexOf(ch);
      out += i >= 0 ? LAYOUT_EN[i] : ch;
    }
    return out;
  }

  // Варианты запроса в другой раскладке (только если запрос целиком в одной раскладке)
  layoutVariants(q) {
    const hasCyr = /[а-яё]/i.test(q);
    const hasLat = /[a-z]/i.test(q);
    const out = [];
    if (hasLat && !hasCyr) out.push(this.enToRu(q));
    if (hasCyr && !hasLat) out.push(this.ruToEn(q));
    return out.filter((v) => v.trim() && v !== q.toLowerCase());
  }

  // Итоговый порядок: релевантность запросу + бонус за частоту + закреплённые.
  // Закреплённые без запроса всегда сверху; при поиске получают небольшой бонус.
  // Если по запросу пусто, пробуем его же в другой раскладке.
  rank(query, tab) {
    const pool = this.templates.filter((t) => !tab || !t.group || t.group === tab);
    const run = (q) => {
      const tokens = this.nq(q).split(/\s+/).filter(Boolean);
      const scored = pool
        .map((t, i) => ({
          t, i,
          u: this.usageOf(t),
          pinIdx: this.pins.indexOf(this.tkey(t)),
          rel: tokens.length ? this.relevance(t, tokens) : 0,
        }))
        .filter((x) => !tokens.length || x.rel >= 0);
      return { tokens, scored };
    };

    const raw = String(query || "");
    let r = run(raw);
    let note = "";
    if (!r.scored.length && raw.trim()) {
      for (const alt of this.layoutVariants(raw)) {
        const r2 = run(alt);
        if (r2.scored.length) { r = r2; note = alt.trim(); break; }
      }
    }

    // без запроса закреплённые идут строго в порядке закрепления; при поиске получают лишь небольшой бонус
    const pinScore = (x) => (x.pinIdx < 0 ? 0 : r.tokens.length ? 30 : 1e7 - x.pinIdx * 1000);
    const score = (x) => x.rel + Math.log2(1 + Math.min(x.u.n, 100)) * 8 + pinScore(x);
    r.scored.sort((a, b) => score(b) - score(a) || b.u.last - a.u.last || a.i - b.i);
    return { items: r.scored, tokens: r.tokens, note };
  }

  // ---------------------------------------------------------------- резервная копия

  exportBackup() {
    const data = {
      app: PLUGIN_ID,
      version: 2,
      exportedAt: new Date().toISOString(),
      raw: this.raw,
      usage: this.usage,
      pinned: this.pins,
      binds: this.binds,
    };
    const json = JSON.stringify(data, null, 2);
    const name = PLUGIN_ID + "-backup-" + new Date().toISOString().slice(0, 10) + ".json";
    try {
      const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      this.toast("Резервная копия: " + name + " (смотри папку загрузок)", "success");
    } catch (e) {
      console.error("[SupportTemplates] экспорт", e);
      navigator.clipboard.writeText(json).then(
        () => this.toast("Не удалось сохранить файл. Копия скопирована в буфер обмена", "warning"),
        () => this.toast("Не удалось сделать резервную копию (см. консоль Ctrl+Shift+I)", "error")
      );
    }
  }

  // Понимает: файл экспорта, сам конфиг плагина ({raw, usage, pinned}), JSON-массив шаблонов
  // и обычный текст в формате "## сервер / ### шаблон". Возвращает {raw?, usage?, pinned?} или null.
  parseBackup(text) {
    let obj = null;
    try { obj = JSON.parse(text); } catch (_) {}
    const res = {};
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      if (typeof obj.raw === "string") res.raw = obj.raw;
      if (obj.usage && typeof obj.usage === "object" && !Array.isArray(obj.usage)) {
        const u = {};
        Object.keys(obj.usage).forEach((k) => {
          const v = obj.usage[k];
          const n = Math.floor(Number(v && v.n));
          if (n > 0 && isFinite(n)) u[k] = { n, last: Number(v.last) || 0 };
        });
        res.usage = u;
      }
      if (obj.pinned) res.pinned = this.normPins(obj.pinned);
      if (obj.binds && typeof obj.binds === "object" && !Array.isArray(obj.binds)) res.binds = this.normBinds(obj.binds);
    } else {
      res.raw = String(text);
    }
    if (res.raw !== undefined && !this.parseTemplates(res.raw).length) return null;
    if (res.raw === undefined && res.usage === undefined && res.pinned === undefined && res.binds === undefined) return null;
    return res;
  }

  confirmModal(title, body, onConfirm) {
    try {
      BdApi.UI.showConfirmationModal(title, body, {
        confirmText: "Заменить",
        cancelText: "Отмена",
        danger: true,
        onConfirm,
      });
      return;
    } catch (_) {}
    if (window.confirm(body)) onConfirm();
  }

  importBackup(done) {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = ".json,.txt,.md,application/json,text/plain";
    inp.addEventListener("change", async () => {
      const file = inp.files && inp.files[0];
      if (!file) return;
      let text;
      try { text = await file.text(); } catch (e) {
        this.toast("Не удалось прочитать файл", "error");
        return;
      }
      const data = this.parseBackup(text);
      if (!data) {
        this.toast("Файл не распознан: нет шаблонов, статистики и закреплений", "error");
        return;
      }
      const parts = [];
      if (data.raw !== undefined) parts.push("шаблонов: " + this.parseTemplates(data.raw).length);
      if (data.usage !== undefined) parts.push("записей статистики: " + Object.keys(data.usage).length);
      if (data.pinned !== undefined) parts.push("закреплённых: " + data.pinned.length);
      if (data.binds !== undefined) parts.push("своих клавиш: " + Object.keys(data.binds).length);
      this.confirmModal(
        "Импорт резервной копии",
        "В файле: " + parts.join(", ") + ".\n\nТекущие данные этих разделов будут заменены. " +
          "Если нужна копия текущих, сначала сделай экспорт.",
        () => {
          if (data.raw !== undefined) this.saveRaw(data.raw);
          if (data.usage !== undefined) { this.usage = data.usage; this.saveUsage(); }
          if (data.pinned !== undefined) { this.pins = data.pinned; this.savePins(); }
          if (data.binds !== undefined) { this.binds = data.binds; this.saveBinds(); this.rebuildBindMap(); }
          this.toast("Импорт выполнен (" + parts.join(", ") + ")", "success");
          if (done) done();
        }
      );
    });
    inp.click();
  }

  // Формат:
  //   ## Название сервера      (необязательно: начинает группу шаблонов этого сервера)
  //   ### Название шаблона     (дальше текст шаблона до следующего "##" или "###")
  // Шаблоны выше первого "## " считаются общими и показываются на всех серверах.
  // Также понимает JSON вида [{"title": "...", "text": "...", "group": "..."}].
  parseTemplates(raw) {
    const src = String(raw || "").replace(/\r/g, "").trim();
    if (!src) return [];

    if (src.startsWith("[")) {
      try {
        const arr = JSON.parse(src);
        return arr
          .map((x) => ({
            title: String(x.title || x.name || "").trim(),
            text: String(x.text || x.content || "").trim(),
            group: String(x.group || "").trim(),
          }))
          .filter((x) => x.title && x.text);
      } catch (_) {}
    }

    const items = [];
    let cur = null;
    let group = "";
    for (const rawLine of src.split("\n")) {
      // Строка вида "\## текст" или "\### текст" — это обычный текст шаблона
      // (заголовок Discord), а не название шаблона/сервера. Слэш убирается.
      const esc = /^\\#{1,6}\s/.test(rawLine);
      const line = esc ? rawLine.slice(1) : rawLine;
      const t = esc ? null : line.match(/^###\s+(.+?)\s*$/);
      const g = esc ? null : line.match(/^##\s+(.+?)\s*$/);
      if (t) {
        if (cur) items.push(cur);
        cur = { title: t[1], group, lines: [] };
      } else if (g) {
        if (cur) items.push(cur);
        cur = null;
        group = g[1];
      } else if (cur) {
        cur.lines.push(line);
      }
    }
    if (cur) items.push(cur);
    return items
      .map((i) => ({ title: i.title, group: i.group, text: i.lines.join("\n").trim() }))
      .filter((i) => i.text);
  }

  groups() {
    const seen = [];
    for (const t of this.templates) if (t.group && !seen.includes(t.group)) seen.push(t.group);
    return seen;
  }

  async syncFromUrl(silent) {
    try {
      const f = (BdApi.Net && BdApi.Net.fetch) || window.fetch.bind(window);
      const res = await f(TEMPLATES_URL);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const text = await res.text();
      if (!this.parseTemplates(text).length) throw new Error("не удалось разобрать шаблоны");
      this.saveRaw(text);
      if (!silent) this.toast("Шаблонов загружено: " + this.templates.length, "success");
    } catch (e) {
      console.error("[SupportTemplates] загрузка с сайта", e);
      this.toast("Шаблоны не загрузились: " + e.message, "error");
    }
  }

  toast(text, type = "info", timeout) {
    try { BdApi.UI.showToast(text, timeout ? { type, timeout } : { type }); } catch (_) {}
  }

  // ---------------------------------------------------------------- текущий сервер

  norm(s) {
    return String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  }

  currentGuildName() {
    try {
      const W = BdApi.Webpack;
      const sel = W.getStore("SelectedGuildStore");
      const gs = W.getStore("GuildStore");
      const id = sel && sel.getGuildId && sel.getGuildId();
      const g = id && gs && gs.getGuild && gs.getGuild(id);
      return g && g.name ? g.name : "";
    } catch (_) {
      return "";
    }
  }

  // Какая группа подходит к открытому серверу: сравнение по названию (по вхождению в обе стороны)
  autoTab() {
    const name = this.norm(this.currentGuildName());
    if (!name) return "";
    let best = "";
    for (const g of this.groups()) {
      const gn = this.norm(g);
      if (!gn) continue;
      if ((name.includes(gn) || gn.includes(name)) && g.length > best.length) best = g;
    }
    return best;
  }

  // ---------------------------------------------------------------- кнопка в строке ввода

  scheduleInject() {
    if (this.injectPending) return;
    this.injectPending = true;
    requestAnimationFrame(() => {
      this.injectPending = false;
      this.inject();
    });
  }

  inject() {
    document.querySelectorAll('[class*="channelTextArea_"]').forEach((area) => {
      if (area.querySelector(".st-btn")) return;
      const holder = area.querySelector('[class*="buttons_"]');
      if (!holder) return;
      const btn = document.createElement("div");
      btn.className = "st-btn";
      btn.title = "Шаблоны ответов (Ctrl+Alt+T)";
      btn.innerHTML = ICON;
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (this.pop) this.close(true);
        else this.open(btn);
      });
      holder.prepend(btn);
    });
  }

  // ---------------------------------------------------------------- окно выбора

  open(anchor) {
    this.close(false);
    const pop = document.createElement("div");
    pop.className = "st-pop";

    const input = document.createElement("input");
    input.className = "st-search";
    input.placeholder = "Поиск шаблона...";
    const tabs = document.createElement("div");
    tabs.className = "st-tabs";
    const hint = document.createElement("div");
    hint.className = "st-hint";
    const list = document.createElement("div");
    list.className = "st-list";
    const foot = document.createElement("div");
    foot.className = "st-foot";
    foot.textContent =
      "Enter вставить · " + (QUICK_HOTKEYS_ENABLED ? "Alt+1…9 быстро · " : "") + "Ctrl+P закрепить (перетаскивай)" +
      (this.groups().length ? " · Tab сервер" : "");
    pop.append(input, tabs, hint, list, foot);
    document.body.append(pop);

    if (anchor) {
      const r = anchor.getBoundingClientRect();
      pop.style.right = Math.max(8, window.innerWidth - r.right) + "px";
      pop.style.bottom = window.innerHeight - r.top + 10 + "px";
    } else {
      pop.style.right = "80px";
      pop.style.bottom = "80px";
    }

    this.pop = pop;
    this.list = list;
    this.input = input;
    this.tabsEl = tabs;
    this.hintEl = hint;
    this.sel = 0;

    // Автовыбор набора по открытому серверу
    this.tab = this.autoTab();
    this.guildName = this.currentGuildName();
    this.autoFailed = this.groups().length > 0 && !this.tab;

    input.addEventListener("input", () => {
      this.sel = 0;
      this.render(input.value);
    });
    this.renderTabs();
    this.render("");
    input.focus();
  }

  close(refocus) {
    this.recording = null;
    this.endDrag();
    if (this.pop) {
      this.pop.remove();
      this.pop = null;
    }
    if (refocus) this.focusEditor();
  }

  // dir: +1 — новый набор "приезжает" справа, -1 — слева (если не задан, считается по порядку вкладок)
  setTab(value, dir) {
    if (value === this.tab) { this.input.focus(); return; }
    const values = ["", ...this.groups()];
    if (!dir) dir = values.indexOf(value) >= values.indexOf(this.tab) ? 1 : -1;
    this.tab = value;
    this.autoFailed = false;
    this.sel = 0;
    // вкладки не пересоздаём, а переключаем класс — так срабатывает плавная смена цвета
    this.tabsEl.querySelectorAll(".st-tab").forEach((el) =>
      el.classList.toggle("st-tab-on", el.dataset.value === value)
    );
    this.render(this.input.value);
    this.list.scrollTop = 0;
    this.animateList(dir);
    this.input.focus();
  }

  animateList(dir) {
    const l = this.list;
    if (!l) return;
    l.classList.remove("st-in-right", "st-in-left");
    void l.offsetWidth; // перезапуск анимации
    l.classList.add(dir > 0 ? "st-in-right" : "st-in-left");
  }

  cycleTab(delta) {
    const values = ["", ...this.groups()];
    if (values.length < 2) return;
    const i = Math.max(0, values.indexOf(this.tab));
    this.setTab(values[(i + delta + values.length) % values.length], delta);
  }

  renderTabs() {
    const groups = this.groups();
    this.tabsEl.textContent = "";
    this.tabsEl.style.display = groups.length ? "flex" : "none";
    if (groups.length) {
      [["", "Все"], ...groups.map((g) => [g, g])].forEach(([value, label]) => {
        const tab = document.createElement("div");
        tab.className = "st-tab" + (value === this.tab ? " st-tab-on" : "");
        tab.textContent = label;
        tab.dataset.value = value;
        tab.addEventListener("click", () => this.setTab(value));
        this.tabsEl.append(tab);
      });
    }
    this.updateHint();
  }

  // Одна строка-подсказка под вкладками: не определился сервер или сработала смена раскладки
  updateHint() {
    if (!this.hintEl) return;
    let msg = "";
    if (this.autoFailed) {
      msg =
        "Набор не определён по названию сервера" +
        (this.guildName ? " «" + this.guildName + "»" : "") +
        ". Выбери вкладку вручную (Tab).";
    } else if (this.layoutNote) {
      msg = "Раскладка: показаны результаты для «" + this.layoutNote + "»";
    }
    this.hintEl.textContent = msg;
    this.hintEl.style.display = msg ? "block" : "none";
  }

  // Текст с выделенными словами запроса (<mark>). Строка нормализуется без смены длины.
  setHighlighted(el, text, tokens) {
    el.textContent = "";
    if (!tokens || !tokens.length) {
      el.textContent = text;
      return;
    }
    const f = this.nq(text);
    const marks = new Uint8Array(text.length);
    for (const tok of tokens) {
      let i = f.indexOf(tok);
      while (i !== -1) {
        marks.fill(1, i, i + tok.length);
        i = f.indexOf(tok, i + tok.length);
      }
    }
    let i = 0;
    while (i < text.length) {
      let j = i;
      while (j < text.length && marks[j] === marks[i]) j++;
      const seg = text.slice(i, j);
      if (marks[i]) {
        const mk = document.createElement("mark");
        mk.className = "st-hl";
        mk.textContent = seg;
        el.append(mk);
      } else {
        el.append(document.createTextNode(seg));
      }
      i = j;
    }
  }

  // Превью текста. Если слово запроса найдено далеко в тексте, показываем кусок вокруг него.
  preview(t, tokens) {
    const flat = t.text.replace(/\s+/g, " ").trim();
    let start = 0;
    if (tokens.length) {
      const f = this.nq(flat);
      let pos = -1;
      for (const tok of tokens) {
        const i = f.indexOf(tok);
        if (i !== -1 && (pos === -1 || i < pos)) pos = i;
      }
      if (pos > 90) start = Math.max(0, pos - 40);
    }
    return (start > 0 ? "…" : "") + flat.slice(start, start + 140);
  }

  clearDropMarks() {
    this.list.querySelectorAll(".st-drop-before, .st-drop-after").forEach((el) =>
      el.classList.remove("st-drop-before", "st-drop-after")
    );
  }

  // Перетаскивание закреплённых. Сделано на событиях мыши, а не на нативном HTML5 drag&drop:
  // Discord перехватывает нативный drag на уровне окна и отменяет его.
  makeDraggable(item, t) {
    const key = this.tkey(t);
    item.dataset.pin = "1";
    item.dataset.key = key;
    item.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      if (e.target && e.target.closest && e.target.closest(".st-pin, .st-bind")) return;
      e.preventDefault(); // без выделения текста, фокус остаётся в поиске
      this.beginDragWatch(e, item, key);
    });
  }

  // Ждём, пока мышь сдвинется на несколько пикселей: меньше — это обычный клик (вставка шаблона)
  beginDragWatch(e, item, key) {
    this.endDrag();
    const d = {
      item, key,
      x: e.clientX, y: e.clientY,
      scroll: this.list.scrollTop,
      active: false,
      target: null,
    };
    d.move = (ev) => this.dragMove(ev);
    d.up = () => this.dragUp();
    this.drag = d;
    document.addEventListener("mousemove", d.move, true);
    document.addEventListener("mouseup", d.up, true);
  }

  dragMove(e) {
    const d = this.drag;
    if (!d) return;
    if (!d.active) {
      if (Math.abs(e.clientX - d.x) < 5 && Math.abs(e.clientY - d.y) < 5) return;
      d.active = true;
      d.item.classList.add("st-dragging");
      this.list.classList.add("st-drag-active");
    }
    e.preventDefault();

    // автопрокрутка у верхнего и нижнего края списка
    const lr = this.list.getBoundingClientRect();
    if (e.clientY < lr.top + 24) this.list.scrollTop -= 12;
    else if (e.clientY > lr.bottom - 24) this.list.scrollTop += 12;

    // перетаскиваемая строка следует за курсором
    d.item.style.transform = "translateY(" + (e.clientY - d.y + this.list.scrollTop - d.scroll) + "px)";

    // куда встанет: перед первым закреплённым, у которого середина ниже курсора, иначе после последнего
    this.clearDropMarks();
    d.target = null;
    const others = Array.from(this.list.querySelectorAll('.st-item[data-pin="1"]')).filter((el) => el !== d.item);
    if (!others.length) return;
    let target = others[others.length - 1];
    let after = true;
    for (const el of others) {
      const r = el.getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) { target = el; after = false; break; }
    }
    target.classList.add(after ? "st-drop-after" : "st-drop-before");
    d.target = { key: target.dataset.key, after };
  }

  dragUp() {
    const d = this.drag;
    if (!d) return;
    this.endDrag();
    if (!d.active) return; // не сдвинулась — обычный клик
    this.justDragged = true;
    setTimeout(() => { this.justDragged = false; }, 0);
    if (!d.target || !this.movePin(d.key, d.target.key, d.target.after)) return;
    const moved = this.templates.find((x) => this.tkey(x) === d.key);
    this.render(this.input.value, moved);
    const el = this.list.querySelectorAll(".st-item")[this.sel];
    if (el) {
      el.classList.add("st-flash");
      el.scrollIntoView({ block: "nearest" });
    }
  }

  endDrag() {
    const d = this.drag;
    if (!d) return;
    document.removeEventListener("mousemove", d.move, true);
    document.removeEventListener("mouseup", d.up, true);
    d.item.classList.remove("st-dragging");
    d.item.style.transform = "";
    if (this.list) {
      this.list.classList.remove("st-drag-active");
      this.clearDropMarks();
    }
    this.drag = null;
  }

  pinToggle(t) {
    if (!t) return;
    this.togglePin(t);
    this.render(this.input.value, t); // выбранный шаблон остаётся выбранным, даже если сдвинулся
    const el = this.list.querySelectorAll(".st-item")[this.sel];
    if (el) el.scrollIntoView({ block: "nearest" });
  }

  // keep — шаблон, который должен остаться выбранным после перерисовки
  render(query, keep) {
    const { items, tokens, note } = this.rank(query, this.tab);
    this.shown = items.map((x) => x.t);
    this.layoutNote = note;
    if (keep) {
      const k = this.shown.indexOf(keep);
      this.sel = k >= 0 ? k : 0;
    }
    this.updateHint();

    this.list.textContent = "";
    if (!this.shown.length) {
      const empty = document.createElement("div");
      empty.className = "st-empty";
      empty.textContent = this.templates.length
        ? "Ничего не найдено"
        : "Шаблонов нет. Добавь их в настройках плагина.";
      this.list.append(empty);
      return;
    }
    this.shown.forEach((t, i) => {
      const item = document.createElement("div");
      item.className = "st-item" + (i === this.sel ? " st-sel" : "");

      const title = document.createElement("div");
      title.className = "st-title";
      const tt = document.createElement("span");
      this.setHighlighted(tt, t.title, tokens);
      title.append(tt);
      if (!this.tab && t.group) {
        const tag = document.createElement("span");
        tag.className = "st-tag";
        tag.textContent = t.group;
        title.append(tag);
      }
      const n = this.usageOf(t).n;
      if (n > 0) {
        const cnt = document.createElement("span");
        cnt.className = "st-count";
        cnt.textContent = "×" + n;
        cnt.title = "Сколько раз использован";
        title.append(cnt);
      }
      if (QUICK_HOTKEYS_ENABLED && i < 9) {
        const key = document.createElement("span");
        key.className = "st-key";
        key.textContent = "Alt+" + (i + 1);
        title.append(key);
      }

      // кнопка своей клавиши: «Назначить» / назначенное сочетание (✕ снимает) / режим записи
      const bound = this.binds[this.tkey(t)];
      const recording = this.recording === t;
      const bind = document.createElement("span");
      bind.className = "st-bind" + (recording ? " st-rec" : bound ? " st-bound" : "");
      if (recording) {
        bind.textContent = "Нажми сочетание… Esc — отмена, Backspace — снять";
      } else if (bound) {
        bind.title = "Изменить клавишу";
        bind.append(document.createTextNode(this.comboLabel(bound)));
        const x = document.createElement("span");
        x.className = "st-bind-x";
        x.textContent = "✕";
        x.title = "Снять клавишу";
        x.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.clearBind(t);
          this.rerender(t);
        });
        bind.append(x);
      } else {
        bind.title = "Назначить свою клавишу на этот шаблон";
        bind.innerHTML = KEYBIND_ICON;
        bind.append(document.createTextNode("Назначить"));
      }
      bind.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.recording = recording ? null : t;
        this.rerender(t);
      });
      title.append(bind);

      const prev = document.createElement("div");
      prev.className = "st-prev";
      this.setHighlighted(prev, this.preview(t, tokens), tokens);

      const pinned = this.isPinned(t);
      const pin = document.createElement("div");
      pin.className = "st-pin" + (pinned ? " st-pinned" : "");
      pin.title = (pinned ? "Открепить" : "Закрепить") + " (Ctrl+P)";
      pin.innerHTML = PIN_ICON;
      pin.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.pinToggle(t);
      });

      item.append(title, prev, pin);
      // менять порядок можно только у закреплённых и только без поискового запроса
      if (pinned && !tokens.length) this.makeDraggable(item, t);
      item.addEventListener("click", () => {
        if (this.justDragged) return; // отпускание мыши после перетаскивания — не вставка
        this.insert(t);
      });
      this.list.append(item);
    });
  }

  moveSel(delta) {
    if (!this.shown || !this.shown.length) return;
    this.sel = (this.sel + delta + this.shown.length) % this.shown.length;
    const items = this.list.querySelectorAll(".st-item");
    items.forEach((el, i) => el.classList.toggle("st-sel", i === this.sel));
    if (items[this.sel]) items[this.sel].scrollIntoView({ block: "nearest" });
  }

  // ---------------------------------------------------------------- вставка текста

  focusEditor() {
    const ed = document.querySelector('[role="textbox"][data-slate-editor="true"]');
    if (ed) ed.focus();
    return ed;
  }

  editorText() {
    const ed = document.querySelector('[role="textbox"][data-slate-editor="true"]');
    return ed ? (ed.innerText || ed.textContent || "") : "";
  }

  // Alt+N: вставить N-й шаблон. Если окно открыто, берётся список из окна,
  // иначе список для открытого сервера (закреплённые, потом частые).
  quickInsert(i) {
    const list = this.pop ? this.shown : this.rank("", this.autoTab()).items.map((x) => x.t);
    const t = list && list[i];
    if (!t) return;
    this.toast("Вставлен шаблон: " + t.title, "info", 1500);
    this.insert(t);
  }

  // Только вставляет текст в поле ввода. Отправляешь сообщение сам.
  // Каждый способ проверяется: если текст не появился в поле, пробуем следующий.
  async insert(t) {
    const text = t.text;
    this.bumpUsage(t);
    this.close(false);
    const ed = this.focusEditor();
    const norm = (s) => String(s).replace(/\s+/g, " ").trim();
    const probe = norm(text).slice(0, 15);
    const before = norm(this.editorText());

    const landed = async () => {
      await new Promise((r) => setTimeout(r, 150));
      const now = norm(this.editorText());
      return now.length > before.length && now.includes(probe);
    };

    const strategies = [];

    // 1. Внутренний диспетчер Discord (перебираем все подходящие модули)
    strategies.push(() => {
      let mods = [];
      try {
        mods = BdApi.Webpack.getModules(
          (m) => m && typeof m.dispatchToLastSubscribed === "function",
          { searchExports: true }
        ) || [];
      } catch (_) {}
      if (!mods.length) {
        try {
          const one = BdApi.Webpack.getModule(
            (m) => m && typeof m.dispatchToLastSubscribed === "function",
            { searchExports: true }
          );
          if (one) mods = [one];
        } catch (_) {}
      }
      mods.forEach((CD) => {
        try { CD.dispatchToLastSubscribed("INSERT_TEXT", { plainText: text, rawText: text }); } catch (_) {}
      });
    });

    // 2. execCommand
    strategies.push(() => {
      this.focusEditor();
      document.execCommand("insertText", false, text);
    });

    // 3. Синтетическая вставка (paste)
    strategies.push(() => {
      const el = this.focusEditor();
      if (!el) return;
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    });

    if (ed) {
      for (let i = 0; i < strategies.length; i++) {
        try { strategies[i](); } catch (e) { console.error("[SupportTemplates] способ " + (i + 1), e); }
        if (await landed()) {
          console.log("[SupportTemplates] вставлено способом " + (i + 1));
          return;
        }
      }
    }

    // 4. Ничего не сработало: кладём в буфер обмена
    try {
      await navigator.clipboard.writeText(text);
      this.toast(
        ed ? "Не удалось вставить в поле. Текст скопирован, нажми Ctrl+V"
           : "Поле ввода не найдено. Текст скопирован, нажми Ctrl+V",
        "warning"
      );
    } catch (_) {
      this.toast("Не удалось вставить шаблон (см. консоль Ctrl+Shift+I)", "error");
    }
  }

  // ---------------------------------------------------------------- настройки плагина

  getSettingsPanel() {
    const wrap = document.createElement("div");
    wrap.style.cssText = "padding:8px 0; color:var(--text-normal);";

    const info = document.createElement("div");
    info.style.cssText = "margin-bottom:8px; font-size:13px; color:var(--text-muted); line-height:1.45; white-space:pre-line;";
    info.textContent =
      "Формат: строка «## Название сервера» начинает набор шаблонов этого сервера, " +
      "строка «### Название шаблона» начинает шаблон, ниже идёт его текст.\n" +
      "Шаблоны выше первого «## » общие и показываются на всех серверах. " +
      "Набор выбирается автоматически по названию открытого сервера (достаточно части названия), " +
      "переключать вручную можно клавишей Tab в окне шаблонов.\n" +
      "Если внутри текста шаблона нужна строка-заголовок Discord (## или ###), поставь перед ней обратный слэш: \\## текст. В сообщение он не попадёт.\n" +
      "Alt+1…9 вставляет шаблоны сверху списка без открытия окна, Ctrl+P в окне закрепляет шаблон. " +
      "Закреплённые можно менять местами перетаскиванием, а кнопка «Назначить» у шаблона задаёт ему свою клавишу. " +
      "Экспорт сохраняет шаблоны, статистику, закрепления и клавиши в файл; импорт понимает этот файл и сам конфиг плагина.";

    const ta = document.createElement("textarea");
    ta.value = this.raw;
    ta.rows = 20;
    ta.style.cssText =
      "width:100%; box-sizing:border-box; padding:8px; border-radius:4px; border:none; outline:none; " +
      "background:var(--input-background); color:var(--text-normal); font-family:monospace; font-size:13px;";

    const row = document.createElement("div");
    row.style.cssText = "display:flex; gap:8px; margin-top:8px; flex-wrap:wrap;";

    const mkBtn = (label, onClick) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.cssText =
        "padding:6px 14px; border:none; border-radius:4px; cursor:pointer; " +
        "background:var(--brand-500, #5865f2); color:#fff; font-size:14px;";
      b.addEventListener("click", onClick);
      return b;
    };

    row.append(
      mkBtn("Сохранить", () => {
        const parsed = this.parseTemplates(ta.value);
        if (!parsed.length) {
          this.toast("Не нашёл ни одного шаблона. Проверь формат «### Название»", "error");
          return;
        }
        this.saveRaw(ta.value);
        const g = this.groups();
        this.toast(
          "Сохранено шаблонов: " + parsed.length + (g.length ? " (наборы: " + g.join(", ") + ")" : ""),
          "success"
        );
      }),
      mkBtn("Вернуть примеры", () => {
        ta.value = DEFAULT_RAW;
      }),
      mkBtn("Сбросить статистику", () => {
        this.resetUsage();
        this.toast("Статистика использования шаблонов сброшена", "success");
      }),
      mkBtn("Экспорт в файл", () => this.exportBackup()),
      mkBtn("Импорт из файла", () => this.importBackup(() => { ta.value = this.raw; }))
    );

    if (TEMPLATES_URL) {
      row.append(
        mkBtn("Обновить с сайта", async () => {
          await this.syncFromUrl(false);
          ta.value = this.raw;
        })
      );
    }

    wrap.append(info, ta, row);
    return wrap;
  }
};
