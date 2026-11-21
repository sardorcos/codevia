import {initDemo,getProjects,getProject,getAssets,getAsset,getAllAssets,getAllNotes,getNotes,createProject,addAsset,addNote,setNoteStatus,removeProject,removeAsset,setAssetScale,removeAllData,latestFiles,fileInfo,formatBytes,capabilities} from './core/storage.js';
import {parseDXF,parseOBJ,parseSTL,parseGLB,meshBounds} from './core/geometry.js';
import {exportProject,importProjectPackage} from './core/pack.js';
import {conversionTargets,dxfToSVG,meshToSTL,meshToOBJ,meshToPLY,meshToGLB,meshToUSDZ,jpegToPDF,baseName,extOf} from './core/convert.js';
import {Capacitor,registerPlugin} from './vendor/capacitor-core.js';

const APP_VERSION='0.4.0';
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
const date=t=>new Date(t).toLocaleDateString('ru-RU',{day:'numeric',month:'short'});
const niceName=name=>String(name).length>54?String(name).slice(0,52)+'…':name;
const featureDefs=[
  ['drawing','Чертежи','PDF, DXF и изображения','pdf',''],
  ['model','3D-модели','STL, OBJ и GLB','cube','lime'],
  ['measure','Измерения','Проверить расстояние','measure','violet'],
  ['notes','Замечания','Отметки прямо на файле','comment','orange'],
  ['versions','Версии','Сохранить все редакции','history','sky'],
  ['share','Экспорт','Другие форматы и отправка','export','rose']
];
const navDefs=[['home','Главная','home'],['projects','Проекты','folders'],['notes','Замечания','comment'],['settings','Настройки','settings']];
function notify(message){toastArea.textContent=message;toastArea.classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>toastArea.classList.remove('visible'),3700);}
function header(){return `<header class="app-header"><div class="brand"><span class="brand-icon">${icon('box')}</span><span>ModelLink<span style="color:var(--blue)">.</span></span></div><div class="header-right"><span class="header-chip"><i class="dot"></i> Данные на устройстве</span><button data-action="go-settings" class="avatar" aria-label="Открыть настройки">ML</button></div></header>`;}
function navItem([id,label,glyph]){return `<button class="nav-item ${state.tab===id?'active':''}" data-action="tab" data-tab="${id}" aria-label="${label}" ${state.tab===id?'aria-current="page"':''}>${icon(glyph)}<span>${label}</span></button>`;}
function layout(content){return `<div class="app-layout"><aside class="side-nav"><div class="brand" style="padding:0 12px"><span class="brand-icon">${icon('box')}</span>ModelLink<span style="color:var(--blue)">.</span></div><div class="side-title">Рабочее пространство</div>${navDefs.map(navItem).join('')}<div class="side-note">Ваши файлы хранятся на этом устройстве. Для переноса проекта используйте «Поделиться».</div></aside><div class="main-area">${state.tab==='viewer'?'':header()}<main class="page ${state.tab==='viewer'?'viewer-page':''}">${content}</main></div></div>${state.tab==='viewer'?'':`<nav class="bottom-nav" aria-label="Основная навигация">${navDefs.map(navItem).join('')}</nav>`}`;}
function sectionTitle(title,button='',action=''){return `<div class="section-heading"><h2>${title}</h2>${button?`<button class="link-button" data-action="${action}">${button} ${icon('arrow','small')}</button>`:''}</div>`;}
function fileTypePreview(name){const cap=fileInfo(name);return cap.label||cap.ext;}
function projectTile(p,assets,notes){const files=latestFiles(assets.filter(x=>x.projectId===p.id));const count=notes.filter(n=>n.projectId===p.id&&n.status==='open').length;return `<button class="project-card" data-action="open-project" data-id="${esc(p.id)}"><span class="project-thumb ${p.demo?'demo':''}">${icon(files.some(x=>x.kind==='model')?'cube':'folders')}</span><span class="project-body"><span class="project-title">${esc(p.name)}</span>${p.demo?` <span class="tag">ПРИМЕР</span>`:''}<div class="project-sub">${files.length} файлов · ${count} замечаний · ${date(p.updatedAt)}</div></span>${icon('arrow','small arrow-right')}</button>`;}
function homeView(projects,files,notes){const recents=projects.slice(0,3);
  return `<section class="home-head"><div class="eyebrow">Ваши проекты под рукой</div><h1>Чертежи и 3D.<br>Один экран.</h1><p class="lead">Открывайте, проверяйте и отправляйте файлы прямо с телефона.</p></section>
    <div class="quick-launch"><div><h2>С чего начнём?</h2><p>Откройте файл за пару касаний</p></div><div class="quick-launch-actions"><button class="btn white" data-action="import">${icon('upload','small')} Открыть файл</button><button class="btn ghost-white" data-action="new-project">${icon('plus','small')} Проект</button></div></div>
    <section>${sectionTitle('Что можно делать')}<div class="tools-grid">${featureDefs.map(([id,name,desc,glyph,color])=>`<button class="tool-card" data-action="feature" data-feature="${id}"><span class="tool-icon ${color}">${icon(glyph)}</span><span><span class="tool-name">${name}</span><div class="tool-desc">${desc}</div></span></button>`).join('')}</div></section>
    <section class="section">${sectionTitle('Последние проекты','Все проекты','go-projects')}<div class="project-list">${recents.length?recents.map(p=>projectTile(p,files,notes)).join(''):`<div class="empty">${icon('folders')}<h3>Здесь появятся ваши проекты</h3><p>Добавьте первый чертёж или модель</p><button class="btn primary" data-action="import">Открыть файл</button></div>`}</div></section>
    <section class="section">${sectionTitle('Форматы файлов','Подробнее','formats')}<div class="format-rail">${['PDF','DXF','SVG','STL','OBJ','GLB'].concat(IS_NATIVE?['USDZ']:[],['DWG*','STEP*','IFC*']).map(x=>`<span class="format-tag">${x}</span>`).join('')}</div><p class="small-muted" style="margin-top:9px">* Исходники DWG, STEP, IFC сохраняются и передаются без изменений. Для просмотра добавьте копию в PDF, DXF, GLB или STL.</p></section>`;
}
function projectsView(projects,files,notes){let filtered=projects.filter(p=>p.name.toLowerCase().includes(state.search.toLowerCase()));if(state.filter==='demo')filtered=filtered.filter(p=>p.demo);if(state.filter==='mine')filtered=filtered.filter(p=>!p.demo);
  return `<div class="eyebrow">Рабочее пространство</div><div class="detail-top"><div><h1>Проекты</h1><p class="lead">Чертежи, модели и все версии</p></div><button class="btn primary" data-action="new-project">${icon('plus','small')} Создать</button></div>
  <label class="search-field">${icon('search','small')}<input id="project-search" type="search" placeholder="Найти проект" value="${esc(state.search)}" aria-label="Поиск проекта"></label>
  <div class="segmented"><button class="chip ${state.filter==='all'?'active':''}" data-action="filter" data-filter="all">Все</button><button class="chip ${state.filter==='mine'?'active':''}" data-action="filter" data-filter="mine">Мои</button><button class="chip ${state.filter==='demo'?'active':''}" data-action="filter" data-filter="demo">Примеры</button></div>
  <div class="project-list">${filtered.map(p=>projectTile(p,files,notes)).join('')||'<div class="empty"><h3>Ничего не найдено</h3><p>Измените запрос или создайте проект</p></div>'}</div>
  <div style="margin-top:24px"><button class="btn outline block" data-action="import-package">${icon('download','small')} Импортировать пакет .mlink</button></div>`;
}
function detailView(p,files,notes){const current=latestFiles(files),open=notes.filter(n=>n.status==='open');return `<div class="breadcrumbs"><button data-action="go-projects">Проекты</button>${icon('arrow','small')}<span>${esc(niceName(p.name))}</span></div>
<div class="project-hero"><span class="eyebrow">${p.demo?'Демонстрационный проект':'Ваш проект'}</span><h1>${esc(p.name)}</h1><p>${esc(p.description||'Файлы и комментарии проекта')}</p><div class="info-stack"><span>${icon('file','small')} ${current.length} файлов</span><span>${icon('comment','small')} ${open.length} замечаний</span><span>${icon('history','small')} ${files.length-current.length} старых версий</span></div>
<div class="action-bar"><button class="btn primary" data-action="import-here">${icon('plus','small')} Добавить файлы</button><button class="btn outline" data-action="share-project">${icon('share','small')} Поделиться</button></div></div>
${sectionTitle('Файлы')}<div class="file-list">${current.map(f=>fileRow(f)).join('')||`<div class="empty"><h3>Пока нет файлов</h3><p>Добавьте чертёж или 3D-модель</p></div>`}</div>
<div class="section">${sectionTitle('Замечания')}<div>${open.slice(0,3).map((n,i)=>noteRow(n,i+1)).join('')||'<p class="small-muted">Открытых замечаний нет</p>'}</div></div>
<div class="section"><button class="btn outline" data-action="project-versions">${icon('history','small')} История версий</button> <button class="btn outline" data-action="delete-project">${icon('trash','small')} Удалить проект</button></div>`;}
function fileBadge(name,kind){const ext=String(name).split('.').at(-1).toLowerCase();const glyph=ext==='pdf'?'pdf':ext==='dwg'?'dwg':kind==='model'||kind==='ar'?'cube':kind==='drawing'?'layers':null;
  return glyph?`<span class="file-ext has-icon">${icon(glyph)}</span>`:`<span class="file-ext">${esc(fileInfo(name).label.slice(0,6))}</span>`;}
function fileRow(f){const info=fileInfo(f.name);return `<button class="file-row" data-action="open-asset" data-id="${esc(f.id)}">${fileBadge(f.name,f.kind)}<span class="body"><h3>${esc(niceName(f.name))}</h3><p>${formatBytes(f.size)} · версия ${f.version} · ${info.preview==='source'?'Оригинал':info.preview==='partial'?'Базовый просмотр':'Просмотр'}</p></span>${icon('arrow','small')}</button>`;}
function noteRow(n,index){return `<div class="annotation-card"><span class="annotation-count">${index}</span><span class="body"><p>${esc(n.text)}</p><div class="meta">${date(n.createdAt)} · версия ${n.version} · <span class="status-text ${n.status==='resolved'?'resolved':''}">${n.status==='resolved'?'Проверено':'Открыто'}</span></div></span><button class="btn tiny ${n.status==='resolved'?'outline':'soft'}" data-action="toggle-note" data-id="${n.id}" aria-label="Изменить статус">${n.status==='resolved'?'Вернуть':'Готово'}</button></div>`;}
function notesView(notes,files){return `<div class="eyebrow">Контроль изменений</div><h1>Замечания</h1><p class="lead">Нажмите на запись, чтобы открыть соответствующий файл</p><div class="section">${notes.map((n,i)=>{const asset=files.find(f=>f.id===n.assetId);return `<div class="annotation-card"><span class="annotation-count">${notes.length-i}</span><div class="body"><p>${esc(n.text)}</p><div class="meta">${esc(asset?.name||'Файл не найден')} · версия ${n.version} · ${date(n.createdAt)}</div><div class="row" style="margin-top:10px"><button class="btn tiny soft" data-action="open-asset" data-id="${esc(n.assetId)}">${icon('eye','small')} Открыть</button><button class="btn tiny ${n.status==='resolved'?'outline':'soft'}" data-action="toggle-note" data-id="${n.id}">${n.status==='resolved'?'Вернуть':'Выполнено'}</button></div></div></div>`;}).join('')||`<div class="empty">${icon('pin','large')}<h3>Замечаний пока нет</h3><p>Откройте файл и нажмите «Отметить»</p></div>`}</div>`;}
function settingsView(projects,files){return `<div class="eyebrow">ModelLink</div><h1>Настройки</h1><p class="lead">Простые инструменты без сложных меню</p><div class="two-col section"><div class="stat"><strong>${projects.length}</strong><p>проектов</p></div><div class="stat"><strong>${files.length}</strong><p>файлов и версий</p></div></div><div class="group-card section"><div class="setting-row"><div><strong>Тема оформления</strong><br><span>Светлая / тёмная</span></div><button class="btn outline tiny" data-action="theme">${icon('light','small')} ${state.theme==='dark'?'Светлая':'Тёмная'}</button></div><div class="setting-row"><div><strong>Поддерживаемые форматы</strong><br><span>Что открывается прямо в приложении</span></div><button class="icon-button" data-action="formats" aria-label="Форматы">${icon('arrow')}</button></div><div class="setting-row"><div><strong>Импорт проекта</strong><br><span>Открыть резервный пакет .mlink</span></div><button class="icon-button" data-action="import-package" aria-label="Импорт пакета">${icon('download')}</button></div></div><div class="notice section">${icon('info','small')} &nbsp; Данные хранятся только на этом устройстве. Экспортируйте важные проекты в .mlink для резервной копии.</div><div class="group-card section"><div class="setting-row"><div><strong>О приложении</strong><br><span>Версия ${APP_VERSION}</span></div><button class="icon-button" data-action="about" aria-label="О приложении">${icon('arrow')}</button></div><div class="setting-row"><div><strong>Конфиденциальность</strong><br><span>Данные не собираются</span></div><button class="icon-button" data-action="privacy" aria-label="Конфиденциальность">${icon('arrow')}</button></div><div class="setting-row"><div><strong>Удалить все данные</strong><br><span>Проекты, файлы и замечания</span></div><button class="icon-button" data-action="erase-all" aria-label="Удалить все данные">${icon('trash')}</button></div></div><div class="section"><button class="btn outline" data-action="open-example">${icon('cube','small')} Посмотреть пример</button></div>`;}
function viewerContent(f,allFiles,notes){const info=fileInfo(f.name);const siblings=allFiles.filter(x=>x.groupId===f.groupId).sort((a,b)=>b.version-a.version);
  const toolbar=`<div class="viewer-tools"><button class="btn tiny ${state.viewerTool==='view'?'soft active-tool':'outline'}" data-action="viewer-tool" data-tool="view">${icon('eye','small')} Вид</button><button class="btn tiny ${state.viewerTool==='comment'?'soft active-tool':'outline'}" data-action="viewer-tool" data-tool="comment">${icon('comment','small')} Отметить</button><button class="btn tiny ${state.viewerTool==='measure'?'soft active-tool':'outline'}" data-action="viewer-tool" data-tool="measure">${icon('measure','small')} Измерить</button>${f.kind==='drawing'||f.kind==='model'?`<button class="btn tiny outline" data-action="zoom" data-k="1.25" aria-label="Приблизить">${icon('zoom-in','small')}</button><button class="btn tiny outline" data-action="zoom" data-k="0.8" aria-label="Отдалить">${icon('zoom-out','small')}</button>`:''}<button class="btn tiny outline" data-action="fit">${icon('fit','small')} Вписать</button></div>`;
  return `<div class="breadcrumbs"><button data-action="back-project">${icon('chevron','small')} Проект</button></div><div class="viewer-header"><div style="min-width:0"><div class="eyebrow">${esc(info.label)} · Версия ${f.version}</div><div class="viewer-heading">${esc(f.name)}</div></div><div class="row"><button class="icon-button" data-action="export-file" aria-label="Экспорт в другой формат">${icon('export')}</button>${canQuickLook(f.name)?`<button class="icon-button" data-action="quicklook" aria-label="Открыть в Quick Look">${icon('eye')}</button>`:''}<button class="icon-button" data-action="${IS_NATIVE?'share-file':'download-file'}" aria-label="${IS_NATIVE?'Поделиться или сохранить в Файлы':'Скачать оригинал'}">${icon(IS_NATIVE?'share':'download')}</button>${IS_NATIVE?'':`<button class="icon-button" data-action="share-file" aria-label="Поделиться файлом">${icon('share')}</button>`}<button class="icon-button" data-action="delete-asset" aria-label="Удалить эту версию">${icon('trash')}</button></div></div>${toolbar}
  <div class="canvas-wrap" id="canvas-wrap"><div class="viewport-badge">${esc(info.preview==='source'?'Оригинал':info.preview==='partial'?'Базовый просмотр':'Просмотр')}</div><div class="preview-body" id="preview-body"><div class="file-unsupported"><h3>Загружаем просмотр…</h3></div></div><div class="canvas-hint" id="canvas-hint">${f.kind==='model'?'Вращайте одним пальцем, масштаб — двумя':f.kind==='drawing'?'Двигайте одним пальцем, масштаб — двумя':'Коснитесь файла для отметки'}</div></div>
  <div class="viewer-data"><div class="section-heading"><h3>Замечания · ${notes.length}</h3><button class="link-button" data-action="quick-comment">${icon('plus','small')} Добавить</button></div>${notes.map((n,i)=>noteRow(n,i+1)).join('')||'<p class="small-muted">Здесь появятся замечания к этому файлу.</p>'}</div>
  <div class="section">${sectionTitle('Версии файла')}<div class="group-card">${siblings.map(v=>`<div class="version-item"><span>Версия ${v.version} ${v.id===f.id?'<span class="tag">ОТКРЫТА</span>':''}<br><small style="color:var(--muted)">${date(v.createdAt)} · ${formatBytes(v.size)}</small></span>${v.id===f.id?'':`<button class="btn tiny outline" data-action="open-asset" data-id="${v.id}">Открыть</button>`}</div>`).join('')}</div></div>`;}

function modal(title,html){document.getElementById('modal-title').textContent=title;document.getElementById('modal-content').innerHTML=html;if(!dialog.open)dialog.showModal();}
function closeModal(){if(dialog.open)dialog.close();}
function selectTab(tab){state.tab=tab;state.projectId=null;state.assetId=null;state.viewer=null;state.viewerTool='view';window.scrollTo(0,0);render();}
function releasePreview(){if(previewUrl){URL.revokeObjectURL(previewUrl);previewUrl=null;}}

async function render(){
  const projects=await getProjects(),files=await getAllAssets(),notes=await getAllNotes();state.projectIds=projects.map(p=>p.id);state.notes=notes;
  let body='';
  if(state.tab==='home')body=homeView(projects,files,notes);
  if(state.tab==='projects')body=projectsView(projects,files,notes);
  if(state.tab==='notes')body=notesView(notes,files);
  if(state.tab==='settings')body=settingsView(projects,files);
  if(state.tab==='project'){
    const p=projects.find(p=>p.id===state.projectId);
    body=p?detailView(p,files.filter(f=>f.projectId===p.id),notes.filter(n=>n.projectId===p.id)):'<div class="empty">Проект не найден</div>';
  }
  if(state.tab==='viewer'){
    const f=files.find(f=>f.id===state.assetId);
    body=f?viewerContent(f,files,notes.filter(n=>n.assetId===f.id)):'<div class="empty">Файл не найден</div>';
  }
  state.viewer?.cleanup?.();releasePreview();app.innerHTML=layout(body);
  if(state.tab==='viewer'&&state.assetId) await activateViewer(files.find(f=>f.id===state.assetId));
}
async function openAsset(id){const asset=await getAsset(id);if(!asset){notify('Файл не найден');return;}state.tab='viewer';state.assetId=id;state.projectId=asset.projectId;state.viewerTool='view';state.viewer=null;window.scrollTo(0,0);await render();}
async function openProject(id){const p=await getProject(id);if(!p)return;state.projectId=id;state.assetId=null;state.tab='project';window.scrollTo(0,0);await render();}
function filePickerAction(mode='all',projectId=null){
  state.pickerProject=projectId;state.pickerMode=mode;
  const accepts={all:'',drawing:'.pdf,.dxf,.svg,.png,.jpg,.jpeg,.webp,.bmp',model:'.glb,.stl,.obj,.step,.stp,.ifc,.dwg,.rvt,.sldprt,.sldasm',package:'.mlink'};
  filePicker.setAttribute('accept',accepts[mode]||'');filePicker.multiple=mode!=='package';
  if(NativeML){nativeChoose();return;}
  filePicker.value='';filePicker.click();
}
async function pickProjectToImport(files){if(state.pickerProject)return state.pickerProject;const projects=await getProjects();let inbox=projects.find(x=>x.name==='Мои файлы'&&!x.demo);if(!inbox)inbox=await createProject('Мои файлы','Файлы, открытые с телефона');return inbox.id;}
async function addPickedFiles(files){if(!files?.length)return;
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
  modal('Форматы и возможности',`<p class="small-muted" style="margin-bottom:14px">Открыть, сохранить и передать можно файлы любых расширений (до 100 МБ). Кнопка «Экспорт» в просмотре преобразует файл в другие форматы.</p><div class="group-card">${rows}</div><p class="plan-warning">DWG, STEP, IFC и другие закрытые CAD-форматы хранятся и передаются без изменений. Для просмотра на телефоне добавьте в проект копию в PDF, DXF, GLB или STL.</p>`);
}
function newProjectModal(){modal('Новый проект',`<form id="create-project"><label class="field">Название проекта<input name="name" maxlength="100" required autofocus placeholder="Например, Завод · фасад" /></label><label class="field">Описание (необязательно)<textarea name="description" maxlength="350" placeholder="Что хранится в проекте"></textarea></label><button class="btn primary block" type="submit">${icon('plus','small')} Создать проект</button></form>`);dialog.querySelector('input')?.focus();}
function newNoteModal(point){state.pendingPoint=point;state.pendingLocationType='normalized';modal('Новое замечание',`<form id="create-note"><p class="small-muted" style="margin-bottom:13px">Замечание будет прикреплено к открытой версии файла.</p><label class="field">Что нужно проверить?<textarea name="text" autofocus required maxlength="1200" placeholder="Например, проверить ширину прохода…"></textarea></label><button class="btn primary block" type="submit">${icon('check','small')} Сохранить замечание</button></form>`);}
function measureResultModal(pixels,mmPerPixel){state.lastPixels=pixels;const mm=mmPerPixel?pixels*mmPerPixel:null;
  modal('Измерение',`<div class="measure-result"><strong>${mm!==null?formatLength(mm):`${pixels.toFixed(1)} пикс.`}</strong><span>${mm!==null?`${pixels.toFixed(1)} пикс. · масштаб задан вами`:'Расстояние в пикселях изображения'}</span></div><form id="calibrate"><label class="field">${mm!==null?'Уточнить масштаб: реальная длина этого отрезка, мм':'Знаете реальную длину этого отрезка? Укажите её, мм'}<input name="length" type="number" inputmode="decimal" min="0.001" step="any" required placeholder="Например, 30000"></label><button class="btn primary block" type="submit">${icon('ruler','small')} Задать масштаб</button></form>${mm!==null?`<button class="btn outline block" style="margin-top:10px" data-action="clear-scale">Сбросить масштаб</button>`:''}<p class="small-muted" style="margin-top:12px">Масштаб сохраняется для этой версии файла. Сверяйте критичные размеры в CAD-программе.</p>`);}
function formatLength(mm){if(mm>=1000)return `${(mm/1000).toFixed(mm>=100000?1:3).replace(/\.?0+$/,'')} м`;if(mm>=10)return `${mm.toFixed(1).replace(/\.0$/,'')} мм`;return `${mm.toFixed(2)} мм`;}
function askDeleteAsset(){modal('Удалить версию файла?',`<p class="lead" style="margin-bottom:22px">Будет удалена открытая версия и её замечания. Другие версии этого файла останутся.</p><div class="row"><button class="btn outline" data-action="close-modal" style="flex:1">Отмена</button><button class="btn danger" style="flex:1" data-action="confirm-delete-asset">Удалить</button></div>`);}
function askEraseAll(){modal('Удалить все данные?',`<p class="lead" style="margin-bottom:22px">Будут удалены все проекты, файлы, версии и замечания на этом устройстве. Сначала экспортируйте нужные проекты в .mlink.</p><div class="row"><button class="btn outline" data-action="close-modal" style="flex:1">Отмена</button><button class="btn danger" style="flex:1" data-action="confirm-erase-all">Удалить всё</button></div>`);}
function privacyModal(){modal('Конфиденциальность',`<div class="prose"><p><strong>ModelLink не собирает данные.</strong> В приложении нет учётных записей, рекламы, аналитики и отслеживания.</p><p>Проекты, файлы, версии и замечания хранятся только на этом устройстве. Приложение не отправляет их на серверы и не обращается к сети.</p><p>Файл покидает устройство, только когда вы сами отправляете его через меню «Поделиться» (AirDrop, «Файлы», почта и т.&nbsp;д.).</p><p>Удалить все данные можно в «Настройках» или удалив приложение.</p></div>`);}
function aboutModal(){modal('О приложении',`<div class="prose"><p><strong>ModelLink ${APP_VERSION}</strong>. Чертежи, 3D-модели, замечания и версии проектов на телефоне.</p><p>Открывает любой файл. Просмотр: PDF, изображения (включая HEIC и TIFF), SVG, DXF, STL, OBJ, GLB, текст и код${IS_NATIVE?', а также Office, iWork, USDZ (AR), аудио и видео через Quick Look':''}.</p><p>Экспорт: DXF → SVG, PDF, PNG, JPEG; 3D → USDZ, STL, OBJ, GLB, PLY, PNG; изображения → PNG, JPEG, PDF${IS_NATIVE?'; PDF → страницы PNG/JPEG; текст, HTML, RTF → PDF':''}; любой файл → ZIP. Всё преобразуется на устройстве.</p><p>Измерения на DXF выводятся в единицах чертежа, на изображениях — в пикселях или в миллиметрах после калибровки. Перед производственными решениями сверяйте размеры в CAD-программе.</p><p class="small-muted">Компоненты с открытым кодом: JSZip (MIT), Capacitor (MIT).</p></div>`);}
function askDeleteProject(){modal('Удалить проект?',`<p class="lead" style="margin-bottom:22px">Будут удалены все локальные файлы, версии и замечания этого проекта. Действие нельзя отменить.</p><div class="row"><button class="btn outline" data-action="close-modal" style="flex:1">Отмена</button><button class="btn danger" style="flex:1" data-action="confirm-delete">Удалить</button></div>`);}
function versionsModal(projectId){getAssets(projectId).then(files=>{
  const groups=new Map();for(const f of files){if(!groups.has(f.groupId))groups.set(f.groupId,[]);groups.get(f.groupId).push(f);}
  modal('История версий',`<p class="small-muted" style="margin-bottom:10px">Редакции сохраняются автоматически при повторной загрузке файла с тем же именем.</p>${[...groups.values()].map(arr=>`<div class="group-card" style="margin-bottom:12px"><div style="font-size:14px;font-weight:750;margin:13px 0">${esc(arr[0].name)}</div>${arr.sort((a,b)=>b.version-a.version).map(f=>`<div class="version-item"><span>Версия ${f.version} <small style="color:var(--muted)">${date(f.createdAt)}</small></span><button class="btn tiny soft" data-action="open-asset" data-id="${f.id}">Открыть</button></div>`).join('')}</div>`).join('')||'<div class="empty">Версий нет</div>'}`);
});}
function exportPickerModal(files){modal('Экспорт файла',`<p class="small-muted" style="margin-bottom:12px">Выберите файл: его можно преобразовать в другой формат и отправить.</p><div class="file-list">${files.slice(0,40).map(f=>`<button class="file-row" data-action="export-picked" data-id="${esc(f.id)}"><span class="file-ext">${esc(fileInfo(f.name).label.slice(0,6))}</span><span class="body"><h3>${esc(niceName(f.name))}</h3><p>${formatBytes(f.size)}</p></span>${icon('arrow','small')}</button>`).join('')}</div><button class="btn outline block" style="margin-top:14px" data-action="share-project-picker">${icon('share','small')} Отправить проект целиком (.mlink)</button>`);}
function exportModal(f){const targets=conversionTargets(f.name,{native:IS_NATIVE});const meshNeedsView=['stl','obj','glb'].includes(extOf(f.name));
  const row=t=>`<div class="setting-row"><div><strong>${esc(t.label)}</strong><br><span>${esc(t.note||(t.engine==='native'?'Преобразование на iPhone':t.engine==='zip'?'Сжатый архив':'Преобразование на устройстве'))}</span></div><div class="row" style="gap:6px;flex-shrink:0"><button class="btn tiny soft" data-action="convert" data-to="${t.to}" data-engine="${t.engine}" data-mode="share" aria-label="${esc(t.label)}: поделиться">${icon('share','small')}</button><button class="btn tiny outline" data-action="convert" data-to="${t.to}" data-engine="${t.engine}" data-mode="project" aria-label="${esc(t.label)}: сохранить в проект">${icon('plus','small')}</button></div></div>`;
  modal('Экспорт',`<p class="small-muted" style="margin-bottom:12px"><strong>${esc(f.name)}</strong> · ${formatBytes(f.size)}<br>${icon('share','small')} — поделиться или сохранить в «Файлы», ${icon('plus','small')} — добавить в проект.</p><div class="group-card"><div class="setting-row"><div><strong>Оригинал .${esc(extOf(f.name)||'файл')}</strong><br><span>Без изменений</span></div><button class="btn tiny soft" data-action="share-file" aria-label="Поделиться оригиналом">${icon('share','small')}</button></div>${targets.map(row).join('')}</div>${meshNeedsView?'<p class="small-muted" style="margin-top:10px">PNG-снимок сохраняет текущий ракурс модели. USDZ открывается в AR через Quick Look.</p>':''}${targets.length?'':'<p class="small-muted" style="margin-top:10px">Для этого формата доступна только передача оригинала.</p>'}`);}
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
  if(action==='back-project'){await openProject(state.projectId);return;}
  if(action==='download-file'){const f=await getAsset(state.assetId);await saveBlob(f.blob,f.name);return;}
  if(action==='export-file'){const f=await getAsset(state.assetId);if(f)exportModal(f);return;}
  if(action==='export-picked'){closeModal();await openAsset(button.dataset.id);const f=await getAsset(button.dataset.id);if(f)exportModal(f);return;}
  if(action==='share-project-picker'){projectPickerModal(await getProjects(),'share');return;}
  if(action==='convert'){await convertAction(button);return;}
  if(action==='quicklook'){const f=await getAsset(state.assetId);if(!(await quickLook(f.blob,f.name)))notify('Этот формат нельзя открыть в Quick Look');return;}
  if(action==='delete-asset'){askDeleteAsset();return;}
  if(action==='confirm-delete-asset'){const a=await removeAsset(state.assetId);closeModal();notify('Версия файла удалена');const rest=latestFiles(await getAssets(a.projectId)).find(f=>f.groupId===a.groupId);if(rest)await openAsset(rest.id);else await openProject(a.projectId);return;}
  if(action==='privacy'){privacyModal();return;}
  if(action==='about'){aboutModal();return;}
  if(action==='erase-all'){askEraseAll();return;}
  if(action==='confirm-erase-all'){await removeAllData();closeModal();notify('Все данные удалены');selectTab('home');return;}
  if(action==='clear-scale'){await setAssetScale(state.assetId,null);closeModal();notify('Масштаб сброшен');await render();return;}
  if(action==='share-file'){const f=await getAsset(state.assetId);await shareBlob(f.blob,f.name);return;}
  if(action==='share-project'){await shareProject();return;}
  if(action==='share-picked-project'){state.projectId=button.dataset.id;closeModal();await shareProject();return;}
  if(action==='versions-picked-project'){closeModal();versionsModal(button.dataset.id);return;}
  if(action==='project-versions'){versionsModal(state.projectId);return;}
  if(action==='delete-project'){askDeleteProject();return;}
  if(action==='confirm-delete'){await removeProject(state.projectId);closeModal();notify('Проект удалён');selectTab('projects');return;}
  if(action==='toggle-note'){const note=state.notes.find(n=>n.id===button.dataset.id);if(note)await setNoteStatus(note.id,note.status==='resolved'?'open':'resolved');await render();return;}
  if(action==='viewer-tool'){state.viewerTool=button.dataset.tool;state.viewer?.setTool?.(state.viewerTool);if(state.viewerTool==='measure'&&!state.viewer?.measure)notify('Измерения доступны для DXF и изображений');if(state.viewerTool==='comment')notify('Коснитесь места для замечания');app.querySelectorAll('[data-action="viewer-tool"]').forEach(b=>{const on=b.dataset.tool===state.viewerTool;b.classList.toggle('soft',on);b.classList.toggle('active-tool',on);b.classList.toggle('outline',!on);});return;}
  if(action==='fit'){state.viewer?.fit?.();return;}
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

// ---------------------------------------------------------------- conversion
const MIME={svg:'image/svg+xml',png:'image/png',jpeg:'image/jpeg',pdf:'application/pdf',stl:'model/stl',obj:'model/obj',ply:'application/octet-stream',glb:'model/gltf-binary',usdz:'model/vnd.usdz+zip',zip:'application/zip'};
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
  if(ext==='dxf'){const svg=dxfToSVG(parseDXF(await f.blob.text()));if(to==='svg')return {files:[toFile(f,'svg',svg)]};
    return {files:[await canvasTo(await rasterize(new Blob([svg],{type:'image/svg+xml'}),{maxSide:3600,minSide:2400}),to,f)]};}
  if(['stl','obj','glb'].includes(ext)){
    if(to==='png'){const scene=document.getElementById('scene');if(!scene||state.assetId!==f.id)throw new Error('Откройте модель, чтобы сохранить снимок');return {files:[toFile(f,'png',await canvasBlob(scene,'image/png'))]};}
    const mesh=await parseMesh(f);
    const data={stl:()=>meshToSTL(mesh),obj:()=>meshToOBJ(mesh,baseName(f.name)),ply:()=>meshToPLY(mesh),glb:()=>meshToGLB(mesh),usdz:()=>meshToUSDZ(mesh,{upAxis:ext==='stl'?'Z':'Y'})}[to];
    if(!data)throw new Error('Неизвестный формат');return {files:[toFile(f,to,data())]};}
  if(f.kind==='image')return {files:[await canvasTo(await rasterize(f.blob,{minSide:ext==='svg'?2000:0}),to,f)]};
  throw new Error('Такое преобразование недоступно');
}
async function convertAction(button){
  const f=await getAsset(state.assetId);if(!f)throw new Error('Сначала откройте файл');
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
    previewUrl=URL.createObjectURL(f.blob);host.innerHTML=`<img class="preview-image" src="${previewUrl}" alt="${esc(f.name)}">`;
    const image=host.querySelector('img');image.addEventListener('error',()=>{host.innerHTML=`<div class="file-unsupported">${icon('image','large')}<h3>${esc(f.name)}</h3><p>Это изображение нельзя показать здесь.</p><div class="row" style="justify-content:center">${canQuickLook()?`<button class="btn primary" data-action="quicklook">${icon('eye','small')} Открыть</button>`:''}<button class="btn outline" data-action="export-file">${icon('export','small')} Экспорт</button></div></div>`;});image.addEventListener('load',()=>{
      const rect=image.getBoundingClientRect(),ratio=Math.min(rect.width/image.naturalWidth,rect.height/image.naturalHeight);
      const nw=image.naturalWidth*ratio,nh=image.naturalHeight*ratio,left=(rect.width-nw)/2,top=(rect.height-nh)/2;
      state.viewer={measure:true,setTool(){},fit(){},pxToWorld(e){return{x:(e.clientX-rect.left-left)/nw,y:(e.clientY-rect.top-top)/nh}},pictureBounds:{left,top,width:nw,height:nh}};
      for(const [i,n] of state.notes.filter(n=>n.assetId===f.id).entries()){
        const pin=document.createElement('button');pin.className='image-annotation';pin.textContent=String(i+1);pin.style.left=`${left+nw*(n.point?.x??.5)}px`;pin.style.top=`${top+nh*(n.point?.y??.5)}px`;pin.title=n.text;host.append(pin);
      }
    });
    host.addEventListener('click',e=>{
      if(e.target.closest('.image-annotation'))return;
      if(!state.viewer)return;
      const p=state.viewer.pxToWorld(e);if(p.x<0||p.x>1||p.y<0||p.y>1)return;
      if(state.viewerTool==='comment')newNoteModal(p);
      if(state.viewerTool==='measure'){
        state.measurePoints=state.measurePoints||[];if(state.measurePoints.length>=2){state.measurePoints=[];host.querySelectorAll('.measure-dot').forEach(x=>x.remove());}
        state.measurePoints.push(p);const bounds=state.viewer.pictureBounds;const dot=document.createElement('span');dot.className='measure-dot';dot.style.left=`${bounds.left+bounds.width*p.x}px`;dot.style.top=`${bounds.top+bounds.height*p.y}px`;host.append(dot);
        if(state.measurePoints.length===2){const [a,b]=state.measurePoints;const pixels=Math.hypot((a.x-b.x)*image.naturalWidth,(a.y-b.y)*image.naturalHeight);measureResultModal(pixels,f.mmPerPixel);}
      }
    });return;
  }
  if(f.kind==='ar'||(f.kind==='pdf'&&NativeML)){
    host.innerHTML=`<div class="file-unsupported">${icon(f.kind==='pdf'?'file':'cube','large')}<h3>${esc(f.name)}</h3><p>${f.kind==='pdf'?'Все страницы, поиск по тексту и масштабирование в системном просмотрщике.':'Объёмная модель и режим дополненной реальности в системном просмотрщике.'}</p>${canQuickLook(f.name)?`<button class="btn primary" data-action="quicklook">${icon('eye','small')} Открыть ${f.kind==='pdf'?'PDF':'модель'}</button>`:''}</div>`;
    document.getElementById('canvas-hint').textContent=f.kind==='pdf'?'Замечания добавляются кнопкой «Добавить»':'Quick Look доступен на iPhone';
    state.viewer={measure:false,setTool(){},fit(){}};return;
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
    if(form.id==='calibrate'){const length=Number(String(new FormData(form).get('length')).replace(',','.'));if(!(length>0)||!(state.lastPixels>0))throw new Error('Введите длину больше нуля');await setAssetScale(state.assetId,length/state.lastPixels);closeModal();notify(`Масштаб задан: ${formatLength(length)} = ${state.lastPixels.toFixed(1)} пикс.`);state.measurePoints=[];await render();state.viewerTool='measure';state.viewer?.setTool?.('measure');app.querySelectorAll('[data-action="viewer-tool"]').forEach(b=>{const on=b.dataset.tool==='measure';b.classList.toggle('soft',on);b.classList.toggle('active-tool',on);b.classList.toggle('outline',!on);});return;}
    if(form.id==='create-note'){const f=await getAsset(state.assetId);const fd=new FormData(form);if(!f)throw new Error('Сначала откройте файл');await addNote({projectId:f.projectId,assetId:f.id,text:fd.get('text'),point:state.pendingPoint||{x:.5,y:.5},locationType:state.pendingLocationType||'normalized'});state.pendingPoint=null;state.pendingLocationType='normalized';state.viewerTool='view';closeModal();await render();notify('Замечание сохранено');}
  }catch(err){notify(err.message||'Не удалось сохранить');}
});
document.addEventListener('input',e=>{if(e.target.id==='project-search'){const el=e.target;state.search=el.value;const start=el.selectionStart;render().then(()=>{const next=document.getElementById('project-search');next?.focus();next?.setSelectionRange(start,start);});}});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)nativeDrain();});
async function init(){
  if(NativeML)NativeML.addListener('inboxChanged',()=>nativeDrain()).catch(console.warn);
  navigator.storage?.persist?.().catch(()=>{});
  try{state.theme=localStorage.getItem('modellink-theme')||'light';document.body.classList.toggle('dark',state.theme==='dark');await initDemo();await render();if(!IS_NATIVE&&'serviceWorker' in navigator&&location.protocol==='https:')navigator.serviceWorker.register('./sw.js').catch(console.warn);await nativeDrain();}
  catch(e){console.error(e);app.innerHTML=`<div class="boot-screen">${icon('warning','large')}<h2>Не удалось открыть хранилище</h2><p class="lead" style="text-align:center;padding:20px">Проверьте разрешения браузера и свободное место на устройстве.</p></div>`;}
}
init();
