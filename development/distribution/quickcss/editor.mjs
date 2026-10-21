import * as monaco from 'monaco-editor/editor';
import 'monaco-editor/features/register.all';
import 'monaco-editor/languages/definitions/css/register';
import 'monaco-editor/languages/features/css/register';
import editorWorker from 'quickcss:editor-worker';
import cssWorker from 'quickcss:css-worker';

const workers = new Set();
const urls = new Map();
let editor, model, subscription, disposed = false;
self.MonacoEnvironment = {
    getWorker(_moduleId, label) {
        if (disposed) throw new Error('QuickCSS has closed');
        const source = ['css', 'scss', 'less'].includes(label) ? cssWorker : editorWorker;
        if (!urls.has(source)) urls.set(source, URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
        const worker = new Worker(urls.get(source), { name: `quickcss-${label}` });
        workers.add(worker);
        const terminate = worker.terminate.bind(worker);
        worker.terminate = () => { workers.delete(worker); terminate(); };
        return worker;
    }
};
const layout = () => editor?.layout();
window.addEventListener('resize', layout);
window.addEventListener('pagehide', () => {
    disposed = true;
    window.removeEventListener('resize', layout);
    subscription?.dispose();
    editor?.dispose();
    model?.dispose();
    for (const worker of workers) worker.terminate();
    for (const url of urls.values()) URL.revokeObjectURL(url);
    workers.clear(); urls.clear();
}, { once: true });

try {
    const css = await window.getCurrentCss();
    if (typeof css !== 'string') throw Error('Invalid CSS');
    if (!disposed) {
        model = monaco.editor.createModel(css, 'css');
        editor = monaco.editor.create(document.getElementById('container'), {
            model, ariaLabel: 'QuickCSS', theme: window.getTheme() === 'vs-dark' ? 'vs-dark' : 'vs'
        });
        subscription = editor.onDidChangeModelContent(() => window.setCss(editor.getValue()));
    }
} catch {
    // Never replace existing CSS with an empty editor after a failed read.
    const status = document.getElementById('status');
    status.hidden = false;
    status.textContent = 'Не удалось открыть QuickCSS. Закройте окно и попробуйте снова.';
}
