// ==UserScript==
// @name         VK Templates Search
// @namespace    majestic-support
// @version      0.5
// @description  Поиск, фильтры и подсветка в панели шаблонов сообщений ВКонтакте
// @match        https://vk.ru/*
// @match        https://vk.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const VERSION = '0.5';
  const LS_FREC = 'mjxTplFrecency';
  const LS_DEBUG = 'mjxTplDebug';

  const MIN_BODY = 3;   // короче — по телу не ищем, иначе матчит всё
  const MIN_FUZZY = 4;  // фаззи только для осмысленных слов

  const dbg = () => localStorage.getItem(LS_DEBUG) === '1';
  const log = (...a) => { if (dbg()) console.log('%c[mjx]', 'color:#71aaeb;font-weight:bold', ...a); };

  const loadFrec = () => { try { return JSON.parse(localStorage.getItem(LS_FREC)) || {}; } catch { return {}; } };
  const saveFrec = f => { try { localStorage.setItem(LS_FREC, JSON.stringify(f)); } catch {} };

  // soft: посимвольно 1:1, индексы совпадают с оригиналом
  const soft = s => (s || '').replace(/\u00a0/g, ' ').toLowerCase().replace(/ё/g, 'е');
  // hard: для матчинга, плейсхолдеры и лишние пробелы выкидываем
  const hard = s => soft(s).replace(/\{[^}]*\}/g, ' ').replace(/\s+/g, ' ').trim();
  const tokenize = s => hard(s).split(' ').filter(Boolean);

  // ключ = подстрока названия шаблона, значение = синонимы, по которым его тоже найдут
  const ALIASES = [
    ['фризит игру', 'фпс fps лаги лагает фризы тормозит просадки статтер stutter'],
    ['ошибка внедрения патча', 'краш крашится вылет вылетает закрывается патч инжект'],
    ['вечный запуск', 'бесконечный висит зависает не запускается патчится'],
    ['server not responding', 'снр сервер не отвечает коннект подключение'],
    ['черный экран', 'чёрный blackscreen пустой экран'],
    ['долгая проверка файлов', 'загрузка качается медленно скачивание'],
    ['не удалось скачать ресурс', 'ресурс кэш cache файл не качается'],
    ['не удаляют моды', 'redux редукс замененки одежда текстуры'],
    ['reshade', 'решейд енб enb коммандлайн commandline графмоды'],
    ['пропадает голосовой чат', 'войс voice голос микрофон не слышно'],
    ['отсутствует миникарта', 'радар карта миникарта пропала гпс'],
    ['не удалось обнаружить rgl', 'рокстар rockstar лаунчер рокстара socialclub'],
    ['аккаунт social club', 'сошиалклаб сц регистрация уже зарегистрирован'],
    ['выбивает чужой аккаунт', 'чужой бан не мой аккаунт ip'],
    ['запускается версия стим', 'steam стим steamapi'],
    ['microsoft vc', 'визуал visual c++ redist драйвера msvc'],
    ['vpn', 'впн обход запрет прокси proxy днс dns'],
    ['переустановка винды', 'windows винда виндовс переустановить систему образ'],
    ['запрос логов', 'логи log main.log клиентлог'],
    ['проблемы с донатом', 'донат оплата платеж деньги чек не пришло валюта'],
    ['проблемы с аккаунтом', '2фа 2fa двухфакторка восстановление угнали взлом почта'],
    ['временная блокировка', 'ограничение транзакции заморозка снятие'],
    ['разбаны амнистии жалобы', 'разбан бан амнистия жалоба апелляция unban'],
    ['разбан telegram', 'тг телега телеграм дискорд discord мут'],
    ['баг репорт', 'баг bug багрепорт сообщить о баге'],
    ['обращение к администрации', 'админ администратор репорт report жалоба на игрока'],
    ['улучшение проекта', 'предложение идея фича suggestion'],
    ['вопросы по форуму', 'форум forum регистрация на форуме'],
    ['вопросы по медиа', 'медиа media блогер стример ютуб twitch'],
    ['купить ключ активации', 'ключ key гта5 гта покупка активация rockstar'],
    ['бонус код', 'бонускод бонус premium промокод'],
    ['проблемы с мерчем', 'мерч merch store магазин одежда'],
    ['о проблеме известно', 'известно баг чиним разработчики'],
    ['технический раздел', 'техраздел форум техподдержка'],
    ['наш лаунчер', 'лаунчер launcher скачать установщик'],
    ['1.500.7', 'ошибка регистрации 1.000.7 rockstar reg'],
  ];

  let API = { version: VERSION, mounted: false };
  window.__mjxTpl = API;

  function collect(root) {
    return [...root.querySelectorAll('.Templates__listItem')].map((el, idx) => {
      const titleEl = el.querySelector('.vkuiSimpleCell__overTitle');
      const bodyEl = el.querySelector('.vkuiSimpleCell__children');
      const rawTitle = (titleEl?.textContent || '').replace(/\u00a0/g, ' ').trim();
      const rawBody = (bodyEl?.textContent || '').replace(/\u00a0/g, ' ').trim();
      const title = hard(rawTitle);
      const alias = ALIASES.filter(([k]) => title.includes(k)).map(([, v]) => v).join(' ');
      return {
        idx, el, titleEl, bodyEl, rawTitle, rawBody,
        title, alias, body: hard(rawBody),
        tag: /^ро\s*[-–—]/i.test(rawTitle) ? 'ro' : 'mj',
      };
    });
  }

  // 4 всё в названии | 3 синонимы | 2 всё в тексте | -1 мимо
  function strictScore(it, toks) {
    const all = hay => toks.every(t => hay.includes(t));
    if (all(it.title)) return { score: 4, where: 'title' };
    if (it.alias && all(it.title + ' ' + it.alias)) return { score: 3, where: 'alias' };
    if (toks.every(t => t.length >= MIN_BODY) && all(it.body)) return { score: 2, where: 'body' };
    return { score: -1, where: null };
  }

  // длина участка, на котором уложилась подпоследовательность; -1 если нет
  function subseqSpan(needle, hay) {
    let i = 0, start = -1;
    for (let p = 0; p < hay.length; p++) {
      if (hay[p] === needle[i]) {
        if (i === 0) start = p;
        if (++i === needle.length) return p - start + 1;
      }
    }
    return -1;
  }

  // запасной проход: одно слово, не короче MIN_FUZZY, совпадение плотное
  function fuzzyScore(it, toks) {
    if (toks.length !== 1) return -1;
    const t = toks[0];
    if (t.length < MIN_FUZZY) return -1;
    const span = subseqSpan(t, it.title);
    return span >= 0 && span <= t.length * 3 ? 1 : -1;
  }

  // общий счёт — используется в report()
  function scoreOf(it, toks) {
    if (!toks.length) return { score: 0, where: null };
    const s = strictScore(it, toks);
    if (s.score >= 0) return s;
    const f = fuzzyScore(it, toks);
    return f >= 0 ? { score: f, where: 'title' } : { score: -1, where: null };
  }

  // диапазоны совпадений всех токенов, слитые
  function ranges(text, toks) {
    const s = soft(text);
    const rs = [];
    for (const t of toks) {
      let from = 0, i;
      while ((i = s.indexOf(t, from)) >= 0) { rs.push([i, i + t.length]); from = i + t.length; }
    }
    rs.sort((a, b) => a[0] - b[0]);
    const out = [];
    for (const r of rs) {
      const last = out[out.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else out.push([...r]);
    }
    return out;
  }

  // строка тела с максимумом попаданий
  function bestLine(rawBody, toks) {
    const lines = rawBody.split('\n');
    let best = null, bestHits = 0;
    for (const line of lines) {
      const s = soft(line);
      const hits = toks.reduce((n, t) => n + (s.includes(t) ? 1 : 0), 0);
      if (hits > bestHits) { bestHits = hits; best = line.trim(); }
    }
    return bestHits ? best : null;
  }

  function buildHl(className, text, rs) {
    const span = document.createElement('span');
    span.className = className;
    span.classList.add('mjx-ov');
    let at = 0;
    for (const [from, to] of rs) {
      if (from > at) span.append(document.createTextNode(text.slice(at, from)));
      const m = document.createElement('mark');
      m.textContent = text.slice(from, to);
      Object.assign(m.style, {
        background: 'rgba(113,170,235,.4)', color: 'inherit',
        borderRadius: '3px', padding: '0 1px',
      });
      span.append(m);
      at = to;
    }
    span.append(document.createTextNode(text.slice(at)));
    return span;
  }

  function addBadge(it) {
    const slot = it.el.querySelector('.vkuiSimpleCell__before');
    if (!slot || slot.querySelector('.mjx-badge')) return;
    const b = document.createElement('span');
    b.className = 'mjx-badge';
    b.textContent = it.tag === 'ro' ? 'RO' : 'MJ';
    b.title = it.tag === 'ro' ? 'Russia Online' : 'Majestic';
    Object.assign(b.style, {
      display: 'inline-block', flex: '0 0 auto', marginRight: '8px',
      padding: '1px 5px', borderRadius: '5px', fontSize: '10px',
      fontWeight: '600', lineHeight: '14px', letterSpacing: '.3px',
      background: it.tag === 'ro' ? 'rgba(233,122,42,.22)' : 'rgba(38,136,235,.22)',
      color: it.tag === 'ro' ? '#e97a2a' : '#5aa1ea',
    });
    slot.append(b);
  }

  function mount(root) {
    const header = root.querySelector('.Templates__header');
    const content = root.querySelector('[data-scrollbar="content"]');
    if (!header || !content || root.querySelector('.mjx-tpl-ui')) return;

    // flex-колонка: двигаем частые наверх через order, DOM не трогаем
    content.style.display = 'flex';
    content.style.flexDirection = 'column';

    const ui = document.createElement('div');
    ui.className = 'mjx-tpl-ui';
    Object.assign(ui.style, { padding: '0 12px 8px', boxSizing: 'border-box' });

    const box = document.createElement('div');
    box.style.position = 'relative';

    const input = document.createElement('input');
    input.placeholder = 'Поиск: название, текст или синоним…';
    input.spellcheck = false;
    Object.assign(input.style, {
      width: '100%', padding: '7px 56px 7px 10px', borderRadius: '8px',
      boxSizing: 'border-box', fontSize: '13px', outline: 'none',
      border: '1px solid var(--vkui--color_field_border_alpha, #4a4a4a)',
      background: 'var(--vkui--color_field_background, #1c1c1e)',
      color: 'var(--vkui--color_text_primary, #e1e3e6)',
    });

    const counter = document.createElement('span');
    Object.assign(counter.style, {
      position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)',
      fontSize: '11px', pointerEvents: 'none',
      color: 'var(--vkui--color_text_secondary, #828282)',
    });
    box.append(input, counter);

    const chips = document.createElement('div');
    Object.assign(chips.style, { display: 'flex', gap: '6px', marginTop: '6px' });

    let tagFilter = 'all';
    const chipEls = [['all', 'Все'], ['ro', 'Russia Online'], ['mj', 'Majestic']].map(([key, label]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      Object.assign(b.style, {
        padding: '3px 10px', borderRadius: '12px', border: 'none',
        fontSize: '11px', cursor: 'pointer', whiteSpace: 'nowrap',
      });
      b.addEventListener('click', () => { tagFilter = key; apply(); });
      chips.append(b);
      return { key, b };
    });

    function paintChips() {
      for (const { key, b } of chipEls) {
        const on = key === tagFilter;
        b.style.background = on
          ? 'var(--vkui--color_background_accent, #2688eb)'
          : 'var(--vkui--color_background_secondary, #2c2d2e)';
        b.style.color = on ? '#fff' : 'var(--vkui--color_text_secondary, #909499)';
      }
    }

    ui.append(box, chips);
    header.insertAdjacentElement('afterend', ui);

    let items = collect(root);
    let frec = loadFrec();
    let cursor = -1;
    let lastVisible = [];

    items.forEach(addBadge);

    function clearOverlays() {
      for (const it of items) {
        it.el.querySelectorAll('.mjx-ov').forEach(n => n.remove());
        if (it.titleEl) it.titleEl.style.display = '';
        if (it.bodyEl) it.bodyEl.style.display = '';
      }
    }

    function paintCursor() {
      for (const it of items) it.el.style.background = '';
      const cur = lastVisible[cursor];
      if (cur) {
        cur.el.style.background = 'var(--vkui--color_background_secondary, #2c2d2e)';
        cur.el.scrollIntoView({ block: 'nearest' });
      }
    }

    function apply() {
      const toks = tokenize(input.value);
      clearOverlays();
      paintChips();

      const pool = items.filter(it => tagFilter === 'all' || it.tag === tagFilter);
      let scored = [];
      let fuzzy = false;

      if (!toks.length) {
        scored = pool.map(it => ({ it, score: 0, where: null }));
      } else {
        for (const it of pool) {
          const r = strictScore(it, toks);
          if (r.score >= 0) scored.push({ it, ...r });
        }
        if (!scored.length) {
          // строгих нет — только тогда показываем «похожие»
          fuzzy = true;
          for (const it of pool) {
            const s = fuzzyScore(it, toks);
            if (s >= 0) scored.push({ it, score: s, where: 'title' });
          }
        }
      }

      const byEl = new Map(scored.map(s => [s.it, s]));
      for (const it of items) {
        const s = byEl.get(it);
        it.el.style.display = s ? '' : 'none';
        it.el.style.order = String(-(((s ? s.score : -1) + 1) * 1000 + Math.min(999, frec[it.rawTitle] || 0)));
      }

      if (toks.length) {
        for (const { it, where } of scored) {
          const tr = ranges(it.rawTitle, toks);
          if (it.titleEl && tr.length) {
            it.titleEl.style.display = 'none';
            it.titleEl.after(buildHl(it.titleEl.className, it.rawTitle, tr));
          }
          if (where === 'body' && it.bodyEl) {
            const line = bestLine(it.rawBody, toks);
            if (line) {
              it.bodyEl.style.display = 'none';
              const ov = buildHl(it.bodyEl.className, line, ranges(line, toks));
              Object.assign(ov.style, {
                display: '-webkit-box', WebkitLineClamp: '2',
                WebkitBoxOrient: 'vertical', overflow: 'hidden',
              });
              it.bodyEl.after(ov);
            }
          }
        }
      }

      lastVisible = scored
        .sort((a, b) => Number(a.it.el.style.order) - Number(b.it.el.style.order))
        .map(s => s.it);

      cursor = toks.length && lastVisible.length ? 0 : -1;
      counter.textContent = toks.length || tagFilter !== 'all'
        ? `${fuzzy ? '≈' : ''}${lastVisible.length}/${items.length}`
        : `${items.length}`;
      input.style.borderColor = toks.length && !lastVisible.length
        ? 'var(--vkui--color_text_negative, #e64646)'
        : 'var(--vkui--color_field_border_alpha, #4a4a4a)';
      paintCursor();
      log('apply', { toks, tagFilter, visible: lastVisible.length, fuzzy });
    }

    function pick(it) {
      if (!it) return;
      frec[it.rawTitle] = (frec[it.rawTitle] || 0) + 1;
      saveFrec(frec);
      log('pick', it.rawTitle);
      it.el.click(); // родной клик — VK сам подставит {greeting}/{user name}
    }

    input.addEventListener('input', apply);
    input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (lastVisible.length) { cursor = (cursor + 1) % lastVisible.length; paintCursor(); }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (lastVisible.length) { cursor = (cursor - 1 + lastVisible.length) % lastVisible.length; paintCursor(); }
      } else if (e.key === 'Tab') {
        e.preventDefault();
        const order = ['all', 'ro', 'mj'];
        tagFilter = order[(order.indexOf(tagFilter) + 1) % 3];
        apply();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        pick(lastVisible[cursor >= 0 ? cursor : 0]);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        if (input.value) { input.value = ''; apply(); } else input.blur();
      }
    });

    new MutationObserver(() => {
      const next = collect(root);
      if (next.length !== items.length) {
        log('list changed', items.length, '->', next.length);
        items = next; items.forEach(addBadge); apply();
      }
    }).observe(content, { childList: true });

    apply();
    input.focus();

    // ---- debug API ----
    API = Object.assign(API, {
      version: VERSION,
      mounted: true,
      get items() { return items; },
      get state() { return { query: input.value, tagFilter, cursor, visible: lastVisible.length }; },
      frecency: () => loadFrec(),
      resetFrecency: () => { frec = {}; saveFrec(frec); apply(); },
      setDebug: on => localStorage.setItem(LS_DEBUG, on ? '1' : '0'),
      search: q => { input.value = q; apply(); return lastVisible.map(i => `${i.tag.toUpperCase()} ${i.rawTitle}`); },
      table: () => console.table(items.map(i => ({
        idx: i.idx, tag: i.tag, title: i.rawTitle, bodyLen: i.rawBody.length,
        aliasLen: i.alias.length, frec: frec[i.rawTitle] || 0,
        order: i.el.style.order, hidden: i.el.style.display === 'none',
      }))),
      report() {
        const anchors = {
          container: document.querySelectorAll('.Templates__container').length,
          header: document.querySelectorAll('.Templates__header').length,
          listItem: document.querySelectorAll('.Templates__listItem').length,
          overTitle: document.querySelectorAll('.vkuiSimpleCell__overTitle').length,
          children: document.querySelectorAll('.vkuiSimpleCell__children').length,
          scrollContent: document.querySelectorAll('[data-scrollbar="content"]').length,
        };
        const bodies = items.map(i => i.rawBody.length);
        const probe = ['разбан', 'фпс', 'тг', 'краш', 'донат', 'разбан тг', 'рзбан']
          .map(q => `${q}=${items.filter(i => scoreOf(i, tokenize(q)).score >= 0).length}`);
        return [
          `mjx v${VERSION} | ${location.host}${location.pathname}`,
          `anchors: ${JSON.stringify(anchors)}`,
          `items=${items.length} bodyLen min/max=${Math.min(...bodies)}/${Math.max(...bodies)}`,
          `tags: ro=${items.filter(i => i.tag === 'ro').length} mj=${items.filter(i => i.tag === 'mj').length}`,
          `noAlias: ${items.filter(i => !i.alias).map(i => i.rawTitle).join(' | ') || '—'}`,
          `state: ${JSON.stringify(this.state)}`,
          `probe: ${probe.join(' ')}`,
          `badges=${document.querySelectorAll('.mjx-badge').length} overlays=${document.querySelectorAll('.mjx-ov').length}`,
        ].join('\n');
      },
    });
    window.__mjxTpl = API;
    log('mounted', items.length);
  }

  new MutationObserver(() => {
    const root = document.querySelector('.Templates__container');
    if (root) mount(root);
  }).observe(document.body, { childList: true, subtree: true });
})();
