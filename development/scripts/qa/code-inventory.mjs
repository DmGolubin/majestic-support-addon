// Static review inventory, not a claim of runtime or branch coverage.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import ts from 'typescript';

const output = process.argv[2];
if (!output) throw new Error('Usage: node scripts/qa/code-inventory.mjs <output.json>');
if (fs.existsSync(output)) throw new Error('Refusing to overwrite an earlier inventory');
const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {encoding: 'utf8'}).split('\0').filter(Boolean))]
    .filter(p => /\.(?:[cm]?js|[cm]?ts|tsx|css|ps1|bat|cmd|py|json|ya?ml|html)$/.test(p)
        && !p.startsWith('docs/') && !/(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml)$/.test(p));
const rows = files.map(file => {
    const bytes = fs.readFileSync(file), text = bytes.toString('utf8'), symbols = [];
    const syntax = /\.(?:[cm]?ts|tsx|[cm]?js)$/.test(file);
    if (syntax) {
        const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
        const visit = node => {
            if (ts.isFunctionLike(node) && node.body) {
                const name = node.name?.getText(source) ?? node.parent?.name?.getText(source) ?? '<callback>';
                symbols.push({name, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1});
            }
            ts.forEachChild(node, visit);
        };
        visit(source);
    } else if (/\.(?:py|ps1)$/.test(file)) {
        text.split(/\r?\n/).forEach((line, index) => {
            const match = /^\s*(?:async\s+def|def|function)\s+([\w-]+)/i.exec(line);
            if (match) symbols.push({name: match[1], line: index + 1});
        });
    }
    return {file, category: file.startsWith('tests/') ? 'tests' : file.startsWith('reference/') ? 'historical-reference'
        : file.startsWith('scripts/') ? 'tooling' : 'product-or-build',
        sha256: createHash('sha256').update(bytes).digest('hex'), lines: text.split(/\r?\n/).length,
        symbolMethod: syntax ? 'TypeScript AST function-like bodies' : /\.(?:py|ps1)$/.test(file) ? 'declaration line scan' : 'not applicable',
        symbols};
});
fs.mkdirSync(path.dirname(path.resolve(output)), {recursive: true});
fs.writeFileSync(output, JSON.stringify({
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {encoding:'utf8'}).trim(),
    limitation: 'Static inventory of tracked and nonignored untracked own files. Symbols are review navigation, not test/function coverage. Vendor dependencies and generated artifacts are separate boundaries.',
    files: rows
}, null, 2) + '\n');
console.log(JSON.stringify({files: rows.length, symbols: rows.reduce((n,r) => n + r.symbols.length, 0),
    categories: Object.fromEntries([...new Set(rows.map(r=>r.category))].map(c=>[c,rows.filter(r=>r.category===c).length]))}));
