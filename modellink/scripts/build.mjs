import {cp,copyFile,rm,mkdir,writeFile} from 'node:fs/promises';
const root=new URL('../',import.meta.url);
const dir=new URL('../www/',import.meta.url);
await rm(dir,{recursive:true,force:true});await mkdir(dir,{recursive:true});
for(const path of ['index.html','styles.css','app.js','manifest.webmanifest','sw.js']) await copyFile(new URL('../'+path,import.meta.url),new URL('../www/'+path,import.meta.url));
for(const path of ['core','assets','vendor'])await cp(new URL('../'+path,import.meta.url),new URL('../www/'+path,import.meta.url),{recursive:true});
console.log('ModelLink web build → www/');
