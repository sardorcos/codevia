// Interface languages: Russian (source), English, Uzbek (Latin).
// The UI is written in Russian; this layer translates rendered text nodes and attributes on the fly
// (exact phrases first, then known fragments inside composed strings such as "3 файлов · 2 замечаний").
// User content (project/file names, remarks, layer names, file text) is marked translate="no" or skipped.
import table from '../i18n/strings.js';

export const LANGS = [['ru', 'Русский'], ['en', 'English'], ['uz', 'O‘zbekcha']];
const COL = { en: 1, uz: 2 };
let lang = 'ru', exact = null, fragRe = null, fragMap = null;
const CYR = /[А-Яа-яЁё]/;
const SKIP_ATTR = '[translate="no"]';
const SKIP = '[translate="no"],script,style,textarea,code,pre,.text-preview,.project-title,.file-row h3,.annotation-card .body>p,.viewer-heading,.fs-title,.layer-name strong,.prop-item,.project-hero h1,.sent-row strong,.secure-head strong';

export function detectLang() {
  try { const saved = localStorage.getItem('modellink-lang'); if (saved && (saved === 'ru' || COL[saved])) return saved; } catch {}
  const nav = (navigator.languages?.[0] || navigator.language || 'ru').toLowerCase();
  return nav.startsWith('ru') ? 'ru' : nav.startsWith('uz') ? 'uz' : nav.startsWith('kk') || nav.startsWith('ky') || nav.startsWith('tg') || nav.startsWith('be') || nav.startsWith('uk') ? 'ru' : 'en';
}
export function getLang() { return lang; }
export function locale() { return lang === 'en' ? 'en-US' : lang === 'uz' ? 'uz-UZ' : 'ru-RU'; }
export function setLang(next) {
  lang = next === 'ru' || COL[next] ? next : 'ru';
  try { localStorage.setItem('modellink-lang', lang); } catch {}
  document.documentElement.lang = lang;
  exact = fragRe = fragMap = null;
  if (lang !== 'ru') {
    const c = COL[lang]; exact = new Map(); fragMap = new Map();
    for (const row of table) { exact.set(row[0], row[c]); fragMap.set(row[0], row[c]); }
    const keys = [...fragMap.keys()].sort((a, b) => b.length - a.length).map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    fragRe = new RegExp(`(${keys.join('|')})`, 'g'); // word boundaries are checked in the callback (no look-behind: Safari < 16.4)
  }
}
/** Translates one string (exact phrase, else known fragments). Russian passes through. */
export function t(s) {
  if (lang === 'ru' || s == null) return s;
  const str = String(s); if (!CYR.test(str)) return str;
  const trimmed = str.trim(); const hit = exact.get(trimmed);
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
