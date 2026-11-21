import {getProject,getAssets,getNotes,createProject,addAsset,addNote,setNoteStatus} from './storage.js';
export const PACKAGE_VERSION=1;
export function validPath(path){
  return typeof path==='string' && !!path && path.length<=220 && !path.startsWith('/') && !path.includes('\\') && !path.split('/').some(x=>x==='..'||x==='') && !/^[A-Za-z]:/.test(path);
}
export function validatePackageManifest(manifest){
  if(!manifest||manifest.format!=='modellink-package'||manifest.version!==PACKAGE_VERSION)throw new Error('Это не поддерживаемый пакет ModelLink');
  if(typeof manifest.project?.name!=='string'||!manifest.project.name.trim())throw new Error('В пакете нет имени проекта');
  if(!Array.isArray(manifest.files)||manifest.files.length>256||!Array.isArray(manifest.notes))throw new Error('Некорректный пакет');
  if(manifest.notes.length>3000)throw new Error('Слишком много замечаний');
  for(const f of manifest.files){if(!validPath(f.path)||!validPath(f.entry)||typeof f.id!=='string'||!Number.isSafeInteger(f.size)||f.size<0||f.size>100*1024*1024)throw new Error('Недопустимый файл пакета');}
  return true;
}
export async function exportProject(projectId,JSZip){
  const p=await getProject(projectId);if(!p)throw new Error('Проект не найден');
  const files=await getAssets(projectId),notes=await getNotes(projectId);
  const zip=new JSZip();
  const manifest={format:'modellink-package',version:PACKAGE_VERSION,created:new Date().toISOString(),project:{name:p.name,description:p.description},files:[],notes:notes.map(n=>({assetId:n.assetId,text:n.text,point:n.point,locationType:n.locationType,page:n.page,status:n.status,createdAt:n.createdAt}))};
  for(let i=0;i<files.length;i++){
    const f=files[i],entry=`files/${i.toString().padStart(4,'0')}`;
    zip.file(entry,f.blob);
    manifest.files.push({entry,id:f.id,path:f.path,name:f.name,mime:f.mime,size:f.size,groupId:f.groupId,version:f.version,createdAt:f.createdAt});
  }
  zip.file('manifest.json',JSON.stringify(manifest,null,2));
  const blob=await zip.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:3}});
  if(blob.size>200*1024*1024)throw new Error('Пакет превышает 200 МБ');
  return blob;
}
export async function importProjectPackage(blob,JSZip){
  if(blob.size>200*1024*1024)throw new Error('Максимальный размер пакета: 200 МБ');
  const zip=await JSZip.loadAsync(blob,{checkCRC32:true});
  const entry=zip.file('manifest.json');if(!entry)throw new Error('В пакете нет manifest.json');
  const manifest=JSON.parse(await entry.async('string'));
  validatePackageManifest(manifest);
  if(manifest.files.reduce((acc,f)=>acc+f.size,0)>200*1024*1024)throw new Error('Слишком большой объём распаковки');
  for(const f of manifest.files)if(!zip.file(f.entry))throw new Error(`В пакете отсутствует ${f.path}`);
  const p=await createProject(manifest.project.name,manifest.project.description||'');
  const map=new Map();
  try{
    const files=[...manifest.files].sort((a,b)=>a.path.localeCompare(b.path)||a.version-b.version);
    for(const item of files){
      const raw=await zip.file(item.entry).async('blob');
      if(raw.size!==item.size)throw new Error(`Ошибка размера: ${item.name}`);
      const name=String(item.name||item.path.split('/').at(-1)).slice(0,150);
      const file=new File([raw],name,{type:item.mime||'application/octet-stream'});
      const asset=await addAsset(p.id,file,{path:item.path});
      map.set(item.id,asset.id);
    }
    for(const note of manifest.notes){
      if(!map.has(note.assetId)||!String(note.text||'').trim())continue;
      const stored=await addNote({projectId:p.id,assetId:map.get(note.assetId),text:note.text,point:note.point,locationType:note.locationType||'normalized',page:note.page||1});
      if(note.status==='resolved')await setNoteStatus(stored.id,'resolved');
    }
    return p;
  } catch(e){
    // Partial projects are still visible for recovery, rather than silently disappearing.
    throw new Error(`${e.message} (проект ${p.name} создан частично)`);
  }
}
