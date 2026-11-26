// Interface languages: Russian (source), English, Uzbek (Latin), Kazakh, Turkish, German, Spanish, French, Chinese (Simplified).
// A phrase missing in a language falls back to English.
// The UI is written in Russian; this layer translates rendered text nodes and attributes on the fly
// (exact phrases first, then known fragments inside composed strings such as "3 файлов · 2 замечаний").
// User content (project/file names, remarks, layer names, file text) is marked translate="no" or skipped.
import table from '../i18n/strings.js';

export const LANGS = [['ru', 'Русский'], ['en', 'English'], ['uz', 'O‘zbekcha'], ['kk', 'Қазақша'], ['tr', 'Türkçe'], ['de', 'Deutsch'], ['es', 'Español'], ['fr', 'Français'], ['zh', '简体中文']];
const COL = { en: 1, uz: 2, kk: 3, tr: 4, de: 5, es: 6, fr: 7, zh: 8 };
const LOCALES = { ru: 'ru-RU', en: 'en-US', uz: 'uz-UZ', kk: 'kk-KZ', tr: 'tr-TR', de: 'de-DE', es: 'es-ES', fr: 'fr-FR', zh: 'zh-CN' };
let lang = 'ru', exact = null, fragRe = null, fragMap = null, done = null;
const CYR = /[А-Яа-яЁё]/;
const SKIP_ATTR = '[translate="no"]';
const SKIP = '[translate="no"],script,style,textarea,code,pre,.text-preview,.project-title,.file-row h3,.annotation-card .body>p,.viewer-heading,.fs-title,.layer-name strong,.prop-item,.project-hero h1,.sent-row strong,.secure-head strong';

export function detectLang() {
  try { const saved = localStorage.getItem('modellink-lang'); if (saved && (saved === 'ru' || COL[saved])) return saved; } catch {}
  const nav = (navigator.languages?.[0] || navigator.language || 'ru').toLowerCase();
  const base = nav.split(/[-_]/)[0];
  if (base === 'ru' || COL[base]) return base;
  return ['ky', 'tg', 'be', 'uk', 'hy', 'az', 'tk'].includes(base) ? 'ru' : 'en';
}
export function getLang() { return lang; }
export function locale() { return LOCALES[lang] || 'ru-RU'; }
export function setLang(next) {
  lang = next === 'ru' || COL[next] ? next : 'ru';
  try { localStorage.setItem('modellink-lang', lang); } catch {}
  document.documentElement.lang = lang;
  exact = fragRe = fragMap = done = null;
  if (lang !== 'ru') {
    const c = COL[lang]; exact = new Map(); fragMap = new Map(); done = new Set();
    for (const row of table) { const v = row[c] || row[1]; exact.set(row[0], v); fragMap.set(row[0], v); if (v !== row[0]) done.add(v); }
    const keys = [...fragMap.keys()].sort((a, b) => b.length - a.length).map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    fragRe = new RegExp(`(${keys.join('|')})`, 'g'); // word boundaries are checked in the callback (no look-behind: Safari < 16.4)
  }
}
// Counted nouns: {key: {lang: [one, other] | ru: [one, few, many]}}. Languages without plural after numerals use one form.
const NOUNS = {
  file: { ru: ['файл', 'файла', 'файлов'], en: ['file', 'files'], uz: ['fayl'], kk: ['файл'], tr: ['dosya'], de: ['Datei', 'Dateien'], es: ['archivo', 'archivos'], fr: ['fichier', 'fichiers'], zh: ['个文件'] },
  remark: { ru: ['замечание', 'замечания', 'замечаний'], en: ['remark', 'remarks'], uz: ['izoh'], kk: ['ескерту'], tr: ['not'], de: ['Anmerkung', 'Anmerkungen'], es: ['observación', 'observaciones'], fr: ['remarque', 'remarques'], zh: ['条批注'] },
  oldVersion: { ru: ['старая версия', 'старые версии', 'старых версий'], en: ['older version', 'older versions'], uz: ['eski versiya'], kk: ['ескі нұсқа'], tr: ['eski sürüm'], de: ['ältere Version', 'ältere Versionen'], es: ['versión anterior', 'versiones anteriores'], fr: ['ancienne version', 'anciennes versions'], zh: ['个旧版本'] },
  project: { ru: ['проект', 'проекта', 'проектов'], en: ['project', 'projects'], uz: ['loyiha'], kk: ['жоба'], tr: ['proje'], de: ['Projekt', 'Projekte'], es: ['proyecto', 'proyectos'], fr: ['projet', 'projets'], zh: ['个项目'] },
  event: { ru: ['событие', 'события', 'событий'], en: ['event', 'events'], uz: ['hodisa'], kk: ['оқиға'], tr: ['olay'], de: ['Ereignis', 'Ereignisse'], es: ['evento', 'eventos'], fr: ['événement', 'événements'], zh: ['个事件'] },
  object: { ru: ['объект', 'объекта', 'объектов'], en: ['object', 'objects'], uz: ['obyekt'], kk: ['нысан'], tr: ['nesne'], de: ['Objekt', 'Objekte'], es: ['objeto', 'objetos'], fr: ['objet', 'objets'], zh: ['个对象'] },
  triangle: { ru: ['треугольник', 'треугольника', 'треугольников'], en: ['triangle', 'triangles'], uz: ['uchburchak'], kk: ['үшбұрыш'], tr: ['üçgen'], de: ['Dreieck', 'Dreiecke'], es: ['triángulo', 'triángulos'], fr: ['triangle', 'triangles'], zh: ['个三角形'] },
};
/** "3 файла" / "3 files" / "3 个文件": number with the noun in the right grammatical form for the current language. */
export function plural(n, key) {
  const forms = NOUNS[key]?.[lang] || NOUNS[key]?.en; if (!forms) return String(n);
  const num = Number(n).toLocaleString(locale());
  let w;
  if (lang === 'ru') { const a = Math.abs(n) % 100, b = a % 10; w = a > 10 && a < 20 ? forms[2] : b === 1 ? forms[0] : b >= 2 && b <= 4 ? forms[1] : forms[2]; }
  else w = forms.length < 2 ? forms[0] : new Intl.PluralRules(locale()).select(n) === 'one' ? forms[0] : forms[1];
  return `${num} ${w}`;
}
/** Translates one string (exact phrase, else known fragments). Russian passes through. */
export function t(s) {
  if (lang === 'ru' || s == null) return s;
  const str = String(s); if (!CYR.test(str)) return str;
  const trimmed = str.trim(); const hit = exact.get(trimmed);
  if (hit === undefined && done.has(trimmed)) return str; // already in the target language
  if (hit !== undefined) return str.replace(trimmed, hit);
  const LET = /[А-Яа-яЁёA-Za-z]/;
  return str.replace(fragRe, (frag, _g, at) => {
    const before = str[at - 1], after = str[at + frag.length];
    if (LET.test(frag[0]) && before && LET.test(before)) return frag; // inside a longer word
    if (LET.test(frag[frag.length - 1]) && after && LET.test(after)) return frag;
    return fragMap.get(frag) ?? frag;
  });
}
function skip(el) { return !!el?.closest?.(SKIP); }
export function translateTree(root) {
  if (lang === 'ru' || !root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = []; let n; while ((n = walker.nextNode())) if (CYR.test(n.nodeValue)) nodes.push(n);
  for (const node of nodes) { if (skip(node.parentElement)) continue; const v = t(node.nodeValue); if (v !== node.nodeValue) node.nodeValue = v; }
  const els = root.querySelectorAll ? root.querySelectorAll('[aria-label],[placeholder],[title],[alt]') : [];
  for (const el of [root, ...els]) {
    if (!el.getAttribute || el.closest?.(SKIP_ATTR)) continue;
    for (const a of ['aria-label', 'placeholder', 'title', 'alt']) { const v = el.getAttribute(a); if (v && CYR.test(v)) { const tv = t(v); if (tv !== v) el.setAttribute(a, tv); } }
  }
}
let observer = null;
export function startTranslator(root = document.body) {
  observer?.disconnect(); if (lang === 'ru') return;
  translateTree(root);
  observer = new MutationObserver(list => {
    for (const m of list) {
      if (m.type === 'characterData') { const node = m.target; if (CYR.test(node.nodeValue) && !skip(node.parentElement)) { const v = t(node.nodeValue); if (v !== node.nodeValue) node.nodeValue = v; } }
      else if (m.type === 'attributes') { const el = m.target; const v = el.getAttribute(m.attributeName); if (v && CYR.test(v) && !el.closest?.(SKIP_ATTR)) { const tv = t(v); if (tv !== v) el.setAttribute(m.attributeName, tv); } }
      else for (const node of m.addedNodes) { if (node.nodeType === 1) translateTree(node); else if (node.nodeType === 3 && CYR.test(node.nodeValue) && !skip(node.parentElement)) node.nodeValue = t(node.nodeValue); }
    }
  });
  observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-label', 'placeholder', 'title', 'alt'] });
}
