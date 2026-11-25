import { bytesToBase64, encodeUtf8, textToBase64 } from './bytes';
import { isExternalRef, mimeOf, resolveRelative } from './paths';
import type { Files, ProjectFile } from './types';
import { t } from '../i18n';

export interface PreviewOptions {
  /** Allow https: resources (CDNs, fonts). Off by default: the preview never touches the network. */
  allowNetwork: boolean;
  /** Random per-frame token; messages from the frame must echo it. */
  token: string;
  /** Budget for files embedded for fetch()/dynamic images. */
  embedBudget?: number;
  /** Strips TypeScript/JSX from .ts/.tsx/.jsx scripts (loaded lazily by the app when needed). */
  transpile?: (path: string, code: string) => string;
}

/** Scripts the preview must transpile before running. */
export const needsTranspile = (path: string) => /\.(tsx?|jsx|mts)$/i.test(path);

export interface PreviewResult {
  html: string;
  missing: string[];
}

const fileBytes = (f: ProjectFile): Uint8Array => (f.text ? encodeUtf8(f.content) : f.data);
const dataUrl = (path: string, f: ProjectFile): string =>
  `data:${mimeOf(path)};base64,${f.text ? textToBase64(f.content) : bytesToBase64(f.data)}`;

/** Escapes text placed inside an inline <script>/<style> so it can never close the element early. */
export const escapeRawText = (code: string, tag: 'script' | 'style'): string =>
  code.replace(new RegExp(`</(${tag})`, 'gi'), '<\\/$1').replace(/<!--/g, '<\\!--');

export function cspFor(allowNetwork: boolean): string {
  const net = allowNetwork ? ' https:' : '';
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' data: blob:${net}`,
    `style-src 'unsafe-inline' data:${net}`,
    `img-src data: blob:${net}`,
    `font-src data:${net}`,
    `media-src data: blob:${net}`,
    `connect-src ${allowNetwork ? 'https:' : "'none'"}`,
    "worker-src blob: data:",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
    "object-src 'none'",
  ].join('; ');
}

class Builder {
  missing = new Set<string>();
  private cssCache = new Map<string, string>();
  private moduleCache = new Map<string, string>();
  /** One data: URL per asset path: a gallery referencing an image 20 times encodes it once (R10). */
  private assetCache = new Map<string, string>();

  constructor(
    private files: Files,
    private transpile?: (path: string, code: string) => string,
  ) {}

  /** Source of a script file, transpiled when it is TypeScript/JSX. */
  scriptSource(path: string, code: string): string {
    if (!needsTranspile(path) || !this.transpile) return code;
    try {
      return this.transpile(path, code);
    } catch (e) {
      const msg = String((e as Error)?.message ?? e).replace(/[\\'\n\r]/g, ' ');
      return `console.error('${path}: ${msg}')`;
    }
  }

  private lookup(from: string, ref: string): { path: string; file: ProjectFile } | null {
    if (!ref || isExternalRef(ref)) return null;
    const path = resolveRelative(from, ref.trim());
    if (path === null) return null;
    const file = this.files[path] ?? this.files[`${path}/index.html`];
    if (!file) {
      this.missing.add(path);
      return null;
    }
    return { path, file };
  }

  asset(from: string, ref: string): string | null {
    const hit = this.lookup(from, ref);
    if (!hit) return null;
    let url = this.assetCache.get(hit.path);
    if (!url) {
      url = dataUrl(hit.path, hit.file);
      this.assetCache.set(hit.path, url);
    }
    return url;
  }

  css(from: string, css: string, depth = 0): string {
    const withImports = css.replace(/@import\s+(?:url\()?\s*["']([^"']+)["']\s*\)?\s*([^;]*);/gi, (whole, ref: string) => {
      if (depth > 8) return whole;
      const hit = this.lookup(from, ref);
      if (!hit || !hit.file.text) return whole;
      return this.css(hit.path, hit.file.content, depth + 1);
    });
    return withImports.replace(/url\(\s*(["']?)([^"')]+?)\1\s*\)/gi, (whole, q: string, ref: string) => {
      const url = this.asset(from, ref);
      return url ? `url(${q}${url}${q})` : whole;
    });
  }

  cssFile(path: string): string | null {
    const f = this.files[path];
    if (!f?.text) return null;
    if (!this.cssCache.has(path)) this.cssCache.set(path, this.css(path, f.content));
    return this.cssCache.get(path)!;
  }

  /** Rewrites relative ES-module specifiers to data: URLs, recursively (cycles are left untouched). */
  module(path: string, stack: string[] = []): string | null {
    const f = this.files[path];
    if (!f?.text) return null;
    if (this.moduleCache.has(path)) return this.moduleCache.get(path)!;
    if (stack.includes(path)) return null;
    const next = [...stack, path];
    const code = this.scriptSource(path, f.content).replace(
      /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])((?:\.{1,2}\/|\/)[^"']+)\2/g,
      (whole, lead: string, q: string, ref: string) => {
        const target = resolveRelative(path, ref);
        if (target === null) return whole;
        if (!this.files[target]) {
          this.missing.add(target);
          return whole;
        }
        const url = /\.(m?js|jsx|tsx?|mts)$/i.test(target) ? this.module(target, next) : this.asset(path, ref);
        return url ? `${lead}${q}${url}${q}` : whole;
      },
    );
    const url = `data:text/javascript;base64,${textToBase64(code)}`;
    this.moduleCache.set(path, url);
    return url;
  }

  srcset(from: string, value: string): string {
    return value
      .split(',')
      .map((part) => {
        const [ref, ...rest] = part.trim().split(/\s+/);
        const url = ref ? this.asset(from, ref) : null;
        return [url ?? ref, ...rest].join(' ');
      })
      .join(', ');
  }
}

/** Files exposed to fetch() and dynamically created images inside the preview. */
function embeddedFiles(files: Files, budget: number): Record<string, { t: string; b: 0 | 1; d: string }> {
  const out: Record<string, { t: string; b: 0 | 1; d: string }> = {};
  let used = 0;
  const entries = Object.entries(files).sort(([, a], [, b]) => Number(b.text) - Number(a.text));
  // Binaries (images for dynamically created <img>, data files) get at most a third of the budget:
  // they are base64-encoded and copied on every rebuild of the page (R10).
  let usedBinary = 0;
  for (const [path, f] of entries) {
    const size = fileBytes(f).length;
    if (size > 2 * 1024 * 1024 || used + size > budget) continue;
    if (!f.text && usedBinary + size > budget / 3) continue;
    used += size;
    if (!f.text) usedBinary += size;
    out[path] = f.text ? { t: mimeOf(path), b: 0, d: f.content } : { t: mimeOf(path), b: 1, d: bytesToBase64(f.data) };
  }
  return out;
}

/**
 * XMLHttpRequest for project files ($.getJSON, axios, old tutorials), served from FILES like fetch().
 * Requests to other hosts go to the real XHR (still subject to the preview CSP).
 */
const XHR_SHIM = `(function(){var RX=window.XMLHttpRequest;if(!RX)return;function X(){this.readyState=0;this.status=0;this.statusText='';this.responseText='';this.response=null;this.responseType='';this.responseURL='';this._h={};this._l={};this._real=null;this.timeout=0;this.withCredentials=false;this.upload={addEventListener:function(){}}}
X.UNSENT=0;X.OPENED=1;X.HEADERS_RECEIVED=2;X.LOADING=3;X.DONE=4;
X.prototype.open=function(m,u,a){this._m=m;this._u=String(u);this._p=isExt(this._u)?null:resolve(this._u);if(this._p===null&&isExt(this._u)){var r=this._real=new RX(),s=this;r.onreadystatechange=function(){s.readyState=r.readyState;if(r.readyState===4){s.status=r.status;s.statusText=r.statusText;s.response=r.response;try{s.responseText=r.responseText}catch(_){}}s._fire('readystatechange')};r.onload=function(){s._fire('load');s._fire('loadend')};r.onerror=function(){s._fire('error');s._fire('loadend')};r.open(m,u,a!==false);return}this.readyState=1;this._fire('readystatechange')};
X.prototype.setRequestHeader=function(k,v){if(this._real)this._real.setRequestHeader(k,v)};
X.prototype.overrideMimeType=function(){};
X.prototype.getResponseHeader=function(k){if(this._real)return this._real.getResponseHeader(k);return String(k).toLowerCase()==='content-type'&&this._t?this._t:null};
X.prototype.getAllResponseHeaders=function(){if(this._real)return this._real.getAllResponseHeaders();return this._t?'content-type: '+this._t+'\\r\\n':''};
X.prototype.addEventListener=function(t,f){(this._l[t]=this._l[t]||[]).push(f)};
X.prototype.removeEventListener=function(t,f){this._l[t]=(this._l[t]||[]).filter(function(x){return x!==f})};
X.prototype._fire=function(t){var e={type:t,target:this,currentTarget:this,lengthComputable:false,loaded:0,total:0};if(typeof this['on'+t]==='function')try{this['on'+t](e)}catch(err){setTimeout(function(){throw err})}(this._l[t]||[]).forEach(function(f){try{f.call(this,e)}catch(err){setTimeout(function(){throw err})}},this)};
X.prototype.abort=function(){if(this._real)this._real.abort();this._aborted=true};
X.prototype.send=function(body){if(this._real){this._real.responseType=this.responseType;this._real.timeout=this.timeout;this._real.send(body);return}var s=this;setTimeout(function(){if(s._aborted)return;var f=s._p&&FILES[s._p];s.responseURL=s._u;if(!f){s.status=404;s.statusText='Not Found';s.responseText='Not found';s.response=s.responseType===''||s.responseType==='text'?'Not found':null;post({type:'console',level:'warn',args:['XMLHttpRequest: '+s._u+' (404)']})}else{s.status=200;s.statusText='OK';s._t=f.t;var text=f.b?null:f.d;var rt=s.responseType;if(rt==='json'){try{s.response=JSON.parse(text===null?new TextDecoder().decode(b64(f.d)):text)}catch(_){s.response=null}}else if(rt==='arraybuffer'){s.response=f.b?b64(f.d).buffer:new TextEncoder().encode(text).buffer}else if(rt==='blob'){s.response=new Blob([f.b?b64(f.d):text],{type:f.t})}else{s.responseText=text===null?new TextDecoder().decode(b64(f.d)):text;s.response=s.responseText}}s.readyState=2;s._fire('readystatechange');s.readyState=3;s._fire('readystatechange');s.readyState=4;s._fire('readystatechange');s._fire(s.status===200?'load':'load');s._fire('loadend')},0)};
window.XMLHttpRequest=X})();`;

/** Runtime injected first into every preview page: console bridge, fetch shim, link navigation, storage fallback. */
function shimScript(token: string, entry: string, embedded: object): string {
  const json = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');
  const L = json({
    error: t('Ошибка'),
    line: t(' (строка '),
    rejection: t('Необработанная ошибка Promise: '),
    confirm: t('confirm() в предпросмотре всегда возвращает false: '),
    prompt: t('prompt() в предпросмотре возвращает null: '),
    notFound: t('fetch: файл не найден в проекте: '),
    noFetch: t('fetch недоступен'),
    forms: t('Отправка форм в предпросмотре отключена'),
  });
  return `(function(){
var T=${json(token)},BASE=${json(entry)},FILES=${json(embedded)},L=${L};
function post(m){m.token=T;try{parent.postMessage(m,'*')}catch(e){}}
function fmt(v){try{if(v instanceof Error)return v.name+': '+v.message;if(v&&typeof v==='object')return JSON.stringify(v,null,1);return String(v)}catch(e){return String(v)}}
['log','info','warn','error','debug'].forEach(function(k){var o=console[k];console[k]=function(){try{post({type:'console',level:k,args:[].map.call(arguments,fmt)})}catch(e){}return o&&o.apply(console,arguments)}});
addEventListener('error',function(e){post({type:'console',level:'error',args:[(e.message||L.error)+(e.lineno?L.line+e.lineno+')':'')]})});
addEventListener('unhandledrejection',function(e){post({type:'console',level:'error',args:[L.rejection+fmt(e.reason)]})});
function mem(){var d={};return{getItem:function(k){return Object.prototype.hasOwnProperty.call(d,k)?d[k]:null},setItem:function(k,v){d[k]=String(v)},removeItem:function(k){delete d[k]},clear:function(){d={}},key:function(i){return Object.keys(d)[i]||null},get length(){return Object.keys(d).length}}}
['localStorage','sessionStorage'].forEach(function(n){try{window[n].getItem('x')}catch(e){try{Object.defineProperty(window,n,{value:mem(),configurable:true})}catch(_){}}});
window.alert=function(m){post({type:'alert',message:String(m)})};
window.confirm=function(m){post({type:'console',level:'warn',args:[L.confirm+m]});return false};
window.prompt=function(m){post({type:'console',level:'warn',args:[L.prompt+m]});return null};
function isExt(u){return /^([a-z][a-z0-9+.-]*:|\\/\\/)/i.test(u)}
function resolve(ref){var t=String(ref).split(/[?#]/)[0];try{t=decodeURIComponent(t)}catch(e){}if(!t)return null;var parts=t.charAt(0)==='/'?[]:BASE.split('/').slice(0,-1);var segs=t.split('/');for(var i=0;i<segs.length;i++){var s=segs[i];if(!s||s==='.')continue;if(s==='..'){if(!parts.length)return null;parts.pop()}else parts.push(s)}return parts.join('/')||null}
function b64(d){var s=atob(d),a=new Uint8Array(s.length);for(var i=0;i<s.length;i++)a[i]=s.charCodeAt(i);return a}
function asUrl(p){var f=FILES[p];if(!f)return null;return 'data:'+f.t+';base64,'+(f.b?f.d:btoa(unescape(encodeURIComponent(f.d))))}
var of=window.fetch;
window.fetch=function(input,init){var url=typeof input==='string'?input:(input&&input.url)||String(input);if(typeof input==='string'&&!isExt(url)){var p=resolve(url),f=p&&FILES[p];if(f)return Promise.resolve(new Response(f.b?b64(f.d):f.d,{status:200,headers:{'Content-Type':f.t}}));post({type:'console',level:'warn',args:[L.notFound+url]});return Promise.resolve(new Response('Not found',{status:404,statusText:'Not Found'}))}return of?of.apply(this,arguments):Promise.reject(new TypeError(L.noFetch))};
function fix(el){if(!el||el.nodeType!==1)return;['src','poster'].forEach(function(a){var v=el.getAttribute&&el.getAttribute(a);if(v&&!isExt(v)){var u=asUrl(resolve(v));if(u)el.setAttribute(a,u)}})}
try{new MutationObserver(function(ms){ms.forEach(function(m){if(m.type==='attributes')fix(m.target);else m.addedNodes.forEach(function(n){fix(n);if(n.querySelectorAll)n.querySelectorAll('[src],[poster]').forEach(fix)})})}).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['src','poster']})}catch(e){}
document.addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('a[href]');if(!a)return;var h=a.getAttribute('href');if(!h)return;e.preventDefault();if(h.charAt(0)==='#'){var id=h.slice(1),el=id&&(document.getElementById(id)||document.getElementsByName(id)[0]);if(el)el.scrollIntoView({behavior:'smooth'});return}if(isExt(h)){post({type:'external',href:h});return}var q=h.indexOf('?')>=0?h.split('?')[1].split('#')[0]:'';post({type:'navigate',path:resolve(h),query:q})},true);
document.addEventListener('submit',function(e){e.preventDefault();var f=e.target;if(!f||!f.getAttribute)return;var act=f.getAttribute('action')||BASE;if(isExt(act)){post({type:'external',href:act});return}var fd;try{fd=new FormData(f,e.submitter||undefined)}catch(_){fd=new FormData(f)}var ps=[];fd.forEach(function(v,k){if(typeof v==='string')ps.push(encodeURIComponent(k)+'='+encodeURIComponent(v))});var body=ps.join('&');var m=(f.getAttribute('method')||'get').toLowerCase();post(m==='post'?{type:'navigate',path:resolve(act),query:'',post:body}:{type:'navigate',path:resolve(act),query:body})},true);
${XHR_SHIM}
try{if(window.navigation)navigation.addEventListener('navigate',function(e){if(!e.cancelable||e.hashChange||e.downloadRequest)return;var u=e.destination&&e.destination.url;if(!u||u.indexOf('about:')===0)return;e.preventDefault();try{var x=new URL(u);if(/^https?:$/.test(x.protocol)&&x.origin!==location.origin){post({type:'external',href:u});return}var bd=String(document.baseURI).split(/[?#]/)[0].replace(/[^/]*$/,''),clean=u.split('#')[0].split('?')[0],rel=clean.indexOf(bd)===0?clean.slice(bd.length):clean.split('/').pop();post({type:'navigate',path:resolve(rel),query:x.search.slice(1)})}catch(_){}})}catch(e){}
})();`;
}

function hasDoctype(html: string): boolean {
  return /^\s*(<!--[\s\S]*?-->\s*)*<!doctype/i.test(html);
}

/**
 * Turns a project HTML page into a self-contained document for a sandboxed srcdoc iframe:
 * linked CSS is inlined (with url()/@import resolved), scripts and assets become data: URLs,
 * relative paths (./, ../, /) are resolved against the page, and the runtime shim is injected.
 */
export function buildPreview(files: Files, entry: string, html: string, opts: PreviewOptions): PreviewResult {
  const b = new Builder(files, opts.transpile);
  const doc = new DOMParser().parseFromString(html, 'text/html');

  for (const link of Array.from(doc.querySelectorAll('link[href]'))) {
    const rel = (link.getAttribute('rel') ?? '').toLowerCase();
    const href = link.getAttribute('href') ?? '';
    if (rel.split(/\s+/).includes('stylesheet')) {
      const target = isExternalRef(href) ? null : resolveRelative(entry, href);
      const css = target ? b.cssFile(target) : null;
      if (css !== null) {
        const style = doc.createElement('style');
        const media = link.getAttribute('media');
        if (media) style.setAttribute('media', media);
        style.textContent = escapeRawText(css, 'style');
        link.replaceWith(style);
      } else if (target) b.missing.add(target);
    } else if (/icon|preload|apple-touch-icon/.test(rel)) {
      const url = b.asset(entry, href);
      if (url) link.setAttribute('href', url);
    }
  }
  for (const style of Array.from(doc.querySelectorAll('style'))) {
    style.textContent = b.css(entry, style.textContent ?? '');
  }
  for (const el of Array.from(doc.querySelectorAll('[style]'))) {
    el.setAttribute('style', b.css(entry, el.getAttribute('style') ?? ''));
  }
  for (const script of Array.from(doc.querySelectorAll('script'))) {
    const src = script.getAttribute('src');
    const isModule = (script.getAttribute('type') ?? '').toLowerCase() === 'module';
    if (src) {
      if (isExternalRef(src)) continue;
      const target = resolveRelative(entry, src);
      if (!target || !files[target]?.text) {
        if (target) b.missing.add(target);
        continue;
      }
      const url = isModule
        ? b.module(target)
        : `data:text/javascript;base64,${textToBase64(b.scriptSource(target, (files[target] as { content: string }).content))}`;
      if (url) script.setAttribute('src', url);
    } else if (isModule && script.textContent) {
      // Inline modules: rewrite relative imports, keep the code inline.
      const tmp = '__codevia_inline__.mjs';
      const inlineFiles = { ...files, [tmp]: { text: true as const, content: script.textContent } };
      const inner = new Builder(inlineFiles);
      const url = inner.module(tmp);
      if (url) {
        script.textContent = '';
        script.setAttribute('src', url);
      }
      inner.missing.forEach((m) => b.missing.add(m));
    }
  }
  for (const el of Array.from(doc.querySelectorAll('img[src], source[src], audio[src], video[src], video[poster], input[type=image][src], track[src]'))) {
    for (const attr of ['src', 'poster']) {
      const v = el.getAttribute(attr);
      if (!v) continue;
      const url = b.asset(entry, v);
      if (url) el.setAttribute(attr, url);
    }
  }
  for (const el of Array.from(doc.querySelectorAll('[srcset]'))) {
    el.setAttribute('srcset', b.srcset(entry, el.getAttribute('srcset') ?? ''));
  }
  for (const el of Array.from(doc.querySelectorAll('use[href], image[href]'))) {
    const v = el.getAttribute('href') ?? '';
    if (!v.startsWith('#')) {
      const [ref, frag] = v.split('#');
      const url = b.asset(entry, ref ?? '');
      if (url) el.setAttribute('href', frag ? `${url}#${frag}` : url);
    }
  }
  // Remove author <base>; it would break resolution and is blocked by CSP anyway.
  doc.querySelectorAll('base').forEach((x) => x.remove());

  const head = doc.head;
  const meta = doc.createElement('meta');
  meta.setAttribute('http-equiv', 'Content-Security-Policy');
  meta.setAttribute('content', cspFor(opts.allowNetwork));
  const shim = doc.createElement('script');
  shim.textContent = shimScript(opts.token, entry, embeddedFiles(files, opts.embedBudget ?? 12 * 1024 * 1024));
  const charset = head.querySelector('meta[charset]');
  head.prepend(meta);
  if (charset) head.prepend(charset);
  else {
    const c = doc.createElement('meta');
    c.setAttribute('charset', 'utf-8');
    head.prepend(c);
  }
  meta.after(shim);

  const out = (hasDoctype(html) ? '<!doctype html>\n' : '') + doc.documentElement.outerHTML;
  return { html: out, missing: [...b.missing] };
}
