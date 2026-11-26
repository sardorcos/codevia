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
