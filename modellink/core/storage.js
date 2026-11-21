const NAME = 'modellink-mobile-v04';
const VERSION = 1;
const MAX_FILE = 100 * 1024 * 1024;
const STORE = {projects:'projects',assets:'assets',notes:'notes',prefs:'prefs'};
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
export async function getAssets(projectId){return (await all(STORE.assets)).filter(f=>f.projectId===projectId).sort((a,b)=>b.createdAt-a.createdAt);}
export async function getAllAssets(){return all(STORE.assets);}
export async function getAsset(id){return one(STORE.assets,id);}
export async function addAsset(projectId,file,opts={}){
  const project=await getProject(projectId);
  if(!project) throw new Error('Проект не найден');
  const size=file.size;
  if(!Number.isFinite(size)||size>MAX_FILE) throw new Error('Максимальный размер одного файла: 100 МБ');
  const path=String(opts.path||file.name).replace(/\\/g,'/').replace(/^\/+/, '');
  if(path.split('/').includes('..')) throw new Error('Недопустимый путь файла');
  const exists=(await getAssets(projectId)).filter(f=>f.path===path).sort((a,b)=>b.version-a.version);
  const newest=exists[0];
  const asset={id:uid(),projectId,name:file.name,path,groupId:newest?.groupId||uid(),version:(newest?.version||0)+1,
    size, mime:file.type||'application/octet-stream',blob:file,createdAt:Date.now(),kind:kindFor(file.name)};
  await put(STORE.assets,asset);
  project.updatedAt=Date.now();await put(STORE.projects,project);
  return asset;
}
export async function removeAsset(id){
  const asset=await getAsset(id);if(!asset)throw new Error('Файл не найден');
  for(const note of (await getNotes(asset.projectId)).filter(n=>n.assetId===id)) await del(STORE.notes,note.id);
  await del(STORE.assets,id);
  const project=await getProject(asset.projectId);if(project){project.updatedAt=Date.now();await put(STORE.projects,project);}
  return asset;
}
/** Physical scale for raster/vector images: millimetres per source pixel. */
export async function setAssetScale(id,mmPerPixel){
  const asset=await getAsset(id);if(!asset)throw new Error('Файл не найден');
  if(mmPerPixel!==null&&!(Number.isFinite(mmPerPixel)&&mmPerPixel>0))throw new Error('Некорректный масштаб');
  asset.mmPerPixel=mmPerPixel;await put(STORE.assets,asset);return asset;
}
export async function removeAllData(){
  for(const store of Object.values(STORE)){for(const item of await all(store))await del(store,item.id);}
}
export async function removeProject(id){
  const assets=await getAssets(id);const notes=await getNotes(id);
  for(const asset of assets) await del(STORE.assets,asset.id);
  for(const note of notes) await del(STORE.notes,note.id);
  await del(STORE.projects,id);
}
export async function getNotes(projectId){return (await all(STORE.notes)).filter(n=>n.projectId===projectId).sort((a,b)=>b.createdAt-a.createdAt);}
export async function getAllNotes(){return all(STORE.notes);}
export async function addNote({projectId,assetId,text,point,locationType='normalized',page=1}){
  if(!String(text||'').trim()) throw new Error('Напишите замечание');
  const asset=await getAsset(assetId);
  if(!asset||asset.projectId!==projectId) throw new Error('Файл не найден');
  const note={id:uid(),projectId,assetId,version:asset.version,text:String(text).trim().slice(0,1200),point,locationType,page,status:'open',createdAt:Date.now()};
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
  if(['svg','png','jpg','jpeg','gif','webp','bmp'].includes(ext))return 'image';
  if(['pdf'].includes(ext))return 'pdf';
  if(['dxf'].includes(ext))return 'drawing';
  if(['obj','stl','glb'].includes(ext))return 'model';
  if(['mlink'].includes(ext))return 'bundle';
  if(['usdz','reality'].includes(ext))return 'ar';
  return 'source';
}
export const capabilities={
  pdf:{label:'PDF',preview:'yes',note:'Встроенный PDF-просмотрщик'},
  svg:{label:'SVG',preview:'yes',note:'Векторная графика'},
  png:{label:'PNG',preview:'yes',note:'Изображение'},jpg:{label:'JPG',preview:'yes',note:'Изображение'},jpeg:{label:'JPEG',preview:'yes',note:'Изображение'},webp:{label:'WebP',preview:'yes',note:'Изображение'},gif:{label:'GIF',preview:'yes',note:'Изображение'},bmp:{label:'BMP',preview:'yes',note:'Изображение'},
  dxf:{label:'DXF',preview:'partial',note:'Базовые линии, окружности, дуги, полилинии и подписи'},
  obj:{label:'OBJ',preview:'partial',note:'Полигональная геометрия; без материалов MTL'},
  stl:{label:'STL',preview:'yes',note:'Треугольные 3D-модели'},
  glb:{label:'GLB',preview:'partial',note:'Базовые треугольные glTF 2.0 модели; без расширений сжатия'},
  usdz:{label:'USDZ',preview:'yes',note:'3D и дополненная реальность через Quick Look на iPhone'},
  dwg:{label:'DWG',preview:'source',note:'Оригинал хранится и передаётся; для просмотра сохраните копию в DXF или PDF'},
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
  return {ext:ext.toUpperCase(),...(capabilities[ext]||{label:ext.toUpperCase()||'Файл',preview:'source',note:'Сохранение и передача оригинала'})};
}
export function formatBytes(value){if(value<1024)return `${value} Б`;if(value<1048576)return `${(value/1024).toFixed(1).replace('.0','')} КБ`;return `${(value/1048576).toFixed(1).replace('.0','')} МБ`;}
export async function initDemo(){
  const projects=await getProjects();if(projects.length||localStorage.getItem('modellink-demo-seeded'))return;
  const p=await createProject('Демо · План склада','Пример для знакомства с просмотром и замечаниями',true);
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 590"><rect width="900" height="590" fill="#fff"/><g stroke="#23324e" stroke-width="4" fill="none"><rect x="70" y="80" width="750" height="425"/><path d="M395 80v425M610 80v425M70 300h325M610 300h210M160 300v205M395 195h215"/><rect x="96" y="105" width="262" height="150" stroke="#98a7be" stroke-width="2"/><path d="M160 300v60M395 370v80" stroke="#fff" stroke-width="9"/><path d="M395 370q-80 0-80 80M160 360q60 0 60-60" stroke="#5472d8" stroke-width="2"/></g><g font-family="Arial" fill="#536078" font-size="25"><text x="168" y="188">СКЛАД</text><text x="448" y="155">ОФИС</text><text x="657" y="175">ЦЕХ</text><text x="190" y="445">ПОГРУЗКА</text><text x="667" y="421">ВЫХОД</text></g><g fill="none" stroke="#3e70fa" stroke-width="2"><path d="M70 65h750M70 57v16M820 57v16"/></g><text x="420" y="54" text-anchor="middle" font-family="Arial" font-size="16" fill="#3e70fa">30 м</text></svg>`;
  const drawing=await addAsset(p.id,new File([svg],'План склада.svg',{type:'image/svg+xml'}));
  await addNote({projectId:p.id,assetId:drawing.id,text:'Проверить ширину прохода для погрузчика',point:{x:.43,y:.57}});
  const obj=`# ModelLink demo, simple beam frame\no Frame\nv -1 -0.5 -0.2\nv 1 -0.5 -0.2\nv 1 0.5 -0.2\nv -1 0.5 -0.2\nv -1 -0.5 0.2\nv 1 -0.5 0.2\nv 1 0.5 0.2\nv -1 0.5 0.2\nf 1 2 3 4\nf 5 8 7 6\nf 1 5 6 2\nf 2 6 7 3\nf 3 7 8 4\nf 5 1 4 8\n`;
  await addAsset(p.id,new File([obj],'3D-элемент.obj',{type:'text/plain'}));
  localStorage.setItem('modellink-demo-seeded','1');
}
