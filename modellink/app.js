import {initDemo,getProjects,getProject,getAssets,getAsset,getAllAssets,getAllNotes,getNotes,createProject,addAsset,addNote,setNoteStatus,removeProject,removeAsset,renameProject,renameAsset,removeNote,setAssetScale,sandbox as sandboxStore,sent as sentStore,pref,setPref,setVaultCrypto,setProjectVault,updateAssetMeta,ensureFingerprints,removeAllData,latestFiles,fileInfo,kindFor,formatBytes,capabilities} from './core/storage.js';
import {parseDXF,parseOBJ,parseSTL,parseGLB,meshBounds} from './core/geometry.js';
import {exportProject,importProjectPackage,PACKAGE_VERSION} from './core/pack.js';
import {sealPackage,readEnvelope,openPackage,checkPolicy,keyLink,parseKeyLink,appendAudit,makeReceipt,verifyReceipt,sealBytes,openBytes,randomBytes,b64u,uuid,sha256} from './core/secure.js';
import {conversionTargets,dxfToSVG,meshToSTL,meshToOBJ,meshToPLY,meshToGLB,meshToUSDZ,jpegToPDF,baseName,extOf,zipStore,redactDrawing,drawingToDXF} from './core/convert.js';
import {Capacitor,registerPlugin} from './vendor/capacitor-core.js';
import {LANGS,detectLang,setLang,getLang,locale,t,t as tl,plural,startTranslator} from './core/i18n.js';
setLang(detectLang());

const APP_VERSION='0.8.0';
const IS_NATIVE=Capacitor.isNativePlatform();
/** Native iOS bridge (ios/App/App/ModelLinkNativePlugin.swift); null in the browser. */
const NativeML=IS_NATIVE?registerPlugin('ModelLinkNative'):null;
const QUICK_LOOK=new Set(['pdf','usdz','reality','png','jpg','jpeg','gif','webp','heic','tif','tiff','txt','rtf','csv','pages','numbers','key','doc','docx','xls','xlsx','ppt','pptx']);
const canQuickLook=()=>!!NativeML; // iOS decides (QLPreviewController.canPreview)

const app=document.getElementById('app');
const dialog=document.getElementById('modal');
const filePicker=document.getElementById('file-picker');
const toastArea=document.getElementById('toast');
const state={tab:'home',projectId:null,assetId:null,search:'',filter:'all',viewerTool:'view',viewer:null,notes:[],pendingPoint:null,pickerProject:null,pickerMode:'all',projectIds:[],theme:'light'};
let previewUrl=null,toastTimer;
const paths={
  box:'<path d="m3 7 9-4 9 4-9 4-9-4Z"/><path d="M3 7v10l9 4 9-4V7M12 11v10"/>',
  home:'<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z"/><path d="M9 21v-8h6v8"/>',
  folders:'<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v2"/><path d="M3 10h18l-2 11H5L3 10Z"/>',
  tasks:'<path d="M4 7h3m4 0h9M4 12h3m4 0h9M4 17h3m4 0h9"/><path d="m4 4 1 1 2-2"/>',
  settings:'<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.04.04-2 2-.05-.04a1.7 1.7 0 0 0-1.88-.35l-.08.04a1.7 1.7 0 0 0-1 1.57V21h-3v-.07a1.7 1.7 0 0 0-1-1.57l-.08-.04a1.7 1.7 0 0 0-1.88.35l-.05.04-2-2 .04-.04A1.7 1.7 0 0 0 7.25 15l-.04-.08a1.7 1.7 0 0 0-1.57-1H5v-3h.64a1.7 1.7 0 0 0 1.57-1l.04-.08A1.7 1.7 0 0 0 6.9 8l-.04-.05 2-2L9 6a1.7 1.7 0 0 0 1.88.35l.08-.04a1.7 1.7 0 0 0 1-1.57V4h3v.74a1.7 1.7 0 0 0 1 1.57l.08.04A1.7 1.7 0 0 0 18 6l.05-.04 2 2L20 8a1.7 1.7 0 0 0-.35 1.88l.04.08a1.7 1.7 0 0 0 1.57 1H22v3h-.74a1.7 1.7 0 0 0-1.57 1Z"/>',
  upload:'<path d="M12 16V3m-5 5 5-5 5 5"/><path d="M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  arrow:'<path d="m9 18 6-6-6-6"/>',
  chevron:'<path d="m15 18-6-6 6-6"/>',
  image:'<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.6"/><path d="m21 16-5-5L5 21"/>',
  cube:'<path d="m12 2 9 5-9 5-9-5 9-5ZM3 7v10l9 5 9-5V7M12 12v10"/>',
  ruler:'<path d="M21 16 8 3 3 8l13 13 5-5ZM7 7l3-3M10 10l3-3M13 13l3-3M16 16l3-3"/>',
  comment:'<path d="M21 11.5A8.5 8.5 0 0 1 12.5 20a8.8 8.8 0 0 1-4-.9L3 21l1.9-5.5A8.5 8.5 0 1 1 21 11.5Z"/>',
  history:'<path d="M3 12a9 9 0 1 1 3 6.7M3 17v-5h5"/><path d="M12 7v5l4 2"/>',
  share:'<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.7 10.6 6.6-4.2M8.7 13.4l6.6 4.2"/>',
  search:'<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  download:'<path d="M12 3v13m-5-5 5 5 5-5M4 18v3h16v-3"/>',
  check:'<path d="m4 12 5 5L20 6"/>',
  close:'<path d="m6 6 12 12M18 6 6 18"/>',
  eye:'<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  fit:'<path d="M8 3H4v4m12-4h4v4M4 17v4h4m12-4v4h-4"/>',
  rotate:'<path d="M4 8a9 9 0 1 1-.5 8M4 3v5h5"/>',
  dots:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  trash:'<path d="M3 6h18M8 6V4h8v2m3 0-1 15H6L5 6M10 10v7m4-7v7"/>',
  warning:'<path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5m0 3v1"/>',
  info:'<circle cx="12" cy="12" r="10"/><path d="M12 11v6m0-10v1"/>',
  layers:'<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/>',
  menu:'<path d="M4 6h16M4 12h16M4 18h16"/>',
  file:'<path d="M6 2h8l5 5v15H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2ZM14 2v6h6"/>',
  light:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  export:'<path d="M12 15V3m-4 4 4-4 4 4"/><path d="M8 11H6a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-2"/>',
  link:'<path d="M10 13a5 5 0 0 0 7 .3l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7-.3l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
};
/** Colour 3D icons (assets/icons, from the ModelLink icon set); UI chrome (arrows, close, theme) stays vector. */
const IMG_ICONS={box:'logo',logo:'logo',home:'home',folders:'folder',search:'search',settings:'settings',
  pdf:'pdf',dwg:'dwg',cube:'cube',image:'pdf',ruler:'ruler',comment:'comment',history:'history',share:'share',
  rotate:'rotate',move:'move','zoom-in':'zoom-in','zoom-out':'zoom-out',fit:'fit',target:'target',layers:'layers',
  eye:'eye','eye-off':'eye-off',measure:'measure',pin:'pin',edit:'edit',trash:'trash',download:'download',upload:'upload',
  export:'export',link:'link',lock:'lock',unlock:'unlock',warning:'warning',check:'check',info:'info',star:'star',dots:'dots'};
function icon(name,extra=''){if(IMG_ICONS[name])return `<img class="icon img-icon ${extra}" src="assets/icons/${IMG_ICONS[name]}.png" alt="" aria-hidden="true" draggable="false">`;return `<svg class="icon ${extra}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]||paths.file}</svg>`;}
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date=t=>new Date(t).toLocaleDateString(locale(),{day:'numeric',month:'short'});
const niceName=name=>String(name).length>54?String(name).slice(0,52)+'…':name;
const featureDefs=[
  ['drawing','Чертежи','DWG, DXF, PDF и изображения','dwg',''],
  ['model','3D-модели','FBX, MAX, OBJ, STL, GLB…','cube','lime'],
  ['measure','Измерения','Проверить расстояние','measure','violet'],
  ['notes','Замечания','Отметки прямо на файле','comment','orange'],
  ['versions','Версии','Сохранить все редакции','history','sky'],
  ['share','Экспорт','Другие форматы и отправка','export','rose']
];
const navDefs=[['home','Главная','home'],['projects','Проекты','folders'],['notes','Замечания','comment'],['settings','Настройки','settings']];
function notify(message){toastArea.textContent=message;toastArea.classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>toastArea.classList.remove('visible'),3700);}
function header(){return `<header class="app-header"><div class="brand"><span class="brand-icon">${icon('box')}</span><span>ModelLink<span style="color:var(--blue)">.</span></span></div><div class="header-right"><button class="header-chip ${settings.offlineLock?'locked':''}" data-action="go-settings" aria-label="Режим данных">${settings.offlineLock?icon('lock','small')+' 100% офлайн':'<i class="dot"></i> На устройстве'}</button><button data-action="go-settings" class="icon-button" aria-label="Настройки">${icon('settings')}</button></div></header>`;}
function navItem([id,label,glyph]){return `<button class="nav-item ${state.tab===id?'active':''}" data-action="tab" data-tab="${id}" aria-label="${label}" ${state.tab===id?'aria-current="page"':''}>${icon(glyph)}<span>${label}</span></button>`;}
function layout(content){return `<div class="app-layout"><aside class="side-nav"><div class="brand" style="padding:0 12px"><span class="brand-icon">${icon('box')}</span>ModelLink<span style="color:var(--blue)">.</span></div><div class="side-title">Рабочее пространство</div>${navDefs.map(navItem).join('')}<div class="side-note">Ваши файлы хранятся на этом устройстве. Для переноса проекта используйте «Поделиться».</div></aside><div class="main-area">${state.tab==='viewer'?'':header()}<main class="page ${state.tab==='viewer'?'viewer-page':''}">${content}</main></div></div>${state.tab==='viewer'?'':`<nav class="bottom-nav" aria-label="Основная навигация">${navDefs.map(navItem).join('')}</nav>`}`;}
function sectionTitle(title,button='',action=''){return `<div class="section-heading"><h2>${title}</h2>${button?`<button class="link-button" data-action="${action}">${button} ${icon('arrow','small')}</button>`:''}</div>`;}
function fileTypePreview(name){const cap=fileInfo(name);return cap.label||cap.ext;}
function projectTile(p,assets,notes){const files=latestFiles(assets.filter(x=>x.projectId===p.id));const count=notes.filter(n=>n.projectId===p.id&&n.status==='open').length;return `<button class="project-card" data-action="open-project" data-id="${esc(p.id)}"><span class="project-thumb ${p.demo?'demo':''}">${icon(files.some(x=>x.kind==='model')?'cube':'folders')}</span><span class="project-body"><span class="project-title">${esc(p.name)}</span>${p.demo?` <span class="tag">ПРИМЕР</span>`:''}<div class="project-sub">${plural(files.length,'file')} · ${plural(count,'remark')} · ${date(p.updatedAt)}</div></span>${icon('arrow','small arrow-right')}</button>`;}
function recentFiles(files){const list=latestFiles(files).slice(0,4);if(!list.length)return '';
  return `<section style="margin-bottom:26px">${sectionTitle('Недавние файлы')}<div class="file-list">${list.map(f=>fileRow(f,true)).join('')}</div></section>`;}
function homeView(projects,files,notes){const recents=projects.slice(0,3);
  return `<section class="home-head"><div class="eyebrow">Ваши проекты под рукой</div><h1>Чертежи и 3D.<br>Один экран.</h1><p class="lead">Открывайте, проверяйте и отправляйте файлы прямо с телефона.</p></section>
    <div class="quick-launch"><div><h2>С чего начнём?</h2><p>Откройте файл за пару касаний</p></div><div class="quick-launch-actions"><button class="btn white" data-action="import">${icon('upload','small')} Открыть файл</button><button class="btn ghost-white" data-action="new-project">${icon('plus','small')} Проект</button></div></div>
    ${recentFiles(files)}
    <section>${sectionTitle('Что можно делать')}<div class="tools-grid">${featureDefs.map(([id,name,desc,glyph,color])=>`<button class="tool-card" data-action="feature" data-feature="${id}"><span class="tool-icon ${color}">${icon(glyph)}</span><span><span class="tool-name">${name}</span><div class="tool-desc">${desc}</div></span></button>`).join('')}</div></section>
    <section class="section">${sectionTitle('Последние проекты','Все проекты','go-projects')}<div class="project-list">${recents.length?recents.map(p=>projectTile(p,files,notes)).join(''):`<div class="empty">${icon('folders')}<h3>Здесь появятся ваши проекты</h3><p>Добавьте первый чертёж или модель</p><button class="btn primary" data-action="import">Открыть файл</button></div>`}</div></section>
    <section class="section">${sectionTitle('Форматы файлов','Подробнее','formats')}<div class="format-rail">${['DWG','DXF','PDF','FBX','MAX','OBJ','STL','GLB','3DS'].concat(IS_NATIVE?['USDZ']:[],['STEP*','IFC*']).map(x=>`<span class="format-tag">${x}</span>`).join('')}</div><p class="small-muted" style="margin-top:9px">* STEP и IFC хранятся и передаются без изменений. Для просмотра добавьте копию в GLB или STL.</p></section>`;
}
function projectsView(projects,files,notes){const q=state.search.trim().toLowerCase();let filtered=projects.filter(p=>p.name.toLowerCase().includes(q)||(q&&(p.description||'').toLowerCase().includes(q)));const fileHits=q?latestFiles(files).filter(f=>f.name.toLowerCase().includes(q)):[];if(state.filter==='demo')filtered=filtered.filter(p=>p.demo);if(state.filter==='mine')filtered=filtered.filter(p=>!p.demo);
  return `<div class="eyebrow">Рабочее пространство</div><div class="detail-top"><div><h1>Проекты</h1><p class="lead">Чертежи, модели и все версии</p></div><button class="btn primary" data-action="new-project">${icon('plus','small')} Создать</button></div>
  <label class="search-field">${icon('search','small')}<input id="project-search" type="search" placeholder="Найти проект или файл" value="${esc(state.search)}" aria-label="Поиск проекта"></label>
  <div class="segmented"><button class="chip ${state.filter==='all'?'active':''}" data-action="filter" data-filter="all">Все</button><button class="chip ${state.filter==='mine'?'active':''}" data-action="filter" data-filter="mine">Мои</button><button class="chip ${state.filter==='demo'?'active':''}" data-action="filter" data-filter="demo">Примеры</button></div>
  <div class="project-list">${filtered.map(p=>projectTile(p,files,notes)).join('')||(fileHits.length?'':'<div class="empty"><h3>Ничего не найдено</h3><p>Измените запрос или создайте проект</p></div>')}</div>
  ${fileHits.length?`<div class="section">${sectionTitle(`Файлы · ${fileHits.length}`)}<div class="file-list">${fileHits.slice(0,30).map(f=>fileRow(f,true)).join('')}</div></div>`:''}
  <div style="margin-top:24px"><button class="btn outline block" data-action="import-package">${icon('download','small')} Импортировать пакет .mlink</button></div>`;
}
function detailView(p,files,notes){const current=latestFiles(files),open=notes.filter(n=>n.status==='open');return `<div class="breadcrumbs"><button data-action="go-projects">Проекты</button>${icon('arrow','small')}<span translate="no">${esc(niceName(p.name))}</span></div>
<div class="project-hero"><span class="eyebrow">${p.demo?'Демонстрационный проект':'Ваш проект'}</span><h1>${esc(p.name)}</h1><p>${esc(p.description||'Файлы и комментарии проекта')}</p><div class="info-stack"><span>${icon('file','small')} ${plural(current.length,'file')}</span><span>${icon('comment','small')} ${plural(open.length,'remark')}</span><span>${icon('history','small')} ${plural(files.length-current.length,'oldVersion')}</span></div>
<div class="action-bar"><button class="btn primary" data-action="import-here">${icon('plus','small')} Добавить файлы</button><button class="btn outline" data-action="share-project">${icon('share','small')} Поделиться</button></div><div class="action-grid"><button class="btn tiny soft" data-action="secure-share">${icon('lock','small')} Защищённая отправка</button><button class="btn tiny outline" data-action="notes-report">${icon('pdf','small')} Отчёт по замечаниям</button><button class="btn tiny outline" data-action="vault-move">${icon(p.vault?'unlock':'lock','small')} ${p.vault?'Из сейфа':'В сейф'}</button><button class="btn tiny outline" data-action="rename-project">${icon('edit','small')} Переименовать</button></div></div>
${sectionTitle('Файлы')}<div class="file-list">${current.map(f=>fileRow(f)).join('')||`<div class="empty"><h3>Пока нет файлов</h3><p>Добавьте чертёж или 3D-модель</p></div>`}</div>
<div class="section">${sectionTitle('Замечания')}<div>${open.slice(0,3).map((n,i)=>noteRow(n,i+1)).join('')||'<p class="small-muted">Открытых замечаний нет</p>'}</div></div>
<div class="section"><button class="btn outline" data-action="project-versions">${icon('history','small')} История версий</button> <button class="btn outline" data-action="delete-project">${icon('trash','small')} Удалить проект</button></div>`;}
function fileBadge(name,kind){const ext=String(name).split('.').at(-1).toLowerCase();const glyph=ext==='pdf'?'pdf':ext==='dwg'?'dwg':kind==='model'||kind==='ar'?'cube':kind==='drawing'?'layers':null;
  return glyph?`<span class="file-ext has-icon">${icon(glyph)}</span>`:`<span class="file-ext">${esc(fileInfo(name).label.slice(0,6))}</span>`;}
function fileRow(f,withProject=false){const info=fileInfo(f.name);const project=withProject?state.projectNames?.get(f.projectId):null;return `<button class="file-row" data-action="open-asset" data-id="${esc(f.id)}">${fileBadge(f.name,f.kind)}<span class="body"><h3>${esc(niceName(f.name))}</h3><p>${project?`${esc(project)} · `:''}${formatBytes(f.size)} · версия ${f.version}${withProject?` · ${date(f.createdAt)}`:` · ${info.preview==='source'?'Оригинал':info.preview==='partial'?'Базовый просмотр':'Просмотр'}`}</p></span>${icon('arrow','small')}</button>`;}
function noteRow(n,index){return `<div class="annotation-card"><span class="annotation-count">${index}</span><span class="body"><p>${esc(n.text)}</p>${audioTag(n)}<div class="meta">${date(n.createdAt)} · версия ${n.version} · <span class="status-text ${n.status==='resolved'?'resolved':''}">${n.status==='resolved'?'Проверено':'Открыто'}</span></div></span><span class="note-actions"><button class="btn tiny ${n.status==='resolved'?'outline':'soft'}" data-action="toggle-note" data-id="${n.id}" aria-label="Изменить статус">${n.status==='resolved'?'Вернуть':'Готово'}</button><button class="btn tiny outline" data-action="delete-note" data-id="${n.id}" aria-label="Удалить замечание">${icon('trash','small')}</button></span></div>`;}
function notesView(notes,files){return `<div class="eyebrow">Контроль изменений</div><h1>Замечания</h1><p class="lead">Нажмите на запись, чтобы открыть соответствующий файл</p><div class="section">${notes.map((n,i)=>{const asset=files.find(f=>f.id===n.assetId);return `<div class="annotation-card"><span class="annotation-count">${notes.length-i}</span><div class="body"><p>${esc(n.text)}</p><div class="meta">${esc(asset?.name||'Файл не найден')} · версия ${n.version} · ${date(n.createdAt)}</div><div class="row" style="margin-top:10px"><button class="btn tiny soft" data-action="open-asset" data-id="${esc(n.assetId)}">${icon('eye','small')} Открыть</button><button class="btn tiny ${n.status==='resolved'?'outline':'soft'}" data-action="toggle-note" data-id="${n.id}">${n.status==='resolved'?'Вернуть':'Выполнено'}</button></div></div></div>`;}).join('')||`<div class="empty">${icon('pin','large')}<h3>Замечаний пока нет</h3><p>Откройте файл и нажмите «Отметить»</p></div>`}</div>`;}
function settingsView(projects,files){return `<div class="eyebrow">ModelLink</div><h1>Настройки</h1><p class="lead">Простые инструменты без сложных меню</p><div class="two-col section"><div class="stat"><strong>${projects.length}</strong><p>Проекты</p></div><div class="stat"><strong>${files.length}</strong><p>Файлы и версии</p></div></div><div class="group-card section"><div class="setting-row lang-row"><div><strong>Язык интерфейса</strong><br><span>Language</span></div><div class="lang-switch">${LANGS.map(([code,name])=>`<button class="chip ${getLang()===code?'active':''}" data-action="set-lang" data-lang="${code}" translate="no">${name}</button>`).join('')}</div></div><div class="setting-row"><div><strong>Тема оформления</strong><br><span>Светлая / тёмная</span></div><button class="btn outline tiny" data-action="theme">${icon('light','small')} ${state.theme==='dark'?'Светлая':'Тёмная'}</button></div><div class="setting-row"><div><strong>Поддерживаемые форматы</strong><br><span>Что открывается прямо в приложении</span></div><button class="icon-button" data-action="formats" aria-label="Форматы">${icon('arrow')}</button></div><div class="setting-row"><div><strong>Импорт проекта</strong><br><span>Открыть резервный пакет .mlink</span></div><button class="icon-button" data-action="import-package" aria-label="Импорт пакета">${icon('download')}</button></div></div><div class="notice section">${icon('info','small')} &nbsp; Данные хранятся только на этом устройстве. Экспортируйте важные проекты в .mlink для резервной копии.</div><div class="section">${sectionTitle('Безопасность')}<div class="group-card">
  <div class="setting-row"><div><strong>Режим «Без следов»</strong><br><span>${settings.offlineLock?'Включён: приложение не обращается к сети вообще':'Сеть только для проверки отзыва пакетов'}</span></div><button class="switch ${settings.offlineLock?'on':''}" data-action="toggle-setting" data-key="offlineLock" role="switch" aria-checked="${settings.offlineLock}" aria-label="Без следов"></button></div>
  <div class="setting-row"><div><strong>Шторка в переключателе приложений</strong><br><span>Всегда скрывать содержимое при сворачивании</span></div><button class="switch ${settings.shieldAlways?'on':''}" data-action="toggle-setting" data-key="shieldAlways" role="switch" aria-checked="${settings.shieldAlways}" aria-label="Шторка"></button></div>
  <div class="setting-row"><div><strong>Режим паники</strong><br><span>Экраном вниз${IS_NATIVE?'':' (iPhone)'} или три пальца — закрыть конфиденциальное</span></div><button class="switch ${settings.panicMotion?'on':''}" data-action="toggle-setting" data-key="panicMotion" role="switch" aria-checked="${settings.panicMotion}" aria-label="Режим паники"></button></div>
  <div class="setting-row"><div><strong>Имя, компания, список отзыва</strong><br><span>${esc([settings.userName,settings.company].filter(Boolean).join(', ')||'Не указаны')}</span></div><button class="icon-button" data-action="edit-identity" aria-label="Изменить">${icon('edit')}</button></div>
  <div class="setting-row"><div><strong>Отправленные пакеты</strong><br><span>Ключи, отзыв, квитанции об ознакомлении</span></div><button class="icon-button" data-action="sent-packages" aria-label="Отправленные пакеты">${icon('arrow')}</button></div>
  <div class="setting-row"><div><strong>Сверить файл по SHA-256</strong><br><span>Доказать, какая ревизия была передана</span></div><button class="icon-button" data-action="verify-fp" aria-label="Сверить файл">${icon('search')}</button></div>
  <div class="setting-row"><div><strong>Экстренная очистка</strong><br><span>Стереть полученные пакеты и временные файлы</span></div><button class="icon-button" data-action="emergency-wipe" aria-label="Экстренная очистка">${icon('warning')}</button></div>
  </div></div><div class="group-card section"><div class="setting-row"><div><strong>О приложении</strong><br><span>Версия ${APP_VERSION}</span></div><button class="icon-button" data-action="about" aria-label="О приложении">${icon('arrow')}</button></div><div class="setting-row"><div><strong>Конфиденциальность</strong><br><span>Данные не собираются</span></div><button class="icon-button" data-action="privacy" aria-label="Конфиденциальность">${icon('arrow')}</button></div><div class="setting-row"><div><strong>Удалить все данные</strong><br><span>Проекты, файлы и замечания</span></div><button class="icon-button" data-action="erase-all" aria-label="Удалить все данные">${icon('trash')}</button></div></div><div class="section"><button class="btn outline" data-action="open-example">${icon('cube','small')} Посмотреть пример</button></div>`;}
function viewerContent(f,allFiles,notes){const info=fileInfo(f.name);const siblings=allFiles.filter(x=>x.groupId===f.groupId).sort((a,b)=>b.version-a.version);
  const toolbar=`<div class="viewer-tools"><button class="btn tiny ${state.viewerTool==='view'?'soft active-tool':'outline'}" data-action="viewer-tool" data-tool="view">${icon('eye','small')} Вид</button><button class="btn tiny ${state.viewerTool==='comment'?'soft active-tool':'outline'}" data-action="viewer-tool" data-tool="comment">${icon('comment','small')} Отметить</button><button class="btn tiny ${state.viewerTool==='measure'?'soft active-tool':'outline'}" data-action="viewer-tool" data-tool="measure">${icon('measure','small')} Измерить</button>${(f.kind==='drawing'||f.kind==='image')&&!f.secure?`<button class="btn tiny ${state.viewerTool==='redact'?'soft active-tool':'outline'}" data-action="viewer-tool" data-tool="redact">${icon('eye-off','small')} Скрыть</button>`:''}${['drawing','model','image'].includes(f.kind)?`<button class="btn tiny outline" data-action="zoom" data-k="1.4" aria-label="Приблизить">${icon('zoom-in','small')}</button><button class="btn tiny outline" data-action="zoom" data-k="0.7" aria-label="Отдалить">${icon('zoom-out','small')}</button>`:''}${f.kind==='model'?`<button class="btn tiny outline" data-action="wireframe">${icon('cube','small')} Каркас</button><button class="btn tiny outline" data-action="cad-bg" aria-label="Светлый или тёмный фон">${icon('light','small')} ${cadDark()?'Светлый фон':'Тёмный фон'}</button>${f.name.toLowerCase().endsWith('.max')?`<button class="btn tiny outline" data-action="max-props">${icon('info','small')} Свойства</button>`:''}`:''}${f.kind==='drawing'?`<button class="btn tiny outline" data-action="layers">${icon('layers','small')} Слои</button><button class="btn tiny outline" data-action="cad-bg" aria-label="Светлый или тёмный фон">${icon('light','small')} ${cadDark()?'Светлый фон':'Тёмный фон'}</button>`:''}<button class="btn tiny outline" data-action="fit">${icon('fit','small')} Вписать</button>${['drawing','model','image','pdf','text'].includes(f.kind)?`<button class="btn tiny outline" data-action="fullscreen">${icon('fit','small')} На весь экран</button>`:''}</div>`;
  return `<div class="breadcrumbs"><button data-action="back-project">${icon('chevron','small')} Проект</button></div><div class="viewer-header"><div style="min-width:0"><div class="eyebrow">${esc(info.label)} · Версия ${f.version}</div><div class="viewer-heading">${esc(f.name)}</div></div><div class="row">${viewOnlyBlocked(f)?`<span class="viewonly-chip">${icon('lock','small')} Только просмотр</span>`:`<button class="icon-button" data-action="export-file" aria-label="Экспорт в другой формат">${icon('export')}</button><button class="icon-button" data-action="share-file" aria-label="Поделиться">${icon('share')}</button>`}<button class="icon-button" data-action="file-menu" aria-label="Ещё">${icon('dots')}</button></div></div>${toolbar}
  <div class="canvas-wrap" id="canvas-wrap">${f.secure?`<div class="watermark" style="${watermarkStyle()}"></div>`:''}<div class="capture-veil">${icon('eye-off','large')}<span>Скрыто во время записи экрана</span></div><div class="fs-bar" role="toolbar" aria-label="Полноэкранный режим"><button class="fs-btn" data-action="fullscreen" aria-label="Выйти из полноэкранного режима">${icon('close')}</button><span class="fs-title">${esc(niceName(f.name))}</span><button class="fs-btn" data-action="zoom" data-k="1.4" aria-label="Приблизить">${icon('zoom-in')}</button><button class="fs-btn" data-action="zoom" data-k="0.7" aria-label="Отдалить">${icon('zoom-out')}</button><button class="fs-btn" data-action="fit" aria-label="Вписать">${icon('fit')}</button>${f.kind==='drawing'?`<button class="fs-btn" data-action="layers" aria-label="Слои">${icon('layers')}</button>`:''}${f.kind==='drawing'||f.kind==='model'?`<button class="fs-btn" data-action="cad-bg" aria-label="Светлый или тёмный фон">${icon('light')}</button>`:''}</div><div class="viewport-badge">${esc(info.preview==='source'?'Оригинал':info.preview==='partial'?'Базовый просмотр':'Просмотр')}</div><div class="preview-body" id="preview-body"><div class="file-unsupported"><h3>Загружаем просмотр…</h3></div></div><div class="canvas-hint" id="canvas-hint">${f.kind==='model'?'Вращайте одним пальцем, масштаб — двумя':f.kind==='drawing'?'Двигайте одним пальцем, масштаб — двумя':'Коснитесь файла для отметки'}</div></div>
  <div class="viewer-data"><div class="section-heading"><h3>Замечания · ${notes.length}</h3><button class="link-button" data-action="quick-comment">${icon('plus','small')} Добавить</button></div>${notes.map((n,i)=>noteRow(n,i+1)).join('')||'<p class="small-muted">Здесь появятся замечания к этому файлу.</p>'}</div>
  <div class="section">${sectionTitle('Версии файла')}<div class="group-card">${siblings.map(v=>`<div class="version-item"><span>Версия ${v.version} ${v.id===f.id?'<span class="tag">ОТКРЫТА</span>':''}<br><small style="color:var(--muted)">${date(v.createdAt)} · ${formatBytes(v.size)}</small></span>${v.id===f.id?'':`<button class="btn tiny outline" data-action="open-asset" data-id="${v.id}">Открыть</button>`}</div>`).join('')}</div></div>`;}

function modal(title,html){document.getElementById('modal-title').textContent=title;document.getElementById('modal-content').innerHTML=html;if(!dialog.open)dialog.showModal();}
function closeModal(){if(dialog.open)dialog.close();}
async function securePanels(){
  const boxes=(await sandboxStore.all()).sort((a,b)=>b.addedAt-a.addedAt);
  const vaultCount=(await getProjects()).filter(p=>p.vault).length;
  return `<div class="section">${sectionTitle('Сейф и защищённые пакеты')}<button class="project-card vault-card" data-action="open-vault"><span class="project-thumb">${icon('lock')}</span><span class="project-body"><span class="project-title">Сейф</span><div class="project-sub">${vaultCount?`${plural(vaultCount,'project')} · `:''}${IS_NATIVE?'Face ID / код-пароль':'код приложения'} · шифрование AES-256</div></span>${icon('arrow','small arrow-right')}</button>
  ${boxes.map(r=>{const h=r.header;const exp=h.expiresAt&&Date.now()>Date.parse(h.expiresAt);return `<div class="project-card sandbox-card"><button class="sandbox-open" data-action="open-sandbox" data-id="${esc(r.id)}"><span class="project-thumb">${icon('unlock')}</span><span class="project-body"><span class="project-title">${esc(h.sender||'Защищённый пакет')}</span><div class="project-sub">${h.recipient?.name?`для ${esc(h.recipient.name)} · `:''}${exp?'срок истёк':h.expiresAt?`до ${new Date(h.expiresAt).toLocaleDateString(locale())}`:'без срока'}${h.oneTime?' · одноразовый':''}${h.viewOnly?' · только просмотр':''}</div></span></button><button class="icon-button" data-action="delete-sandbox" data-id="${esc(r.id)}" aria-label="Удалить пакет">${icon('trash')}</button></div>`;}).join('')}
  <p class="small-muted" style="margin-top:8px">Полученные защищённые пакеты лежат в песочнице: не попадают в «Мои файлы», поиск и недавние.</p></div>`;
}
function vaultView(projects,files,notes){return `<div class="breadcrumbs"><button data-action="lock-vault">${icon('lock','small')} Закрыть сейф</button></div><div class="eyebrow">${icon('lock','small')} Открыт по ${IS_NATIVE?'Face ID / код-паролю':'коду'}</div><h1>Сейф</h1><p class="lead">Файлы зашифрованы ключом этого устройства (не переносится в резервные копии). Сейф закрывается при сворачивании приложения.</p>
  <div class="project-list section">${projects.map(p=>projectTile(p,files,notes)).join('')||`<div class="empty">${icon('lock','large')}<h3>Сейф пуст</h3><p>Откройте проект и нажмите «В сейф»</p></div>`}</div>`;}
function selectTab(tab){if(state.secure&&tab!=='secure')closeSecure();if(state.vaultOpen&&tab!=='vault')lockVault();state.tab=tab;state.projectId=null;state.assetId=null;state.viewer=null;state.viewerTool='view';window.scrollTo(0,0);render();}
function releasePreview(){if(previewUrl){URL.revokeObjectURL(previewUrl);previewUrl=null;}}

async function render(){
  const projects=await getProjects(),files=await getAllAssets(),notes=await getAllNotes();for(const f of files)f.kind=kindFor(f.name); /* kinds evolve between versions (DWG became viewable) */state.projectIds=projects.map(p=>p.id);state.projectNames=new Map(projects.map(p=>[p.id,p.name]));state.notes=notes;
  const vaultIds=new Set(projects.filter(p=>p.vault).map(p=>p.id));
  const pub=projects.filter(p=>!p.vault),pubFiles=files.filter(f=>!vaultIds.has(f.projectId)),pubNotes=notes.filter(n=>!vaultIds.has(n.projectId));
  if(state.secure)state.notes=notes.concat(state.secure.notes);
  if(state.secure&&state.secure.header.expiresAt&&Date.now()>Date.parse(state.secure.header.expiresAt)){await closeSecure();notify('Срок действия пакета истёк');state.tab='projects';}
  if(['project','viewer','vault'].includes(state.tab)&&!state.secure&&(state.tab==='vault'||vaultIds.has(state.projectId))&&!state.vaultOpen){state.tab='projects';}
  let body='';
  if(state.tab==='home')body=homeView(pub,pubFiles,pubNotes);
  if(state.tab==='projects')body=projectsView(pub,pubFiles,pubNotes)+await securePanels();
  if(state.tab==='vault')body=vaultView(projects.filter(p=>p.vault),files,notes);
  if(state.tab==='secure')body=state.secure?secureView():'<div class="empty">Пакет закрыт</div>';
  if(state.tab==='notes')body=notesView(pubNotes,pubFiles);
  if(state.tab==='settings')body=settingsView(projects,files);
  if(state.tab==='project'){
    const p=projects.find(p=>p.id===state.projectId);
    body=p?detailView(p,files.filter(f=>f.projectId===p.id),notes.filter(n=>n.projectId===p.id)):'<div class="empty">Проект не найден</div>';
  }
  if(state.tab==='viewer'){
    var viewed=null;try{viewed=await assetById(state.assetId);}catch(e){notify(e.message);}
    if(viewed)viewed.kind=kindFor(viewed.name);
    const all=state.secure&&String(state.assetId).startsWith('sbx:')?state.secure.assets:files;
    body=viewed?viewerContent(viewed,all,state.notes.filter(n=>n.assetId===viewed.id)):'<div class="empty">Файл не найден</div>';
  }
  state.viewer?.cleanup?.();releasePreview();releaseAudioUrls();if(state.tab!=='viewer')document.body.classList.remove('viewer-full');document.body.classList.toggle('cad-dark',cadDark());app.innerHTML=layout(body);updatePrivacy();
  if(state.tab==='viewer'&&viewed) await activateViewer(viewed);
}
async function openAsset(id){let asset;try{asset=await assetById(id);}catch(e){notify(e.message);return;}if(!asset){notify('Файл не найден');return;}state.tab='viewer';state.assetId=id;state.projectId=asset.projectId;state.viewerTool='view';state.viewer=null;window.scrollTo(0,0);await render();}
async function openProject(id){const p=await getProject(id);if(!p)return;state.projectId=id;state.assetId=null;state.tab='project';window.scrollTo(0,0);await render();}
function filePickerAction(mode='all',projectId=null){
  state.pickerProject=projectId;state.pickerMode=mode;
  const accepts={all:'',drawing:'.dwg,.pdf,.dxf,.svg,.png,.jpg,.jpeg,.webp,.bmp',model:'.glb,.gltf,.fbx,.obj,.stl,.3ds,.dae,.ply,.3mf,.max,.usdz,.step,.stp,.ifc',package:'.mlink'};
  filePicker.setAttribute('accept',accepts[mode]||'');filePicker.multiple=mode!=='package';
  if(NativeML){nativeChoose();return;}
  filePicker.value='';filePicker.click();
}
async function pickProjectToImport(files){if(state.pickerProject)return state.pickerProject;const projects=await getProjects();let inbox=projects.find(x=>(x.name==='Мои файлы'||x.name===t('Мои файлы'))&&!x.demo&&!x.vault);if(!inbox)inbox=await createProject(t('Мои файлы'),t('Файлы, открытые с телефона'));return inbox.id;}
async function addPickedFiles(files){if(!files?.length)return;
  const receipts=files.filter(f=>/\.mlinkack$/i.test(f.name));files=files.filter(f=>!/\.mlinkack$/i.test(f.name));
  for(const r of receipts)await importReceipt(r);
  const secured=[];for(const f of files.filter(f=>f.name.toLowerCase().endsWith('.mlink'))){try{if(await readEnvelope(f,window.JSZip))secured.push(f);}catch(e){notify(e.message);secured.push(f);}}
  files=files.filter(f=>!secured.includes(f));for(const f of secured){try{await secureImport(f);}catch(e){notify(e.message);}}
  if(!files.length)return;
  const packages=files.filter(f=>f.name.toLowerCase().endsWith('.mlink'));
  const regular=files.filter(f=>!f.name.toLowerCase().endsWith('.mlink'));
  if(state.pickerMode==='package'&&!packages.length)throw new Error('Выберите пакет .mlink');
  let lastProject=null,lastAsset=null;
  for(const f of packages){if(!window.JSZip)throw new Error('Не удалось загрузить ZIP-модуль');lastProject=await importProjectPackage(f,window.JSZip);}
  if(regular.length){const projectId=await pickProjectToImport(regular);for(const f of regular)lastAsset=await addAsset(projectId,f);}
  state.pickerProject=null;closeModal();
  if(packages.length)notify(packages.length===1&&!regular.length?'Проект импортирован':`Импортировано: проектов ${packages.length}, файлов ${regular.length}`);
  else notify(`Добавлено файлов: ${regular.length}`);
  if(lastAsset)await openAsset(lastAsset.id);else if(lastProject)await openProject(lastProject.id);
}
async function nativeStagedToFile(native,item){
  if(item.size>100*1024*1024)throw new Error('Файл слишком большой для браузерного хранилища');
  const parts=[];let off=0;
  while(off<item.size){const v=await native.readChunk({id:item.id,offset:off,length:128*1024});const raw=atob(v.base64);const bytes=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);if(bytes.length!==v.byteCount||v.nextOffset!==off+bytes.length)throw new Error('Ошибка передачи файла');parts.push(bytes);off=v.nextOffset;}
  const f=new File(parts,item.name,{type:item.mimeType||'application/octet-stream'});
  if(item.sha256){const buffer=await f.arrayBuffer();const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',buffer))].map(x=>x.toString(16).padStart(2,'0')).join('');if(hash!==item.sha256.toLowerCase())throw new Error('Ошибка контрольной суммы SHA-256');}
  return f;
}
async function nativeReceive(incoming){const native=NativeML;if(!native)return;const problems=[...(incoming.errors||[])];const files=[];
  for(const item of incoming.files||[]){try{files.push(await nativeStagedToFile(native,item));}catch(e){problems.push(`${item.name}: ${e.message}`);}finally{await native.deleteStaged({id:item.id}).catch(()=>{});}}
  if(files.length){try{await addPickedFiles(files);}catch(e){problems.push(e.message);}}
  state.pickerProject=null;
  if(problems.length)notify(problems.slice(0,2).join('; '));
}
async function nativeChoose(){const native=NativeML;try{const received=await native.pickFiles();if(received.cancelled)return;if(received.files?.length)notify('Сохраняем файлы…');await nativeReceive(received);}catch(e){notify(e.message||'Не удалось открыть Файлы');}}
let draining=false;
async function nativeDrain(){const native=NativeML;if(!native||draining)return;draining=true;try{const incoming=await native.drainInbox();if(incoming.files?.length){state.pickerMode='all';state.pickerProject=null;notify('Получаем файлы…');}await nativeReceive(incoming);}catch(e){console.warn('Incoming files:',e);}finally{draining=false;}}
async function saveBlob(blob,name){if(NativeML){await shareBlob(blob,name);return;}downloadBlob(blob,name);}
function downloadBlob(blob,name){const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}
/** Streams a blob to the app's native export folder in chunks, then runs `use(exportId)`. */
async function withNativeExport(blob,name,use){const native=NativeML;if(blob.size<=0)throw new Error('Файл пустой');if(blob.size>200*1024*1024)throw new Error('Слишком большой файл для передачи');let offset=0;
  const begin=await native.beginExport({name,size:blob.size});try{
    while(offset<blob.size){const arr=new Uint8Array(await blob.slice(offset,offset+96*1024).arrayBuffer());let binary='';for(let i=0;i<arr.length;i+=0x8000)binary+=String.fromCharCode.apply(null,arr.subarray(i,i+0x8000));const ret=await native.appendExportChunk({exportId:begin.exportId,offset,base64:btoa(binary)});if(ret.nextOffset!==offset+arr.length)throw new Error('Ошибка записи экспорта');offset=ret.nextOffset;}
    await native.finalizeExport({exportId:begin.exportId});return await use(begin.exportId);
  }finally{await native.deleteExport({exportId:begin.exportId}).catch(()=>{});}
}
async function iosShareBlob(blob,name){if(!NativeML)return false;await withNativeExport(blob,name,id=>NativeML.shareExport({exportId:id}));return true;}
async function quickLook(blob,name){if(!canQuickLook(name))return false;const r=await withNativeExport(blob,name,id=>NativeML.previewExport({exportId:id}));return !!r?.presented;}
async function shareBlob(blob,name){
  if(await iosShareBlob(blob,name))return;
  const file=new File([blob],name,{type:blob.type||'application/octet-stream'});
  if(navigator.canShare?.({files:[file]})){
    try{await navigator.share({files:[file],title:'ModelLink'});return;}catch(err){if(err.name==='AbortError')return;}
  }
  downloadBlob(blob,name);notify('Файл сохранён для отправки');
}
async function shareProject(){const p=await getProject(state.projectId);if(!p)return;notify('Собираем пакет проекта…');const blob=await exportProject(p.id,window.JSZip);await shareBlob(blob,`${p.name.replace(/[^\wа-яА-ЯёЁ-]/g,'_').slice(0,40)||'ModelLink'}.mlink`);}

function formatModal(){
  const rows=Object.entries(capabilities).map(([ext,item])=>`<div class="setting-row"><div><strong>${esc(item.label)} <span style="font-weight:500">.${esc(ext)}</span></strong><br><span>${esc(item.note)}</span></div><span class="tag" style="color:${item.preview==='yes'?'#138a62':item.preview==='source'?'#b06d1b':'#4264c8'}">${item.preview==='yes'?'Просмотр':item.preview==='partial'?'Частично':'Исходник'}</span></div>`).join('');
  modal('Форматы и возможности',`<p class="small-muted" style="margin-bottom:14px">Открыть, сохранить и передать можно файлы любых расширений (до 100 МБ). Кнопка «Экспорт» в просмотре преобразует файл в другие форматы.</p><div class="group-card">${rows}</div><p class="plan-warning">DWG (R13–2018+) и DXF открываются со слоями, блоками и цветами. STEP, IFC и другие 3D-форматы САПР хранятся и передаются без изменений: для просмотра добавьте копию в GLB или STL.</p>`);
}
function newProjectModal(){modal('Новый проект',`<form id="create-project"><label class="field">Название проекта<input name="name" maxlength="100" required autofocus placeholder="Например, Завод · фасад" /></label><label class="field">Описание (необязательно)<textarea name="description" maxlength="350" placeholder="Что хранится в проекте"></textarea></label><button class="btn primary block" type="submit">${icon('plus','small')} Создать проект</button></form>`);dialog.querySelector('input')?.focus();}
function newNoteModal(point){state.pendingPoint=point;state.pendingLocationType='normalized';modal('Новое замечание',`<form id="create-note"><p class="small-muted" style="margin-bottom:13px">Замечание будет прикреплено к открытой версии файла.</p><label class="field">Что нужно проверить?<textarea name="text" maxlength="1200" placeholder="Например, проверить ширину прохода…"></textarea></label>
  <button class="btn primary block" type="submit">${icon('check','small')} Сохранить замечание</button></form>`);}
const audioUrls=[];function releaseAudioUrls(){while(audioUrls.length)URL.revokeObjectURL(audioUrls.pop());}
function audioTag(n){if(!n.audio)return '';const url=URL.createObjectURL(n.audio);audioUrls.push(url);return `<audio class="note-audio" controls preload="none" src="${url}"></audio>`;}
function measureResultModal(pixels,mmPerPixel){state.lastPixels=pixels;const mm=mmPerPixel?pixels*mmPerPixel:null;
  modal('Измерение',`<div class="measure-result"><strong>${mm!==null?formatLength(mm):`${pixels.toFixed(1)} пикс.`}</strong><span>${mm!==null?`${pixels.toFixed(1)} пикс. · масштаб задан вами`:'Расстояние в пикселях изображения'}</span></div><form id="calibrate"><label class="field">${mm!==null?'Уточнить масштаб: реальная длина этого отрезка, мм':'Знаете реальную длину этого отрезка? Укажите её, мм'}<input name="length" type="number" inputmode="decimal" min="0.001" step="any" required placeholder="Например, 30000"></label><button class="btn primary block" type="submit">${icon('ruler','small')} Задать масштаб</button></form>${mm!==null?`<button class="btn outline block" style="margin-top:10px" data-action="clear-scale">Сбросить масштаб</button>`:''}<p class="small-muted" style="margin-top:12px">Масштаб сохраняется для этой версии файла. Сверяйте критичные размеры в CAD-программе.</p>`);}
function formatLength(mm){if(mm>=1000)return `${(mm/1000).toFixed(mm>=100000?1:3).replace(/\.?0+$/,'')} м`;if(mm>=10)return `${mm.toFixed(1).replace(/\.0$/,'')} мм`;return `${mm.toFixed(2)} мм`;}
function askDeleteAsset(){modal('Удалить версию файла?',`<p class="lead" style="margin-bottom:22px">Будет удалена открытая версия и её замечания. Другие версии этого файла останутся.</p><div class="row"><button class="btn outline" data-action="close-modal" style="flex:1">Отмена</button><button class="btn danger" style="flex:1" data-action="confirm-delete-asset">Удалить</button></div>`);}
function askEraseAll(){modal('Удалить все данные?',`<p class="lead" style="margin-bottom:22px">Будут удалены все проекты, файлы, версии и замечания на этом устройстве. Сначала экспортируйте нужные проекты в .mlink.</p><div class="row"><button class="btn outline" data-action="close-modal" style="flex:1">Отмена</button><button class="btn danger" style="flex:1" data-action="confirm-erase-all">Удалить всё</button></div>`);}
function privacyModal(){modal('Конфиденциальность',`<div class="prose"><p><strong>ModelLink не собирает данные.</strong> В приложении нет учётных записей, рекламы, аналитики и отслеживания.</p><p>Проекты, файлы, версии и замечания хранятся только на этом устройстве. Приложение не отправляет их на серверы и не обращается к сети.</p><p>Файл покидает устройство, только когда вы сами отправляете его через меню «Поделиться» (AirDrop, «Файлы», почта и другие).</p><p>Удалить все данные можно в «Настройках» или удалив приложение.</p></div>`);}
function aboutModal(){modal('О приложении',`<div class="prose"><p><strong>ModelLink ${APP_VERSION}</strong>. Чертежи, 3D-модели, замечания и версии проектов на телефоне.</p><p>Открывает любой файл. Просмотр: чертежи DWG (R13–2018+) и DXF со слоями, блоками и цветами; PDF, изображения (включая HEIC и TIFF), SVG; 3D: FBX, 3ds Max (.max), OBJ, STL, GLB/glTF, 3DS, DAE, PLY, 3MF; текст и код${IS_NATIVE?', а также Office, iWork, USDZ (AR), аудио и видео через Quick Look':''}.</p><p>Экспорт: DWG → DXF, PDF, SVG, PNG, JPEG; DXF → PDF, SVG, PNG, JPEG; 3D (в т.ч. FBX и MAX) → USDZ, GLB, OBJ, STL, PLY, PNG; изображения → PNG, JPEG, PDF${IS_NATIVE?'; PDF → страницы PNG/JPEG; текст, HTML, RTF → PDF':''}; любой файл → ZIP. Всё преобразуется на устройстве.</p><p>Измерения на DWG/DXF привязываются к ближайшей точке и выводятся в единицах чертежа (мм, м…), на изображениях — в пикселях или в миллиметрах после калибровки. Перед производственными решениями сверяйте размеры в CAD-программе.</p><p class="small-muted">Компоненты с открытым кодом: acad-ts (MIT, порт ACadSharp), three.js (MIT), JSZip (MIT), Capacitor (MIT).</p></div>`);}
function askDeleteProject(){modal('Удалить проект?',`<p class="lead" style="margin-bottom:22px">Будут удалены все локальные файлы, версии и замечания этого проекта. Действие нельзя отменить.</p><div class="row"><button class="btn outline" data-action="close-modal" style="flex:1">Отмена</button><button class="btn danger" style="flex:1" data-action="confirm-delete">Удалить</button></div>`);}
function versionsModal(projectId){getAssets(projectId).then(files=>{
  const groups=new Map();for(const f of files){if(!groups.has(f.groupId))groups.set(f.groupId,[]);groups.get(f.groupId).push(f);}
  modal('История версий',`<p class="small-muted" style="margin-bottom:10px">Редакции сохраняются автоматически при повторной загрузке файла с тем же именем.</p>${[...groups.values()].map(arr=>`<div class="group-card" style="margin-bottom:12px"><div style="font-size:14px;font-weight:750;margin:13px 0">${esc(arr[0].name)}</div>${arr.sort((a,b)=>b.version-a.version).map(f=>`<div class="version-item"><span>Версия ${f.version} <small style="color:var(--muted)">${date(f.createdAt)}</small></span><button class="btn tiny soft" data-action="open-asset" data-id="${f.id}">Открыть</button></div>`).join('')}</div>`).join('')||'<div class="empty">Версий нет</div>'}`);
});}
function exportPickerModal(files){modal('Экспорт файла',`<p class="small-muted" style="margin-bottom:12px">Выберите файл: его можно преобразовать в другой формат и отправить.</p><div class="file-list">${files.slice(0,40).map(f=>`<button class="file-row" data-action="export-picked" data-id="${esc(f.id)}"><span class="file-ext">${esc(fileInfo(f.name).label.slice(0,6))}</span><span class="body"><h3>${esc(niceName(f.name))}</h3><p>${formatBytes(f.size)}</p></span>${icon('arrow','small')}</button>`).join('')}</div><button class="btn outline block" style="margin-top:14px" data-action="share-project-picker">${icon('share','small')} Отправить проект целиком (.mlink)</button>`);}
function exportModal(f){const targets=conversionTargets(f.name,{native:IS_NATIVE});const meshNeedsView=['stl','obj','glb'].includes(extOf(f.name));
  const row=t=>`<div class="setting-row"><div><strong>${esc(t.label)}</strong><br><span>${esc(t.note||(t.engine==='native'?'Преобразование на iPhone':t.engine==='zip'?'Сжатый архив':'Преобразование на устройстве'))}</span></div><div class="row" style="gap:6px;flex-shrink:0"><button class="btn tiny soft" data-action="convert" data-to="${t.to}" data-engine="${t.engine}" data-mode="share" aria-label="${esc(t.label)}: поделиться">${icon('share','small')}</button><button class="btn tiny outline" data-action="convert" data-to="${t.to}" data-engine="${t.engine}" data-mode="project" aria-label="${esc(t.label)}: сохранить в проект">${icon('plus','small')}</button></div></div>`;
  modal('Экспорт',`<p class="small-muted" style="margin-bottom:6px"><strong translate="no">${esc(f.name)}</strong> · ${formatBytes(f.size)}</p><div class="legend"><span>${icon('share','small')} Поделиться</span><span>${icon('plus','small')} В проект</span></div><div class="group-card"><div class="setting-row"><div><strong>Оригинал .${esc(extOf(f.name)||'файл')}</strong><br><span>Без изменений</span></div><button class="btn tiny soft" data-action="share-file" aria-label="Поделиться оригиналом">${icon('share','small')}</button></div>${targets.map(row).join('')}</div>${meshNeedsView?'<p class="small-muted" style="margin-top:10px">PNG-снимок сохраняет текущий ракурс модели. USDZ открывается в AR через Quick Look.</p>':''}${targets.length?'':'<p class="small-muted" style="margin-top:10px">Для этого формата доступна только передача оригинала.</p>'}`);}
function projectPickerModal(projects,action){modal(action==='share'?'Поделиться проектом':'Выберите проект',`<div class="file-list">${projects.map(p=>`<button class="file-row" data-action="${action==='share'?'share-picked-project':'versions-picked-project'}" data-id="${p.id}"><span class="file-ext">${icon('folders','small')}</span><span class="body"><h3>${esc(p.name)}</h3></span>${icon('arrow','small')}</button>`).join('')||'<p class="small-muted">Проектов пока нет</p>'}</div>`);}

async function actionHandler(button){const action=button.dataset.action;
  if(action==='tab'){selectTab(button.dataset.tab);return;}
  if(action==='go-settings'){selectTab('settings');return;}
  if(action==='go-projects'){selectTab('projects');return;}
  if(action==='open-project'){await openProject(button.dataset.id);return;}
  if(action==='open-asset'){closeModal();await openAsset(button.dataset.id);return;}
  if(action==='new-project'){newProjectModal();return;}
  if(action==='close-modal'){closeModal();return;}
  if(action==='import'){filePickerAction();return;}
  if(action==='import-here'){filePickerAction('all',state.projectId);return;}
  if(action==='import-package'){filePickerAction('package');return;}
  if(action==='open-example'){const p=(await getProjects()).find(p=>p.demo);if(p)await openProject(p.id);else notify('Демонстрационный проект отсутствует');return;}
  if(action==='formats'){formatModal();return;}
  if(action==='filter'){state.filter=button.dataset.filter;await render();return;}
  if(action==='theme'){state.theme=state.theme==='dark'?'light':'dark';document.body.classList.toggle('dark',state.theme==='dark');localStorage.setItem('modellink-theme',state.theme);await render();return;}
  if(action==='back-project'){if(String(state.projectId).startsWith('sbx:')){state.tab='secure';state.assetId=null;await render();return;}await openProject(state.projectId);return;}
  if(action==='download-file'){const f=await assetById(state.assetId);if(viewOnlyBlocked(f)){notify('Отправитель запретил выгрузку этого файла');return;}await saveBlob(f.blob,f.name);return;}
  if(action==='export-file'){const f=await assetById(state.assetId);if(viewOnlyBlocked(f)){notify('Отправитель запретил выгрузку этого файла');return;}if(f)exportModal(f);return;}
  if(action==='export-picked'){closeModal();await openAsset(button.dataset.id);const f=await assetById(button.dataset.id);if(f)exportModal(f);return;}
  if(action==='share-project-picker'){projectPickerModal(await getProjects(),'share');return;}
  if(action==='convert'){if(viewOnlyBlocked(await assetById(state.assetId))){notify('Отправитель запретил выгрузку');return;}await convertAction(button);return;}
  if(action==='quicklook'){const f=await assetById(state.assetId);if(viewOnlyBlocked(f)){notify('В режиме «только просмотр» системный просмотр недоступен');return;}if(!(await quickLook(f.blob,f.name)))notify('Этот формат нельзя открыть в Quick Look');return;}
  if(action==='delete-asset'){askDeleteAsset();return;}
  if(action==='confirm-delete-asset'){const a=await removeAsset(state.assetId);closeModal();notify('Версия файла удалена');const rest=latestFiles(await getAssets(a.projectId)).find(f=>f.groupId===a.groupId);if(rest)await openAsset(rest.id);else await openProject(a.projectId);return;}
  if(action==='privacy'){privacyModal();return;}
  if(action==='about'){aboutModal();return;}
  if(action==='erase-all'){askEraseAll();return;}
  if(action==='confirm-erase-all'){await removeAllData();closeModal();notify('Все данные удалены');selectTab('home');return;}
  if(action==='clear-scale'){await setAssetScale(state.assetId,null);closeModal();notify('Масштаб сброшен');await render();return;}
  if(action==='share-file'){const f=await assetById(state.assetId);if(viewOnlyBlocked(f)){notify('Отправитель запретил выгрузку этого файла');return;}await shareBlob(f.blob,f.name);return;}
  if(action==='share-project'){await shareProject();return;}
  if(action==='share-picked-project'){state.projectId=button.dataset.id;closeModal();await shareProject();return;}
  if(action==='versions-picked-project'){closeModal();versionsModal(button.dataset.id);return;}
  if(action==='project-versions'){versionsModal(state.projectId);return;}
  if(action==='delete-project'){askDeleteProject();return;}
  if(action==='confirm-delete'){await removeProject(state.projectId);closeModal();notify('Проект удалён');selectTab('projects');return;}
  if(action==='toggle-note'&&String(button.dataset.id).startsWith('sbx')){const n=state.secure?.notes.find(x=>x.id===button.dataset.id);if(n&&!n.fromSender){n.status=n.status==='resolved'?'open':'resolved';await secureAudit({type:'comment'});}else notify('Замечания отправителя изменить нельзя');await render();return;}
  if(action==='delete-note'&&String(button.dataset.id).startsWith('sbx')){const s=state.secure;if(s){const n=s.notes.find(x=>x.id===button.dataset.id);if(n?.fromSender){notify('Замечания отправителя удалить нельзя');return;}s.notes=s.notes.filter(x=>x.id!==button.dataset.id);await secureAudit({type:'comment'});}await render();return;}
  if(action==='toggle-note'){const note=state.notes.find(n=>n.id===button.dataset.id);if(note)await setNoteStatus(note.id,note.status==='resolved'?'open':'resolved');await render();return;}
  if(action==='viewer-tool'){state.viewerTool=button.dataset.tool;state.viewer?.setTool?.(state.viewerTool);if(state.viewerTool==='measure'&&!state.viewer?.measure)notify('Измерения доступны для DXF и изображений');if(state.viewerTool==='comment')notify('Коснитесь места для замечания');app.querySelectorAll('[data-action="viewer-tool"]').forEach(b=>{const on=b.dataset.tool===state.viewerTool;b.classList.toggle('soft',on);b.classList.toggle('active-tool',on);b.classList.toggle('outline',!on);});return;}
  if(action==='fit'){state.viewer?.fit?.();return;}
  if(action==='file-menu'){const f=await assetById(state.assetId);if(!f)return;const item=(act,ic,label,extra='')=>`<button class="file-row" data-action="${act}"${extra}><span class="file-ext has-icon">${icon(ic)}</span><span class="body"><h3>${label}</h3></span></button>`;
    modal(niceName(f.name),`<div class="file-list">${viewOnlyBlocked(f)?'':`${canQuickLook()?item('quicklook','eye','Открыть в Quick Look'):''}${item('export-file','export','Экспорт в другой формат')}${IS_NATIVE?item('share-file','share','Отправить или сохранить в «Файлы»'):item('download-file','download','Скачать оригинал')}`}${f.secure?'':`${item('rename-asset','edit','Переименовать')}${f.redactions?.length?item('clear-redactions','eye','Вернуть скрытые области ('+f.redactions.length+')'):''}${item('delete-asset','trash','Удалить эту версию')}`}</div><div class="fp" style="margin-top:12px"><strong>Отпечаток SHA-256</strong><code>${esc(f.sha256||'считается при добавлении')}</code></div><p class="small-muted" style="margin-top:12px">${formatBytes(f.size)} · версия ${f.version} · добавлен ${date(f.createdAt)}</p>`);return;}
  if(action==='secure-share'){await secureShareModal(button.dataset.id||state.projectId);return;}
  if(action==='close-secure'){await closeSecure();state.tab='projects';state.projectId=null;await render();return;}
  if(action==='secure-ack'){await secureAckModal();return;}
  if(action==='secure-audit'){modal('Журнал пакета («чёрный ящик»)',`<p class="small-muted">Каждая запись содержит хеш предыдущей: изменить историю незаметно нельзя. Журнал уходит отправителю вместе с квитанцией.</p>${auditList(state.secure?.audit||[])}`);return;}
  if(action==='open-sandbox'){await unlockModal(button.dataset.id);return;}
  if(action==='delete-sandbox'){await sandboxStore.del(button.dataset.id);notify('Пакет удалён');await render();return;}
  if(action==='scan-key'){const k=await scanKey();if(k){const form=dialog.querySelector('#unlock-secure');await openSecure(button.dataset.id,k,{remember:!!form?.remember?.checked});}return;}
  if(action==='copy-key'){try{await navigator.clipboard.writeText(state.lastKeyLink);notify('Скопировано');}catch{notify(state.lastKeyLink);}return;}
  if(action==='sent-packages'){await sentPackagesModal();return;}
  if(action==='sent-key'){const p=await sentStore.get(button.dataset.id);if(p){const header={id:p.id};await showKeyQR(p.policy&&p.key?keyLink(header,p.key):'', 'Ключ пакета', 'Этот ключ открывает пакет «'+esc(p.title)+'». Если пакет защищён паролем, ключ тоже подходит.');}return;}
  if(action==='sent-revoke'){const p=await sentStore.get(button.dataset.id);if(p){p.revoked=!p.revoked;await sentStore.put(p);}await sentPackagesModal();if(p?.revoked)notify('Опубликуйте обновлённый «Список отзыва» по адресу из Настроек');return;}
  if(action==='share-revocations'){const ids=(await sentStore.all()).filter(p=>p.revoked).map(p=>p.id);await shareBlob(new Blob([JSON.stringify({revoked:ids,updated:new Date().toISOString()},null,1)],{type:'application/json'}),'revocations.json');return;}
  if(action==='import-receipt'){const f=await pickOneFile();if(f)await importReceipt(f);return;}
  if(action==='verify-fp'){await verifyFingerprint();return;}
  if(action==='emergency-wipe'){modal('Экстренная очистка',`<p class="lead" style="margin-bottom:18px">Будут удалены все полученные защищённые пакеты, временные файлы и кэш просмотра. Ваши проекты и сейф останутся.</p><div class="row"><button class="btn outline" style="flex:1" data-action="close-modal">Отмена</button><button class="btn danger" style="flex:1" data-action="confirm-wipe">Очистить</button></div>`);return;}
  if(action==='confirm-wipe'){await emergencyWipe();return;}
  if(action==='panic'){await panic();return;}
  if(action==='open-vault'){if(await unlockVault()){state.tab='vault';state.projectId=null;await render();}return;}
  if(action==='lock-vault'){lockVault();state.tab='projects';await render();return;}
  if(action==='vault-move'){const p=await getProject(state.projectId);if(!p)return;if(!(await unlockVault()))return;notify(p.vault?'Переносим из сейфа…':'Шифруем и переносим в сейф…');await setProjectVault(p.id,!p.vault);notify(p.vault?'Проект перенесён в общий раздел':'Проект в сейфе');if(!p.vault){state.tab='vault';state.projectId=null;}await render();return;}
  if(action==='toggle-setting'){const k=button.dataset.key;await saveSetting(k,!settings[k]);await render();return;}
  if(action==='edit-identity'){modal('Подпись и список отзыва',`<form id="identity"><label class="field">Ваше имя (для квитанций и отправителя)<input name="userName" maxlength="80" value="${esc(settings.userName)}"></label><label class="field">Компания<input name="company" maxlength="80" value="${esc(settings.company)}"></label><label class="field">Адрес списка отзыва (https://…/revocations.json)<input name="revocationUrl" type="url" inputmode="url" value="${esc(settings.revocationUrl)}" placeholder="https://example.com/revocations.json"></label><p class="small-muted" style="margin-bottom:14px">Список отзыва — файл JSON {"revoked":["id",…]} на любом вашем сайте. Его можно выгрузить из «Отправленных пакетов».</p><button class="btn primary block" type="submit">Сохранить</button></form>`);return;}
  if(action==='clear-redactions'){await updateAssetMeta(state.assetId,{redactions:[]});closeModal();notify('Скрытые области удалены');await render();return;}
  if(action==='rename-project'){const p=await getProject(state.projectId);if(p)modal('Переименовать проект',`<form id="rename-project"><label class="field">Название<input name="name" maxlength="100" required value="${esc(p.name)}"></label><label class="field">Описание<textarea name="description" maxlength="350">${esc(p.description||'')}</textarea></label><button class="btn primary block" type="submit">${icon('check','small')} Сохранить</button></form>`);return;}
  if(action==='rename-asset'){const f=await assetById(state.assetId);if(f)modal('Переименовать файл',`<form id="rename-asset"><label class="field">Имя файла (все версии)<input name="name" maxlength="150" required value="${esc(f.name)}"></label><button class="btn primary block" type="submit">${icon('check','small')} Сохранить</button></form>`);return;}
  if(action==='delete-note'){await removeNote(button.dataset.id);notify('Замечание удалено');await render();return;}
  if(action==='notes-report'){await notesReport();return;}
  if(action==='layers'){layersModal();return;}
  if(action==='wireframe'){wireframe=!wireframe;state.viewer?.wireframe?.(wireframe);return;}
  if(action==='max-props'){maxPropsModal();return;}
  if(action==='layers-all'){state.viewer?.setAllLayers?.(button.dataset.on==='1');layersModal();return;}
  if(action==='cad-bg'){try{localStorage.setItem('modellink-cad-bg',cadDark()?'light':'dark');}catch{}state.viewer?.redraw?.();document.querySelectorAll('[data-action="cad-bg"].btn').forEach(b=>b.lastChild.textContent=' '+(cadDark()?'Светлый фон':'Тёмный фон'));document.body.classList.toggle('cad-dark',cadDark());return;}
  if(action==='set-lang'){setLang(button.dataset.lang);await render();startTranslator(document.body);notify(t('Сохранено'));return;}
  if(action==='fullscreen'){const on=!document.body.classList.contains('viewer-full');document.body.classList.toggle('viewer-full',on);haptic();if(on&&NativeML)NativeML.setPrivacy({}).catch(()=>{});setTimeout(()=>state.viewer?.redraw?.(),60);return;}
  if(action==='zoom'){state.viewer?.zoom?.(Number(button.dataset.k)||1);return;}
  if(action==='quick-comment'){newNoteModal({x:.5,y:.5});return;}
  if(action==='feature'){
    const feature=button.dataset.feature;
    if(feature==='drawing'||feature==='model'){filePickerAction(feature);return;}
    if(feature==='notes'){selectTab('notes');return;}
    if(feature==='measure'){
      const files=await getAllAssets();const f=latestFiles(files).find(f=>f.kind==='drawing'||f.kind==='image');
      if(f){await openAsset(f.id);state.viewerTool='measure';state.viewer?.setTool?.('measure');notify('Выберите две точки на чертеже');}else{notify('Для измерения откройте чертёж');filePickerAction('drawing');}return;
    }
    if(feature==='versions'){projectPickerModal(await getProjects(),'versions');return;}
    if(feature==='share'){const files=latestFiles(await getAllAssets());if(!files.length){notify('Сначала откройте файл');filePickerAction();return;}exportPickerModal(files);return;}
  }
}

async function assetById(id){if(String(id).startsWith('sbx:'))return state.secure?.assets.find(a=>a.id===id)||null;return getAsset(id);}
// ---------------------------------------------------------------- security: settings, device keys, vault
const settings={offlineLock:false,shieldAlways:false,panicMotion:true,revocationUrl:'',userName:'',company:''};
async function loadSettings(){for(const k of Object.keys(settings)){const v=await pref('set:'+k,null);if(v!==null)settings[k]=v;}}
async function saveSetting(k,v){settings[k]=v;await setPref('set:'+k,v);updatePrivacy();}
async function deviceKey(name){
  if(NativeML){const r=await NativeML.keychainGet({name});if(r?.value)return b64u.dec(r.value.replace(/\+/g,'-').replace(/\//g,'_'));const k=randomBytes(32);let s='';for(const b of k)s+=String.fromCharCode(b);await NativeML.keychainSet({name,value:btoa(s)});return k;}
  const stored=await pref('key:'+name,null);if(stored)return b64u.dec(stored);const k=randomBytes(32);await setPref('key:'+name,b64u.enc(k));return k;
}
async function deviceId(){let id=await pref('deviceId',null);if(!id){id=uuid().slice(0,8);await setPref('deviceId',id);}return id;}
state.vaultOpen=false;
async function unlockVault(){
  if(state.vaultOpen)return true;
  if(NativeML){const r=await NativeML.authenticate({reason:'Откройте сейф ModelLink'});if(!r.ok){if(r.error)notify(r.error);return false;}}
  else{const saved=await pref('vaultPin',null);const pin=prompt(t(saved?'Код сейфа':'Придумайте код сейфа (4+ цифры)'));if(!pin)return false;const h=await sha256('mlink-vault:'+pin);if(!saved){if(pin.length<4){notify('Минимум 4 цифры');return false;}await setPref('vaultPin',h);}else if(h!==saved){notify('Неверный код');return false;}}
  setVaultCrypto(await deviceKey('vault'),{seal:sealBytes,open:openBytes});state.vaultOpen=true;updatePrivacy();return true;
}
function lockVault(){setVaultCrypto(null);state.vaultOpen=false;drawingCache.clear();modelCache.clear();updatePrivacy();}
function isSensitive(){return !!state.secure||(state.vaultOpen&&['vault','project','viewer'].includes(state.tab));}
function updatePrivacy(){if(!NativeML)return;NativeML.setPrivacy({shield:settings.shieldAlways||isSensitive(),panicMotion:settings.panicMotion&&isSensitive()}).catch(()=>{});}

// ---------------------------------------------------------------- panic, screenshots, screen recording
async function panic(){
  haptic();try{await closeSecure({reason:'panic'});}catch{}lockVault();closeModal();
  state.tab='home';state.projectId=null;state.assetId=null;state.viewer?.cleanup?.();state.viewer=null;document.body.classList.remove('capture-hidden');await render();
}
document.addEventListener('touchstart',e=>{if(e.touches.length>=3&&isSensitive()){e.preventDefault();panic();}},{passive:false});
let escTaps=0;document.addEventListener('keydown',e=>{if(e.key!=='Escape')return;escTaps++;setTimeout(()=>escTaps=0,600);if(escTaps>=2&&isSensitive())panic();});
// Leaving the app locks the vault AND takes its content off the screen: otherwise the file that was open stays rendered
// and is visible on return without Face ID.
document.addEventListener('visibilitychange',()=>{if(!document.hidden||!state.vaultOpen||state.secure)return;const shown=isSensitive();lockVault();
  if(shown){closeModal();state.tab='home';state.projectId=null;state.assetId=null;state.viewer?.cleanup?.();state.viewer=null;document.body.classList.remove('viewer-full','capture-hidden');render();}});
async function onScreenshot(){if(!isSensitive())return;if(state.secure){await secureAudit({type:'screenshot'});notify('Снимок экрана записан в журнал пакета');}else notify('Снимок экрана конфиденциального проекта');}
function onCapture(captured){document.body.classList.toggle('capture-hidden',!!captured&&isSensitive());if(captured&&isSensitive()){notify('Идёт запись экрана — чертёж скрыт');if(state.secure)secureAudit({type:'screen-recording'});}}

// ---------------------------------------------------------------- QR codes
async function qrSvg(text){const {default:qrcode}=await import('./vendor/qrcode.min.js');const q=qrcode(0,'M');q.addData(text);q.make();const n=q.getModuleCount(),c=4;let d='';for(let y=0;y<n;y++)for(let x=0;x<n;x++)if(q.isDark(y,x))d+=`M${x+c} ${y+c}h1v1h-1z`;return `<svg class="qr" viewBox="0 0 ${n+2*c} ${n+2*c}" role="img" aria-label="QR-код"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;}
async function showKeyQR(link,title,note){state.lastKeyLink=link;modal(title,`<div class="qr-box">${await qrSvg(link)}</div><p class="small-muted" style="margin:12px 0">${note}</p><div class="row"><button class="btn outline" style="flex:1" data-action="copy-key">${icon('link','small')} Скопировать</button><button class="btn primary" style="flex:1" data-action="close-modal">Готово</button></div>`);}
async function scanKey(){if(!NativeML){const code=prompt(t('Вставьте ключ доступа (mlink:…)'));return code?parseKeyLink(code)||{password:code}:null;}const r=await NativeML.scanQR();if(r.cancelled)return null;const k=parseKeyLink(r.text);if(!k)throw new Error('Это не QR-код ключа ModelLink');return k;}

// ---------------------------------------------------------------- fingerprints
async function pickOneFile(){
  if(NativeML){const r=await NativeML.pickFiles();if(r.cancelled||!r.files?.length)return null;const item=r.files[0];try{return await nativeStagedToFile(NativeML,item);}finally{NativeML.deleteStaged({id:item.id}).catch(()=>{});}}
  return new Promise(res=>{const i=document.createElement('input');i.type='file';i.onchange=()=>res(i.files[0]||null);i.click();});
}
async function verifyFingerprint(){
  const f=await pickOneFile();if(!f)return;notify('Считаем SHA-256…');const h=await sha256(f);
  const assets=(await getAllAssets()).filter(a=>a.sha256===h);const sentHits=(await sentStore.all()).filter(p=>(p.files||[]).some(x=>x.sha256===h));
  const projects=new Map((await getProjects()).map(p=>[p.id,p.name]));
  modal('Сверка файла',`<div class="fp"><strong>${esc(f.name)}</strong><code>${h}</code></div>${assets.length||sentHits.length?`<div class="notice success" style="margin-top:12px">${icon('check','small')} Совпадает с:</div><div class="group-card" style="margin-top:8px">${assets.map(a=>`<div class="setting-row"><div><strong>${esc(a.name)}</strong><br><span>${esc(projects.get(a.projectId)||'')} · версия ${a.version} · ${date(a.createdAt)}</span></div></div>`).join('')}${sentHits.map(p=>`<div class="setting-row"><div><strong>Отправлено: ${esc(p.title)}</strong><br><span>${esc(p.recipient?.name||'')} · ${date(Date.parse(p.created))}</span></div></div>`).join('')}</div>`:`<div class="notice warn" style="margin-top:12px">${icon('warning','small')} Такой файл в приложении не найден — это другая ревизия или изменённая копия.</div>`}`);
}

// ---------------------------------------------------------------- protected package: sender
async function secureShareModal(projectId){
  const p=await getProject(projectId);if(!p)return;const exp=new Date(Date.now()+14*86400e3).toISOString().slice(0,10);
  modal('Защищённая отправка',`<form id="secure-share" data-project="${esc(projectId)}"><p class="small-muted" style="margin-bottom:12px">Пакет шифруется AES-256. Без пароля или ключа его нельзя открыть, даже если он перехвачен в почте или мессенджере.</p>
  <label class="field">Получатель — имя<input name="rname" maxlength="80" placeholder="Иван Петров"></label><label class="field">Компания<input name="rcompany" maxlength="80" placeholder="ООО «Подрядчик»"></label>
  <div class="seg2"><label><input type="radio" name="mode" value="key" checked> Ключ по QR</label><label><input type="radio" name="mode" value="password"> Пароль</label></div>
  <label class="field pw-field">Пароль (от 8 символов)<input name="password" type="password" autocomplete="new-password" minlength="8"></label>
  <label class="field">Действует до<input name="expires" type="date" value="${exp}"></label>
  <label class="check"><input type="checkbox" name="viewOnly" checked> <span><strong>Только просмотр</strong><br>Нельзя выгрузить исходные DWG/STEP и переслать файлы</span></label>
  <label class="check"><input type="checkbox" name="oneTime"> <span><strong>Одноразовый просмотр</strong><br>Открывается один раз, после закрытия стирается</span></label>
  <label class="check"><input type="checkbox" name="check" ${settings.revocationUrl?'checked':'disabled'}> <span><strong>Проверять отзыв</strong><br>${settings.revocationUrl?'По списку отзыва, когда есть сеть':'Укажите адрес списка отзыва в Настройках'}</span></label>
  <p class="small-muted" style="margin:6px 0 14px">Имя получателя будет видно водяным знаком поверх каждого чертежа. Скрытые области (инструмент «Скрыть») вырезаются из пакета.</p>
  <button class="btn primary block" type="submit">${icon('lock','small')} Создать и отправить</button></form>`);
  const form=dialog.querySelector('#secure-share');const sync=()=>form.querySelector('.pw-field').style.display=form.mode.value==='password'?'':'none';form.addEventListener('change',sync);sync();
}
async function buildInnerPackage(projectId,policy){
  const p=await getProject(projectId),files=await getAssets(projectId),notes=await getNotes(projectId);
  const zip=new window.JSZip();const manifest={format:'modellink-package',version:PACKAGE_VERSION,created:new Date().toISOString(),project:{name:p.name,description:p.description},files:[],notes:[],policy};
  const idMap=new Map();let i=0;
  for(const f of latestFiles(files)){
    let blob=f.blob,name=f.name,redacted=false;
    if(f.redactions?.length&&f.kind==='drawing'){const d=redactDrawing(await loadDrawing(f),f.redactions);blob=new Blob([drawingToDXF(d)]);name=`${baseName(f.name)} (обезличено).dxf`;redacted=true;}
    else if(f.redactions?.length&&f.kind==='image'){blob=await redactImage(f);name=`${baseName(f.name)} (обезличено).png`;redacted=true;}
    const entry=`files/${String(i++).padStart(4,'0')}`;zip.file(entry,blob);const h=await sha256(blob);
    manifest.files.push({entry,id:f.id,path:name,name,mime:blob.type||f.mime,size:blob.size,groupId:f.groupId,version:f.version,createdAt:f.createdAt,sha256:h,redacted});idMap.set(f.id,true);
  }
  manifest.audit=await appendAudit([],{type:'created',who:policy.sender||'Отправитель',device:await deviceId(),rev:new Date().toLocaleString(locale())});
  manifest.notes=[];notes.filter(n=>idMap.has(n.assetId)).forEach((n,k)=>{const item={assetId:n.assetId,text:n.text,point:n.point,locationType:n.locationType,status:n.status,createdAt:n.createdAt};if(n.audio){item.audioEntry=`audio/${String(k).padStart(4,'0')}`;item.audioMime=n.audio.type;zip.file(item.audioEntry,n.audio);}manifest.notes.push(item);});
  zip.file('manifest.json',JSON.stringify(manifest));
  return {bytes:await zip.generateAsync({type:'uint8array',compression:'DEFLATE',compressionOptions:{level:6}}),manifest,title:p.name};
}
async function createSecurePackage(form){
  const fd=new FormData(form),projectId=form.dataset.project,mode=fd.get('mode');
  const password=mode==='password'?String(fd.get('password')||''):null;if(mode==='password'&&password.length<8)throw new Error('Пароль — минимум 8 символов');
  const expires=fd.get('expires')?new Date(fd.get('expires')+'T23:59:59').toISOString():null;
  const policy={recipient:{name:String(fd.get('rname')||'').trim(),company:String(fd.get('rcompany')||'').trim()},sender:[settings.userName,settings.company].filter(Boolean).join(', '),expiresAt:expires,viewOnly:!!fd.get('viewOnly'),oneTime:!!fd.get('oneTime'),checkUrl:fd.get('check')&&settings.revocationUrl?settings.revocationUrl:null};
  notify('Шифруем пакет…');
  const inner=await buildInnerPackage(projectId,policy);
  const {bytes,id,keyCode,header,raw}=await sealPackage(inner.bytes,policy,password?{password}:{},{zipStore});
  await sentStore.put({id,title:inner.title,projectId,recipient:policy.recipient,created:header.created,expiresAt:expires,policy,key:b64u.enc(raw),receipts:[],revoked:false,files:inner.manifest.files.map(f=>({name:f.name,sha256:f.sha256,version:f.version}))});
  closeModal();
  const fileName=`${inner.title.replace(/[^\wа-яА-ЯёЁ -]/g,'_').slice(0,36)||'ModelLink'}${policy.recipient.name?' — '+policy.recipient.name.replace(/[^\wа-яА-ЯёЁ -]/g,'_').slice(0,24):''}.mlink`;
  await shareBlob(new Blob([bytes],{type:'application/vnd.modellink.package+zip'}),fileName);
  await showKeyQR(keyLink(header,keyCode,password),password?'Пароль — по QR при встрече':'Ключ доступа',password?'Пароль можно показать этим QR-кодом при личной встрече — не пересылайте его в той же переписке, что и файл.':'Покажите этот QR-код получателю при встрече или передайте ключ отдельным каналом. Без него пакет не открыть. Ключ сохранён в «Настройки → Отправленные пакеты».');
}
async function sentPackagesModal(){
  const list=(await sentStore.all()).sort((a,b)=>Date.parse(b.created)-Date.parse(a.created));
  modal('Отправленные пакеты',`${list.length?`<div class="group-card">${list.map(p=>{const exp=p.expiresAt&&Date.now()>Date.parse(p.expiresAt);const r=p.receipts?.length;return `<div class="sent-row"><div><strong>${esc(p.title)}</strong><br><span>${esc([p.recipient?.name,p.recipient?.company].filter(Boolean).join(', ')||'Получатель не указан')} · ${date(Date.parse(p.created))}${p.expiresAt?` · до ${new Date(p.expiresAt).toLocaleDateString(locale())}`:''}</span><br><span class="badges">${p.revoked?'<b class="bad">отозван</b>':exp?'<b class="bad">срок истёк</b>':'<b class="ok">активен</b>'}${p.policy?.viewOnly?'<b>только просмотр</b>':''}${p.policy?.oneTime?'<b>одноразовый</b>':''}${r?`<b class="ok">ознакомлен: ${r}</b>`:''}</span>${(p.receipts||[]).map(x=>`<div class="receipt">${icon('check','small')} ${esc(x.name)}${x.company?`, ${esc(x.company)}`:''} — ${new Date(x.at).toLocaleString(locale())}${x.chainOk?'':' · журнал повреждён'}</div>`).join('')}</div><div class="sent-actions"><button class="btn tiny outline" data-action="sent-key" data-id="${p.id}">QR</button><button class="btn tiny ${p.revoked?'soft':'outline'}" data-action="sent-revoke" data-id="${p.id}">${p.revoked?'Вернуть':'Отозвать'}</button></div></div>`;}).join('')}</div>
  <div class="row" style="margin-top:12px;flex-wrap:wrap"><button class="btn outline tiny" data-action="share-revocations">${icon('share','small')} Список отзыва (JSON)</button><button class="btn outline tiny" data-action="import-receipt">${icon('download','small')} Проверить квитанцию</button></div>
  <p class="small-muted" style="margin-top:10px">Отзыв срабатывает у получателя при следующем открытии, если в пакете включена проверка, есть сеть и опубликован актуальный список отзыва по адресу из Настроек. Без сети действует срок действия пакета.</p>`:'<div class="empty"><h3>Пока нет</h3><p>Откройте проект → «Защищённая отправка»</p></div>'}`);
}
async function importReceipt(file){
  const text=await file.text();let parsed;try{parsed=JSON.parse(JSON.parse(text).body);}catch{throw new Error('Это не квитанция ModelLink');}
  const pkg=await sentStore.get(parsed.packageId);if(!pkg)throw new Error('Квитанция относится к пакету, отправленному с другого устройства');
  const v=await verifyReceipt(b64u.dec(pkg.key),text);
  if(v.ok){pkg.receipts=[...(pkg.receipts||[]).filter(r=>r.at!==v.data.at),{name:v.data.name,company:v.data.company,at:v.data.at,revision:v.data.revision,chainOk:v.chainOk,events:(v.data.chain||[]).length}];await sentStore.put(pkg);}
  modal('Квитанция об ознакомлении',`<div class="notice ${v.ok?'success':'warn'}">${icon(v.ok?'check':'warning','small')} ${v.ok?'Подпись верна: квитанция создана тем, у кого есть ключ этого пакета.':'Подпись неверна — квитанция подделана или изменена.'}</div><div class="group-card" style="margin-top:12px"><div class="setting-row"><div><strong>${esc(v.data.name||'—')}</strong><br><span>${esc(v.data.company||'')}</span></div></div><div class="setting-row"><div><strong>Ознакомлен</strong><br><span>${new Date(v.data.at).toLocaleString(locale())} · ревизия ${esc(String(v.data.revision||''))}</span></div></div><div class="setting-row"><div><strong>Журнал получателя</strong><br><span>${plural((v.data.chain||[]).length,'event')} · ${v.chainOk?'цепочка цела':'цепочка нарушена'}</span></div></div></div>${auditList(v.data.chain||[])}`);
}

// ---------------------------------------------------------------- protected package: recipient (sandbox)
state.secure=null;
async function secureImport(file){
  const env=await readEnvelope(file,window.JSZip);if(!env)return false;
  await sandboxStore.put({id:env.header.id,header:env.header,headerText:env.headerText,payload:env.payload,addedAt:Date.now(),audit:[],notes:[]});
  await unlockModal(env.header.id);return true;
}
async function unlockModal(id){
  const rec=await sandboxStore.get(id);if(!rec)return;const h=rec.header;
  if(rec.savedKey){try{const secret=dec8(await openBytes(await deviceKey('sandbox'),b64u.dec(rec.savedKey)));await openSecure(id,parseKeyLink(secret)||secret);return;}catch(e){if(/истёк|отозван|уже был/.test(e.message)){notify(e.message);return;}}}
  modal('Защищённый пакет',`<div class="secure-head">${icon('lock','large')}<div><strong>${esc(h.sender||'Отправитель не указан')}</strong><br><span>${h.recipient?.name?`Для: ${esc([h.recipient.name,h.recipient.company].filter(Boolean).join(', '))} · `:''}${h.expiresAt?`до ${new Date(h.expiresAt).toLocaleDateString(locale())}`:'без срока'}</span></div></div>
  <div class="badges" style="margin:10px 0 14px">${h.viewOnly?'<b>только просмотр</b>':''}${h.oneTime?'<b class="bad">одноразовый</b>':''}${h.checkUrl?'<b>проверка отзыва</b>':''}</div>
  <form id="unlock-secure" data-id="${esc(id)}">${h.kdf.alg==='raw'?'<label class="field">Ключ доступа<input name="secret" autocomplete="off" placeholder="mlink:key:… или код"></label>':'<label class="field">Пароль<input name="secret" type="password" autocomplete="off"></label>'}
  ${h.oneTime?'':'<label class="check"><input type="checkbox" name="remember"> <span>Запомнить на этом устройстве</span></label>'}
  <div class="row"><button class="btn outline" type="button" style="flex:1" data-action="scan-key" data-id="${esc(id)}">${icon('target','small')} Сканировать QR</button><button class="btn primary" type="submit" style="flex:1">${icon('unlock','small')} Открыть</button></div></form>`);
}
const dec8=b=>new TextDecoder().decode(b);
async function revocationCheck(h){
  if(!h.checkUrl||!NativeML||settings.offlineLock)return null;
  try{const r=await NativeML.fetchText({url:h.checkUrl});if(r.status!==200)return null;let ids=[];try{const j=JSON.parse(r.text);ids=Array.isArray(j)?j:(j.revoked||[]);}catch{ids=r.text.split(/\s+/);}return ids.map(String).includes(h.id);}catch{return null;}
}
async function openSecure(id,secretInput,{remember=false}={}){
  const rec=await sandboxStore.get(id);if(!rec)throw new Error('Пакет не найден');const h=rec.header;
  const seen=new Set(await pref('seenOnce',[])),revoked=new Set(await pref('revokedIds',[])),lastSeen=await pref('lastSeenTime',0);
  let pol=checkPolicy(h,{seen,revoked,lastSeenTime:lastSeen});if(!pol.ok){if(/отозван|Одноразовый/.test(pol.reason))await sandboxStore.del(id);throw new Error(pol.reason);}
  const link=typeof secretInput==='string'?parseKeyLink(secretInput):secretInput;const secret=link?(link.key||link.password):secretInput;const rawKey=!!link?.key;
  if(link?.id&&link.id!==id)throw new Error('Этот ключ от другого пакета');
  const {inner,raw}=await openPackage({header:h,headerText:rec.headerText,payload:rec.payload},secret,{rawKey});
  const rv=await revocationCheck(h);if(rv===true){await setPref('revokedIds',[...revoked,id]);await sandboxStore.del(id);throw new Error('Доступ к пакету отозван отправителем');}
  await setPref('lastSeenTime',Math.max(lastSeen,Date.now()));
  if(h.oneTime)await setPref('seenOnce',[...seen,id]);
  if(remember&&!h.oneTime){rec.savedKey=b64u.enc(await sealBytes(await deviceKey('sandbox'),new TextEncoder().encode(rawKey?`mlink:key:${id}:${secret}`:String(secret))));await sandboxStore.put(rec);}
  const zip=await window.JSZip.loadAsync(inner);const manifest=JSON.parse(await zip.file('manifest.json').async('string'));
  const assets=[];for(const m of manifest.files){const blob=await zip.file(m.entry).async('blob');assets.push({id:'sbx:'+id+':'+m.id,projectId:'sbx:'+id,name:m.name,path:m.path,groupId:m.groupId,version:m.version,size:blob.size,mime:m.mime,blob:new Blob([blob],{type:m.mime}),createdAt:m.createdAt,kind:kindFor(m.name),sha256:m.sha256,secure:true});}
  const senderNotes=[];for(const [i,n] of manifest.notes.entries()){const audio=n.audioEntry&&zip.file(n.audioEntry)?new Blob([await zip.file(n.audioEntry).async('blob')],{type:n.audioMime||'audio/mp4'}):null;senderNotes.push({...n,audio,id:'sbxn:'+i,projectId:'sbx:'+id,assetId:'sbx:'+id+':'+n.assetId,version:1,fromSender:true});}
  state.secure={id,header:h,raw,title:manifest.project.name,description:manifest.project.description,assets,notes:[...senderNotes,...(rec.notes||[])],audit:rec.audit?.length?rec.audit:(manifest.audit||[]),policy:manifest.policy||{}};
  await secureAudit({type:'opened'});closeModal();state.tab='secure';state.projectId='sbx:'+id;state.assetId=null;updatePrivacy();await render();
  if(h.oneTime)notify('Одноразовый просмотр: пакет удалится после закрытия');
}
async function secureAudit(event){
  const s=state.secure;if(!s)return;const who=settings.userName||s.header.recipient?.name||'Получатель';
  s.audit=await appendAudit(s.audit,{...event,who,device:await deviceId()});const rec=await sandboxStore.get(s.id);if(rec){rec.audit=s.audit;rec.notes=s.notes.filter(n=>!n.fromSender);await sandboxStore.put(rec);}
}
async function closeSecure({reason='close'}={}){
  const s=state.secure;if(!s)return;
  if(s.header.oneTime){await sandboxStore.del(s.id);}else await secureAudit({type:'closed'});
  state.secure=null;drawingCache.clear();modelCache.clear();if(NativeML)NativeML.wipeTemp().catch(()=>{});updatePrivacy();
  if(s.header.oneTime&&reason!=='panic')notify('Одноразовый пакет стёрт с устройства');
}
function secureView(){
  const s=state.secure;const h=s.header;const exp=h.expiresAt?new Date(h.expiresAt).toLocaleDateString(locale()):null;
  return `<div class="breadcrumbs"><button data-action="close-secure">${icon('chevron','small')} Закрыть пакет</button></div>
  <div class="project-hero secure-hero"><span class="eyebrow">${icon('lock','small')} Защищённый пакет · песочница</span><h1>${esc(s.title)}</h1><p>${esc(h.sender?`От: ${h.sender}`:'Отправитель не указан')}${h.recipient?.name?` · Для: ${esc([h.recipient.name,h.recipient.company].filter(Boolean).join(', '))}`:''}</p>
  <div class="badges" style="margin-top:10px">${h.viewOnly?'<b>только просмотр</b>':'<b class="ok">можно выгружать</b>'}${exp?`<b>до ${exp}</b>`:''}${h.oneTime?'<b class="bad">одноразовый</b>':''}<b>ID ${esc(h.id.slice(0,8))}</b></div>
  <div class="action-bar"><button class="btn primary" data-action="secure-ack">${icon('check','small')} Ознакомлен</button><button class="btn outline" data-action="secure-audit">${icon('history','small')} Журнал</button></div></div>
  ${sectionTitle('Файлы')}<div class="file-list">${s.assets.map(f=>fileRow(f)).join('')}</div>
  <p class="small-muted" style="margin-top:14px">Файлы расшифрованы только в памяти и не попадают в «Мои файлы», поиск и резервные копии. ${h.oneTime?'После закрытия пакет будет стёрт.':''} Три пальца на экране или переворот телефона экраном вниз мгновенно закрывают пакет.</p>`;
}
function auditList(chain){const names={created:'Создан',opened:'Открыт',closed:'Закрыт',acknowledged:'Ознакомлен',screenshot:'Снимок экрана','screen-recording':'Запись экрана',comment:'Замечание',destroyed:'Стёрт'};
  return chain.length?`<div class="group-card" style="margin-top:12px">${chain.map(e=>`<div class="setting-row audit-row"><div><strong>${names[e.type]||esc(e.type)}</strong>${e.rev?` · ревизия ${esc(String(e.rev))}`:''}<br><span>${new Date(e.t).toLocaleString(locale())} · ${esc(e.who||'')}${e.device?` · устройство ${esc(e.device)}`:''}</span></div><code>${esc((e.h||'').slice(0,8))}</code></div>`).join('')}</div>`:'<p class="small-muted">Событий пока нет</p>';}
async function secureAckModal(){const s=state.secure;const h=s.header;
  modal('Подтверждение ознакомления',`<form id="secure-ack"><p class="small-muted" style="margin-bottom:12px">В журнал пакета запишется отметка с временем и именем. Квитанцию, подписанную ключом пакета, отправьте отправителю — он сможет проверить, что она подлинная.</p><label class="field">Имя<input name="name" required maxlength="80" value="${esc(settings.userName||h.recipient?.name||'')}"></label><label class="field">Компания<input name="company" maxlength="80" value="${esc(settings.company||h.recipient?.company||'')}"></label><button class="btn primary block" type="submit">${icon('check','small')} Ознакомлен с ревизией от ${new Date(h.created).toLocaleDateString(locale())}</button></form>`);}
async function sendReceipt(name,company){
  const s=state.secure;const rev=new Date(s.header.created).toLocaleString(locale());
  await secureAudit({type:'acknowledged',who:name,rev});
  const receipt=await makeReceipt(s.raw,{packageId:s.id,revision:rev,files:s.assets.map(a=>({name:a.name,sha256:a.sha256})),name,company,chain:s.audit});
  closeModal();await shareBlob(new Blob([receipt],{type:'application/json'}),`${s.title.replace(/[^\wа-яА-ЯёЁ -]/g,'_').slice(0,36)} — ознакомлен.mlinkack`);
}
function watermarkStyle(){const s=state.secure;if(!s)return '';const h=s.header;const text=[h.recipient?.name,h.recipient?.company].filter(Boolean).join(' · ')||'Конфиденциально';
  const line=`${text} · ${new Date().toLocaleDateString(locale())} · ${h.id.slice(0,8)}`;const svg=`<svg xmlns='http://www.w3.org/2000/svg' width='360' height='170'><text x='0' y='100' transform='rotate(-24 180 85)' font-family='-apple-system,Arial' font-size='14' font-weight='600' fill='rgba(110,120,140,0.34)'>${line.replace(/[<>&'"]/g,'')}</text></svg>`;
  return `background-image:url(&quot;data:image/svg+xml;utf8,${encodeURIComponent(svg)}&quot;)`;}
function viewOnlyBlocked(f){return !!(f?.secure&&state.secure?.header.viewOnly);}

// ---------------------------------------------------------------- emergency wipe
async function emergencyWipe(){
  await closeSecure({reason:'panic'});await sandboxStore.clear();drawingCache.clear();modelCache.clear();releasePreview();
  let removed=0;if(NativeML){try{removed=(await NativeML.wipeTemp()).removed||0;}catch{}}
  try{for(const k of await caches?.keys?.()||[])await caches.delete(k);}catch{}
  closeModal();notify(`Экстренная очистка: защищённые пакеты и временные файлы удалены${removed?` (${removed})`:''}`);await render();
}

// ---------------------------------------------------------------- redaction tool helpers
async function redactImage(f){const c=await rasterize(f.blob);const ctx=c.getContext('2d');ctx.fillStyle='#000';for(const r of f.redactions||[])ctx.fillRect(Math.min(r.x0,r.x1)*c.width,Math.min(r.y0,r.y1)*c.height,Math.abs(r.x1-r.x0)*c.width,Math.abs(r.y1-r.y0)*c.height);return canvasBlob(c,'image/png');}

// ---------------------------------------------------------------- notes report
async function notesReport(){
  const p=await getProject(state.projectId);if(!p)return;const files=await getAssets(p.id),notes=(await getNotes(p.id)).sort((a,b)=>a.createdAt-b.createdAt);
  if(!notes.length){notify('В проекте нет замечаний');return;}
  const byId=new Map(files.map(f=>[f.id,f]));const open=notes.filter(n=>n.status!=='resolved').length;
  const when=t=>new Date(t).toLocaleString(locale(),{day:'numeric',month:'long',year:'numeric',hour:'2-digit',minute:'2-digit'});
  const html=`<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${esc(p.name)} — замечания</title><style>body{font:11pt -apple-system,Helvetica,Arial,sans-serif;color:#172236;margin:0}h1{font-size:20pt;margin:0 0 4pt}.sub{color:#66738a;margin-bottom:16pt}table{width:100%;border-collapse:collapse}th,td{text-align:left;vertical-align:top;padding:6pt 5pt;border-bottom:1px solid #dfe4ec}th{font-size:9pt;color:#66738a;text-transform:uppercase}.st{font-weight:600}.open{color:#b06d1b}.done{color:#138a62}td.n{width:20pt;color:#66738a}</style></head><body><h1>${esc(p.name)}</h1><div class="sub">Отчёт по замечаниям · ${when(Date.now())} · всего ${notes.length}, открыто ${open}${p.description?` · ${esc(p.description)}`:''}</div><table><thead><tr><th>№</th><th>Замечание</th><th>Файл</th><th>Статус</th><th>Дата</th></tr></thead><tbody>${notes.map((n,i)=>{const f=byId.get(n.assetId);return `<tr><td class="n">${i+1}</td><td>${esc(n.text)}</td><td>${esc(f?.name||'—')}<br><span style="color:#66738a">версия ${n.version}</span></td><td class="st ${n.status==='resolved'?'done':'open'}">${n.status==='resolved'?'Выполнено':'Открыто'}</td><td>${when(n.createdAt)}</td></tr>`;}).join('')}</tbody></table></body></html>`;
  const base=`${p.name.replace(/[^\wа-яА-ЯёЁ -]/g,'_').slice(0,40)||'ModelLink'} — замечания`;
  const blob=new Blob([html],{type:'text/html'});
  if(NativeML){notify('Готовим PDF…');const r=await withNativeExport(blob,`${base}.html`,id=>NativeML.convertExport({exportId:id,to:'pdf'}));const ids=(r.files||[]).map(x=>x.id);try{await NativeML.shareStaged({ids});}finally{for(const id of ids)await NativeML.deleteStaged({id}).catch(()=>{});}return;}
  downloadBlob(blob,`${base}.html`);notify('Отчёт сохранён (HTML, откройте и распечатайте в PDF)');
}

// ---------------------------------------------------------------- conversion
const MODEL_EXTS=new Set(['glb','gltf','fbx','obj','stl','3ds','dae','ply','3mf','max']);
const MIME={dxf:'image/vnd.dxf',svg:'image/svg+xml',png:'image/png',jpeg:'image/jpeg',pdf:'application/pdf',stl:'model/stl',obj:'model/obj',ply:'application/octet-stream',glb:'model/gltf-binary',usdz:'model/vnd.usdz+zip',zip:'application/zip'};
const EXT={jpeg:'jpg'};
const outName=(f,to)=>`${baseName(f.name)}.${EXT[to]||to}`;
const toFile=(f,to,data)=>new File([data],outName(f,to),{type:MIME[to]||'application/octet-stream'});
function canvasBlob(canvas,type,quality){return new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('Не удалось создать изображение')),type,quality));}
function loadImage(blob){return new Promise((resolve,reject)=>{const url=URL.createObjectURL(blob);const img=new Image();img.onload=()=>resolve({img,release:()=>URL.revokeObjectURL(url)});img.onerror=()=>{URL.revokeObjectURL(url);reject(new Error('Браузер не может прочитать это изображение'));};img.src=url;});}
/** Draws an image on a canvas, limited to ~16 Mpx (iOS canvas limit) and 4096 px per side. */
async function rasterize(blob,{maxSide=4096,minSide=0}={}){
  const {img,release}=await loadImage(blob);try{
    let w=img.naturalWidth||img.width||1024,h=img.naturalHeight||img.height||1024;
    const up=minSide&&Math.max(w,h)<minSide?minSide/Math.max(w,h):1;w*=up;h*=up;
    const k=Math.min(1,maxSide/Math.max(w,h),Math.sqrt(16e6/(w*h)));w=Math.max(1,Math.round(w*k));h=Math.max(1,Math.round(h*k));
    const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,w,h);ctx.drawImage(img,0,0,w,h);return canvas;
  }finally{release();}
}
async function canvasTo(canvas,to,f){
  if(to==='png')return toFile(f,to,await canvasBlob(canvas,'image/png'));
  const jpeg=await canvasBlob(canvas,'image/jpeg',.92);if(to==='jpeg')return toFile(f,to,jpeg);
  if(to==='pdf')return toFile(f,to,jpegToPDF(new Uint8Array(await jpeg.arrayBuffer()),canvas.width,canvas.height));
  throw new Error('Неизвестный формат');
}
async function parseMesh(f){const ext=extOf(f.name);
  if(ext==='obj')return parseOBJ(await f.blob.text());if(ext==='stl')return parseSTL(await f.blob.arrayBuffer());if(ext==='glb')return parseGLB(await f.blob.arrayBuffer());
  throw new Error('Это не 3D-модель');}
/** Returns {files:[File]} (made here) or {staged:[native items]} (made by the iOS converter). */
async function runConversion(f,to,engine){
  if(engine==='zip'){if(!window.JSZip)throw new Error('Не удалось загрузить ZIP-модуль');const zip=new window.JSZip();zip.file(f.name,f.blob);return {files:[toFile(f,'zip',await zip.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:6}}))]};}
  if(engine==='native'){const r=await withNativeExport(f.blob,f.name,id=>NativeML.convertExport({exportId:id,to}));return {staged:r.files||[]};}
  const ext=extOf(f.name);
  if(ext==='dxf'||ext==='dwg'){
    if(to==='dxf'){if(f.redactions?.length)return {files:[toFile(f,'dxf',drawingToDXF(redactDrawing(await loadDrawing(f),f.redactions)))]};const {bytes}=await cadRun('dxf',f);return {files:[toFile(f,'dxf',bytes)]};}
    const svg=dxfToSVG(redactDrawing(await loadDrawing(f),f.redactions),{hiddenLayers:hiddenLayers.get(f.id)||null});if(to==='svg')return {files:[toFile(f,'svg',svg)]};
    return {files:[await canvasTo(await rasterize(new Blob([svg],{type:'image/svg+xml'}),{maxSide:3600,minSide:2400}),to,f)]};}
  if(MODEL_EXTS.has(ext)){
    if(to==='png'){if(state.assetId!==f.id||!state.viewer?.snapshot)throw new Error('Откройте модель, чтобы сохранить снимок');return {files:[toFile(f,'png',await state.viewer.snapshot())]};}
    if(to==='thumb'){const m=await loadModelCached(f);if(!m.info?.thumbnail)throw new Error('В файле нет миниатюры');const c=await rasterize(new Blob([m.info.thumbnail],{type:'image/bmp'}));return {files:[toFile(f,'png',await canvasBlob(c,'image/png'))]};}
    const {objectToMesh}=await import('./core/model3d.js');const m=await loadModelCached(f);let mesh=objectToMesh(m.root);
    if(to==='stl'||to==='ply')mesh={vertices:mesh.vertices.map(([x,y,z])=>[x,-z,y]),faces:mesh.faces}; // printers expect Z-up
    const data={stl:()=>meshToSTL(mesh),obj:()=>meshToOBJ(mesh,baseName(f.name)),ply:()=>meshToPLY(mesh),glb:()=>meshToGLB(mesh),usdz:()=>meshToUSDZ(mesh,{upAxis:'Y'})}[to];
    if(!data)throw new Error('Неизвестный формат');return {files:[toFile(f,to,data())]};}
  if(f.kind==='image'){const src=f.redactions?.length?await redactImage(f):f.blob;return {files:[await canvasTo(await rasterize(src,{minSide:ext==='svg'?2000:0}),to,f)]};}
  throw new Error('Такое преобразование недоступно');
}
async function convertAction(button){
  const f=await assetById(state.assetId);if(!f)throw new Error('Сначала откройте файл');
  const {to,engine,mode}=button.dataset;
  const buttons=[...document.querySelectorAll('#modal [data-action="convert"]')];buttons.forEach(b=>b.disabled=true);notify('Преобразуем…');
  let result;try{result=await runConversion(f,to,engine);}finally{buttons.forEach(b=>b.disabled=false);}
  const staged=result.staged||[];
  try{
    if(mode==='share'){
      if(staged.length){await NativeML.shareStaged({ids:staged.map(x=>x.id)});return;}
      const files=result.files;if(files.length===1){await shareBlob(files[0],files[0].name);return;}
      const zip=new window.JSZip();files.forEach(x=>zip.file(x.name,x));await shareBlob(await zip.generateAsync({type:'blob'}),`${baseName(f.name)}.zip`);return;
    }
    const files=result.files||[];for(const item of staged)files.push(await nativeStagedToFile(NativeML,item));
    if(!files.length)throw new Error('Нет результата');
    let first;for(const x of files){const a=await addAsset(f.projectId,x);first=first||a;}
    closeModal();notify(files.length===1?`Добавлено: ${files[0].name}`:`Добавлено файлов: ${files.length}`);await openAsset(first.id);
  }finally{for(const item of staged)await NativeML.deleteStaged({id:item.id}).catch(()=>{});}
}

const viewerRuntime={};
async function activateViewer(f){if(!f)return;const info=fileInfo(f.name),host=document.getElementById('preview-body'),wrap=document.getElementById('canvas-wrap');if(!host)return;
  if(f.kind==='image'){
    previewUrl=URL.createObjectURL(f.blob);
    host.innerHTML=`<div class="zoom-stage"><div class="zoom-layer"><img class="preview-image" src="${previewUrl}" alt="${esc(f.name)}" draggable="false"></div></div>`;
    const stage=host.querySelector('.zoom-stage'),layer=host.querySelector('.zoom-layer'),image=host.querySelector('img');
    const t={s:1,x:0,y:0};let box=null;
    const apply=()=>{layer.style.transform=`translate(${t.x}px,${t.y}px) scale(${t.s})`;layer.style.setProperty('--inv',String(1/t.s));};
    const clamp=()=>{const r=stage.getBoundingClientRect();if(t.s<=1){t.s=Math.max(1,t.s);t.x=0;t.y=0;return;}t.x=Math.min(0,Math.max(r.width-r.width*t.s,t.x));t.y=Math.min(0,Math.max(r.height-r.height*t.s,t.y));};
    const zoomAt=(k,sx,sy)=>{const ns=Math.max(1,Math.min(12,t.s*k));t.x=sx-(sx-t.x)*ns/t.s;t.y=sy-(sy-t.y)*ns/t.s;t.s=ns;clamp();apply();};
    const local=e=>{const r=stage.getBoundingClientRect();return [e.clientX-r.left,e.clientY-r.top];};
    const toImage=(sx,sy)=>{const lx=(sx-t.x)/t.s,ly=(sy-t.y)/t.s;return {x:(lx-box.left)/box.width,y:(ly-box.top)/box.height};};
    const addPin=(cls,p,text)=>{const el=document.createElement(cls==='measure-dot'?'span':'button');el.className=cls;if(text)el.textContent=text;el.style.left=`${box.left+box.width*p.x}px`;el.style.top=`${box.top+box.height*p.y}px`;layer.append(el);return el;};
    image.addEventListener('error',()=>{host.innerHTML=`<div class="file-unsupported">${icon('image','large')}<h3>${esc(f.name)}</h3><p>Это изображение нельзя показать здесь.</p><div class="row" style="justify-content:center">${canQuickLook()?`<button class="btn primary" data-action="quicklook">${icon('eye','small')} Открыть</button>`:''}<button class="btn outline" data-action="export-file">${icon('export','small')} Экспорт</button></div></div>`;});
    image.addEventListener('load',()=>{
      const r=layer.getBoundingClientRect(),ratio=Math.min(r.width/image.naturalWidth,r.height/image.naturalHeight);
      const nw=image.naturalWidth*ratio,nh=image.naturalHeight*ratio;box={left:(r.width-nw)/2,top:(r.height-nh)/2,width:nw,height:nh};
      state.notes.filter(n=>n.assetId===f.id).forEach((n,i)=>{const pin=addPin('image-annotation',n.point||{x:.5,y:.5},String(i+1));pin.title=n.text;pin.setAttribute('aria-label',`Замечание ${i+1}: ${n.text}`);});
      const hint=document.getElementById('canvas-hint');if(hint)hint.textContent='Масштаб — 2 пальца или двойной тап';hideHintSoon();
    });
    const touches=new Map();let pinch=null,drag=null,lastTap=0;
    const drawRedactions=()=>{if(!box)return;layer.querySelectorAll('.redact-box').forEach(x=>x.remove());for(const r of [...(f.redactions||[]),...(rdraft?[rdraft]:[])]){const el=document.createElement('div');el.className='redact-box'+(r===rdraft?' draft':'');el.style.left=`${box.left+box.width*Math.min(r.x0,r.x1)}px`;el.style.top=`${box.top+box.height*Math.min(r.y0,r.y1)}px`;el.style.width=`${box.width*Math.abs(r.x1-r.x0)}px`;el.style.height=`${box.height*Math.abs(r.y1-r.y0)}px`;layer.append(el);}};
    let rdraft=null;image.addEventListener('load',()=>setTimeout(drawRedactions,0));
    stage.addEventListener('pointerdown',e=>{if(e.target.closest('.image-annotation'))return;stage.setPointerCapture(e.pointerId);touches.set(e.pointerId,local(e));
      if(state.viewerTool==='redact'&&touches.size===1&&box){const p=toImage(...local(e));rdraft={x0:p.x,y0:p.y,x1:p.x,y1:p.y};return;}
      if(touches.size===2){const [a,c]=[...touches.values()];pinch={d:Math.max(1,Math.hypot(a[0]-c[0],a[1]-c[1])),s:t.s,m:[(a[0]+c[0])/2,(a[1]+c[1])/2],x:t.x,y:t.y};drag=null;return;}
      drag={start:local(e),last:local(e),moved:false};});
    stage.addEventListener('pointermove',e=>{if(!touches.has(e.pointerId))return;touches.set(e.pointerId,local(e));
      if(rdraft){const p=toImage(...local(e));rdraft.x1=Math.max(0,Math.min(1,p.x));rdraft.y1=Math.max(0,Math.min(1,p.y));drawRedactions();return;}
      if(pinch&&touches.size>=2){const [a,c]=[...touches.values()];const m=[(a[0]+c[0])/2,(a[1]+c[1])/2];const ns=Math.max(1,Math.min(12,pinch.s*Math.hypot(a[0]-c[0],a[1]-c[1])/pinch.d));
        t.x=m[0]-(pinch.m[0]-pinch.x)*ns/pinch.s;t.y=m[1]-(pinch.m[1]-pinch.y)*ns/pinch.s;t.s=ns;clamp();apply();return;}
      if(!drag)return;const p=local(e);if(!drag.moved&&Math.hypot(p[0]-drag.start[0],p[1]-drag.start[1])>8)drag.moved=true;
      if(drag.moved&&t.s>1){t.x+=p[0]-drag.last[0];t.y+=p[1]-drag.last[1];clamp();apply();}drag.last=p;});
    const end=e=>{touches.delete(e.pointerId);if(rdraft){const r=rdraft;rdraft=null;if(Math.abs(r.x1-r.x0)>0.01&&Math.abs(r.y1-r.y0)>0.01&&e.type!=='pointercancel'){f.redactions=[...(f.redactions||[]),r];updateAssetMeta(f.id,{redactions:f.redactions}).then(()=>notify('Область скрыта: при экспорте и защищённой отправке её содержимое будет удалено')).catch(err=>notify(err.message));}drawRedactions();return;}if(pinch){if(touches.size<2)pinch=null;drag=null;return;}const d=drag;drag=null;if(!d||d.moved||!box||e.type==='pointercancel')return;
      const [sx,sy]=local(e);const p=toImage(sx,sy);const inside=p.x>=0&&p.x<=1&&p.y>=0&&p.y<=1;
      if(state.viewerTool==='comment'){if(inside)newNoteModal(p);return;}
      if(state.viewerTool==='measure'){if(!inside)return;state.measurePoints=state.measurePoints||[];if(state.measurePoints.length>=2){state.measurePoints=[];layer.querySelectorAll('.measure-dot').forEach(x=>x.remove());}
        state.measurePoints.push(p);addPin('measure-dot',p);haptic();
        if(state.measurePoints.length===2){const [a,c]=state.measurePoints;measureResultModal(Math.hypot((a.x-c.x)*image.naturalWidth,(a.y-c.y)*image.naturalHeight),f.mmPerPixel);}return;}
      const now=Date.now();if(now-lastTap<320){if(t.s>1.05){t.s=1;clamp();apply();}else zoomAt(2.5,sx,sy);lastTap=0;}else lastTap=now;};
    stage.addEventListener('pointerup',end);stage.addEventListener('pointercancel',end);
    stage.addEventListener('wheel',e=>{e.preventDefault();const [sx,sy]=local(e);zoomAt(e.deltaY>0?.88:1.14,sx,sy);},{passive:false});
    state.measurePoints=[];
    state.viewer={measure:true,setTool(tool){if(tool!=='measure'){state.measurePoints=[];layer.querySelectorAll('.measure-dot').forEach(x=>x.remove());}},
      fit(){t.s=1;t.x=0;t.y=0;apply();},zoom(k){const r=stage.getBoundingClientRect();zoomAt(k,r.width/2,r.height/2);}};
    return;
  }
  if(f.kind==='ar'||(f.kind==='pdf'&&NativeML)){
    host.innerHTML=`<div class="file-unsupported">${icon(f.kind==='pdf'?'file':'cube','large')}<h3>${esc(f.name)}</h3><p>${f.kind==='pdf'?'Все страницы, поиск по тексту и масштабирование в системном просмотрщике.':'Объёмная модель и режим дополненной реальности в системном просмотрщике.'}</p>${canQuickLook(f.name)?`<button class="btn primary" data-action="quicklook">${icon('eye','small')} Открыть ${f.kind==='pdf'?'PDF':'модель'}</button>`:''}</div>`;
    document.getElementById('canvas-hint').textContent=f.kind==='pdf'?'Замечания добавляются кнопкой «Добавить»':'Quick Look доступен на iPhone';
    state.viewer={measure:false,setTool(){},fit(){}};return;
  }
  if(f.kind==='audio'){
    previewUrl=URL.createObjectURL(f.blob);
    host.innerHTML=`<div class="audio-card">${icon('comment','large')}<h3>${esc(f.name)}</h3><audio controls preload="metadata" src="${previewUrl}"></audio><p class="small-muted">${formatBytes(f.size)} · звук воспроизводится на устройстве</p></div>`;
    const hint=document.getElementById('canvas-hint');if(hint)hint.textContent='Аудиофайл';state.viewer={measure:false,setTool(){},fit(){}};return;
  }
  if(f.kind==='text'){
    const limit=1024*1024,text=await f.blob.slice(0,limit).text();
    host.innerHTML=`<pre class="text-preview" tabindex="0" aria-label="Содержимое файла"></pre>`;host.querySelector('pre').textContent=text+(f.size>limit?'\n\n… показан первый 1 МБ файла':'');
    document.getElementById('canvas-hint').textContent=`${text.split('\n').length} строк`;state.viewer={measure:false,setTool(){},fit(){}};return;
  }
  if(f.kind==='pdf'){
    previewUrl=URL.createObjectURL(f.blob);
    host.innerHTML=`<iframe class="preview-pdf" src="${previewUrl}" title="PDF: ${esc(f.name)}" sandbox="allow-same-origin" referrerpolicy="no-referrer"></iframe>`;
    document.getElementById('canvas-hint').textContent='PDF: замечания добавляются кнопкой сверху';
    state.viewer={measure:false,setTool(){},fit(){}};
    return;
  }
  if(f.kind==='drawing'){await activateCadViewer(f,host,wrap);return;}
  if(f.kind==='model'){const handled=await activateModelViewer(f,host,wrap);if(handled)return;}
  if(f.kind==='drawing'||f.kind==='model'){
    try{
      let drawing,mesh;
      if(f.kind==='drawing')drawing=parseDXF(await f.blob.text());
      else if(f.name.toLowerCase().endsWith('.obj'))mesh=parseOBJ(await f.blob.text());
      else if(f.name.toLowerCase().endsWith('.stl'))mesh=parseSTL(await f.blob.arrayBuffer());
      else if(f.name.toLowerCase().endsWith('.glb'))mesh=parseGLB(await f.blob.arrayBuffer());
      if(!drawing&&!mesh)throw new Error('Формат модели не поддерживается');
      host.innerHTML='<canvas id="scene" aria-label="Просмотр геометрии"></canvas>';
      const canvas=document.getElementById('scene');let width=0,height=0;
      const resize=()=>{const dpr=Math.min(2,devicePixelRatio||1);width=wrap.clientWidth;height=wrap.clientHeight;canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);canvas.getContext('2d').setTransform(dpr,0,0,dpr,0,0);draw();};
      const params={yaw:.5,pitch:.34,zoom:1,panX:0,panY:0,measurePoints:[]};const b=mesh?meshBounds(mesh):drawing.bounds;
      const getCoordinates=e=>{const rect=canvas.getBoundingClientRect();return{x:e.clientX-rect.left,y:e.clientY-rect.top};};
      let currentScale=1,offX=0,offY=0;
      const draw=()=>{
        const ctx=canvas.getContext('2d');ctx.clearRect(0,0,width,height);ctx.fillStyle='#f8faff';ctx.fillRect(0,0,width,height);
        if(drawing){
          const spanX=Math.max(1,b.maxX-b.minX),spanY=Math.max(1,b.maxY-b.minY);
          currentScale=Math.min((width-70)/spanX,(height-70)/spanY)*params.zoom;
          offX=(width-spanX*currentScale)/2+params.panX;offY=(height-spanY*currentScale)/2+params.panY;
          const project=p=>[offX+(p[0]-b.minX)*currentScale,height-offY-(p[1]-b.minY)*currentScale];
          ctx.strokeStyle='#344969';ctx.lineWidth=1.2;ctx.fillStyle='#3f536f';
          for(const ent of drawing.entities){
            ctx.beginPath();
            if(ent.type==='line'){const a=project(ent.a),c=project(ent.b);ctx.moveTo(...a);ctx.lineTo(...c);ctx.stroke();}
            if(ent.type==='point'){const p=project(ent.p);ctx.arc(p[0],p[1],3,0,Math.PI*2);ctx.fill();}
            if(ent.type==='circle'||ent.type==='arc'){
              const p=project(ent.c);const r=ent.r*currentScale;
              if(ent.type==='circle')ctx.arc(p[0],p[1],r,0,Math.PI*2);
              else {const s=-ent.end*Math.PI/180,e=-ent.start*Math.PI/180;ctx.arc(p[0],p[1],r,s,e);}
              ctx.stroke();
            }
            if(ent.type==='polyline'){ent.points.forEach((p,i)=>{const a=project(p);if(i===0)ctx.moveTo(...a);else ctx.lineTo(...a);});if(ent.closed)ctx.closePath();ctx.stroke();}
            if(ent.type==='text'){const p=project(ent.p);ctx.font=`${Math.max(8,Math.min(28,ent.height*currentScale))}px system-ui`;ctx.fillText(ent.text,p[0],p[1]);}
          }
          if(params.measurePoints.length){ctx.strokeStyle='#2764fa';ctx.fillStyle='#2764fa';ctx.lineWidth=2;params.measurePoints.forEach(p=>{ctx.beginPath();ctx.arc(p.x,p.y,4,0,Math.PI*2);ctx.fill();});if(params.measurePoints.length===2){ctx.beginPath();ctx.moveTo(params.measurePoints[0].x,params.measurePoints[0].y);ctx.lineTo(params.measurePoints[1].x,params.measurePoints[1].y);ctx.stroke();}}
          const pinned=state.notes.filter(n=>n.assetId===f.id);
          pinned.forEach((n,i)=>{const p=n.locationType==='world'?project([n.point.x,n.point.y]):[n.point.x*width,n.point.y*height];drawPin(ctx,p[0],p[1],i+1);});
        }
        if(mesh){
          const center=b.center,span=b.span;const cosY=Math.cos(params.yaw),sinY=Math.sin(params.yaw),cosP=Math.cos(params.pitch),sinP=Math.sin(params.pitch);
          const maxWidth=Math.min(width,height)*.82*params.zoom;
          const verts=mesh.vertices.map(v=>{
            const x=(v[0]-center[0])/span,y=(v[1]-center[1])/span,z=(v[2]-center[2])/span;
            const xx=x*cosY+z*sinY,zz=z*cosY-x*sinY;
            const yy=y*cosP-zz*sinP,depth=y*sinP+zz*cosP;
            return [width/2+xx*maxWidth,height/2-yy*maxWidth,depth];
          });
          const triangles=[];const step=Math.max(1,Math.ceil(mesh.faces.length/13000));
          for(let i=0;i<mesh.faces.length;i+=step){const face=mesh.faces[i],a=verts[face[0]],c=verts[face[1]],d=verts[face[2]];if(!a||!c||!d)continue;
            const ux=c[0]-a[0],uy=c[1]-a[1],vx=d[0]-a[0],vy=d[1]-a[1];
            const shade=Math.max(.25,Math.min(1,Math.abs((ux*vy-uy*vx)/(maxWidth*maxWidth))*.75+ .45));
            triangles.push({a,c,d,depth:(a[2]+c[2]+d[2])/3,shade});
          }
          triangles.sort((a,b)=>a.depth-b.depth);
          for(const t of triangles){ctx.beginPath();ctx.moveTo(t.a[0],t.a[1]);ctx.lineTo(t.c[0],t.c[1]);ctx.lineTo(t.d[0],t.d[1]);ctx.closePath();const v=Math.floor(194+t.shade*35);ctx.fillStyle=`rgb(${Math.floor(v*.85)},${Math.floor(v*.93)},${Math.min(255,v+4)})`;ctx.fill();ctx.strokeStyle='rgba(67,100,157,.26)';ctx.lineWidth=.6;ctx.stroke();}
          state.notes.filter(n=>n.assetId===f.id).forEach((n,i)=>drawPin(ctx,n.point.x*width,n.point.y*height,i+1));
        }
      };
      const onResize=typeof ResizeObserver==='function'?new ResizeObserver(resize):null;onResize?.observe(wrap);
      let dragStart,last,lastTime;const touches=new Map();let pinch=null;
      const spread=()=>{const [a,c]=[...touches.values()];return Math.max(1,Math.hypot(a.x-c.x,a.y-c.y));};
      canvas.addEventListener('pointerdown',e=>{touches.set(e.pointerId,getCoordinates(e));canvas.setPointerCapture(e.pointerId);
        if(touches.size===2){pinch={distance:spread(),zoom:params.zoom};dragStart=null;last=null;return;}
        if(touches.size>2)return;dragStart=getCoordinates(e);last=dragStart;lastTime=Date.now();});
      const release=e=>{touches.delete(e.pointerId);if(pinch&&touches.size<2){pinch=null;dragStart=null;last=null;}};
      canvas.addEventListener('pointercancel',release);
      canvas.addEventListener('pointermove',e=>{if(touches.has(e.pointerId))touches.set(e.pointerId,getCoordinates(e));
        if(pinch&&touches.size===2){params.zoom=Math.max(.1,Math.min(40,pinch.zoom*spread()/pinch.distance));draw();return;}
        if(!last||state.viewerTool!=='view')return;const p=getCoordinates(e),dx=p.x-last.x,dy=p.y-last.y;
        if(mesh){params.yaw+=dx*.012;params.pitch=Math.max(-1.5,Math.min(1.5,params.pitch+dy*.012));}
        else{params.panX+=dx;params.panY-=dy;}last=p;draw();});
      canvas.addEventListener('pointerup',e=>{const wasPinch=!!pinch;release(e);
        if(wasPinch||!dragStart)return;const p=getCoordinates(e);const moved=Math.hypot(p.x-dragStart.x,p.y-dragStart.y);dragStart=null;last=null;
        if(moved>9)return;
        if(state.viewerTool==='comment'){
          if(drawing){const world={x:(p.x-offX)/currentScale+b.minX,y:(height-p.y-offY)/currentScale+b.minY};newNoteModal(world);state.pendingLocationType='world';}
          else{newNoteModal({x:p.x/width,y:p.y/height});state.pendingLocationType='normalized';}
        }
        if(state.viewerTool==='measure'){
          if(!drawing){notify('Для точных измерений откройте DXF');return;}
          params.measurePoints.push(p);
          if(params.measurePoints.length===2){const [a,c]=params.measurePoints;const len=Math.hypot(a.x-c.x,a.y-c.y)/currentScale;notify(`Расстояние: ${len.toFixed(2)} ед. чертежа. Единицы проверьте в исходнике.`);}
          if(params.measurePoints.length>2)params.measurePoints=[p];draw();
        }
      });
      canvas.addEventListener('wheel',e=>{e.preventDefault();params.zoom=Math.max(.1,Math.min(40,params.zoom*(e.deltaY>0?.9:1.1)));draw();},{passive:false});
      state.viewer={measure:!!drawing,zoom(k){params.zoom=Math.max(.1,Math.min(40,params.zoom*k));draw();},setTool(tool){if(tool!=='measure')params.measurePoints=[];draw();},fit(){params.yaw=.5;params.pitch=.34;params.zoom=1;params.panX=0;params.panY=0;params.measurePoints=[];draw();},cleanup(){onResize?.disconnect();}};
      resize();return;
    }catch(e){host.innerHTML=`<div class="file-unsupported">${icon('warning','large')}<h3>Не удалось показать геометрию</h3><p>${esc(e.message)}</p><button class="btn outline" data-action="download-file">${icon('download','small')} Скачать оригинал</button></div>`;document.getElementById('canvas-hint').textContent='Исходный файл сохранён';return;}
  }
  host.innerHTML=`<div class="file-unsupported">${icon('file','large')}<h3>${esc(f.name)}</h3><p>${esc(info.note)}. Файл сохранён без изменений, его можно скачать или отправить.</p><div class="row" style="justify-content:center;flex-wrap:wrap">${canQuickLook()?`<button class="btn primary" data-action="quicklook">${icon('eye','small')} Открыть</button>`:''}<button class="btn ${canQuickLook()?'outline':'primary'}" data-action="export-file">${icon('export','small')} Экспорт</button><button class="btn outline" data-action="share-file">${icon('share','small')} Отправить</button></div></div>`;
  document.getElementById('canvas-hint').textContent='Исходник доступен для передачи';state.viewer={measure:false,setTool(){},fit(){}};
}
// ---------------------------------------------------------------- 3D viewer (three.js)
const modelCache=new Map();
async function loadModelCached(f){if(modelCache.has(f.id))return modelCache.get(f.id);const {loadModel}=await import('./core/model3d.js');const m=await loadModel(f.blob,f.name);if(modelCache.size>1)modelCache.delete(modelCache.keys().next().value);modelCache.set(f.id,m);return m;}
let wireframe=false;
async function activateModelViewer(f,host,wrap){
  const ext=extOf(f.name),hint=document.getElementById('canvas-hint');
  host.innerHTML=`<div class="file-unsupported"><span class="spinner" aria-hidden="true"></span><h3>Открываем модель…</h3><p>${f.size>8e6?'Большая модель — это может занять время':'Загружаем геометрию и материалы'}</p></div>`;
  let model;
  try{model=await loadModelCached(f);}
  catch(e){
    if(state.assetId!==f.id)return true;
    if(['stl','obj','glb'].includes(ext)&&/import|module|WebGL/i.test(e.message))return false; // fall back to the canvas viewer
    host.innerHTML=`<div class="file-unsupported">${icon('warning','large')}<h3>Не удалось открыть модель</h3><p>${esc(e.message)}</p><div class="row" style="justify-content:center;flex-wrap:wrap">${canQuickLook()?`<button class="btn outline" data-action="quicklook">${icon('eye','small')} Quick Look</button>`:''}<button class="btn outline" data-action="share-file">${icon('share','small')} Отправить оригинал</button></div></div>`;
    state.viewer={measure:false,setTool(){},fit(){}};return true;
  }
  if(state.assetId!==f.id||!host.isConnected)return true;
  const info=model.info||{};
  if(!info.meshes){ // .max without readable geometry: thumbnail + properties
    const url=info.thumbnail?URL.createObjectURL(new Blob([info.thumbnail],{type:'image/bmp'})):null;if(url)previewUrl=url;
    host.innerHTML=`<div class="max-card">${url?`<img src="${url}" alt="Миниатюра сцены">`:icon('cube','large')}<p>${esc(info.error||'Геометрия этой сцены хранится в объектах, которые приложение пока не вычисляет (модификаторы, сплайны, прокси).')}</p><div class="row" style="justify-content:center;flex-wrap:wrap"><button class="btn outline" data-action="max-props">${icon('info','small')} Свойства сцены</button><button class="btn outline" data-action="export-file">${icon('export','small')} Экспорт</button></div></div>`;
    if(hint)hint.textContent='Миниатюра, сохранённая 3ds Max';state.viewer={measure:false,setTool(){},fit(){},maxInfo:info};return true;
  }
  host.innerHTML='<canvas id="scene3d" aria-label="3D-модель"></canvas><div class="model-overlay" id="model-overlay"></div><div class="cad-info" id="cad-info"></div>';
  const canvas=host.querySelector('canvas'),overlay=host.querySelector('#model-overlay'),badge=host.querySelector('#cad-info');
  let viewer;
  try{const {createViewer}=await import('./core/model3d.js');
    viewer=await createViewer(model,{canvas,overlay,dark:cadDark,notes:state.notes.filter(n=>n.assetId===f.id),
      onTap(kind,data){if(kind==='comment'){newNoteModal(data);state.pendingLocationType='model3d';}else if(kind==='measured'){notify(`Расстояние: ${fmtNum(data)} ед. модели`);haptic();}else if(kind==='miss'&&state.viewerTool!=='view')notify('Коснитесь поверхности модели');}});}
  catch(e){if(['stl','obj','glb'].includes(ext))return false;throw e;}
  if(wireframe)viewer.setWireframe(true);
  badge.textContent=`${ext.toUpperCase()} · ${plural(info.triangles,'triangle')}${info.objects?` · объектов: ${info.objects}`:''}${info.skipped?.length?` · пропущено: ${info.skipped.length} типов`:''}`;setTimeout(()=>badge.classList.add('faded'),3500);
  if(info.warning)notify(info.warning);
  if(hint)hint.textContent='1 палец — вращение · 2 — масштаб и сдвиг';hideHintSoon();
  state.viewer={measure:true,model:true,maxInfo:ext==='max'?info:null,fit:()=>viewer.fit(),zoom:k=>viewer.zoom(k),setTool:t=>viewer.setTool(t),redraw:()=>{viewer.setBackground();},
    wireframe:on=>viewer.setWireframe(on),snapshot:()=>viewer.snapshot(),root:model.root,cleanup:()=>viewer.dispose()};
  viewer.setTool(state.viewerTool);return true;
}
function maxPropsModal(){const inf=state.viewer?.maxInfo;if(!inf){notify('Свойства доступны для файлов 3ds Max');return;}
  const secs=(inf.sections||[]).filter(s=>s.items.length);
  modal('Свойства сцены 3ds Max',`${inf.skipped?.length?`<p class="notice warn" style="margin-bottom:12px">Не показаны объекты: ${esc(inf.skipped.join(', '))}. Для полной геометрии экспортируйте сцену из 3ds Max в FBX или OBJ.</p>`:''}${secs.map(s=>`<div class="group-card" style="margin-bottom:12px"><div style="font-size:14px;font-weight:750;margin:12px 0 6px">${esc(s.name)}</div>${s.items.slice(0,80).map(i=>`<div class="prop-item">${esc(i)}</div>`).join('')}${s.items.length>80?`<div class="prop-item">… ещё ${s.items.length-80}</div>`:''}</div>`).join('')||'<p class="small-muted">Свойства не найдены</p>'}`);}

// ---------------------------------------------------------------- DWG / DXF viewer
const drawingCache=new Map();let cadWorker=null,cadSeq=0;const cadPending=new Map();
function cadWorkerCall(msg){
  if(!cadWorker){try{
    cadWorker=new Worker(new URL('./core/cad-worker.js',import.meta.url),{type:'module'});
    cadWorker.onmessage=e=>{const p=cadPending.get(e.data.id);if(!p)return;cadPending.delete(e.data.id);e.data.ok?p.resolve(e.data.result):p.reject(new Error(e.data.error));};
    cadWorker.onerror=()=>{for(const p of cadPending.values())p.reject(Object.assign(new Error('worker'),{worker:true}));cadPending.clear();cadWorker?.terminate();cadWorker=null;};
  }catch{return null;}}
  return new Promise((resolve,reject)=>{const id=++cadSeq;cadPending.set(id,{resolve,reject});cadWorker.postMessage({...msg,id});});
}
async function cadRun(op,f){
  const bytes=await f.blob.arrayBuffer();
  try{const r=cadWorkerCall({op,bytes,name:f.name});if(r)return await r;}catch(e){if(!e.worker)throw e;}
  const [lib,cad]=await Promise.all([import('./vendor/acad-ts.min.js'),import('./core/cad.js')]);
  return cad.cadOp(lib,op,new Uint8Array(bytes),f.name);
}
async function loadDrawing(f){
  if(drawingCache.has(f.id))return drawingCache.get(f.id);
  const {drawing}=await cadRun('drawing',f);
  if(drawingCache.size>4)drawingCache.delete(drawingCache.keys().next().value);
  drawingCache.set(f.id,drawing);return drawing;
}
const viewStates=new Map(),hiddenLayers=new Map();
// On the dark background, colours that are too dark to see (true black, ACI 250…) are lifted towards light grey, keeping the hue.
const toneDark=c=>{if(!c)return c;const n=parseInt(c.slice(1),16),r=n>>16&255,g=n>>8&255,b=n&255,l=(.299*r+.587*g+.114*b)/255,hi=Math.max(r,g,b),chroma=hi-Math.min(r,g,b)>90;if(hi<40)return null;const min=chroma?.16:.42;if(l>=min)return c;const k=(min-l)/(1-l)+.1;return '#'+[r,g,b].map(v=>Math.round(v+(255-v)*k).toString(16).padStart(2,'0')).join('');};
const toneLight=c=>{if(!c)return c;const n=parseInt(c.slice(1),16),r=n>>16&255,g=n>>8&255,b=n&255,l=(.299*r+.587*g+.114*b)/255;if(l<.55)return c;const k=.55/l*.8;return '#'+[r,g,b].map(v=>Math.round(v*k).toString(16).padStart(2,'0')).join('');};
function cadDark(){try{return localStorage.getItem('modellink-cad-bg')!=='light';}catch{return true;}}
async function activateCadViewer(f,host,wrap){
  host.innerHTML=`<div class="file-unsupported"><span class="spinner" aria-hidden="true"></span><h3>Открываем чертёж…</h3><p>${f.size>4e6?'Большой файл — это может занять до минуты':'Читаем геометрию, слои и блоки'}</p></div>`;
  const hint=document.getElementById('canvas-hint');
  let drawing;
  try{drawing=await loadDrawing(f);}
  catch(e){
    if(state.assetId!==f.id)return;
    host.innerHTML=`<div class="file-unsupported">${icon('warning','large')}<h3>Не удалось открыть чертёж</h3><p>${esc(e.message)}</p><div class="row" style="justify-content:center;flex-wrap:wrap">${canQuickLook()?`<button class="btn outline" data-action="quicklook">${icon('eye','small')} Quick Look</button>`:''}<button class="btn outline" data-action="export-file">${icon('export','small')} Экспорт</button><button class="btn outline" data-action="share-file">${icon('share','small')} Отправить оригинал</button></div></div>`;
    if(hint)hint.textContent='Оригинал сохранён без изменений';state.viewer={measure:false,setTool(){},fit(){}};return;
  }
  if(state.assetId!==f.id||!host.isConnected)return;
  host.innerHTML='<canvas id="scene" aria-label="Чертёж"></canvas><div class="cad-info" id="cad-info"></div>';
  const canvas=host.querySelector('canvas'),info=host.querySelector('#cad-info');
  const b=drawing.bounds,unit=drawing.units||'ед.';
  const hidden=hiddenLayers.get(f.id)||new Set(drawing.layers.filter(l=>!l.visible).map(l=>l.name));hiddenLayers.set(f.id,hidden);
  const vs=viewStates.get(f.id)||{zoom:1,cx:(b.minX+b.maxX)/2,cy:(b.minY+b.maxY)/2};viewStates.set(f.id,vs);
  let w=0,h=0,dpr=1,groups=[],texts=[],dots=[],snap=new Float64Array(0),measure=[],frame=0,pframe=0,prims=0,drawMs=0,drawnAt=0,last=null,settle=0,snap2=null,snapView=null;
  const base=()=>Math.min((w-32)/Math.max(1e-9,b.maxX-b.minX),(h-32)/Math.max(1e-9,b.maxY-b.minY));
  const scale=()=>base()*vs.zoom;
  const toScreen=(x,y)=>{const k=scale();return [(x-vs.cx)*k+w/2,h/2-(y-vs.cy)*k];};
  const toWorld=(sx,sy)=>{const k=scale();return [(sx-w/2)/k+vs.cx,(h/2-sy)/k+vs.cy];};
  // Geometry is batched by style and by grid cell, so a frame strokes only the cells inside the viewport
  // (a catalogue with many sheets is not redrawn in full when one sheet is on screen).
  function build(){
    const map=new Map();texts=[];dots=[];const sp=[];prims=0;
    const n=Math.max(1,Math.min(24,Math.ceil(Math.sqrt(drawing.entities.length/800)))),cw=Math.max(1e-9,(b.maxX-b.minX)/n),ch=Math.max(1e-9,(b.maxY-b.minY)/n);
    const cell=v=>Math.max(0,Math.min(n-1,Math.floor(v)));
    const group=(e,x0,y0,x1,y1)=>{const key=`${e.color||''}|${e.fill?(e.hatch?'h':'f'):e.hatch?'l':''}|${e.dash?e.dash.join(','):''}|${cell(((x0+x1)/2-b.minX)/cw)},${cell(((y0+y1)/2-b.minY)/ch)}`;let g=map.get(key);
      if(!g){g={color:e.color,fill:!!e.fill,hatch:!!e.hatch,dash:e.dash||null,path:new Path2D(),x0:Infinity,y0:Infinity,x1:-Infinity,y1:-Infinity};map.set(key,g);}
      if(x0<g.x0)g.x0=x0;if(y0<g.y0)g.y0=y0;if(x1>g.x1)g.x1=x1;if(y1>g.y1)g.y1=y1;prims++;return g.path;};
    for(const e of drawing.entities){
      if(hidden.has(e.layer))continue;
      if(e.type==='line'){const p=group(e,Math.min(e.a[0],e.b[0]),Math.min(e.a[1],e.b[1]),Math.max(e.a[0],e.b[0]),Math.max(e.a[1],e.b[1]));p.moveTo(e.a[0],e.a[1]);p.lineTo(e.b[0],e.b[1]);if(!e.hatch&&sp.length<6e5)sp.push(e.a[0],e.a[1],e.b[0],e.b[1]);}
      else if(e.type==='polyline'){let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;for(const q of e.points){if(q[0]<x0)x0=q[0];if(q[0]>x1)x1=q[0];if(q[1]<y0)y0=q[1];if(q[1]>y1)y1=q[1];}
        const p=group(e,x0,y0,x1,y1);e.points.forEach((q,i)=>i?p.lineTo(q[0],q[1]):p.moveTo(q[0],q[1]));if(e.closed)p.closePath();if(sp.length<6e5)for(const q of e.points.length>200?[e.points[0],e.points.at(-1)]:e.points)sp.push(q[0],q[1]);}
      else if(e.type==='circle'){if(e.r>0){const p=group(e,e.c[0]-e.r,e.c[1]-e.r,e.c[0]+e.r,e.c[1]+e.r);p.moveTo(e.c[0]+e.r,e.c[1]);p.arc(e.c[0],e.c[1],e.r,0,Math.PI*2);}else dots.push(e);if(sp.length<6e5)sp.push(e.c[0],e.c[1]);}
      else if(e.type==='arc'){const p=group(e,e.c[0]-e.r,e.c[1]-e.r,e.c[0]+e.r,e.c[1]+e.r);const s=e.start*Math.PI/180,t=e.end*Math.PI/180;p.moveTo(e.c[0]+e.r*Math.cos(s),e.c[1]+e.r*Math.sin(s));p.arc(e.c[0],e.c[1],e.r,s,t,false);}
      else if(e.type==='point')dots.push({c:e.p,color:e.color});
      else if(e.type==='text')texts.push(e);
    }
    groups=[...map.values()].sort((a,c)=>(c.fill-a.fill));snap=Float64Array.from(sp);
  }
  function draw(){
    frame=0;clearTimeout(settle);const started=performance.now();const ctx=canvas.getContext('2d');const dark=cadDark();const ink=dark?'#e7ecf4':'#1d2a40';const k=scale();
    if(pframe){cancelAnimationFrame(pframe);pframe=0;}last={cx:vs.cx,cy:vs.cy,k};snapView=null;
    const vx0=vs.cx-w/2/k,vx1=vs.cx+w/2/k,vy0=vs.cy-h/2/k,vy1=vs.cy+h/2/k;
    ctx.setTransform(dpr,0,0,dpr,0,0);ctx.fillStyle=dark?'#141a24':'#ffffff';ctx.fillRect(0,0,w,h);
    ctx.save();ctx.setTransform(dpr*k,0,0,-dpr*k,dpr*(w/2-vs.cx*k),dpr*(h/2+vs.cy*k));ctx.lineWidth=(dark?1:1.1)/k;ctx.lineCap='butt';ctx.lineJoin='bevel';
    for(const g of groups){if(g.x1<vx0||g.x0>vx1||g.y1<vy0||g.y0>vy1)continue; // outside the viewport
      if(g.hatch&&!g.fill&&(g.x1-g.x0+g.y1-g.y0)*k<24)continue; // hatch lines of a cell that is a few pixels wide are noise
      const c=(dark?toneDark(g.color):toneLight(g.color))||ink;ctx.lineWidth=(g.hatch&&!g.fill?.6:dark?1:1.1)/k;
      if(g.fill){ctx.globalAlpha=g.hatch?.22:.8;ctx.fillStyle=c;ctx.fill(g.path);ctx.globalAlpha=1;}
      ctx.strokeStyle=c;if(g.dash&&g.dash[0]*k>1.5)ctx.setLineDash(g.dash);ctx.stroke(g.path);if(g.dash)ctx.setLineDash([]);}
    ctx.restore();ctx.setTransform(dpr,0,0,dpr,0,0);
    for(const d of dots){const [x,y]=toScreen(d.c[0],d.c[1]);if(x<-4||y<-4||x>w+4||y>h+4)continue;ctx.fillStyle=(dark?toneDark(d.color):toneLight(d.color))||ink;ctx.fillRect(x-1,y-1,2,2);}
    let shown=0;const minPx=texts.length>4000?6:3;
    for(const t of texts){const px=t.height*k;if(px<minPx)continue;const [x,y]=toScreen(t.p[0],t.p[1]);if(x<-w||x>2*w||y<-60||y>h+60)continue;if(++shown>6000)break;
      ctx.save();ctx.translate(x,y);if(t.rotation)ctx.rotate(-t.rotation);if(t.width&&t.width!==1)ctx.scale(t.width,1);ctx.font=`${Math.min(px,400)}px -apple-system,system-ui,Arial,sans-serif`;ctx.textAlign=t.align||'left';ctx.textBaseline=t.valign||'alphabetic';ctx.fillStyle=(dark?toneDark(t.color):toneLight(t.color))||ink;ctx.fillText(t.text,0,0);ctx.restore();}
    for(const r of [...(f.redactions||[]),...(redactDraft?[redactDraft]:[])]){const a=toScreen(Math.min(r.x0,r.x1),Math.max(r.y0,r.y1)),c=toScreen(Math.max(r.x0,r.x1),Math.min(r.y0,r.y1));ctx.fillStyle=r===redactDraft?'rgba(0,0,0,.55)':'#000';ctx.fillRect(a[0],a[1],c[0]-a[0],c[1]-a[1]);ctx.strokeStyle='#e5484d';ctx.lineWidth=1;ctx.strokeRect(a[0],a[1],c[0]-a[0],c[1]-a[1]);}
    if(measure.length){ctx.strokeStyle='#4f8cff';ctx.fillStyle='#4f8cff';ctx.lineWidth=2;const pts=measure.map(p=>toScreen(p[0],p[1]));
      if(pts.length===2){ctx.setLineDash([6,4]);ctx.beginPath();ctx.moveTo(...pts[0]);ctx.lineTo(...pts[1]);ctx.stroke();ctx.setLineDash([]);
        const len=Math.hypot(measure[1][0]-measure[0][0],measure[1][1]-measure[0][1]);const label=`${fmtNum(len)} ${tl(unit)}`;const mx=(pts[0][0]+pts[1][0])/2,my=(pts[0][1]+pts[1][1])/2;
        ctx.font='600 13px -apple-system,system-ui,sans-serif';const tw=ctx.measureText(label).width;ctx.fillStyle='#2e61f2';ctx.beginPath();ctx.roundRect?ctx.roundRect(mx-tw/2-8,my-24,tw+16,22,8):ctx.rect(mx-tw/2-8,my-24,tw+16,22);ctx.fill();ctx.fillStyle='#fff';ctx.textAlign='center';ctx.fillText(label,mx,my-8);ctx.fillStyle='#4f8cff';}
      for(const [x,y] of pts){ctx.beginPath();ctx.arc(x,y,5,0,Math.PI*2);ctx.fill();ctx.strokeStyle='#fff';ctx.lineWidth=2;ctx.stroke();}}
    state.notes.filter(n=>n.assetId===f.id).forEach((n,i)=>{const p=n.locationType==='world'?toScreen(n.point.x,n.point.y):[n.point.x*w,n.point.y*h];drawPin(ctx,p[0],p[1],i+1);});
    drawMs=performance.now()-started;drawnAt=performance.now();
  }
  const redraw=()=>{if(!frame)frame=requestAnimationFrame(draw);};
  // Pan / pinch on a heavy drawing: between real redraws the last finished frame is blitted, shifted and scaled, inside
  // the canvas itself (one drawImage per frame). No CSS transforms: a magnified layer makes WebKit drop the canvas.
  const preview=()=>{
    pframe=0;if(frame||!last)return;const ctx=canvas.getContext('2d');
    if(!snapView){ // first preview after a real frame: keep a copy of that frame
      if(!snap2)snap2=document.createElement('canvas');
      if(snap2.width!==canvas.width||snap2.height!==canvas.height){snap2.width=canvas.width;snap2.height=canvas.height;}
      const sc=snap2.getContext('2d');sc.setTransform(1,0,0,1,0,0);sc.globalCompositeOperation='copy';sc.drawImage(canvas,0,0);snapView={...last};
    }
    const k=scale(),z=k/snapView.k,tx=w/2-z*w/2+(snapView.cx-vs.cx)*k,ty=h/2-z*h/2-(snapView.cy-vs.cy)*k;
    ctx.setTransform(dpr,0,0,dpr,0,0);ctx.globalAlpha=1;ctx.fillStyle=cadDark()?'#141a24':'#ffffff';ctx.fillRect(0,0,w,h);
    ctx.imageSmoothingEnabled=true;ctx.drawImage(snap2,tx,ty,w*z,h*z);
  };
  const move=()=>{
    if(!last||(prims<12000&&drawMs<10)){redraw();return;} // light drawing: a real frame every time
    const z=scale()/last.k,stale=performance.now()-drawnAt;
    clearTimeout(settle);
    if(stale>Math.max(250,drawMs*4)||((z>2.5||z<.4)&&stale>120)){redraw();return;} // refresh for real a few times per second
    if(!pframe&&!frame)pframe=requestAnimationFrame(preview);
    settle=setTimeout(redraw,120);
  };
  const resize=()=>{snapView=null;dpr=Math.min(drawing.entities.length>30000?2:3,devicePixelRatio||1);w=wrap.clientWidth;h=wrap.clientHeight;canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);draw();};
  const zoomAt=(factor,sx,sy)=>{const [wx,wy]=toWorld(sx,sy);vs.zoom=Math.max(.3,Math.min(5000,vs.zoom*factor));const k=scale();vs.cx=wx-(sx-w/2)/k;vs.cy=wy-(h/2-sy)/k;move();};
  const snapTo=(sx,sy)=>{let best=-1,bd=16*16;const k=scale();for(let i=0;i<snap.length;i+=2){const x=(snap[i]-vs.cx)*k+w/2,y=h/2-(snap[i+1]-vs.cy)*k;const d=(x-sx)**2+(y-sy)**2;if(d<bd){bd=d;best=i;}}return best<0?toWorld(sx,sy):[snap[best],snap[best+1]];};
  const updateInfo=()=>{const hiddenCount=hidden.size;info.textContent=`${drawing.version==='DXF'?'DXF · ':drawing.version?`DWG ${versionLabelUI(drawing.version)} · `:''}${plural(drawing.entities.length,'object')}${drawing.units?` · ${drawing.units}`:''}${hiddenCount?` · скрыто слоёв: ${hiddenCount}`:''}${drawing.truncated?' · показана часть':''}${drawing.space==='paper'?' · лист':''}${drawing.strays?` · далёкие объекты: ${drawing.strays}`:''}${Object.keys(drawing.skipped||{}).length?` · не показано: ${Object.entries(drawing.skipped).map(([k,v])=>`${skippedName(k)} ×${v}`).join(', ')}`:''}${Object.keys(drawing.errors||{}).length?` · ошибки чтения: ${Object.entries(drawing.errors).map(([k,v])=>`${skippedName(k)} ×${v}`).join(', ')}`:''}`;};
  build();updateInfo();setTimeout(()=>info.classList.add('faded'),3500);
  const pos=e=>{const r=canvas.getBoundingClientRect();return [e.clientX-r.left,e.clientY-r.top];};
  const touches=new Map();let pinch=null,drag=null,lastTap=0,redactDraft=null;
  canvas.addEventListener('pointerdown',e=>{canvas.setPointerCapture(e.pointerId);touches.set(e.pointerId,pos(e));
    if(state.viewerTool==='redact'&&touches.size===1){const [x,y]=toWorld(...pos(e));redactDraft={x0:x,y0:y,x1:x,y1:y};return;}
    if(touches.size===2){const [a,c]=[...touches.values()];const m=[(a[0]+c[0])/2,(a[1]+c[1])/2];pinch={d:Math.max(1,Math.hypot(a[0]-c[0],a[1]-c[1])),zoom:vs.zoom,world:toWorld(...m)};drag=null;return;}
    drag={start:pos(e),last:pos(e),moved:false};});
  canvas.addEventListener('pointermove',e=>{if(!touches.has(e.pointerId))return;touches.set(e.pointerId,pos(e));
    if(pinch&&touches.size>=2){const [a,c]=[...touches.values()];const m=[(a[0]+c[0])/2,(a[1]+c[1])/2];vs.zoom=Math.max(.3,Math.min(5000,pinch.zoom*Math.hypot(a[0]-c[0],a[1]-c[1])/pinch.d));const k=scale();vs.cx=pinch.world[0]-(m[0]-w/2)/k;vs.cy=pinch.world[1]-(h/2-m[1])/k;move();return;}
    if(redactDraft){const [x,y]=toWorld(...pos(e));redactDraft.x1=x;redactDraft.y1=y;redraw();return;}
    if(!drag)return;const p=pos(e);if(!drag.moved&&Math.hypot(p[0]-drag.start[0],p[1]-drag.start[1])>8)drag.moved=true;
    if(drag.moved){const k=scale();vs.cx-=(p[0]-drag.last[0])/k;vs.cy+=(p[1]-drag.last[1])/k;drag.last=p;move();}});
  const end=e=>{touches.delete(e.pointerId);if(snapView&&!touches.size){clearTimeout(settle);redraw();}
    if(redactDraft){const r=redactDraft;redactDraft=null;const k=scale();if(Math.abs(r.x1-r.x0)*k>10&&Math.abs(r.y1-r.y0)*k>10&&e.type!=='pointercancel'){f.redactions=[...(f.redactions||[]),r];updateAssetMeta(f.id,{redactions:f.redactions}).then(()=>notify('Область скрыта: при экспорте и защищённой отправке её содержимое будет удалено')).catch(err=>notify(err.message));}redraw();return;}
    if(pinch){if(touches.size<2)pinch=null;drag=null;return;}
    const d=drag;drag=null;if(!d||d.moved||e.type==='pointercancel')return;const [sx,sy]=pos(e);
    if(state.viewerTool==='measure'){const p=snapTo(sx,sy);if(measure.length>=2)measure=[];measure.push(p);
      if(measure.length===2){const dx=measure[1][0]-measure[0][0],dy=measure[1][1]-measure[0][1];notify(`Расстояние ${fmtNum(Math.hypot(dx,dy))} ${unit} · ΔX ${fmtNum(Math.abs(dx))} · ΔY ${fmtNum(Math.abs(dy))}`);haptic();}
      else haptic();redraw();return;}
    if(state.viewerTool==='comment'){const [x,y]=toWorld(sx,sy);newNoteModal({x,y});state.pendingLocationType='world';return;}
    const now=Date.now();if(now-lastTap<320){zoomAt(2.2,sx,sy);lastTap=0;}else lastTap=now;};
  canvas.addEventListener('pointerup',end);canvas.addEventListener('pointercancel',end);
  canvas.addEventListener('wheel',e=>{e.preventDefault();const [sx,sy]=pos(e);zoomAt(e.deltaY>0?.88:1.14,sx,sy);},{passive:false});
  const ro=typeof ResizeObserver==='function'?new ResizeObserver(resize):null;ro?.observe(wrap);
  if(hint)hint.textContent='1 палец — сдвиг · 2 — масштаб · двойной тап — ближе';hideHintSoon();
  state.viewer={measure:true,
    zoom(k){zoomAt(k,w/2,h/2);},
    fit(){vs.zoom=1;vs.cx=(b.minX+b.maxX)/2;vs.cy=(b.minY+b.maxY)/2;measure=[];redraw();},
    setTool(t){if(t!=='measure')measure=[];redraw();},
    layers:drawing.layers,hidden,
    setLayer(name,on){on?hidden.delete(name):hidden.add(name);build();updateInfo();redraw();},
    setAllLayers(on){if(on)hidden.clear();else drawing.layers.forEach(l=>hidden.add(l.name));build();updateInfo();redraw();},
    redraw,cleanup(){ro?.disconnect();clearTimeout(settle);if(frame)cancelAnimationFrame(frame);if(pframe)cancelAnimationFrame(pframe);snap2=null;}};
  resize();
}
function skippedName(k){return ({Solid3D:'3D-тела',Region:'области',Body:'тела',RasterImage:'растровые картинки',PdfUnderlay:'PDF-подложки',DwfUnderlay:'DWF-подложки',DgnUnderlay:'DGN-подложки',Shape:'формы SHX',Ole2Frame:'OLE-объекты'})[k]||k;}
function versionLabelUI(v){return ({AC1012:'R13',AC1014:'R14',AC1015:'2000',AC1018:'2004',AC1021:'2007',AC1024:'2010',AC1027:'2013',AC1032:'2018+'})[v]||v;}
function fmtNum(v){const a=Math.abs(v);return a>=1000?v.toLocaleString(locale(),{maximumFractionDigits:1}):a>=1?v.toLocaleString(locale(),{maximumFractionDigits:2}):v.toLocaleString(locale(),{maximumSignificantDigits:3});}
function hideHintSoon(){const h=document.getElementById('canvas-hint');if(h)setTimeout(()=>h.classList.add('faded'),4000);}
function haptic(){try{navigator.vibrate?.(8);}catch{}}
function layersModal(){const v=state.viewer;if(!v?.layers){notify('Слои есть только у чертежей DWG и DXF');return;}
  modal('Слои',`<div class="row" style="margin-bottom:12px"><button class="btn tiny soft" data-action="layers-all" data-on="1">Показать все</button><button class="btn tiny outline" data-action="layers-all" data-on="0">Скрыть все</button></div><div class="group-card layer-list">${v.layers.map(l=>`<label class="setting-row layer-row"><span class="layer-swatch" style="background:${l.color||'var(--ink)'}"></span><span class="layer-name"><strong>${esc(l.name)}</strong><br><span>${plural(l.count,'object')}</span></span><input type="checkbox" data-layer="${esc(l.name)}" ${v.hidden.has(l.name)?'':'checked'} aria-label="Показывать слой ${esc(l.name)}"></label>`).join('')}</div>`);}
function drawPin(ctx,x,y,index){ctx.save();ctx.fillStyle='#2e61f2';ctx.strokeStyle='white';ctx.lineWidth=3;ctx.beginPath();ctx.arc(x,y,12,0,Math.PI*2);ctx.fill();ctx.stroke();ctx.fillStyle='white';ctx.font='bold 10px system-ui';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(String(index),x,y);ctx.restore();}

document.addEventListener('click',async e=>{
  const button=e.target.closest('[data-action]');if(!button)return;
  try{await actionHandler(button);}catch(error){console.error(error);notify(error.message||'Ошибка операции');}
});
filePicker.addEventListener('change',async e=>{try{await addPickedFiles([...e.target.files]);}catch(err){console.error(err);notify(err.message);}finally{e.target.value='';}});
dialog.addEventListener('click',e=>{if(e.target===dialog)closeModal();});
dialog.addEventListener('submit',async e=>{
  e.preventDefault();const form=e.target;
  try{
    if(form.id==='create-project'){const fd=new FormData(form);const p=await createProject(fd.get('name'),fd.get('description'));closeModal();await openProject(p.id);notify('Проект создан');}
    if(form.id==='secure-share'){await createSecurePackage(form);return;}
    if(form.id==='unlock-secure'){const fd=new FormData(form);await openSecure(form.dataset.id,String(fd.get('secret')||'').trim(),{remember:!!fd.get('remember')});return;}
    if(form.id==='secure-ack'){const fd=new FormData(form);await sendReceipt(String(fd.get('name')).trim(),String(fd.get('company')||'').trim());return;}
    if(form.id==='identity'){const fd=new FormData(form);const url=String(fd.get('revocationUrl')||'').trim();if(url&&!/^https:\/\//.test(url))throw new Error('Адрес должен начинаться с https://');await saveSetting('userName',String(fd.get('userName')||'').trim());await saveSetting('company',String(fd.get('company')||'').trim());await saveSetting('revocationUrl',url);closeModal();notify('Сохранено');await render();return;}
    if(form.id==='rename-project'){const fd=new FormData(form);await renameProject(state.projectId,fd.get('name'),fd.get('description'));closeModal();notify('Сохранено');await render();return;}
    if(form.id==='rename-asset'){const name=await renameAsset(state.assetId,new FormData(form).get('name'));closeModal();notify(`Файл: ${name}`);await render();return;}
    if(form.id==='calibrate'){const length=Number(String(new FormData(form).get('length')).replace(',','.'));if(!(length>0)||!(state.lastPixels>0))throw new Error('Введите длину больше нуля');await setAssetScale(state.assetId,length/state.lastPixels);closeModal();notify(`Масштаб задан: ${formatLength(length)} = ${state.lastPixels.toFixed(1)} пикс.`);state.measurePoints=[];await render();state.viewerTool='measure';state.viewer?.setTool?.('measure');app.querySelectorAll('[data-action="viewer-tool"]').forEach(b=>{const on=b.dataset.tool==='measure';b.classList.toggle('soft',on);b.classList.toggle('active-tool',on);b.classList.toggle('outline',!on);});return;}
    if(form.id==='create-note'&&String(state.assetId).startsWith('sbx:')){const fd=new FormData(form);const n={id:'sbxl:'+uuid(),projectId:state.projectId,assetId:state.assetId,version:1,text:String(fd.get('text')).trim().slice(0,1200),point:state.pendingPoint||{x:.5,y:.5},locationType:state.pendingLocationType||'normalized',status:'open',createdAt:Date.now()};if(!n.text)throw new Error('Напишите замечание');state.secure.notes.push(n);await secureAudit({type:'comment'});state.pendingPoint=null;state.viewerTool='view';closeModal();await render();notify('Замечание сохранено в пакете');return;}
    if(form.id==='create-note'){const f=await assetById(state.assetId);const fd=new FormData(form);if(!f)throw new Error('Сначала откройте файл');await addNote({projectId:f.projectId,assetId:f.id,text:fd.get('text'),point:state.pendingPoint||{x:.5,y:.5},locationType:state.pendingLocationType||'normalized'});state.pendingPoint=null;state.pendingLocationType='normalized';state.viewerTool='view';closeModal();await render();notify('Замечание сохранено');}
  }catch(err){notify(err.message||'Не удалось сохранить');}
});
document.addEventListener('input',e=>{if(e.target.id==='project-search'){const el=e.target;state.search=el.value;const start=el.selectionStart;render().then(()=>{const next=document.getElementById('project-search');next?.focus();next?.setSelectionRange(start,start);});}});
document.addEventListener('change',e=>{const t=e.target;if(t.matches?.('input[data-layer]')&&state.viewer?.setLayer)state.viewer.setLayer(t.dataset.layer,t.checked);});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)nativeDrain();});
async function init(){
  if(NativeML){NativeML.addListener('inboxChanged',()=>nativeDrain()).catch(console.warn);NativeML.addListener('screenshot',()=>onScreenshot()).catch(()=>{});NativeML.addListener('capture',e=>onCapture(e.captured)).catch(()=>{});NativeML.addListener('panic',()=>{if(isSensitive())panic();}).catch(()=>{});}
  await loadSettings().catch(()=>{});
  navigator.storage?.persist?.().catch(()=>{});
  try{state.theme=localStorage.getItem('modellink-theme')||'light';document.body.classList.toggle('dark',state.theme==='dark');await initDemo(t);await render();startTranslator(document.body);ensureFingerprints().catch(()=>{});if(!IS_NATIVE&&'serviceWorker' in navigator&&location.protocol==='https:')navigator.serviceWorker.register('./sw.js').catch(console.warn);await nativeDrain();}
  catch(e){console.error(e);app.innerHTML=`<div class="boot-screen">${icon('warning','large')}<h2>Не удалось открыть хранилище</h2><p class="lead" style="text-align:center;padding:20px">Проверьте разрешения браузера и свободное место на устройстве.</p></div>`;}
}
init();
