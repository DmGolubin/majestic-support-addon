// Q17 source-component browser fixture. All network, Discord stores and insertion are mocks.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..').replaceAll('\\','/');
const require=createRequire(root+'/betterdiscord/package.json');
const { build }=require('esbuild');
const a25 = process.argv.includes('--a25');
const a24 = process.argv.includes('--a24') || a25;
const a23 = process.argv.includes('--a23') || a24;

const here=path.resolve(process.argv[2] ?? 'scripts/qa/runs/q17-ui/before').replaceAll('\\','/');
if(!here.startsWith(root+'/scripts/qa/runs/') || fs.existsSync(here)) throw Error('Use a new directory under scripts/qa/runs');
fs.mkdirSync(here,{recursive:true});
fs.writeFileSync(path.join(here,'react-shim.js'),`export {default as React} from 'react';`);
const observable=`import {createObservable} from '${root}/src/vencord/ui/observable.ts';`;
const data=`export const samples=[['Версия игры Legacy','Частые проблемы'],['Вопросы по Media','Навигация'],['Чёрный экран','Частые проблемы'],['Ошибка инициализации данных / RGL','Проблемы с Rockstar Launcher'],['Запрос логов','Общий перечень проблем'],['NVIDIA Драйверы','Мои шаблоны']].map(([title,category],i)=>({id:String(i),title,category,text:'**Приветствую!**\\n\\nДля решения Вашей проблемы:\\n1. Откройте настройки лаунчера.\\n2. Проверьте файлы игры.',project:'mj',source:i===5?'personal':'faq',status:'actual',statusNote:null,teamUses:0,command:null,color:null,updatedAt:null}));`;
const stubs={
common:`import React from 'react';export * from 'react';export {React};export const GuildStore={getGuild:()=>null};export const ChannelStore={getChannel:id=>({name:id==='1'?'техническая-поддержка':'поддержка-игроков',guild_id:id==='1'?'530693013622489088':'1089530150540034181'})};export const useStateFromStores=(_,fn)=>fn();`,
state:observable+data+`export const ui=createObservable({management:true,windowOpen:false,compose:[],dialog:null,menu:null});export const panelAccess=createObservable({enabled:true,ready:true,projects:['mj','ro'],accountId:'preview'});const tick=createObservable({v:0});export const store={templates:samples,data:{prefix:';',previewOpen:false,usage:{},recent:['1','2'],favorites:[],personal:[],folders:[]},ctx(){return this.data},bindFor:()=>undefined,isFavorite:()=>false,toggleFavorite:()=>{},setPreviewOpen(v){this.data.previewOpen=v;tick.set({v:tick.get().v+1})},setPrefix(v){this.data.prefix=v;tick.set({v:tick.get().v+1})}};window.previewUi=ui;window.previewStore=store;window.previewTick=tick;export const useStore=()=>tick.use().v;const recovery=createObservable({failed:!!window.recoveryFail});export const realStore={get loadError(){return recovery.get().failed},subscribe:recovery.subscribe,load:async()=>{recovery.set({failed:false})}};export const activeScope=()=> 'all';export const listedProject=()=> 'mj';export const poolFor=()=>samples;export const pickTechProject=()=>{};export const watchChatArea=fn=>{window.addEventListener("resize",fn);return()=>window.removeEventListener("resize",fn)};`,
panel:observable+data+`import {PanelError} from '${root}/src/core/panelClient.ts';export const panel=createObservable({enabled:true,phase:'ready',name:'Preview account',error:'',persistent:true,preferencesError:'',sync:'live'});export const cancelPanelLogin=async()=>{};export const connectPanel=async()=>{};export const logoutPanel=async()=>{};export const reloadPanel=async()=>{};export const retryPanelPreferences=async()=>{};export const openPanelPage=()=>{};
export const panelPersonal=createObservable({generation:1,connectionId:'preview-connection',scopes:['personal:write','folders:write'],busy:false,catalog:{accountId:'preview',projects:['mj','ro'],personalRecords:samples.slice(1,4).map(t=>({...t,projects:['mj'],version:'v1',shared:false,folderId:null})),folderRecords:[{id:'123',version:'v1',title:'Частые ответы',project:'mj',position:0}],colors:['red','orange','amber','green','teal','blue','violet','pink'],colorLabels:{}}});
export const authorizePanelReminders=async()=>{};export const authorizePanelEditing=async()=>{};export const panelWriteMessage=()=> 'Ошибка сохранения: черновик остался.';export const preparePanelWrite=req=>async()=>{window.lastMutation=req;if(window.failWrite==='conflict')throw new PanelError('version_conflict',412);if(window.failWrite)throw Error('offline');return {refreshed:true}};window.previewPersonal=panelPersonal;window.previewPanel=panel;`,
sound:observable+`export const ticketSoundState=createObservable({loaded:true,testing:false,customName:window.customSoundName||"",loadingSound:false,error:'',options:{enabled:true,quietWhenVisible:true,volume:83.9506172839506,cooldownMs:3000,channelIds:['1','2']}});export const setTicketSound=patch=>ticketSoundState.set({options:{...ticketSoundState.get().options,...patch}});export const chooseTicketSound=async(file)=>ticketSoundState.set({customName:file.name});export const resetTicketSound=()=>ticketSoundState.set({customName:""});export const retryTicketSoundSettings=async()=>{};export const testTicketSound=async()=>{};`,
debug:observable+`export const debugState=createObservable({on:false});export const debugEnabled=()=>false;export const debugVerbose=()=>false;export const costStart=()=>0;export const costEnd=()=>{};export const dlog=()=>{};export const keyDesc=()=>'';export const logGeometry=()=>{};export const noteKey=()=>{};export const noteRender=()=>{};export const noteSearch=()=>{};export const noteWheel=()=>{};export const setDebugHover=()=>{};export const setDebugWindow=()=>{};`,
flow:`export const insertTemplate=()=>{window.insertions=(window.insertions||0)+1};export const addToCompose=()=>{window.compositions=(window.compositions||0)+1};`,
platform:`export const storage={get:async k=>JSON.parse(localStorage.getItem(k)||"null"),set:async(k,v)=>localStorage.setItem(k,JSON.stringify(v))};export const chatAreaRect=()=>({left:24,right:innerWidth-24,top:innerHeight-54,width:innerWidth-48,height:40});`,
op:`export const windowEditor=()=>document.getElementById('chat-draft');`,
context:`export const openMenu=()=>{};`,
personal:`export function PanelPersonalLibrary(){return <p>Редактор загружается для визуальной проверки.</p>}`
};
stubs.reminders=observable+`export const ticketRemindersState=createObservable({phase:"ready",settings:{discordEnabled:true,projects:[{project:"majestic",personalReminderMinutes:15},{project:"russia-online",personalReminderMinutes:20}]},busy:false,error:"",deliveryError:""});export const refreshTicketReminders=async()=>{};export const setDiscordReminders=async(v)=>ticketRemindersState.set({settings:{...ticketRemindersState.get().settings,discordEnabled:v}});window.previewReminders=ticketRemindersState;`; stubs.identity=`export const PLUGIN_VERSION='1.0.1-canary.21';export const PLUGIN_BUILD='UI fixture';export const PLUGIN_DISTRIBUTION=new URLSearchParams(location.search).get('distribution')||'betterdiscord';`;
stubs.diagnostics=`import {diagnosticJournal} from '${root}/src/core/diagnosticJournal.ts';diagnosticJournal.start({read:()=>null,write:()=>{}},{campaign:'mvp-file-2026-10',durationMs:4*86400000});export const setRecording=on=>diagnosticJournal.enable(on);export const diagnosticStorageStatus=()=>({path:'C:/Users/Tester/AppData/Local/SupportTemplates/channels/canary/data/diagnostics/profile/SupportTemplates-diagnostics.txt',initializing:false,fileError:!!window.failDiagnosticFile,localError:false,lastSavedAt:Date.now()});export const retryDiagnosticFile=()=>{window.failDiagnosticFile=false};export const downloadDiagnostics=()=>{if(window.failDownload)throw Error('fixture download failure');window.previewDownloads=(window.previewDownloads||0)+1};`;
stubs.demo=observable+`export const demo=createObservable({enabled:false,phase:'idle'});export const cancelDemoLogin=()=>{};export const connectDemo=()=>{};export const enableDemo=()=>{};export const pauseDemo=()=>{};`;
stubs.state+=`import {useState,useEffect} from 'react';export function useChatRect(){const [r,set]=useState({top:innerHeight-54,right:innerWidth-24});useEffect(()=>{const f=()=>set({top:innerHeight-54,right:innerWidth-24});window.addEventListener('resize',f);return()=>window.removeEventListener('resize',f)},[]);return r;}`;
const map={'./demo':'demo','../buildInfo':'identity','./diagnostics':'diagnostics','./shims/common':'common','../src/vencord/ui/panel':'panel','../src/vencord/ui/uiState':'state',"./ticketReminders":"reminders",'@webpack/common':'common','./uiState':'state','./panel':'panel','./ticketSound':'sound','./debug':'debug','./flow':'flow','../platform':'platform','./op':'op','./ContextMenu':'context'};
// A23 keeps host/API boundaries mocked, but runs real placement/ranking/audio controllers.
// Browser contexts isolate scenarios; localStorage survives component remount and page reload.
if (a23) {
    stubs.state += `
const preferenceKey='A23_fixture_preferences';
Object.assign(store.data,{showPersonalInAll:false,generalFirstInSearch:true,windowTabOrder:['all','personal','fav','recent'],favorites:['5'],recent:['5','1','2']},JSON.parse(localStorage.getItem(preferenceKey)||'{}'));
const persist=()=>{localStorage.setItem(preferenceKey,JSON.stringify(store.data));tick.set({v:tick.get().v+1})};
for(const [method,key] of Object.entries({setShowPersonalInAll:'showPersonalInAll',setGeneralFirstInSearch:'generalFirstInSearch',setWindowTabOrder:'windowTabOrder',setPreviewOpen:'previewOpen',setPrefix:'prefix'}))store[method]=value=>{store.data[key]=value;persist()};
store.isFavorite=id=>store.data.favorites.includes(id);
samples[0].title='QAneedle помощь';samples[5].title='QAneedle';
window.a23InsertionCalls=[];window.a23ComposeCalls=[];
`;
    stubs.flow = `export const insertTemplate=(template,options)=>{window.insertions=(window.insertions||0)+1;window.a23InsertionCalls.push({id:template.id,options})};export const addToCompose=(...args)=>{window.compositions=(window.compositions||0)+1;window.a23ComposeCalls.push(args)};`;
    stubs.common += `export const SelectedChannelStore={getChannelId:()=>null};const handlers=new Map();export const FluxDispatcher={subscribe:(name,fn)=>handlers.set(name,fn),unsubscribe:name=>handlers.delete(name)};window.a23Dispatch=(name,event)=>handlers.get(name)?.(event);`;
    stubs.platform += `export const toast=(...args)=>{(window.a23Toasts??=[]).push(args)};`;
    stubs.platform += `const immediateSet=storage.set;window.a23PendingWrites=0;storage.set=async(key,value)=>{const snapshot=structuredClone(value);window.a23PendingWrites++;try{if(window.a23StorageDelay&&/windowPlacement|windowSize/.test(key))await new Promise(resolve=>setTimeout(resolve,window.a23StorageDelay));await immediateSet(key,snapshot)}finally{window.a23PendingWrites--}};`;
    stubs.diagnostics = stubs.diagnostics.replace("{campaign:'mvp-file-2026-10',durationMs:4*86400000}", "{continuous:true}");
    delete map['./ticketSound'];
    stubs.soundBoot = `import {startTicketSound,ticketSoundState} from '${root}/src/vencord/ui/ticketSound.ts';window.a23Sound=ticketSoundState;startTicketSound();`;
    map['a23-sound-boot'] = 'soundBoot';
}
if (a24) {
    // Keep the actual menu/dialog and Store collision/persistence behavior.
    stubs.state += `
import {Store} from '${root}/src/core/state.ts';
const initialPreferences={...store.data};
const a24StorageKey='A24_fixture_preferences';
const a24Store=new Store({get:async()=>JSON.parse(localStorage.getItem(a24StorageKey)||'null'),set:async(_,value)=>localStorage.setItem(a24StorageKey,JSON.stringify(value))},true);
for(const key of Object.keys(store))delete store[key];
Object.setPrototypeOf(store,Object.getPrototypeOf(a24Store));Object.assign(store,a24Store);
store.replacePanelCatalog({templates:samples,personal:[],folders:[]});
store.restorePanelPreferences({...initialPreferences,...JSON.parse(localStorage.getItem(a24StorageKey)||'{}')});
store.subscribe(()=>tick.set({v:tick.get().v+1}));
window.previewAccess=panelAccess;
`;
    stubs.panel += `panel.set({stale:false,checkedAt:Date.now()});`;
    stubs.reminders = observable + `const key='A24_fixture_reminders';const settings=JSON.parse(localStorage.getItem(key)||'null')??{discordEnabled:true,projects:[{project:'majestic',personalReminderMinutes:15},{project:'russia-online',personalReminderMinutes:20}]};export const ticketRemindersState=createObservable({phase:'ready',settings,busy:false,error:'',deliveryError:''});export const refreshTicketReminders=async()=>{};export const setDiscordReminders=async enabled=>{const next={...ticketRemindersState.get().settings,discordEnabled:enabled};localStorage.setItem(key,JSON.stringify(next));ticketRemindersState.set({settings:next})};window.previewReminders=ticketRemindersState;`;
    stubs.flow += `export const supersede=()=>{};`;
    stubs.debug += `export const setDebugEnabled=on=>debugState.set({on});`;
    // Real channel IDs from the sound controller defaults, distinct host names.
    stubs.common += `const previousChannel=ChannelStore.getChannel;ChannelStore.getChannel=id=>id==='696711470783922247'?{id,name:'majestic-support',guild_id:'530693013622489088'}:id==='1534231644842754090'?{id,name:'ro-support',guild_id:'1089530150540034181'}:previousChannel(id);`;
    delete map['./ContextMenu'];
    stubs.a24Boundary = `import React from 'react';export default class Boundary extends React.Component{componentDidCatch(error){this.props.onError?.({error})}render(){return this.props.children}}`;
    stubs.a24Idle = `export const ComposeBar=()=>null;export const Inline=()=>null;export const DebugPanel=()=>null;`;
    map['@components/ErrorBoundary'] = 'a24Boundary';
    for (const name of ['./ComposeBar','./InlinePop','./DebugPanel']) map[name] = 'a24Idle';
}
if (a25) {
    stubs.diagnostics = stubs.diagnostics
        .replace('SupportTemplates-diagnostics.txt', 'main.log')
        .replace('lastSavedAt:Date.now()', 'lastSavedAt:Date.now(),...window.a25DiagnosticStatus')
        .replace('window.failDiagnosticFile=false', 'window.failDiagnosticFile=false;window.a25DiagnosticRetries=(window.a25DiagnosticRetries||0)+1');
    stubs.diagnostics += `export const openDiagnosticFolder=async(...args)=>{window.a25FolderOpens=(window.a25FolderOpens||0)+1;(window.a25FolderArguments??=[]).push(args);if(window.a25FolderPending)await new Promise(resolve=>window.a25FolderRelease=resolve);if(window.a25FolderFailure)throw Error('fixture folder unavailable');};`;
    stubs.common += `const a25Channel=ChannelStore.getChannel;ChannelStore.getChannel=id=>{const c=a25Channel(id);return c?{...c,name:id==='696711470783922247'?'техническая-поддержка-игроков-по-проблемам-запуска-и-подключения-к-серверам-majestic':id==='1534231644842754090'?'поддержка-игроков-россия-онлайн-вопросы-по-аккаунту-и-восстановлению-доступа':c.name}:c};`;
    stubs.panel += `
const a25Catalog=panelPersonal.get().catalog;
panelPersonal.set({catalog:{...a25Catalog,personalRecords:[['Проверка файлов лаунчера','red'],['Сбор журналов подключения','amber'],['Восстановление доступа','blue'],['Общий ответ',null]].map(([title,color],i)=>({...a25Catalog.personalRecords[i%3],id:'a25-'+i,title,color,text:'Проверьте файлы лаунчера и повторите подключение. Если проблема сохранится, приложите журнал.',command:i===0?'launcher':null})),colorLabels:{red:'Красный',amber:'Янтарный',blue:'Синий'}}});
`;
}
const hostImport = a24 ? `import {Host} from '${root}/src/vencord/ui/Host.tsx';` : '';
const hostTree = a24 ? '<Host/>' : '<div className="vc-stx-root">{s.management&&<Management/>}{s.windowOpen&&(p.phase==="ready"?<Window/>:<LoginWindow/>)}</div>';
if(!fs.existsSync(root+'/src/vencord/ui/PanelPersonalLibrary.tsx'))map['./PanelPersonalLibrary']='personal';
await build({stdin:{contents:`${hostImport}${a23 ? "import 'a23-sound-boot';" : ''}import '${root}/src/vencord/styles.css';import {React} from '@webpack/common';import {createRoot} from 'react-dom/client';import '${root}/betterdiscord/adapter.css';import {ServiceSettings} from '${root}/betterdiscord/ServiceSettings.tsx';import {BuildIdentity} from '${root}/src/vencord/ui/BuildIdentity.tsx';import {LoginWindow} from '${root}/src/vencord/ui/LoginWindow.tsx';import {panel} from './panel';import {Management} from '${root}/src/vencord/ui/Management.tsx';import {Window} from '${root}/src/vencord/ui/Window.tsx';import {ui} from './uiState';function App(){const s=ui.use();const p=panel.use();const [service,setService]=React.useState(false);window.previewService=setService;return <><div className="review-controls"><button onClick={()=>ui.set({management:true,windowOpen:false})}>Settings</button><button onClick={()=>ui.set({management:false,windowOpen:true})}>Menu</button></div><div id="service" className="stx-bd-settings" style={{display:service?undefined:"none",maxWidth:600,margin:"20px auto",padding:16}}>{service&&<><BuildIdentity/><ServiceSettings active={service!=="inactive"}/></>}</div><div id="vc-stx-host">${hostTree}</div></>}createRoot(document.getElementById('root')).render(<App/>);`,resolveDir:here,loader:'tsx'},bundle:true,outfile:here+'/app.js',nodePaths:[root+'/betterdiscord/node_modules'],inject:[here+'/react-shim.js'],plugins:[{name:'review-alias',setup(b){b.onResolve({filter:/.*/},args=>{if(args.path==='./menu-refinement.css' && !fs.existsSync(root+'/src/vencord/ui/menu-refinement.css'))return {path:'empty',namespace:'stub'};if(map[args.path])return {path:map[args.path],namespace:'stub'};if(args.path.includes('/core/')&&args.importer.replaceAll('\\','/').includes('/src/vencord/'))return {path:path.join(root,'src/core',path.basename(args.path)+(path.extname(args.path)?'':'.ts'))};});b.onLoad({filter:/.*/,namespace:'stub'},args=>({contents:stubs[args.path]??'',loader:'tsx',resolveDir:here}));}}]});
fs.writeFileSync(here+'/index.html',`<!doctype html><meta charset="utf-8"><title>SupportTemplates — UI review</title><link rel="stylesheet" href="app.css"><style>body{margin:0;background:#25272e;font-family:Segoe UI,sans-serif;color:#e6e6e8}.review-controls{position:fixed;top:54px;left:5px;z-index:100000;opacity:.2}.review-controls:hover{opacity:1}</style><div id="chat-text" style="position:fixed;top:8px;left:8px;max-width:160px">Текст сообщения игрока</div><input id="chat-draft" aria-label="Черновик чата" style="position:fixed;bottom:8px;left:16px" value="Не отправлять"><div id="root"></div><script src="app.js"></script>`);
const sourceHashes={};
for(const dir of ['src/vencord/ui','betterdiscord']) for(const file of fs.readdirSync(root+'/'+dir)) {
 if(!/\.(tsx|css)$/.test(file))continue;
 const key=dir+'/'+file;sourceHashes[key]=createHash('sha256').update(fs.readFileSync(root+'/'+key)).digest('hex');
}
fs.writeFileSync(here+'/provenance.json',JSON.stringify({createdAt:new Date().toISOString(),sourceHashes,scope:'Source-component fixture, not release bundle or Discord; API, stores, insertion, diagnostics download mocked. Diagnostic journal in memory only.'},null,2));
console.log('Built '+here);
