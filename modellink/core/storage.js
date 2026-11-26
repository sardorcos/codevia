const NAME = 'modellink-mobile-v04';
const VERSION = 2;
const MAX_FILE = 100 * 1024 * 1024;
const STORE = {projects:'projects',assets:'assets',notes:'notes',prefs:'prefs',sandbox:'sandbox',sent:'sent'};
// Vault: assets of vault projects are stored sealed (AES-GCM) with a device key the app provides after Face ID.
let vaultKey=null,sealFns=null;
export function setVaultCrypto(key,fns){vaultKey=key;if(fns)sealFns=fns;}
export function vaultUnlocked(){return !!vaultKey;}
async function sha256Hex(blob){try{const d=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());return [...new Uint8Array(d)].map(b=>b.toString(16).padStart(2,'0')).join('');}catch{return null;}}
async function unseal(asset){if(!asset||!asset.sealed)return asset;if(!vaultKey||!sealFns)throw new Error('Сейф заблокирован');const plain=await sealFns.open(vaultKey,new Uint8Array(await asset.blob.arrayBuffer()));return {...asset,blob:new Blob([plain],{type:asset.mime}),sealed:false};}
let dbPromise;

export function uid(){return (globalThis.crypto?.randomUUID?.() || `ml-${Date.now()}-${Math.random().toString(36).slice(2)}`);}
export function openDatabase(){
  if(!dbPromise) dbPromise=new Promise((resolve,reject)=>{
    const request=indexedDB.open(NAME,VERSION);
    request.onupgradeneeded=()=>{
      const db=request.result;
      for(const name of Object.values(STORE)){ if(!db.objectStoreNames.contains(name)) db.createObjectStore(name,{keyPath:'id'}); }
    };
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
  return dbPromise;
}
async function execute(store,mode,fn){
  const db=await openDatabase();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(store,mode);
    let output;let caught;
    try {output=fn(tx.objectStore(store));} catch(e){caught=e;tx.abort();}
    tx.oncomplete=()=>resolve(output);
    tx.onerror=()=>reject(tx.error||caught);
    tx.onabort=()=>reject(tx.error||caught||new Error('Транзакция прервана'));
  });
}
export async function all(store){
  const db=await openDatabase();
  return new Promise((resolve,reject)=>{
    const request=db.transaction(store).objectStore(store).getAll();
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
}
export async function one(store,id){
  const db=await openDatabase();
  return new Promise((resolve,reject)=>{
    const request=db.transaction(store).objectStore(store).get(id);
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
}
export async function put(store,obj){return execute(store,'readwrite',s=>s.put(obj));}
export async function del(store,id){return execute(store,'readwrite',s=>s.delete(id));}

export async function createProject(name,description='',demo=false){
  if(!String(name).trim()) throw new Error('Введите название проекта');
  const project={id:uid(),name:String(name).trim().slice(0,100),description:String(description).trim().slice(0,350),createdAt:Date.now(),updatedAt:Date.now(),demo};
  await put(STORE.projects,project);return project;
}
export async function getProjects(){return (await all(STORE.projects)).sort((a,b)=>b.updatedAt-a.updatedAt);}
export async function getProject(id){return one(STORE.projects,id);}
export async function getAssets(projectId,{decrypt=true}={}){const list=(await all(STORE.assets)).filter(f=>f.projectId===projectId).sort((a,b)=>b.createdAt-a.createdAt);return decrypt?Promise.all(list.map(unseal)):list;}
export async function getAllAssets(){return all(STORE.assets);}
export async function getAsset(id){return unseal(await one(STORE.assets,id));}
export async function getAssetRaw(id){return one(STORE.assets,id);}
export async function addAsset(projectId,file,opts={}){
  const project=await getProject(projectId);
  if(!project) throw new Error('Проект не найден');
  const size=file.size;
  if(!Number.isFinite(size)||size>MAX_FILE) throw new Error('Максимальный размер одного файла: 100 МБ');
  const path=String(opts.path||file.name).replace(/\\/g,'/').replace(/^\/+/, '');
  if(path.split('/').includes('..')) throw new Error('Недопустимый путь файла');
  const exists=(await getAssets(projectId,{decrypt:false})).filter(f=>f.path===path).sort((a,b)=>b.version-a.version);
  const newest=exists[0];
  const asset={id:uid(),projectId,name:file.name,path,groupId:newest?.groupId||uid(),version:(newest?.version||0)+1,
    size, mime:file.type||'application/octet-stream',blob:file,createdAt:Date.now(),kind:kindFor(file.name),sha256:await sha256Hex(file)};
  if(project.vault){if(!vaultKey||!sealFns)throw new Error('Сейф заблокирован');asset.blob=new Blob([await sealFns.seal(vaultKey,new Uint8Array(await file.arrayBuffer()))]);asset.sealed=true;}
  await put(STORE.assets,asset);
  project.updatedAt=Date.now();await put(STORE.projects,project);
  return asset;
}
export async function removeAsset(id){
  const asset=await one(STORE.assets,id);if(!asset)throw new Error('Файл не найден');
  for(const note of (await getNotes(asset.projectId)).filter(n=>n.assetId===id)) await del(STORE.notes,note.id);
  await del(STORE.assets,id);
  const project=await getProject(asset.projectId);if(project){project.updatedAt=Date.now();await put(STORE.projects,project);}
  return asset;
}
/** Physical scale for raster/vector images: millimetres per source pixel. */
export async function setAssetScale(id,mmPerPixel){
  const asset=await one(STORE.assets,id);if(!asset)throw new Error('Файл не найден');
  if(mmPerPixel!==null&&!(Number.isFinite(mmPerPixel)&&mmPerPixel>0))throw new Error('Некорректный масштаб');
  asset.mmPerPixel=mmPerPixel;await put(STORE.assets,asset);return asset;
}
export async function renameProject(id,name,description){
  const project=await getProject(id);if(!project)throw new Error('Проект не найден');
  if(!String(name||'').trim())throw new Error('Введите название проекта');
  project.name=String(name).trim().slice(0,100);if(description!==undefined)project.description=String(description).trim().slice(0,350);
  project.updatedAt=Date.now();await put(STORE.projects,project);return project;
}
/** Renames every version of a file (they share groupId) and keeps the extension unless a new one is typed. */
export async function renameAsset(id,newName){
  const asset=await one(STORE.assets,id);if(!asset)throw new Error('Файл не найден');
  let name=String(newName||'').trim().replace(/[\\/:*?"<>|]/g,'_').slice(0,150);if(!name)throw new Error('Введите имя файла');
  const ext=asset.name.includes('.')?asset.name.split('.').at(-1):'';if(ext&&!name.toLowerCase().endsWith('.'+ext.toLowerCase())&&!/\.[a-z0-9]{1,6}$/i.test(name))name+='.'+ext;
  for(const v of (await getAssets(asset.projectId,{decrypt:false})).filter(x=>x.groupId===asset.groupId)){v.name=name;v.path=name;v.kind=kindFor(name);await put(STORE.assets,v);}
  return name;
}
export async function removeNote(id){await del(STORE.notes,id);}
/** Moves a project into or out of the vault, sealing / unsealing every file version. */
export async function setProjectVault(id,inVault){
  const project=await getProject(id);if(!project)throw new Error('Проект не найден');if(!vaultKey||!sealFns)throw new Error('Сейф заблокирован');
  for(const a of await getAssets(id,{decrypt:false})){
    if(inVault&&!a.sealed){a.blob=new Blob([await sealFns.seal(vaultKey,new Uint8Array(await a.blob.arrayBuffer()))]);a.sealed=true;await put(STORE.assets,a);}
    if(!inVault&&a.sealed){const plain=await unseal(a);await put(STORE.assets,{...plain,sealed:false});}
  }
  project.vault=!!inVault;project.updatedAt=Date.now();await put(STORE.projects,project);return project;
}
export async function updateAssetMeta(id,patch){const a=await one(STORE.assets,id);if(!a)throw new Error('Файл не найден');Object.assign(a,patch);await put(STORE.assets,a);return a;}
/** Fills in missing fingerprints (files added before 0.7). */
export async function ensureFingerprints(){for(const a of await all(STORE.assets)){if(a.sha256||a.sealed)continue;a.sha256=await sha256Hex(a.blob);if(a.sha256)await put(STORE.assets,a);}}
// Protected packages received (sandbox) and sent (sender registry) + small key/value preferences.
export const sandbox={all:()=>all(STORE.sandbox),get:id=>one(STORE.sandbox,id),put:r=>put(STORE.sandbox,r),del:id=>del(STORE.sandbox,id),clear:async()=>{for(const r of await all(STORE.sandbox))await del(STORE.sandbox,r.id);}};
export const sent={all:()=>all(STORE.sent),get:id=>one(STORE.sent,id),put:r=>put(STORE.sent,r),del:id=>del(STORE.sent,id)};
export async function pref(key,fallback=null){const r=await one(STORE.prefs,key);return r?r.value:fallback;}
export async function setPref(key,value){await put(STORE.prefs,{id:key,value});}
export async function removeAllData(){
  for(const store of Object.values(STORE)){if(store===STORE.prefs)continue;for(const item of await all(store))await del(store,item.id);}
}
export async function removeProject(id){
  const assets=await getAssets(id,{decrypt:false});const notes=await getNotes(id);
  for(const asset of assets) await del(STORE.assets,asset.id);
  for(const note of notes) await del(STORE.notes,note.id);
  await del(STORE.projects,id);
}
export async function getNotes(projectId){return (await all(STORE.notes)).filter(n=>n.projectId===projectId).sort((a,b)=>b.createdAt-a.createdAt);}
export async function getAllNotes(){return all(STORE.notes);}
export async function addNote({projectId,assetId,text,point,locationType='normalized',page=1,audio=null,audioDuration=0}){
  if(!String(text||'').trim()&&!audio) throw new Error('Напишите замечание');
  if(!String(text||'').trim())text='—';
  const asset=await one(STORE.assets,assetId);
  if(!asset||asset.projectId!==projectId) throw new Error('Файл не найден');
  const note={id:uid(),projectId,assetId,version:asset.version,text:String(text).trim().slice(0,1200),point,locationType,page,status:'open',createdAt:Date.now(),...(audio?{audio,audioDuration}:{})};
  await put(STORE.notes,note);return note;
}
export async function setNoteStatus(id,status){
  const note=await one(STORE.notes,id);
  if(!note) throw new Error('Замечание не найдено');
  note.status=status==='resolved'?'resolved':'open';await put(STORE.notes,note);return note;
}
export function latestFiles(allFiles){
  const byGroup=new Map();
  for(const file of allFiles){const prev=byGroup.get(file.groupId);if(!prev||file.version>prev.version)byGroup.set(file.groupId,file);}
  return [...byGroup.values()].sort((a,b)=>b.createdAt-a.createdAt);
}
export function kindFor(name){
  const ext=String(name).split('.').at(-1)?.toLowerCase();
  if(['svg','png','jpg','jpeg','gif','webp','bmp','heic','heif','tif','tiff'].includes(ext))return 'image';
  if(['txt','md','markdown','csv','tsv','json','xml','html','htm','css','js','mjs','ts','py','php','java','c','h','cpp','swift','kt','rb','go','rs','sh','yml','yaml','ini','cfg','conf','log','sql','gcode','nc','tex','toml','env','properties'].includes(ext))return 'text';
  if(['pdf'].includes(ext))return 'pdf';
  if(['dxf','dwg'].includes(ext))return 'drawing';
  if(['obj','stl','glb','gltf','fbx','3ds','dae','ply','3mf','max'].includes(ext))return 'model';
  if(['mlink'].includes(ext))return 'bundle';
  if(['usdz','reality'].includes(ext))return 'ar';
  if(['mp3','m4a','aac','wav','caf','aiff','aif','ogg','oga','opus','flac','webm'].includes(ext))return 'audio';
  return 'source';
}
export const capabilities={
  pdf:{label:'PDF',preview:'yes',note:'Встроенный PDF-просмотрщик'},
  svg:{label:'SVG',preview:'yes',note:'Векторная графика'},
  png:{label:'PNG',preview:'yes',note:'Изображение'},jpg:{label:'JPG',preview:'yes',note:'Изображение'},jpeg:{label:'JPEG',preview:'yes',note:'Изображение'},webp:{label:'WebP',preview:'yes',note:'Изображение'},gif:{label:'GIF',preview:'yes',note:'Изображение'},bmp:{label:'BMP',preview:'yes',note:'Изображение'},
  dxf:{label:'DXF',preview:'yes',note:'Блоки, слои, цвета, сплайны, штриховки, размеры и тексты'},
  obj:{label:'OBJ',preview:'yes',note:'Полигональная геометрия; без материалов MTL'},
  stl:{label:'STL',preview:'yes',note:'Треугольные 3D-модели'},
  glb:{label:'GLB',preview:'yes',note:'glTF 2.0: материалы, текстуры, иерархия'},
  heic:{label:'HEIC',preview:'yes',note:'Фото iPhone; конвертация в JPEG, PNG и PDF'},tif:{label:'TIFF',preview:'yes',note:'Изображение'},tiff:{label:'TIFF',preview:'yes',note:'Изображение'},
  txt:{label:'TXT',preview:'yes',note:'Текст; экспорт в PDF'},csv:{label:'CSV',preview:'yes',note:'Таблица как текст; экспорт в PDF'},json:{label:'JSON',preview:'yes',note:'Текст'},xml:{label:'XML',preview:'yes',note:'Текст'},gcode:{label:'G-code',preview:'yes',note:'Программа ЧПУ как текст'},
  docx:{label:'DOCX',preview:'source',note:'Просмотр через Quick Look на iPhone'},xlsx:{label:'XLSX',preview:'source',note:'Просмотр через Quick Look на iPhone'},pptx:{label:'PPTX',preview:'source',note:'Просмотр через Quick Look на iPhone'},
  zip:{label:'ZIP',preview:'source',note:'Архив хранится и передаётся'},mp3:{label:'MP3',preview:'yes',note:'Аудио: прослушивание'},m4a:{label:'M4A',preview:'yes',note:'Аудио: прослушивание'},wav:{label:'WAV',preview:'yes',note:'Аудио: прослушивание'},
  fbx:{label:'FBX',preview:'yes',note:'Autodesk FBX: сетки, материалы, текстуры, иерархия'},'3ds':{label:'3DS',preview:'yes',note:'3D Studio: сетки и материалы'},
  dae:{label:'DAE',preview:'yes',note:'Collada'},ply:{label:'PLY',preview:'yes',note:'Сетки и облака точек'},'3mf':{label:'3MF',preview:'yes',note:'Формат 3D-печати'},gltf:{label:'glTF',preview:'partial',note:'glTF со встроенными данными; для внешних файлов используйте GLB'},
  max:{label:'MAX',preview:'partial',note:'3ds Max: Editable Poly/Mesh и примитивы, миниатюра и свойства сцены; модификаторы, сплайны и прокси не вычисляются'},
  usdz:{label:'USDZ',preview:'yes',note:'3D и дополненная реальность через Quick Look на iPhone'},
  dwg:{label:'DWG',preview:'yes',note:'AutoCAD R13–2018+: пространство модели, блоки, слои, цвета, размеры; экспорт в DXF, PDF, SVG, PNG'},
  step:{label:'STEP',preview:'source',note:'Оригинал хранится и передаётся; для просмотра добавьте копию в GLB или STL'},stp:{label:'STP',preview:'source',note:'Оригинал хранится и передаётся; для просмотра добавьте копию в GLB или STL'},
  ifc:{label:'IFC',preview:'source',note:'Оригинал хранится и передаётся; для просмотра добавьте копию в GLB'},rvt:{label:'RVT',preview:'source',note:'Исходник можно сохранить и передать; прямого просмотра нет'},
  sldprt:{label:'SLDPRT',preview:'source',note:'Исходник можно сохранить и передать; для просмотра экспортируйте STEP'},
  sldasm:{label:'SLDASM',preview:'source',note:'Сборку сохраняют вместе со связанными файлами'},
  skp:{label:'SKP',preview:'source',note:'Исходник; для просмотра нужен экспорт в GLB'},
  '3dm':{label:'3DM',preview:'source',note:'Исходник Rhino; для просмотра экспортируйте GLB или OBJ'},
  fcstd:{label:'FreeCAD',preview:'source',note:'Исходник FreeCAD; для просмотра экспортируйте STL или OBJ'},
  igs:{label:'IGES',preview:'source',note:'Исходник; для просмотра экспортируйте STL или GLB'},iges:{label:'IGES',preview:'source',note:'Исходник; для просмотра экспортируйте STL или GLB'}
};
export function fileInfo(name){
  const ext=name.split('.').at(-1)?.toLowerCase()||'';
  return {ext:ext.toUpperCase(),...(capabilities[ext]||{label:ext.toUpperCase()||'Файл',preview:'source',note:'Оригинал: просмотр через Quick Look (iPhone), экспорт в ZIP, передача'})};
}
export function formatBytes(value){if(value<1024)return `${value} Б`;if(value<1048576)return `${(value/1024).toFixed(1).replace('.0','')} КБ`;return `${(value/1048576).toFixed(1).replace('.0','')} МБ`;}
export async function initDemo(t=x=>x){
  const projects=await getProjects();if(projects.length||localStorage.getItem('modellink-demo-seeded'))return;
  const p=await createProject(t('Демо · План склада'),t('Пример для знакомства с просмотром и замечаниями'),true);
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 590"><rect width="900" height="590" fill="#fff"/><g stroke="#23324e" stroke-width="4" fill="none"><rect x="70" y="80" width="750" height="425"/><path d="M395 80v425M610 80v425M70 300h325M610 300h210M160 300v205M395 195h215"/><rect x="96" y="105" width="262" height="150" stroke="#98a7be" stroke-width="2"/><path d="M160 300v60M395 370v80" stroke="#fff" stroke-width="9"/><path d="M395 370q-80 0-80 80M160 360q60 0 60-60" stroke="#5472d8" stroke-width="2"/></g><g font-family="Arial" fill="#536078" font-size="25"><text x="168" y="188">СКЛАД</text><text x="448" y="155">ОФИС</text><text x="657" y="175">ЦЕХ</text><text x="190" y="445">ПОГРУЗКА</text><text x="667" y="421">ВЫХОД</text></g><g fill="none" stroke="#3e70fa" stroke-width="2"><path d="M70 65h750M70 57v16M820 57v16"/></g><text x="420" y="54" text-anchor="middle" font-family="Arial" font-size="16" fill="#3e70fa">30 м</text></svg>`;
  const drawing=await addAsset(p.id,new File([svg],t('План склада.svg'),{type:'image/svg+xml'}));
  await addNote({projectId:p.id,assetId:drawing.id,text:t('Проверить ширину прохода для погрузчика'),point:{x:.43,y:.57}});
  const obj=`# ModelLink demo, simple beam frame\no Frame\nv -1 -0.5 -0.2\nv 1 -0.5 -0.2\nv 1 0.5 -0.2\nv -1 0.5 -0.2\nv -1 -0.5 0.2\nv 1 -0.5 0.2\nv 1 0.5 0.2\nv -1 0.5 0.2\nf 1 2 3 4\nf 5 8 7 6\nf 1 5 6 2\nf 2 6 7 3\nf 3 7 8 4\nf 5 1 4 8\n`;
  await addAsset(p.id,new File([obj],t('3D-элемент.obj'),{type:'text/plain'}));
  localStorage.setItem('modellink-demo-seeded','1');
}
