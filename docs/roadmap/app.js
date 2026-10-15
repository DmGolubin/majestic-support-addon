const labels = { focus: 'Ближайшее', all: 'Весь список', active: 'Делаю сейчас', review: 'Проверить', blocked: 'Нужен API', planned: 'Не начато', deferred: 'На потом', done: 'Готово' };
let data, serialized = '', area = 'all', status = 'focus', query = '', busy = false;
const $ = id => document.getElementById(id);
function el(tag, text, cls) { const node = document.createElement(tag); if (text != null) node.textContent = text; if (cls) node.className = cls; return node; }
function button(text, on, fn) { const node = el('button', text, on ? 'on' : ''); node.type = 'button'; node.setAttribute('aria-pressed', String(on)); node.onclick = fn; return node; }
function render() {
    const opened = new Set([...document.querySelectorAll('.task[open]')].map(n => n.dataset.id));
    const expandedGroups = new Set([...document.querySelectorAll('.readiness-card details[open]')].map(n => n.dataset.group));
    $('updated').textContent = 'Обновлено ' + data.updated;
    $('baseline').textContent = data.baseline;
    $('decisions').replaceChildren(...data.decisions.map(d => el('li', d)));
    const count = s => data.tasks.filter(t => t.status === s).length;
    const groups = [
        ['Показ в Discord', ['A10','A11','A13','C02'], 'Личные шаблоны, переменные, вход и обновление FAQ в локальном демо.'],
        ['Выпуск команде', ['R02','R03','R04'], 'Документация, версия и установка. Завершённое демо ещё не означает готовый выпуск.'],
        ['Подключение к сайту', ['C03','C04','C05','C06','C07','C08','C09'], 'Нужен API разработчика панели. Реальные аккаунты и синхронизация пока не подключены.']
    ];
    $('readiness').replaceChildren(...groups.map(([title, ids, description]) => {
        const items = ids.map(id => data.tasks.find(t => t.id === id)).filter(Boolean);
        const ready = items.every(t => t.status === 'done');
        const card = el('article', null, 'readiness-card');
        card.append(el('span', ready ? 'Проверено' : title === 'Подключение к сайту' ? 'Зависит от разработчика панели' : 'Ещё не закрыто', 'eyebrow'), el('h2', title), el('p', description));
        const list = el('ul');
        for (const t of items) {
            const li = el('li');
            const b = button(t.title, false, () => { status='all'; area='all'; query=t.id.toLowerCase(); $('search').value=t.id; render(); const row=document.querySelector(`[data-id="${t.id}"]`); if(row){row.open=true;row.scrollIntoView({block:'center'});} });
            li.append(b, el('span', labels[t.status], 'readiness-status')); list.append(li);
        }
        const steps = el('details'); steps.dataset.group = title; steps.open = expandedGroups.has(title);
        steps.append(el('summary', `Шаги: ${items.filter(t => t.status === 'done').length} из ${items.length} готовы`), list);
        const next = items.find(t => t.status !== 'done');
        card.append(el('p', next ? 'Далее: ' + next.title : 'Все проверки этого этапа завершены.', 'readiness-next'), steps); return card;
    }));
    $('metrics').replaceChildren(...[[count('done'), 'Завершено'], [count('review'), 'Нужна приёмка'], [count('planned') + count('active') + count('blocked'), 'Впереди и в работе'], [count('deferred'), 'Отложено']].map(([n, title]) => { const node = el('div', null, 'metric'); node.append(el('strong', n), el('span', title)); return node; }));
    const active = data.tasks.filter(t => t.status === 'active');
    $('active').textContent = active.length ? active.map(t => t.title).join(' · ') : 'Сейчас работа не выполняется. Следующие задачи — ниже в разделе «Ближайшее».';
    $('areas').replaceChildren(...['all', ...new Set(data.tasks.map(t => t.area))].map(a => {
        const b = button('', area === a, () => { area = a; render(); });
        b.append(el('span', a === 'all' ? 'Весь проект' : a), el('b', data.tasks.filter(t => a === 'all' || t.area === a).length)); return b;
    }));
    $('filters').replaceChildren(...Object.entries(labels).map(([s, label]) => button(label, status === s, () => { status = s; render(); })));
    const order = Object.keys(labels);
    const tasks = data.tasks.filter(t => (area === 'all' || t.area === area) && (status === 'all' || (status === 'focus' ? ['active','review'].includes(t.status) || ['R02','R03','R04'].includes(t.id) && t.status === 'planned' : t.status === status)) && (/^[a-z]\d+$/i.test(query) ? t.id.toLowerCase() === query : `${t.id} ${t.title} ${t.detail} ${t.area}`.toLowerCase().includes(query))).sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
    $('list-title').textContent = area === 'all' ? labels[status] : area;
    $('count').textContent = `${tasks.length} из ${data.tasks.length}`;
    $('tasks').replaceChildren(...tasks.map(t => {
        const node = el('details', null, 'task'); node.dataset.id = t.id; node.open = opened.has(t.id);
        const summary = el('summary'); const title = el('span', t.title, 'task-name'); title.append(el('span', t.area, 'task-area'));
        summary.append(el('span', t.id, 'task-id'), title, el('span', labels[t.status], `badge ${t.status}`));
        const body = el('div', null, 'task-body'); body.append(el('p', t.detail));
        for (const p of t.evidence) { const a = el('a', p.split('/').pop()); a.href = '../' + p; a.target = '_blank'; a.rel = 'noopener'; body.append(a); }
        body.append(el('small', 'Обновлено ' + t.updated)); node.append(summary, body); return node;
    }));
    if (!tasks.length) $('tasks').append(el('div', 'Нет совпадений. Измените поиск или фильтры.', 'empty'));
}
async function refresh() {
    if (busy) return; busy = true;
    try {
        const r = await fetch('data.json', { cache: 'no-store', signal: AbortSignal.timeout(4000) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const next = await r.json();
        if (!Array.isArray(next.tasks) || next.tasks.some(t => !labels[t.status])) throw new Error('Invalid roadmap');
        const value = JSON.stringify(next);
        if (value !== serialized) { data = next; serialized = value; render(); }
        $('connection').className = ''; $('connection').textContent = 'Список актуален · ' + new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    } catch { $('connection').className = 'error'; $('connection').textContent = data ? 'Нет связи · показана последняя копия' : 'Не удалось загрузить список. Запустите pnpm roadmap:serve'; }
    finally { busy = false; }
}
$('search').oninput = e => { query = e.target.value.trim().toLowerCase(); if (data) render(); };
$('refresh').onclick = refresh;
refresh(); setInterval(refresh, 5000);
