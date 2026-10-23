// A38 offline fixture: real React Window, core Store/ranking, key latch and product CSS.
// Host IO is mocked; no installed Discord process, release bundle or account is used.
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..').replaceAll('\\', '/');
const require = createRequire(root + '/betterdiscord/package.json');
const {build} = require('esbuild');
if (process.argv.includes('--help')) {
    console.log('node scripts/qa/a38-keyboard-regression.mjs NEW_CHILD_OF_scripts/qa/runs/a38-keyboard');
    process.exit(0);
}
const out = path.resolve(process.argv[2] || '').replaceAll('\\', '/');
if (!out.startsWith(root + '/scripts/qa/runs/a38-keyboard/') || fs.existsSync(out)) throw Error('Use a NEW A38 run directory');
fs.mkdirSync(out, {recursive:true});
fs.writeFileSync(out + '/react-shim.js', "export {default as React} from 'react';");

const samples = [
    ...Array.from({length:14}, (_, i) => ({id:`f${String(i).padStart(2,'0')}`, title:i === 13 ? 'Plainbody без приветствия' : `Ответ ${String(i).padStart(2,'0')} — настройка игры`, source:'faq'})),
    ...Array.from({length:10}, (_, i) => ({id:`p${String(i).padStart(2,'0')}`, title:`Личный ${String(i).padStart(2,'0')} — помощь игроку`, source:'personal'})),
].map((t, i) => ({...t, category:i % 2 ? 'Лаунчер' : 'Игра', project:'mj', status:'actual',
    text:(t.id === 'f13' ? '' : '**Приветствую!**\n\n') + `Инструкция ${t.id}.\n1. Откройте настройки.\n2. Проверьте файлы игры.`,
    statusNote:null, teamUses:0, command:null, color:null, updatedAt:null}));
const preferences = {favorites:['f06','f02'], recent:['f10','f01','f06','p02','f12','f09','f08','p07','f11','f02','f00'],
    usage:{}, binds:{}, previewOpen:false, techProject:'mj', showPersonalInAll:false, generalFirstInSearch:true,
    windowTabOrder:['all','personal','fav','recent']};
const obs = `import {createObservable} from '${root}/src/vencord/ui/observable.ts';`;
const stubs = {
    common:"import React from 'react';export * from 'react';export {React};",
    state:obs + `import {Store} from '${root}/src/core/state.ts';
export const ui=createObservable({management:false,windowOpen:true,dialog:null,menu:null,inline:null,channelRevision:0});
const tick=createObservable({v:0});
export const store=new Store({get:async k=>JSON.parse(localStorage.getItem(k)||'null'),set:async(k,v)=>localStorage.setItem(k,JSON.stringify(v))},true);
export const samples=${JSON.stringify(samples)};
store.replacePanelCatalog({templates:samples,personal:[],folders:[]});
store.restorePanelPreferences(${JSON.stringify(preferences)});
store.subscribe(()=>tick.set({v:tick.get().v+1}));
export const useStore=()=>tick.use().v;
export const activeScope=()=> 'mj';export const listedProject=()=> 'mj';export const poolFor=()=>store.templates;
export const pickTechProject=()=>{};
export const watchChatArea=fn=>{window.addEventListener('resize',fn);return()=>window.removeEventListener('resize',fn)};
window.a38Store=store;window.a38Ui=ui;
window.a38Preferences=patch=>store.restorePanelPreferences({...store.data,...patch});
`,
    debug:obs + `export const debugState=createObservable({on:false});export const debugEnabled=()=>false;export const debugVerbose=()=>false;
${['costEnd','dlog','keyDesc','logGeometry','noteKey','noteRender','noteSearch','noteWheel','setDebugHover','setDebugWindow'].map(n=>`export const ${n}=()=>{};`).join('')}
export const costStart=()=>0;`,
    platform:`export const storage={get:async k=>JSON.parse(localStorage.getItem(k)||'null'),set:async(k,v)=>localStorage.setItem(k,JSON.stringify(v))};
export const chatAreaRect=()=>({left:16,right:innerWidth-16,top:innerHeight-54,width:innerWidth-32,height:40});`,
    flow:`import {ui} from './uiState';
export const insertTemplate=(t,options={})=>{window.a38.calls.push({id:t.id,options});if(!window.a38.keepOpen)ui.set({windowOpen:false});document.querySelector('#chat-draft').focus()};`,
    op:"export const windowEditor=()=>document.querySelector('#chat-draft');",
    context:"export const openMenu=(...args)=>{window.a38.menus.push(args)};",
};
const aliases = {'@webpack/common':'common','./uiState':'state','./debug':'debug','../platform':'platform','./flow':'flow','./op':'op','./ContextMenu':'context'};

// Evaluate the exact global handler, rather than reproducing its Alt+N decision tree.
// Foreign input/channel/inline/dialog boundaries are minimal host stubs, outside this suite's scope.
const index = fs.readFileSync(root + '/src/vencord/index.tsx', 'utf8');
const begin = index.indexOf('function handleKey(e: KeyboardEvent) {');
const end = index.indexOf('\nlet host:', begin);
if (begin < 0 || end < begin) throw Error('Global handleKey extraction marker changed; inspect source');
const handler = index.slice(begin, end).trim();
fs.writeFileSync(out + '/global-handler-source.ts', handler);
stubs.global = `import {visibleItems} from '${root}/src/vencord/ui/Window.tsx';
import {ui,store,poolFor,activeScope} from './uiState';
import {insertTemplate} from './flow';
import {latchKey,startLatch,swallowLatched} from '${root}/src/vencord/ui/keylatch.ts';
import {favoritesOf} from '${root}/src/core/rank.ts';
import {comboOf} from '${root}/src/core/keys.ts';
import {templateFitsProject} from '${root}/src/core/guard.ts';
import {debugEnabled,dlog,noteKey,keyDesc} from './debug';
const pluginOn=()=>true, handleInlineKey=()=>false, trapDialogFocus=()=>{}, toast=()=>{};
const inForeignInput=e=>!!e.target?.closest?.('input,textarea,[contenteditable]')&&!e.target.closest('#vc-stx-host')&&e.target.id!=='chat-draft';
const toggleWindow=()=>ui.set({windowOpen:!ui.get().windowOpen});
${handler}
startLatch();document.addEventListener('keydown',handleKey,true);
window.a38Visible=()=>visibleItems.map(t=>({id:t.id,title:t.title}));
`;
aliases['a38-global'] = 'global';

const inputHashes = {};
for (const host of ['native','betterdiscord']) {
    const dir = out + '/' + host;
    fs.mkdirSync(dir);
    const result = await build({stdin:{contents:`import '${root}/src/vencord/styles.css';
import {React} from '@webpack/common';import {createRoot} from 'react-dom/client';
import {Window} from '${root}/src/vencord/ui/Window.tsx';import {ui} from './uiState';
${host === 'betterdiscord' ? `import '${root}/betterdiscord/adapter.css';` : ''}
import 'a38-global';
function App(){const s=ui.use();return <div id="vc-stx-host"><div className="vc-stx-root">{s.windowOpen&&<Window/>}</div></div>}
createRoot(document.querySelector('#root')).render(<App/>);`,resolveDir:dir,loader:'tsx'},
        bundle:true,metafile:true,outfile:dir+'/app.js',nodePaths:[root+'/betterdiscord/node_modules'],inject:[out+'/react-shim.js'],
        plugins:[{name:'a38-host-io',setup(b){
            b.onResolve({filter:/.*/},args=>{
                if(aliases[args.path])return {path:aliases[args.path],namespace:'a38'};
                if(args.path.includes('/core/')&&args.importer.replaceAll('\\','/').includes('/src/vencord/'))
                    return {path:path.join(root,'src/core',path.basename(args.path)+(path.extname(args.path)?'':'.ts'))};
            });
            b.onLoad({filter:/.*/,namespace:'a38'},args=>({contents:stubs[args.path],loader:'tsx',resolveDir:dir}));
        }}]});
    fs.writeFileSync(dir+'/metafile.json',JSON.stringify(result.metafile,null,2));
    for(const p of Object.keys(result.metafile.inputs)){
        const abs=path.resolve(root,p);
        if(!p.startsWith('a38:')&&fs.existsSync(abs)&&!p.includes('node_modules')&&!abs.replaceAll('\\','/').startsWith(out))
            inputHashes[path.relative(root,abs).replaceAll('\\','/')]=createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    }
    fs.writeFileSync(dir+'/index.html',`<!doctype html><html lang="ru"><meta charset="utf-8"><title>A38 ${host} OFFLINE fixture</title>
<link rel="stylesheet" href="app.css"><style>body{margin:0;background:#25272e;color:#e6e6e8;font-family:Segoe UI,sans-serif}#fixture-label{position:fixed;top:8px;left:8px;font-size:11px;opacity:.55}#chat-draft{position:fixed;bottom:8px;left:16px;width:calc(100% - 40px)}</style>
<div id="fixture-label">A38 · ${host} · offline source fixture</div><input id="chat-draft" aria-label="Mock chat draft" value="НЕ ОТПРАВЛЯТЬ"><div id="root"></div>
<script>window.a38={calls:[],menus:[],draftKeys:[],keepOpen:false};document.querySelector('#chat-draft').addEventListener('keydown',e=>{a38.draftKeys.push({key:e.key,repeat:e.repeat});if(e.key==='Enter')e.preventDefault()});</script><script src="app.js"></script></html>`);
}
inputHashes['src/vencord/index.tsx']=createHash('sha256').update(index).digest('hex');
fs.writeFileSync(out+'/provenance.json',JSON.stringify({createdAt:new Date().toISOString(),inputHashes,samples,preferences,
    handler:{source:'src/vencord/index.tsx',startLine:index.slice(0,begin).split('\n').length,sha256:createHash('sha256').update(handler).digest('hex')},
    scope:'Offline source component, not live Discord. Native omits adapter.css; BetterDiscord includes it. Real Window/Preview/placement/Select/Store/ranking/latch. Global handleKey is an exact source slice. Flow insertion, context menu, channel/access/inline/dialog gates and platform storage/editor are fixture boundaries. No fonts loaded from network.'},null,2));
console.log('Built '+out);
