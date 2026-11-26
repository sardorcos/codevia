import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.localStorage={getItem:()=>null,setItem(){}};globalThis.document={documentElement:{}};
const {setLang,t}=await import('../core/i18n.js');
test('exact phrases, fragments in composed strings, user words untouched',()=>{
  setLang('en');
  assert.equal(t('Настройки'),'Settings');
  assert.equal(t('2 файлов · 1 замечаний · 25 нояб.'),'2 files · 1 remarks · 25 нояб.');
  assert.equal(t('Расстояние 4 532,3 мм'),'Distance 4 532,3 mm');
  assert.equal(t('Видеоролик'),'Видеоролик','no partial-word replacement');
  setLang('uz');assert.equal(t('Сейф'),'Seyf');
  setLang('ru');assert.equal(t('Сейф'),'Сейф');
});
test('nine languages, English fallback, plural forms',async()=>{
  const {LANGS,plural}=await import('../core/i18n.js');
  assert.equal(LANGS.length,9);
  for(const [code] of LANGS){setLang(code);assert.ok(t('Настройки').length>0);if(code!=='ru'&&code!=='kk')assert.doesNotMatch(t('Настройки'),/[А-Яа-я]/);}
  setLang('de');assert.equal(t('Настройки'),'Einstellungen');
  setLang('zh');assert.equal(t('Сейф'),'保险箱');
  setLang('kk');assert.equal(t('Жобалар'),'Жобалар','already-Kazakh text is left alone');
  setLang('ru');assert.equal(plural(1,'remark'),'1 замечание');assert.equal(plural(3,'file'),'3 файла');assert.equal(plural(11,'file'),'11 файлов');assert.equal(plural(21,'project'),'21 проект');
  setLang('en');assert.equal(plural(1,'file'),'1 file');assert.equal(plural(2,'file'),'2 files');
  setLang('fr');assert.equal(plural(0,'remark'),'0 remarque');
  setLang('tr');assert.equal(plural(5,'file'),'5 dosya');
  setLang('ru');
});
