// i18n/strings.tsv (ru en uz kk tr de es fr zh, tab-separated; empty cell = English fallback) → i18n/strings.js. Run after editing translations: node scripts/i18n.mjs
import {readFileSync,writeFileSync} from 'node:fs';
const rows=readFileSync(new URL('../i18n/strings.tsv',import.meta.url),'utf8').split('\n').filter(Boolean).map(l=>l.split('\t')).filter(r=>r.length>=3&&r[0].trim()&&!r[0].startsWith('#')).map(r=>{while(r.length>1&&!r[r.length-1])r.pop();return r;});
const seen=new Set(),out=[];for(const r of rows){if(seen.has(r[0]))continue;seen.add(r[0]);out.push(r);}
writeFileSync(new URL('../i18n/strings.js',import.meta.url),'// Generated from strings.tsv by scripts/i18n.mjs\nexport default '+JSON.stringify(out)+';\n');
console.log(`i18n: ${out.length} strings`);
