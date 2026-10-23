// Typecheck the current plugin in the Vencord source layout without copying or building it.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = path.resolve(process.env.VENCORD_DIR ?? path.join(root, '../Vencord'));
const requireBase = createRequire(path.join(base, 'package.json'));
const ts = requireBase('typescript');
const virtual = path.join(base, 'src/userplugins/supportTemplates');
const normalize = p => {
    const absolute = path.resolve(p).replaceAll('\\', '/');
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
};
const prefix = normalize(virtual) + '/';
const files = new Map();
const roots = [];
const directories = new Set();
function collect(dir, target) {
    directories.add(normalize(target));
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) collect(path.join(dir, entry.name), path.join(target, entry.name));
        else {
            const name = path.join(target, entry.name);
            files.set(normalize(name), path.join(dir, entry.name));
            if (/\.tsx?$/.test(name)) roots.push(name);
        }
    }
}
collect(path.join(root, 'src/vencord'), virtual);
collect(path.join(root, 'src/core'), path.join(virtual, 'core'));
const sourcePath = name => normalize(name).startsWith(prefix) ? files.get(normalize(name)) : name;
const configPath = path.join(base, 'tsconfig.json');
const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, base);
const options = { ...parsed.options, noEmit: true };
const host = ts.createCompilerHost(options);
host.readFile = name => { const mapped = sourcePath(name); return mapped ? ts.sys.readFile(mapped) : undefined; };
host.fileExists = name => { const mapped = sourcePath(name); return !!mapped && ts.sys.fileExists(mapped); };
host.directoryExists = name => normalize(name) === normalize(virtual) || normalize(name).startsWith(prefix)
    ? directories.has(normalize(name)) : ts.sys.directoryExists(name);
host.getSourceFile = (name, languageVersion) => {
    const content = host.readFile(name);
    return content === undefined ? undefined : ts.createSourceFile(name, content, languageVersion, true);
};
const names = parsed.fileNames.filter(name => !normalize(name).startsWith(prefix));
names.push(...roots);
const program = ts.createProgram(names, options, host);
const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
if (diagnostics.length) {
    console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCurrentDirectory: () => base, getCanonicalFileName: name => name, getNewLine: () => '\n'
    }));
    process.exitCode = 1;
} else console.log('Current plugin + Vencord typecheck passed (read-only virtual source overlay).');
