// Every Cyrillic text piece in the sources must translate (exact phrase or fragments), except code and demo-drawing labels.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
globalThis.localStorage={getItem:()=>null,setItem(){}};globalThis.document={documentElement:{}};
const {setLang,t}=await import('../core/i18n.js');
const root=new URL('..',import.meta.url).pathname;
const ALLOW=/replace\(\/|\.test\(|^(СКЛАД|ОФИС|ЦЕХ|ПОГРУЗКА|ВЫХОД|30 м)$/;
test('no untranslated interface text (en, de, zh)',()=>{
  const files=['app.js','index.html',...fs.readdirSync(root+'core').filter(f=>f.endsWith('.js')&&f!=='i18n.js').map(f=>'core/'+f)];
  for(const L of ['en','de','zh']){
    setLang(L);const left=new Set();
    for(const f of files){const s=fs.readFileSync(root+f,'utf8').replace(/\/\*[\s\S]*?\*\//g,'').replace(/^\s*\/\/.*$/gm,'');
      for(const m of s.matchAll(/[^'"`<>{}$\n]*[А-Яа-яЁё][^'"`<>{}$\n]*/g)){const piece=m[0].trim();if(!piece||ALLOW.test(piece))continue;if(/[А-Яа-яЁё]/.test(t(piece)))left.add(piece);}}
    assert.deepEqual([...left],[],`${L}: untranslated`);
  }
  setLang('ru');
});
