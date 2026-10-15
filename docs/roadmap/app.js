const labels = { all: 'Все', active: 'В работе', review: 'Нужна приёмка', blocked: 'Ожидает API', planned: 'Осталось', deferred: 'Отложено', done: 'Сделано' };
let data, serialized = '', area = 'all', status = 'all', query = '', busy = false;
const $ = id => document.getElementById(id);
function el(tag, text, cls) { const node = document.createElement(tag); if (text != null) node.textContent = text; if (cls) node.className = cls; return node; }
function button(text, on, fn) { const node = el('button', text, on ? 'on' : ''); node.type = 'button'; node.setAttribute('aria-pressed', String(on)); node.onclick = fn; return node; }
function render() {
    const opened = new Set([...document.querySelectorAll('.task[open]')].map(n => n.dataset.id));
    $('updated').textContent = 'Обновлено ' + data.updated;
    $('baseline').textContent = data.baseline;
    $('decisions').replaceChildren(...data.decisions.map(d => el('li', d)));
    const count = s => data.tasks.filter(t => t.status === s).length;
    $('metrics').replaceChildren(...[[count('done'), 'Завершено'], [count('review'), 'Нужна приёмка'], [count('planned') + count('active') + count('blocked'), 'Впереди и в работе'], [count('deferred'), 'Отложено']].map(([n, title]) => { const node = el('div', null, 'metric'); node.append(el('strong', n), el('span', title)); return node; }));
    const active = data.tasks.filter(t => t.status === 'active');
    $('active').textContent = active.length ? active.map(t => `${t.id} · ${t.title}`).join(' / ') : 'Нет активной задачи — следующий этап ещё не начат';
    $('areas').replaceChildren(...['all', ...new Set(data.tasks.map(t => t.area))].map(a => {
        const b = button('', area === a, () => { area = a; render(); });
        b.append(el('span', a === 'all' ? 'Весь проект' : a), el('b', data.tasks.filter(t => a === 'all' || t.area === a).length)); return b;
    }));
    $('filters').replaceChildren(...Object.entries(labels).map(([s, label]) => button(label, status === s, () => { status = s; render(); })));
    const order = Object.keys(labels);
    const tasks = data.tasks.filter(t => (area === 'all' || t.area === area) && (status === 'all' || t.status === status) && `${t.id} ${t.title} ${t.detail} ${t.area}`.toLowerCase().includes(query)).sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
    $('list-title').textContent = area === 'all' ? 'Все задачи' : area;
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
