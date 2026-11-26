import {readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {Script} from 'node:vm';
const file=(name)=>readFile(new URL('../'+name,import.meta.url),'utf8');
let html=await file('index.html');
const css=await file('styles.css'),vendor=await file('vendor/jszip.min.js');
const modules=await Promise.all(['core/storage.js','core/geometry.js','core/pack.js','app.js'].map(file));
const js=modules.map(source=>source.replace(/^import\s+[^;]+;\s*$/gm,'').replace(/^export\s+/gm,'')).join('\n;\n');
new Script(js);
html=html.replace('<link rel="stylesheet" href="styles.css" />',`<style>${css}</style>`)
  .replace('<script defer src="vendor/jszip.min.js"></script>','')
  .replace('<script type="module" src="app.js"></script>','')
  .replace('</body>',`<script>${vendor}</script><script>${js}</script></body>`);
const output=new URL('../../ModelLink-0.4.0-preview.html',import.meta.url);
await writeFile(output,html);
console.log(`Single-file preview → ${output.pathname} (${(html.length/1024).toFixed(0)} KiB)`);
