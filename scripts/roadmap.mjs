import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'docs/roadmap/data.json');
const data = JSON.parse(fs.readFileSync(source, 'utf8'));
const labels = { active: 'В работе', review: 'Реализовано · нужна приёмка', blocked: 'Ожидает API', planned: 'Осталось', deferred: 'Отложено', done: 'Сделано' };
const args = process.argv.slice(2);
const ids = new Set();
for (const task of data.tasks) {
    if (ids.has(task.id) || !labels[task.status] || !task.title || !task.detail || !task.area) throw new Error(`Invalid task ${task.id}`);
    ids.add(task.id);
    for (const link of task.evidence) {
        const resolved = path.resolve(root, 'docs', link);
        if (!resolved.startsWith(path.join(root, 'docs') + path.sep) || !fs.existsSync(resolved)) throw new Error(`Missing evidence ${link}`);
    }
}
if (args[0] === 'set') {
    const [, id, status, ...note] = args;
    const task = data.tasks.find(t => t.id === id);
    if (!task || !labels[status] || !note.length) throw new Error('Usage: node scripts/roadmap.mjs set ID STATUS "Current progress and remaining work"');
    const stamp = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Bucharest', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    task.status = status; task.detail = note.join(' '); task.updated = stamp; data.updated = stamp;
    fs.writeFileSync(source, JSON.stringify(data, null, 2) + '\n');
} else if (args.length && args[0] !== '--check') throw new Error('Unknown command');
const header = `<!-- Generated from docs/roadmap/data.json; edit the source, then run node scripts/roadmap.mjs. -->\n# SupportTemplates — актуальный план\n\nОбновлено: ${data.updated}. Ветка: ${data.branch}.\n\nЕдинственный список задач: [roadmap/data.json](roadmap/data.json). [Сайт roadmap](roadmap/index.html) запускается командой \`pnpm roadmap:serve\` и открывается на http://127.0.0.1:47834/roadmap/.\n\n${data.baseline}\n\nСтатус «реализовано · нужна приёмка» не означает готовый релиз. Демо не является настоящим API. Исторические аудиты фиксируют состояние на дату отчёта и не заменяют этот список.\n\n`;
function sections(tasks, prefix) {
    return Object.entries(labels).map(([status, label]) => {
        const group = tasks.filter(t => t.status === status);
        return `## ${label} (${group.length})\n\n` + (group.map(t => `### ${t.id} · ${t.title}\n\n${t.area}. ${t.detail}\n` + (t.evidence.length ? '\nОснование: ' + t.evidence.map(p => `[${path.basename(p)}](${prefix}${p})`).join(', ') + '.\n' : '')).join('\n') || 'Нет задач.\n');
    }).join('\n');
}
const status = header + '## Принятые решения\n\n' + data.decisions.map(d => '- ' + d).join('\n') + '\n\n' + sections(data.tasks, '');
const todo = '<!-- Generated from docs/roadmap/data.json. -->\n# Что осталось и отложено\n\nЭто представление единого roadmap, а не отдельный план. Полный список с выполненными задачами: [STATUS](docs/STATUS.md). Обновление: `node scripts/roadmap.mjs`.\n\n' + sections(data.tasks.filter(t => t.status !== 'done'), 'docs/');
for (const [file, content] of [['docs/STATUS.md', status], ['TODO.md', todo]]) {
    const dest = path.join(root, file);
    if (args[0] === '--check') {
        if (fs.readFileSync(dest, 'utf8').replaceAll('\r\n', '\n') !== content) throw new Error(`${file} is stale: run node scripts/roadmap.mjs`);
    } else fs.writeFileSync(dest, content);
}
console.log(`Roadmap: ${data.tasks.length} tasks; STATUS and TODO ${args[0] === '--check' ? 'consistent' : 'updated'}.`);
