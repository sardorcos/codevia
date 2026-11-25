import type { BoxModel, Crumb, Decl, Edges, MatchedRule, NetworkEntry, NetworkKind, NetworkType, TreeChild, TreeElement } from './protocol';

/** What the preview shim hands to the agent (see shimScript() in src/core/preview.ts). */
export interface AgentEnv {
  /** Per-frame token; every message to the parent carries it, every request must echo it. */
  T: string;
  /** Path of the previewed page inside the project. */
  BASE: string;
  /** Project files embedded for fetch()/XHR (t: MIME type, b: 1 when d is base64). */
  FILES: Record<string, { t: string; b: 0 | 1; d: string }>;
  /** Posts a message to the parent (adds the token). */
  post(m: Record<string, unknown>): void;
  /** Resolves a relative URL against the page to a project path. */
  resolve(ref: string): string | null;
  /** Whether a URL has a scheme (or is protocol-relative). */
  isExt(u: string): boolean;
  /** The shim <script> element (hidden from the tree). */
  shim: Element | null;
}

/**
 * The inspector agent that runs inside the live preview.
 *
 * IMPORTANT: this function is serialized with Function.prototype.toString() and injected into the preview
 * document by the shim, so it must be self-contained: no imports, no references to anything outside its body
 * (types are fine — they are erased). Keep "</script" and "<!--" out of it.
 *
 * Cost when the inspector is closed: wrappers around fetch()/XMLHttpRequest that append metadata to a ring
 * buffer, and one message listener. Observers, the overlay, pick mode and response capture run only while
 * the panel has sent `inspect:enable`.
 */
export function inspectorAgent(env: AgentEnv): void {
  const { FILES, post, resolve, isExt, BASE } = env;
  const MAX_NET = 300; // = NETWORK_BUFFER in protocol.ts (the agent cannot import it)
  const MAX_BODY = 200 * 1024;
  const MAX_CHILDREN = 300;
  const TREE_BUDGET = 2000;
  const doc = document;
  const win = window;
  let on = false;

  // ---------------------------------------------------------------- network log

  interface Body {
    mime: string;
    text?: string;
    truncated?: boolean;
  }
  let nextNid = 1;
  let net: NetworkEntry[] = [];
  const bodies = new Map<number, Body>();
  const seenTimings = new Set<string>();

  function utf8Length(s: string): number {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c < 0xdc00) {
        n += 4;
        i++;
      } else n += 3;
    }
    return n;
  }

  function fileSize(f: { b: 0 | 1; d: string }): number {
    if (!f.b) return utf8Length(f.d);
    const pad = f.d.endsWith('==') ? 2 : f.d.endsWith('=') ? 1 : 0;
    return Math.floor((f.d.length * 3) / 4) - pad;
  }

  function typeOf(mime: string, url: string, initiator?: string): NetworkType {
    const m = (mime || '').toLowerCase();
    if (/json/.test(m)) return 'json';
    if (/html/.test(m)) return 'document';
    if (/css/.test(m)) return 'css';
    if (/javascript|ecmascript/.test(m)) return 'script';
    if (/^image\//.test(m)) return 'image';
    if (/^font\/|woff|opentype|truetype/.test(m)) return 'font';
    if (/^(audio|video)\//.test(m)) return 'media';
    if (/^text\/|xml/.test(m)) return 'text';
    const ext = (/\.([a-z0-9]+)(?:[?#]|$)/i.exec(String(url).split(/[?#]/)[0] || '') || [])[1];
    const e = (ext || '').toLowerCase();
    if (e === 'json') return 'json';
    if (/^html?$|^php$/.test(e)) return 'document';
    if (e === 'css') return 'css';
    if (/^(m?js|jsx|tsx?|mts)$/.test(e)) return 'script';
    if (/^(png|jpe?g|gif|webp|avif|svg|ico|bmp)$/.test(e)) return 'image';
    if (/^(woff2?|ttf|otf|eot)$/.test(e)) return 'font';
    if (/^(mp3|wav|ogg|m4a|aac|flac|mp4|webm|mov|m4v)$/.test(e)) return 'media';
    if (/^(txt|md|csv|xml|yml|yaml)$/.test(e)) return 'text';
    if (initiator === 'img' || initiator === 'image') return 'image';
    if (initiator === 'script') return 'script';
    if (initiator === 'css' || initiator === 'link') return 'css';
    if (initiator === 'audio' || initiator === 'video') return 'media';
    return 'other';
  }

  function headerList(h: unknown): [string, string][] {
    const out: [string, string][] = [];
    try {
      if (!h) return out;
      if (typeof (h as Headers).forEach === 'function' && typeof (h as Headers).get === 'function') {
        (h as Headers).forEach((v, k) => out.push([k, v]));
      } else if (Array.isArray(h)) {
        for (const p of h) if (Array.isArray(p) && p.length >= 2) out.push([String(p[0]), String(p[1])]);
      } else if (typeof h === 'object') {
        for (const k of Object.keys(h as object)) out.push([k, String((h as Record<string, unknown>)[k])]);
      }
    } catch {
      /* unreadable headers */
    }
    return out;
  }

  function parseRawHeaders(raw: string): [string, string][] {
    const out: [string, string][] = [];
    for (const line of String(raw || '').split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i > 0) out.push([line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim()]);
    }
    return out;
  }

  function emit(e: NetworkEntry): void {
    if (on) post({ type: 'inspect:network', entry: e });
  }

  function remember(e: NetworkEntry): void {
    net.push(e);
    while (net.length > MAX_NET) {
      const old = net.shift();
      if (old) bodies.delete(old.nid);
    }
    emit(e);
  }

  function begin(kind: NetworkKind, method: string, url: string, project: boolean, reqHeaders: [string, string][]): NetworkEntry {
    const path = project ? resolve(url) : null;
    const e: NetworkEntry = {
      nid: nextNid++,
      kind,
      method: method || 'GET',
      url,
      source: project ? 'project' : 'network',
      status: 0,
      statusText: '',
      type: typeOf('', url),
      mime: '',
      size: -1,
      duration: 0,
      start: performance.now(),
      pending: true,
      reqHeaders,
    };
    if (path) e.path = path;
    remember(e);
    return e;
  }

  function complete(e: NetworkEntry, status: number, statusText: string, mime: string, resHeaders: [string, string][], size: number): void {
    e.pending = false;
    e.status = status;
    e.statusText = statusText;
    e.mime = mime || '';
    e.type = typeOf(e.mime, e.url);
    e.resHeaders = resHeaders;
    e.duration = Math.max(0, performance.now() - e.start);
    const f = e.source === 'project' && e.path ? FILES[e.path] : undefined;
    e.size = f && status === 200 ? fileSize(f) : size;
    e.hasBody = !!f || bodies.has(e.nid);
    emit(e);
  }

  function failed(e: NetworkEntry, err: unknown): void {
    e.pending = false;
    e.duration = Math.max(0, performance.now() - e.start);
    e.error = String((err as Error)?.message || err || 'Failed');
    emit(e);
  }

  function capture(e: NetworkEntry, mime: string, text: string): void {
    const truncated = text.length > MAX_BODY;
    bodies.set(e.nid, { mime, text: truncated ? text.slice(0, MAX_BODY) : text, truncated });
    e.hasBody = true;
    if (e.size < 0) e.size = utf8Length(text);
  }

  const textual = (mime: string) => /json|text|xml|javascript|css|html|svg/i.test(mime || '');

  const realFetch = win.fetch;
  if (typeof realFetch === 'function') {
    win.fetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
      let e: NetworkEntry | null;
      try {
        const input = args[0] as unknown;
        const init = (args[1] || {}) as RequestInit;
        const req = input && typeof input === 'object' && 'url' in (input as object) ? (input as Request) : null;
        const url = typeof input === 'string' ? input : req ? req.url : String(input);
        // Same rule as the shim's fetch(): only string URLs without a scheme are served from the project.
        const project = typeof input === 'string' && !isExt(url);
        const method = String(init.method || (req && req.method) || 'GET').toUpperCase();
        e = begin('fetch', method, url, project, headerList(init.headers || (req && req.headers)));
      } catch {
        e = null;
      }
      const p = realFetch.apply(this, args) as Promise<Response>;
      if (!e) return p;
      const entry = e;
      // Returning the derived promise keeps unhandled rejections unhandled (the page sees the same result).
      return p.then(
        (r) => {
          try {
            const mime = r.headers.get('content-type') || '';
            const len = Number(r.headers.get('content-length'));
            if (on && entry.source === 'network' && textual(mime)) {
              r.clone()
                .text()
                .then((text) => {
                  capture(entry, mime, text);
                  emit(entry);
                })
                .catch(() => undefined);
            }
            complete(entry, r.status, r.statusText, mime, headerList(r.headers), Number.isFinite(len) && len > 0 ? len : -1);
          } catch {
            /* never break the page */
          }
          return r;
        },
        (err) => {
          try {
            failed(entry, err);
          } catch {
            /* ignore */
          }
          throw err;
        },
      );
    } as typeof fetch;
  }

  interface XhrInfo {
    m: string;
    u: string;
    h: [string, string][];
  }
  type Xhr = XMLHttpRequest & { __codeviaXhr?: XhrInfo };
  const XR = (win as unknown as { XMLHttpRequest?: { prototype: XMLHttpRequest } }).XMLHttpRequest;
  if (XR && XR.prototype) {
    const XP = XR.prototype as Xhr;
    const oOpen = XP.open;
    const oSet = XP.setRequestHeader;
    const oSend = XP.send;
    XP.open = function (this: Xhr, ...args: unknown[]) {
      try {
        this.__codeviaXhr = { m: String(args[0] || 'GET').toUpperCase(), u: String(args[1]), h: [] };
      } catch {
        /* ignore */
      }
      return (oOpen as (...a: unknown[]) => void).apply(this, args);
    } as typeof XP.open;
    XP.setRequestHeader = function (this: Xhr, k: string, v: string) {
      try {
        this.__codeviaXhr?.h.push([String(k), String(v)]);
      } catch {
        /* ignore */
      }
      return oSet.call(this, k, v);
    };
    XP.send = function (this: Xhr, ...args: unknown[]) {
      try {
        const c = this.__codeviaXhr;
        if (c) {
          const e = begin('xhr', c.m, c.u, !isExt(c.u), c.h.slice());
          const x: Xhr = this as Xhr;
          x.addEventListener('loadend', () => {
            try {
              const mime = (x.getResponseHeader('content-type') || '').split(';')[0]!.trim() || '';
              const rt = x.responseType;
              let size = -1;
              let text: string | null = null;
              if (rt === '' || rt === 'text') {
                text = String(x.responseText ?? '');
                size = utf8Length(text);
              } else if (rt === 'arraybuffer' && x.response) size = (x.response as ArrayBuffer).byteLength;
              else if (rt === 'blob' && x.response) size = (x.response as Blob).size;
              if (on && e.source === 'network' && text !== null && textual(mime)) capture(e, mime, text);
              if (x.status === 0) failed(e, 'Network error');
              else complete(e, x.status, x.statusText, x.getResponseHeader('content-type') || '', parseRawHeaders(x.getAllResponseHeaders()), size);
            } catch {
              /* ignore */
            }
          });
        }
      } catch {
        /* ignore */
      }
      return (oSend as (...a: unknown[]) => void).apply(this, args);
    } as typeof XP.send;
  }

  /** Resource loads (img, script, link, css url()…) from the Resource Timing buffer. data: URLs have no entries. */
  function fromTiming(t: PerformanceResourceTiming): void {
    if (t.initiatorType === 'fetch' || t.initiatorType === 'xmlhttprequest' || t.initiatorType === 'beacon') return;
    const key = t.name + '@' + t.startTime;
    if (seenTimings.has(key)) return;
    seenTimings.add(key);
    const status = (t as PerformanceResourceTiming & { responseStatus?: number }).responseStatus || 0;
    const size = t.decodedBodySize || t.encodedBodySize || t.transferSize || -1;
    const e: NetworkEntry = {
      nid: nextNid++,
      kind: 'resource',
      method: 'GET',
      url: t.name,
      source: 'network',
      status,
      statusText: '',
      type: typeOf('', t.name, t.initiatorType),
      mime: '',
      size,
      duration: Math.max(0, t.duration),
      start: t.startTime,
      pending: false,
      initiator: t.initiatorType,
      hasBody: false,
    };
    remember(e);
  }

  function collectTimings(): void {
    try {
      for (const t of performance.getEntriesByType('resource') as PerformanceResourceTiming[]) fromTiming(t);
    } catch {
      /* no resource timing */
    }
  }

  // ---------------------------------------------------------------- node ids

  const hasWeakRef = typeof WeakRef === 'function';
  let ids = new WeakMap<Element, number>();
  let byId = new Map<number, WeakRef<Element> | Element>();
  let nextId = 1;

  function idOf(el: Element): number {
    let id = ids.get(el);
    if (!id) {
      id = nextId++;
      ids.set(el, id);
      byId.set(id, hasWeakRef ? new WeakRef(el) : el);
    }
    return id;
  }

  function elOf(id: unknown): Element | null {
    if (typeof id !== 'number') return null;
    const r = byId.get(id);
    const el = r ? (hasWeakRef ? (r as WeakRef<Element>).deref() : (r as Element)) : undefined;
    return el && el.isConnected ? el : null;
  }

  // ---------------------------------------------------------------- tree

  let host: HTMLElement | null = null;
  const hidden = (n: Node) => n === host || n === env.shim;

  function classes(el: Element): string[] {
    return (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean);
  }

  function label(el: Element): string {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    for (const c of classes(el).slice(0, 3)) s += '.' + c;
    return s;
  }

  function crumbs(el: Element): Crumb[] {
    const out: Crumb[] = [];
    for (let n: Element | null = el; n; n = n.parentElement) out.unshift({ id: idOf(n), label: label(n) });
    return out;
  }

  function summary(s: string | null): string {
    const x = String(s || '')
      .slice(0, 400)
      .replace(/\s+/g, ' ')
      .trim();
    return x.length > 80 ? x.slice(0, 79) + '…' : x;
  }

  function childItems(el: Element): Node[] {
    const out: Node[] = [];
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 1) {
        if (!hidden(n)) out.push(n);
      } else if (n.nodeType === 3 && /\S/.test(n.nodeValue || '')) out.push(n);
    }
    return out;
  }

  function attrsOf(el: Element, max: number, cut?: string[]): [string, string][] {
    const out: [string, string][] = [];
    for (const a of Array.from(el.attributes)) {
      if (a.value.length > max) {
        out.push([a.name, a.value.slice(0, max) + '…']);
        if (cut) cut.push(a.name);
      } else out.push([a.name, a.value]);
    }
    return out;
  }

  function serialize(el: Element, depth: number, budget: { n: number }, force: Set<number>): TreeElement {
    const id = idOf(el);
    budget.n--;
    const kids = childItems(el);
    const node: TreeElement = { k: 'e', id, tag: el.tagName.toLowerCase(), attrs: attrsOf(el, 200), count: kids.length };
    // A single text child is always included: the tree shows it inline (<h1>Title</h1>).
    const onlyText = kids.length === 1 && kids[0]!.nodeType === 3;
    if (kids.length && (depth > 0 || force.has(id) || onlyText) && budget.n > 0) {
      const children: TreeChild[] = [];
      for (let i = 0; i < kids.length && i < MAX_CHILDREN; i++) {
        const n = kids[i]!;
        if (n.nodeType === 3) children.push({ k: 't', text: summary(n.nodeValue) });
        else children.push(serialize(n as Element, depth - 1, budget, force));
      }
      node.children = children;
      if (kids.length > MAX_CHILDREN) node.more = kids.length - MAX_CHILDREN;
    }
    return node;
  }

  // ---------------------------------------------------------------- overlay

  interface Layer {
    el: HTMLElement;
  }
  let layers: { m: Layer; b: Layer; p: Layer; c: Layer; tip: Layer } | null = null;
  let selected: Element | null = null;
  let hovered: Element | null = null;
  let frame = 0;

  function ensureOverlay(): void {
    if (!host) {
      host = doc.createElement('div');
      host.setAttribute('data-codevia-inspector', '');
      host.style.cssText =
        'all:initial;position:fixed;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none;z-index:2147483647;display:block';
      const root: ParentNode = host.attachShadow ? host.attachShadow({ mode: 'closed' }) : host;
      const mk = (css: string): Layer => {
        const el = doc.createElement('div');
        el.style.cssText = 'position:fixed;box-sizing:border-box;pointer-events:none;display:none;border-style:solid;border-width:0;' + css;
        root.appendChild(el);
        return { el };
      };
      layers = {
        m: mk('border-color:rgba(246,178,107,.66)'),
        b: mk('border-color:rgba(255,229,153,.66)'),
        p: mk('border-color:rgba(147,196,125,.55)'),
        c: mk('background:rgba(111,168,220,.66)'),
        tip: mk(
          'border-width:0;background:#1d2330;color:#f2f4f7;font:12px/1.3 ui-monospace,Menlo,monospace;padding:4px 7px;border-radius:5px;white-space:nowrap;max-width:90vw;overflow:hidden;text-overflow:ellipsis;box-shadow:0 2px 8px rgba(0,0,0,.35)',
        ),
      };
    }
    if (!host.isConnected) doc.documentElement.appendChild(host);
  }

  function removeOverlay(): void {
    if (host && host.isConnected) host.remove();
  }

  function px(cs: CSSStyleDeclaration, prop: string): number {
    const v = parseFloat(cs.getPropertyValue(prop));
    return Number.isFinite(v) ? v : 0;
  }

  function edges(cs: CSSStyleDeclaration, pre: string, post = ''): Edges {
    return {
      top: px(cs, pre + '-top' + post),
      right: px(cs, pre + '-right' + post),
      bottom: px(cs, pre + '-bottom' + post),
      left: px(cs, pre + '-left' + post),
    };
  }

  const r2 = (n: number) => Math.round(n * 100) / 100;

  function boxOf(el: Element): BoxModel {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const margin = edges(cs, 'margin');
    const border = edges(cs, 'border', '-width');
    const padding = edges(cs, 'padding');
    return {
      width: r2(Math.max(0, r.width - border.left - border.right - padding.left - padding.right)),
      height: r2(Math.max(0, r.height - border.top - border.bottom - padding.top - padding.bottom)),
      margin,
      border,
      padding,
      x: r2(r.left),
      y: r2(r.top),
      boxSizing: cs.getPropertyValue('box-sizing'),
      display: cs.getPropertyValue('display'),
      position: cs.getPropertyValue('position'),
    };
  }

  function place(l: Layer, x: number, y: number, w: number, h: number, ring: Edges | null): void {
    const s = l.el.style;
    s.display = w > 0 || h > 0 ? 'block' : 'none';
    s.left = x + 'px';
    s.top = y + 'px';
    s.width = Math.max(0, w) + 'px';
    s.height = Math.max(0, h) + 'px';
    if (ring) s.borderWidth = `${Math.max(0, ring.top)}px ${Math.max(0, ring.right)}px ${Math.max(0, ring.bottom)}px ${Math.max(0, ring.left)}px`;
  }

  function draw(el: Element | null): void {
    if (!el || !el.isConnected) {
      if (layers) for (const l of [layers.m, layers.b, layers.p, layers.c, layers.tip]) l.el.style.display = 'none';
      return;
    }
    ensureOverlay();
    const L = layers!;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const m = edges(cs, 'margin');
    const b = edges(cs, 'border', '-width');
    const p = edges(cs, 'padding');
    const mt = Math.max(0, m.top);
    const ml = Math.max(0, m.left);
    place(L.m, r.left - ml, r.top - mt, r.width + ml + Math.max(0, m.right), r.height + mt + Math.max(0, m.bottom), m);
    place(L.b, r.left, r.top, r.width, r.height, b);
    place(L.p, r.left + b.left, r.top + b.top, r.width - b.left - b.right, r.height - b.top - b.bottom, p);
    place(
      L.c,
      r.left + b.left + p.left,
      r.top + b.top + p.top,
      r.width - b.left - b.right - p.left - p.right,
      r.height - b.top - b.bottom - p.top - p.bottom,
      null,
    );
    const tip = L.tip.el;
    tip.textContent = label(el) + '  ' + Math.round(r.width * 100) / 100 + ' × ' + Math.round(r.height * 100) / 100;
    tip.style.display = 'block';
    tip.style.width = 'auto';
    tip.style.height = 'auto';
    const vh = win.innerHeight || doc.documentElement.clientHeight || 0;
    const vw = win.innerWidth || doc.documentElement.clientWidth || 0;
    const top = r.top - mt - 26 >= 0 ? r.top - mt - 26 : Math.min(r.bottom + Math.max(0, m.bottom) + 4, Math.max(0, vh - 26));
    tip.style.top = Math.max(0, top) + 'px';
    tip.style.left = Math.max(0, Math.min(r.left, vw - 160)) + 'px';
  }

  function redrawSoon(): void {
    if (frame || !(selected || hovered)) return;
    const raf = win.requestAnimationFrame || ((f: FrameRequestCallback) => setTimeout(() => f(0), 16));
    frame = raf(() => {
      frame = 0;
      draw(hovered || selected);
    }) as unknown as number;
  }

  // ---------------------------------------------------------------- styles

  const IMPORTANT = [
    'display', 'position', 'top', 'right', 'bottom', 'left', 'z-index', 'float', 'clear',
    'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height', 'box-sizing',
    'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'border-style', 'border-color', 'border-radius',
    'color', 'background-color', 'background-image', 'opacity', 'visibility', 'overflow', 'overflow-x', 'overflow-y',
    'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-align', 'text-decoration-line', 'text-transform', 'white-space',
    'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis', 'justify-content', 'align-items', 'align-self', 'gap', 'order',
    'grid-template-columns', 'grid-template-rows', 'grid-column', 'grid-row',
    'transform', 'transition', 'box-shadow', 'cursor', 'pointer-events', 'content',
  ];

  function shorten(v: string): { value: string; truncated: boolean } {
    if (v.length <= 300) return { value: v, truncated: false };
    return { value: v.replace(/(data:[^,;)'"]{0,60}[;,][^)'"]{0,40})[^)'"]*/g, '$1…').slice(0, 300) + (v.length > 300 ? '…' : ''), truncated: true };
  }

  /** Splits at top-level `sep` (outside quotes, parentheses and brackets). */
  function splitTop(s: string, sep: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let q = '';
    let start = 0;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (q) {
        if (ch === '\\') i++;
        else if (ch === q) q = '';
      } else if (ch === '"' || ch === "'") q = ch;
      else if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
      else if (ch === sep && !depth) {
        out.push(s.slice(start, i));
        start = i + 1;
      }
    }
    out.push(s.slice(start));
    return out;
  }

  function parseDecls(cssText: string): Decl[] {
    const out: Decl[] = [];
    for (const part of splitTop(cssText || '', ';')) {
      const c = part.indexOf(':');
      if (c <= 0) continue;
      const name = part.slice(0, c).trim();
      let value = part.slice(c + 1).trim();
      if (!name) continue;
      let important = false;
      const m = /\s*!\s*important\s*$/i.exec(value);
      if (m) {
        important = true;
        value = value.slice(0, m.index).trim();
      }
      const s = shorten(value);
      const d: Decl = { name: name.startsWith('--') ? name : name.toLowerCase(), value: s.value, important };
      if (s.truncated) d.truncated = true;
      out.push(d);
    }
    return out;
  }

  /** Specificity [ids, classes/attributes/pseudo-classes, types/pseudo-elements] of one complex selector. */
  function specificity(sel: string): [number, number, number] {
    let a = 0;
    let b = 0;
    let c = 0;
    const s = sel;
    let i = 0;
    const ident = () => {
      const start = i;
      while (i < s.length && /[\w\u00a0-\uffff-]|\\/.test(s[i]!)) i += s[i] === '\\' ? 2 : 1;
      return s.slice(start, i);
    };
    const parens = () => {
      if (s[i] !== '(') return '';
      let depth = 0;
      const start = i;
      for (; i < s.length; i++) {
        if (s[i] === '(') depth++;
        else if (s[i] === ')' && --depth === 0) {
          i++;
          break;
        }
      }
      return s.slice(start + 1, i - 1);
    };
    const maxOf = (list: string) => {
      let best: [number, number, number] = [0, 0, 0];
      for (const part of splitTop(list, ',')) {
        const x = specificity(part);
        if (x[0] > best[0] || (x[0] === best[0] && (x[1] > best[1] || (x[1] === best[1] && x[2] > best[2])))) best = x;
      }
      return best;
    };
    while (i < s.length) {
      const ch = s[i]!;
      if (ch === '#') {
        i++;
        ident();
        a++;
      } else if (ch === '.') {
        i++;
        ident();
        b++;
      } else if (ch === '[') {
        let q = '';
        for (; i < s.length; i++) {
          if (q) {
            if (s[i] === q) q = '';
          } else if (s[i] === '"' || s[i] === "'") q = s[i]!;
          else if (s[i] === ']') {
            i++;
            break;
          }
        }
        b++;
      } else if (ch === ':') {
        i++;
        if (s[i] === ':') {
          i++;
          ident();
          parens();
          c++;
          continue;
        }
        const name = ident().toLowerCase();
        const arg = parens();
        if (/^(is|not|has|matches|-webkit-any|-moz-any)$/.test(name)) {
          const x = maxOf(arg);
          a += x[0];
          b += x[1];
          c += x[2];
        } else if (name === 'where') {
          /* zero */
        } else if (/^(before|after|first-line|first-letter)$/.test(name)) c++;
        else {
          b++;
          const of = /^nth-(last-)?child$/.test(name) ? /\sof\s(.+)$/i.exec(arg) : null;
          if (of) {
            const x = maxOf(of[1]!);
            a += x[0];
            b += x[1];
            c += x[2];
          }
        }
      } else if (/[a-zA-Z_\u00a0-\uffff-]|\\/.test(ch)) {
        ident();
        c++;
      } else i++;
    }
    return [a, b, c];
  }

  function cmpSpec(x: [number, number, number], y: [number, number, number]): number {
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  }

  interface LooseRule {
    type: number;
    selectorText?: string;
    style?: CSSStyleDeclaration;
    cssRules?: CSSRuleList;
    media?: MediaList;
    conditionText?: string;
    name?: string;
    styleSheet?: CSSStyleSheet | null;
  }
  interface Found extends MatchedRule {
    order: number;
  }

  function mediaMatches(text: string): boolean {
    try {
      return typeof win.matchMedia === 'function' ? win.matchMedia(text).matches : true;
    } catch {
      return true;
    }
  }

  function supports(text: string): boolean {
    try {
      return typeof CSS !== 'undefined' && typeof CSS.supports === 'function' ? CSS.supports(text) : true;
    } catch {
      return true;
    }
  }

  function nestedSelector(sel: string, parent: string | null): string {
    if (!parent) return sel;
    return splitTop(sel, ',')
      .map((p) => (p.includes('&') ? p.replace(/&/g, ':is(' + parent + ')') : ':is(' + parent + ') ' + p.trim()))
      .join(', ');
  }

  function walk(
    el: Element,
    rules: CSSRuleList | undefined,
    key: string,
    conds: string[],
    parentSel: string | null,
    src: string | null,
    origin: MatchedRule['origin'],
    out: Found[],
    counter: { n: number },
  ): void {
    if (!rules) return;
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i] as unknown as LooseRule;
      const k = key + '/' + i;
      try {
        if (r.type === 1 && typeof r.selectorText === 'string' && r.style) {
          const full = nestedSelector(r.selectorText, parentSel);
          const order = counter.n++;
          const parts = splitTop(full, ',')
            .map((p) => p.trim())
            .filter((p) => {
              try {
                return el.matches(p);
              } catch {
                return false;
              }
            });
          if (parts.length) {
            let spec: [number, number, number] = [0, 0, 0];
            for (const p of parts) {
              const x = specificity(p);
              if (cmpSpec(x, spec) > 0) spec = x;
            }
            const f: Found = {
              key: k,
              selector: r.selectorText,
              matched: parts.join(', '),
              specificity: spec,
              decls: parseDecls(r.style.cssText),
              src,
              origin,
              order,
            };
            if (conds.length) f.conditions = conds.slice();
            out.push(f);
          }
          if (r.cssRules && r.cssRules.length) walk(el, r.cssRules, k, conds, full, src, origin, out, counter);
        } else if (r.type === 3) {
          if (r.styleSheet) walk(el, r.styleSheet.cssRules, k, conds, parentSel, src, origin, out, counter);
        } else if (r.type === 4) {
          const text = r.media ? r.media.mediaText : '';
          if (mediaMatches(text)) walk(el, r.cssRules, k, conds.concat('@media ' + text), parentSel, src, origin, out, counter);
        } else if (r.type === 12) {
          if (supports(r.conditionText || '')) walk(el, r.cssRules, k, conds.concat('@supports ' + (r.conditionText || '')), parentSel, src, origin, out, counter);
        } else if (r.type !== 7 && r.cssRules && !r.style) {
          // @layer, @container, @scope…: conditions we cannot evaluate are assumed to apply.
          const c = r.conditionText !== undefined ? '@container ' + r.conditionText : r.name !== undefined ? '@layer ' + r.name : '@rule';
          walk(el, r.cssRules, k, conds.concat(c), parentSel, src, origin, out, counter);
        }
      } catch {
        /* unreadable rule */
      }
    }
  }

  function matchedRules(el: Element): Found[] {
    const out: Found[] = [];
    const counter = { n: 0 };
    const sheets = doc.styleSheets;
    for (let s = 0; s < sheets.length; s++) {
      const sheet = sheets[s]!;
      let rules: CSSRuleList | undefined;
      try {
        rules = sheet.cssRules;
      } catch {
        continue; // cross-origin stylesheet
      }
      if (sheet.disabled) continue;
      const owner = sheet.ownerNode as Element | null;
      if (owner && hidden(owner)) continue;
      if (sheet.media && sheet.media.mediaText && !mediaMatches(sheet.media.mediaText)) continue;
      const mark = owner && owner.getAttribute ? owner.getAttribute('data-codevia-src') : null;
      const href = sheet.href;
      const origin: MatchedRule['origin'] = mark ? 'file' : href ? 'external' : 'page';
      walk(el, rules, 's' + s, [], null, mark || (href ? href : BASE), origin, out, counter);
    }
    out.sort((x, y) => cmpSpec(y.specificity, x.specificity) || y.order - x.order);
    return out;
  }

  const scratch = doc.createElement('div').style;
  const longCache = new Map<string, string[]>();
  function longhands(d: Decl): string[] {
    if (d.name.startsWith('--')) return [d.name];
    const k = d.name + ':' + d.value;
    let hit = longCache.get(k);
    if (!hit) {
      hit = [];
      try {
        scratch.cssText = '';
        scratch.setProperty(d.name, d.value);
        for (let i = 0; i < scratch.length; i++) hit.push(scratch[i]!);
      } catch {
        /* ignore */
      }
      if (!hit.length) hit = [d.name];
      if (longCache.size > 500) longCache.clear();
      longCache.set(k, hit);
    }
    return hit;
  }

  /** Marks declarations that lose the cascade (inline first, then rules by specificity and order; !important first). */
  function markOverridden(groups: Decl[][]): void {
    const claimed = new Set<string>();
    for (const pass of [true, false]) {
      for (const g of groups) {
        // Within one block the last declaration of a property wins.
        for (let i = g.length - 1; i >= 0; i--) {
          const d = g[i]!;
          if (d.important !== pass) continue;
          const lh = longhands(d);
          if (lh.every((p) => claimed.has(p))) d.overridden = true;
          else lh.forEach((p) => claimed.add(p));
        }
      }
    }
  }

  function computed(el: Element, all: boolean): [string, string][] {
    const cs = getComputedStyle(el);
    const names: string[] = [];
    if (all) for (let i = 0; i < cs.length; i++) names.push(cs[i]!);
    const list = all ? names.sort() : IMPORTANT;
    const out: [string, string][] = [];
    for (const n of list) {
      const v = cs.getPropertyValue(n);
      if (v !== '') out.push([n, shorten(v).value]);
    }
    return out;
  }

  function stylesOf(el: Element, rid: number, all: boolean): Record<string, unknown> {
    const rules = matchedRules(el);
    const inline = parseDecls(el.getAttribute('style') || '');
    markOverridden([inline, ...rules.map((r) => r.decls)]);
    const cut: string[] = [];
    let box: BoxModel | null;
    try {
      box = boxOf(el);
    } catch {
      box = null;
    }
    return {
      type: 'inspect:styles',
      rid,
      id: idOf(el),
      found: true,
      tag: el.tagName.toLowerCase(),
      path: crumbs(el),
      inline,
      rules: rules.map((r) => {
        const { order: _order, ...rest } = r;
        return rest;
      }),
      computed: computed(el, all),
      box,
      attrs: attrsOf(el, 2000, cut),
      attrsTruncated: cut,
    };
  }

  function ruleByKey(key: string): LooseRule | null {
    const m = /^s(\d+)((?:\/\d+)+)$/.exec(key || '');
    if (!m) return null;
    const sheet = doc.styleSheets[Number(m[1])];
    if (!sheet) return null;
    let list: CSSRuleList | undefined = sheet.cssRules;
    let rule: LooseRule | null = null;
    for (const part of m[2]!.slice(1).split('/')) {
      if (!list) return null;
      rule = (list[Number(part)] as unknown as LooseRule) || null;
      if (!rule) return null;
      list = rule.type === 3 && rule.styleSheet ? rule.styleSheet.cssRules : rule.cssRules;
    }
    return rule;
  }

  // ---------------------------------------------------------------- pick mode

  let picking = false;
  let pickListening = false;
  let pickTimer: ReturnType<typeof setTimeout> | 0 = 0;
  let touchStart: { x: number; y: number; moved: boolean } | null = null;
  const SWALLOW = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu', 'touchstart', 'touchmove', 'touchend'];

  function target(e: Event, x?: number, y?: number): Element | null {
    let el: Element | null = null;
    if (x !== undefined && y !== undefined && typeof doc.elementFromPoint === 'function') {
      try {
        el = doc.elementFromPoint(x, y);
      } catch {
        el = null;
      }
    }
    if (!el || hidden(el)) {
      const t = e.target as Node | null;
      el = t && t.nodeType === 1 ? (t as Element) : t && t.parentElement ? t.parentElement : null;
    }
    return el && !hidden(el) ? el : null;
  }

  function pickAt(el: Element | null): void {
    if (!picking || !el) return;
    picking = false;
    hovered = null;
    selected = el;
    draw(el);
    post({ type: 'inspect:picked', id: idOf(el), path: crumbs(el) });
    post({ type: 'inspect:pick', on: false });
    // Keep swallowing the rest of this tap (mouseup/click after touchend) before the page gets events again.
    if (pickTimer) clearTimeout(pickTimer);
    pickTimer = setTimeout(stopListening, 450);
  }

  function onPickEvent(e: Event): void {
    e.stopPropagation();
    e.stopImmediatePropagation();
    const type = e.type;
    if (type === 'touchstart') {
      const t = (e as TouchEvent).touches[0];
      touchStart = t ? { x: t.clientX, y: t.clientY, moved: false } : null;
      return; // no preventDefault: the page can still scroll while picking
    }
    if (type === 'touchmove') {
      const t = (e as TouchEvent).touches[0];
      if (t && touchStart && Math.abs(t.clientX - touchStart.x) + Math.abs(t.clientY - touchStart.y) > 10) touchStart.moved = true;
      if (picking && t) {
        hovered = target(e, t.clientX, t.clientY);
        draw(hovered);
      }
      return;
    }
    if (e.cancelable) e.preventDefault();
    if (type === 'touchend') {
      const t = (e as TouchEvent).changedTouches[0];
      const moved = touchStart ? touchStart.moved : false;
      touchStart = null;
      if (!moved) pickAt(target(e, t ? t.clientX : undefined, t ? t.clientY : undefined));
      return;
    }
    if (type === 'click') {
      const me = e as MouseEvent;
      pickAt(target(e, me.clientX || undefined, me.clientY || undefined));
    }
  }

  function onPickHover(e: Event): void {
    if (!picking) return;
    const me = e as MouseEvent;
    const el = target(e, me.clientX, me.clientY);
    if (el && el !== hovered) {
      hovered = el;
      draw(el);
    }
  }

  function startListening(): void {
    if (pickListening) return;
    pickListening = true;
    for (const t of SWALLOW) win.addEventListener(t, onPickEvent, { capture: true, passive: false });
    win.addEventListener('mousemove', onPickHover, true);
  }

  function stopListening(): void {
    if (pickTimer) clearTimeout(pickTimer);
    pickTimer = 0;
    if (!pickListening) return;
    pickListening = false;
    for (const t of SWALLOW) win.removeEventListener(t, onPickEvent, { capture: true });
    win.removeEventListener('mousemove', onPickHover, true);
  }

  function setPick(v: boolean): void {
    picking = v;
    hovered = null;
    if (v) startListening();
    else {
      stopListening();
      draw(selected);
    }
    post({ type: 'inspect:pick', on: v });
  }

  // ---------------------------------------------------------------- enable / observers

  let mo: MutationObserver | null = null;
  let po: PerformanceObserver | null = null;
  let changeTimer: ReturnType<typeof setTimeout> | 0 = 0;

  function onMutations(records: MutationRecord[]): void {
    let relevant = false;
    for (const r of records) {
      if (r.target === host) continue;
      if (r.type === 'childList') {
        const nodes = Array.from(r.addedNodes).concat(Array.from(r.removedNodes));
        if (nodes.length && nodes.every((n) => n === host)) continue;
      }
      relevant = true;
      break;
    }
    if (!relevant) return;
    redrawSoon();
    // Throttled with a trailing edge: continuous animations still produce one event per interval.
    if (!changeTimer)
      changeTimer = setTimeout(() => {
        changeTimer = 0;
        if (on) post({ type: 'inspect:dom-changed' });
      }, 300);
  }

  const onViewport = () => redrawSoon();

  function enable(): void {
    if (!on) {
      on = true;
      try {
        mo = new MutationObserver(onMutations);
        mo.observe(doc.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      } catch {
        mo = null;
      }
      try {
        if (typeof PerformanceObserver === 'function') {
          po = new PerformanceObserver((list) => {
            for (const t of list.getEntries() as PerformanceResourceTiming[]) fromTiming(t);
          });
          po.observe({ type: 'resource' });
        }
      } catch {
        po = null;
      }
      win.addEventListener('scroll', onViewport, { capture: true, passive: true });
      win.addEventListener('resize', onViewport, { passive: true });
      collectTimings();
    }
    post({ type: 'inspect:enabled', page: BASE, title: doc.title });
  }

  function disable(): void {
    if (!on) return;
    on = false;
    mo?.disconnect();
    mo = null;
    po?.disconnect();
    po = null;
    if (changeTimer) clearTimeout(changeTimer);
    changeTimer = 0;
    win.removeEventListener('scroll', onViewport, { capture: true });
    win.removeEventListener('resize', onViewport);
    picking = false;
    stopListening();
    selected = null;
    hovered = null;
    removeOverlay();
    if (!hasWeakRef) {
      ids = new WeakMap();
      byId = new Map();
    }
  }

  // ---------------------------------------------------------------- requests

  type Req = Record<string, unknown> & { type: string; rid?: number };

  function handle(d: Req): void {
    const rid = typeof d.rid === 'number' ? d.rid : 0;
    switch (d.type) {
      case 'inspect:enable':
        enable();
        return;
      case 'inspect:disable':
        disable();
        return;
      case 'inspect:tree': {
        const root = d.id === undefined ? doc.documentElement : elOf(d.id);
        const force = new Set<number>(Array.isArray(d.expanded) ? (d.expanded as unknown[]).filter((x): x is number => typeof x === 'number') : []);
        const reveal = elOf(d.reveal);
        let path: Crumb[] | undefined;
        if (reveal) {
          path = crumbs(reveal);
          for (const c of path.slice(0, -1)) force.add(c.id);
        }
        const depth = typeof d.depth === 'number' ? d.depth : d.id === undefined ? 3 : 1;
        const node = root ? serialize(root, depth, { n: TREE_BUDGET }, force) : null;
        post(path ? { type: 'inspect:tree', rid, node, path } : { type: 'inspect:tree', rid, node });
        return;
      }
      case 'inspect:select': {
        const el = elOf(d.id);
        selected = el;
        hovered = null;
        if (el && d.scroll) {
          const r = el.getBoundingClientRect();
          if (r.bottom < 0 || r.top > (win.innerHeight || 0) || r.right < 0 || r.left > (win.innerWidth || 0)) {
            try {
              el.scrollIntoView({ block: 'center', inline: 'nearest' });
            } catch {
              /* ignore */
            }
          }
        }
        if (el) draw(el);
        else removeOverlay();
        let box: BoxModel | null;
        try {
          box = el ? boxOf(el) : null;
        } catch {
          box = null;
        }
        post({ type: 'inspect:selected', id: el ? idOf(el) : null, path: el ? crumbs(el) : [], box });
        return;
      }
      case 'inspect:styles': {
        const el = elOf(d.id);
        if (!el) {
          post({ type: 'inspect:styles', rid, id: d.id, found: false, tag: '', path: [], inline: [], rules: [], computed: [], box: null, attrs: [], attrsTruncated: [] });
          return;
        }
        post(stylesOf(el, rid, !!d.allComputed));
        return;
      }
      case 'inspect:pick':
        setPick(!!d.on);
        return;
      case 'inspect:edit-style': {
        const el = elOf(d.id);
        const prop = String(d.prop || '').trim();
        const value = String(d.value ?? '').trim();
        let style: CSSStyleDeclaration | null = null;
        if (typeof d.rule === 'string' && d.rule) {
          const r = ruleByKey(d.rule);
          style = r && r.style ? r.style : null;
        } else if (el) style = (el as HTMLElement).style || null;
        if (!style || !prop) {
          post({ type: 'inspect:edited', rid, ok: false, error: 'not found' });
          return;
        }
        if (!value) style.removeProperty(prop);
        else {
          style.setProperty(prop, value, d.important ? 'important' : '');
          if (!style.getPropertyValue(prop)) {
            post({ type: 'inspect:edited', rid, ok: false, error: 'invalid value' });
            return;
          }
        }
        redrawSoon();
        post({ type: 'inspect:edited', rid, ok: true });
        return;
      }
      case 'inspect:edit-attr': {
        const el = elOf(d.id);
        const name = String(d.name || '').trim();
        if (!el || !name) {
          post({ type: 'inspect:edited', rid, ok: false, error: 'not found' });
          return;
        }
        try {
          if (typeof d.oldName === 'string' && d.oldName && d.oldName !== name) el.removeAttribute(d.oldName);
          if (d.value === null || d.value === undefined) el.removeAttribute(name);
          else el.setAttribute(name, String(d.value));
          redrawSoon();
          post({ type: 'inspect:edited', rid, ok: true });
        } catch (err) {
          post({ type: 'inspect:edited', rid, ok: false, error: String((err as Error)?.message || err) });
        }
        return;
      }
      case 'inspect:query': {
        try {
          const all = Array.from(doc.querySelectorAll(String(d.selector || ''))).filter((el) => !hidden(el) && !(host && host.contains(el)));
          post({ type: 'inspect:query', rid, total: all.length, results: all.slice(0, 100).map((el) => ({ id: idOf(el), label: label(el) })) });
        } catch (err) {
          post({ type: 'inspect:query', rid, total: 0, results: [], error: String((err as Error)?.message || err) });
        }
        return;
      }
      case 'inspect:network-all':
        collectTimings();
        post({ type: 'inspect:network-all', rid, entries: net.slice().sort((x, y) => x.start - y.start) });
        return;
      case 'inspect:network-clear':
        net = [];
        bodies.clear();
        return;
      case 'inspect:response': {
        const e = net.find((x) => x.nid === d.nid);
        const res: Record<string, unknown> = { type: 'inspect:response', rid, nid: d.nid, mime: e ? e.mime : '' };
        const f = e && e.source === 'project' && e.path ? FILES[e.path] : undefined;
        if (e && f) {
          res.mime = f.t;
          if (!f.b) {
            res.text = f.d.length > MAX_BODY ? f.d.slice(0, MAX_BODY) : f.d;
            if (f.d.length > MAX_BODY) res.truncated = true;
          } else if (/^image\//.test(f.t)) res.dataUrl = 'data:' + f.t + ';base64,' + f.d;
        } else if (e && bodies.has(e.nid)) {
          const b = bodies.get(e.nid)!;
          res.mime = b.mime;
          res.text = b.text;
          if (b.truncated) res.truncated = true;
        } else if (e && e.type === 'image' && /^(https?:|data:|blob:)/.test(e.url)) res.url = e.url;
        post(res);
        return;
      }
    }
  }

  win.addEventListener('message', (e: MessageEvent) => {
    const d = e.data as Req | null;
    if (!d || typeof d !== 'object' || typeof d.type !== 'string' || d.type.indexOf('inspect:') !== 0) return;
    if ((d as { token?: unknown }).token !== env.T) return;
    if (e.source && e.source !== win.parent && e.source !== win) return;
    // Inspector traffic is not the page's business.
    e.stopImmediatePropagation();
    try {
      handle(d);
    } catch (err) {
      if (typeof d.rid === 'number') post({ type: d.type, rid: d.rid, error: String((err as Error)?.message || err) });
    }
  });

  post({ type: 'inspect:hello', page: BASE });
}
