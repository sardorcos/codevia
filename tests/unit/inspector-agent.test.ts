// @vitest-environment jsdom
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { buildPreview } from '../../src/core/preview';
import { binaryFile, textFile, type Files } from '../../src/core/types';
import { inspectorAgent } from '../../src/tools/inspector/agent';
import type { InspectorRequest, MatchedRule, NetworkEntry, TreeChild, TreeElement } from '../../src/tools/inspector/protocol';

type Msg = Record<string, unknown> & { type: string };
type Win = Window & typeof globalThis;

interface PageOpts {
  /** Replaces window.fetch before the shim runs (the shim falls back to it for network URLs). */
  fetch?: (input: unknown, init?: unknown) => Promise<Response>;
}

/** Builds a preview page and runs it in jsdom; `send` posts inspector requests the way the app will. */
function runPage(files: Files, opts: PageOpts = {}, entry = 'index.html') {
  const { html } = buildPreview(files, entry, (files[entry] as { content: string }).content, { allowNetwork: false, token: 't' });
  const messages: Msg[] = [];
  const dom = new JSDOM(html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, ''), {
    runScripts: 'dangerously',
    url: 'https://host.test/preview-host.html',
    pretendToBeVisual: true,
    beforeParse(w) {
      Object.defineProperty(w, 'parent', { value: { postMessage: (m: Msg) => messages.push(structuredClone(m)) } });
      const g = w as unknown as Record<string, unknown>;
      g.Response = Response;
      g.Headers = Headers;
      g.fetch = opts.fetch ?? (() => Promise.reject(new TypeError('offline')));
    },
  });
  const w = dom.window as unknown as Win;
  const send = (msg: InspectorRequest | Record<string, unknown>, token = 't') =>
    w.dispatchEvent(new w.MessageEvent('message', { data: { ...msg, token } }));
  const last = <T extends Msg = Msg>(type: string): T => {
    const all = messages.filter((m) => m.type === type);
    if (!all.length) throw new Error(`no ${type} message; got ${messages.map((m) => m.type).join(', ')}`);
    return all[all.length - 1] as T;
  };
  const ask = <T extends Msg = Msg>(msg: InspectorRequest): T => {
    send(msg);
    return last<T>(msg.type === 'inspect:edit-style' || msg.type === 'inspect:edit-attr' ? 'inspect:edited' : msg.type === 'inspect:select' ? 'inspect:selected' : msg.type);
  };
  return { dom, w, doc: w.document, messages, send, last, ask };
}

const flush = () => new Promise((r) => setTimeout(r, 20));
const elements = (n: TreeElement): TreeElement[] => (n.children ?? []).filter((c): c is TreeElement => c.k === 'e');
const find = (n: TreeElement, tag: string): TreeElement | undefined => {
  if (n.tag === tag) return n;
  for (const c of elements(n)) {
    const hit = find(c, tag);
    if (hit) return hit;
  }
  return undefined;
};

const PAGE = `<!doctype html><html><head><title>Demo</title><link rel="stylesheet" href="css/styles.css">
<style>.card { color: green; padding: 4px }</style></head>
<body><main id="main" class="wrap"><h1 class="title big">Hello <b>world</b></h1>
<div class="card" style="margin: 2px; color: purple">Card text</div>
<a id="link" href="about.html">About</a><button id="btn" onclick="window.clicked = (window.clicked || 0) + 1">Go</button></main></body></html>`;

const CSS = `body { margin: 0 }
#main .card {
  color: red;
  border: 1px solid black;
}
.card { color: blue; padding: 8px !important }
@media screen { .card { font-size: 20px } }
h1.title { font-weight: 700 }`;

const site = (): Files => ({
  'index.html': textFile(PAGE),
  'about.html': textFile('<h1>About</h1>'),
  'css/styles.css': textFile(CSS),
  'data.json': textFile('{"n":5}'),
  'img/logo.png': binaryFile(new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4])),
});

describe('inspector agent: lifecycle and protocol', () => {
  it('says hello with the token, enables on request and ignores messages without the token', () => {
    const { messages, send, last } = runPage(site());
    expect(messages[0]).toMatchObject({ type: 'inspect:hello', page: 'index.html', token: 't' });
    send({ type: 'inspect:enable' }, 'wrong');
    expect(messages.some((m) => m.type === 'inspect:enabled')).toBe(false);
    send({ type: 'inspect:enable' });
    expect(last('inspect:enabled')).toMatchObject({ page: 'index.html', title: 'Demo', token: 't' });
  });

  it('keeps inspector traffic away from the page message listeners', () => {
    const { w, send } = runPage(site());
    const seen: unknown[] = [];
    w.addEventListener('message', (e) => seen.push(e.data));
    send({ type: 'inspect:enable' });
    w.dispatchEvent(new w.MessageEvent('message', { data: { hello: 1 } }));
    expect(seen).toEqual([{ hello: 1 }]);
  });

  it('is self-contained so it can be serialized into the page', () => {
    const src = inspectorAgent.toString();
    expect(src).not.toMatch(/<\/script|<!--/i);
    expect(() => new Function(`return (${src})`)()).not.toThrow();
  });

  it('adds data-codevia-src to inlined stylesheets', () => {
    const { doc } = runPage(site());
    expect(doc.querySelector('style[data-codevia-src="css/styles.css"]')).not.toBeNull();
  });
});

describe('inspector agent: DOM tree', () => {
  it('serializes elements and text summaries with stable ids, hiding the shim', () => {
    const { ask, doc } = runPage(site());
    const tree = ask<Msg & { node: TreeElement }>({ type: 'inspect:tree', rid: 1 }).node;
    expect(tree).toMatchObject({ k: 'e', tag: 'html' });
    expect(elements(tree).map((e) => e.tag)).toEqual(['head', 'body']);
    const head = elements(tree)[0]!;
    // The shim script is not shown; the inlined stylesheets are.
    expect(elements(head).map((e) => e.tag)).toEqual(['meta', 'title', 'style', 'style']);
    const main = find(tree, 'main')!;
    expect(main.attrs).toEqual([
      ['id', 'main'],
      ['class', 'wrap'],
    ]);
    // depth 3 from <html>: main (depth 2) has its children listed but not theirs.
    expect(main.children).toBeDefined();
    const h1 = elements(main)[0]!;
    expect(h1.tag).toBe('h1');
    expect(h1.count).toBe(2);
    expect(h1.children).toBeUndefined();
    // Lazy children of h1: a text summary and <b>.
    const sub = ask<Msg & { node: TreeElement }>({ type: 'inspect:tree', rid: 2, id: h1.id }).node;
    expect(sub.id).toBe(h1.id);
    expect(sub.children![0]).toEqual({ k: 't', text: 'Hello' } satisfies TreeChild);
    expect((sub.children![1] as TreeElement).tag).toBe('b');
    // Ids are stable across requests.
    const again = ask<Msg & { node: TreeElement }>({ type: 'inspect:tree', rid: 3 }).node;
    expect(find(again, 'main')!.id).toBe(main.id);
    expect(doc.querySelectorAll('[data-codevia-inspector]').length).toBe(0);
  });

  it('loads expanded nodes and the path to a revealed node', () => {
    const { ask } = runPage(site());
    const tree = ask<Msg & { node: TreeElement }>({ type: 'inspect:tree', rid: 1 }).node;
    const h1 = elements(find(tree, 'main')!)[0]!;
    const b = (ask<Msg & { node: TreeElement }>({ type: 'inspect:tree', rid: 2, id: h1.id }).node.children![1] as TreeElement).id;
    const body = find(tree, 'body')!.id;
    const main = find(tree, 'main')!.id;
    // depth 1 loads only html's children; expanded nodes (the panel sends every open node) get theirs too.
    expect(find(ask<Msg & { node: TreeElement }>({ type: 'inspect:tree', rid: 3, depth: 1 }).node, 'main')).toBeUndefined();
    const withExpanded = ask<Msg & { node: TreeElement }>({ type: 'inspect:tree', rid: 3, depth: 1, expanded: [body, main, h1.id] }).node;
    expect(find(withExpanded, 'b')!.id).toBe(b);
    const revealed = ask<Msg & { node: TreeElement; path: { id: number; label: string }[] }>({ type: 'inspect:tree', rid: 4, depth: 1, reveal: b });
    expect(revealed.path.map((c) => c.label)).toEqual(['html', 'body', 'main#main.wrap', 'h1.title.big', 'b']);
    expect(find(revealed.node, 'b')!.id).toBe(b);
  });

  it('limits huge child lists', () => {
    const items = Array.from({ length: 350 }, (_, i) => `<li>${i}</li>`).join('');
    const { ask } = runPage({ 'index.html': textFile(`<ul id="l">${items}</ul>`) });
    const tree = ask<Msg & { node: TreeElement }>({ type: 'inspect:tree', rid: 1, depth: 4 }).node;
    const ul = find(tree, 'ul')!;
    expect(ul.count).toBe(350);
    expect(ul.children).toHaveLength(300);
    expect(ul.more).toBe(50);
  });

  it('answers selector queries and reports invalid selectors', () => {
    const { ask } = runPage(site());
    const q = ask<Msg & { results: { label: string }[]; total: number }>({ type: 'inspect:query', rid: 1, selector: 'main > *' });
    expect(q.total).toBe(4);
    expect(q.results.map((r) => r.label)).toEqual(['h1.title.big', 'div.card', 'a#link', 'button#btn']);
    const bad = ask<Msg & { error?: string }>({ type: 'inspect:query', rid: 2, selector: '##' });
    expect(bad.error).toBeTruthy();
  });

  it('posts a debounced dom-changed while enabled, but not for its own overlay', async () => {
    const { send, doc, messages, ask } = runPage(site());
    send({ type: 'inspect:enable' });
    const main = find(ask<Msg & { node: TreeElement }>({ type: 'inspect:tree', rid: 1 }).node, 'main')!;
    send({ type: 'inspect:select', id: main.id });
    await new Promise((r) => setTimeout(r, 400));
    expect(messages.filter((m) => m.type === 'inspect:dom-changed')).toHaveLength(0);
    doc.getElementById('main')!.append(doc.createElement('p'));
    doc.getElementById('main')!.append(doc.createElement('p'));
    await new Promise((r) => setTimeout(r, 400));
    expect(messages.filter((m) => m.type === 'inspect:dom-changed')).toHaveLength(1);
    send({ type: 'inspect:disable' });
    doc.getElementById('main')!.append(doc.createElement('p'));
    await new Promise((r) => setTimeout(r, 400));
    expect(messages.filter((m) => m.type === 'inspect:dom-changed')).toHaveLength(1);
  });
});

describe('inspector agent: selection, styles and edits', () => {
  const idOf = (ask: ReturnType<typeof runPage>['ask'], selector: string) =>
    ask<Msg & { results: { id: number }[] }>({ type: 'inspect:query', rid: 99, selector }).results[0]!.id;

  it('highlights the selected element in a pointer-events:none overlay outside the tree', () => {
    const { ask, doc, send } = runPage(site());
    send({ type: 'inspect:enable' });
    const id = idOf(ask, '.card');
    const sel = ask<Msg & { path: { label: string }[]; box: unknown }>({ type: 'inspect:select', id });
    expect(sel.path.map((c) => c.label)).toEqual(['html', 'body', 'main#main.wrap', 'div.card']);
    expect(sel.box).toMatchObject({ margin: { top: 2, left: 2 } });
    const host = doc.querySelector<HTMLElement>('[data-codevia-inspector]')!;
    expect(host.parentElement).toBe(doc.documentElement);
    expect(host.style.pointerEvents).toBe('none');
    const tree = ask<Msg & { node: TreeElement }>({ type: 'inspect:tree', rid: 1 }).node;
    expect(elements(tree).map((e) => e.tag)).toEqual(['head', 'body']);
    ask({ type: 'inspect:select', id: null });
    expect(doc.querySelector('[data-codevia-inspector]')).toBeNull();
  });

  it('returns matched rules with their source files, in cascade order, with overridden declarations', () => {
    const { ask } = runPage(site());
    const id = idOf(ask, '.card');
    const s = ask<Msg & { rules: MatchedRule[]; inline: { name: string; value: string; overridden?: boolean }[]; attrs: [string, string][]; computed: [string, string][] }>(
      { type: 'inspect:styles', rid: 1, id },
    );
    expect(s.found).toBe(true);
    expect(s.tag).toBe('div');
    const brief = s.rules.map((r) => [r.selector, r.src, r.origin, r.specificity.join(',')]);
    expect(brief).toEqual([
      ['#main .card', 'css/styles.css', 'file', '1,1,0'],
      ['.card', 'index.html', 'page', '0,1,0'], // the page <style> comes after the linked file
      ['.card', 'css/styles.css', 'file', '0,1,0'],
      ['.card', 'css/styles.css', 'file', '0,1,0'],
    ]);
    expect(s.rules.find((r) => r.conditions)?.conditions).toEqual(['@media screen']);
    expect(s.rules.find((r) => r.conditions)?.decls).toEqual([{ name: 'font-size', value: '20px', important: false }]);
    // Inline color wins over every rule; !important padding in styles.css beats the page's padding.
    expect(s.inline).toEqual([
      { name: 'margin', value: '2px', important: false },
      { name: 'color', value: 'purple', important: false },
    ]);
    const decl = (sel: string, src: string, name: string) => s.rules.find((r) => r.selector === sel && r.src === src && r.decls.some((d) => d.name === name))!.decls.find((d) => d.name === name)!;
    expect(decl('#main .card', 'css/styles.css', 'color').overridden).toBe(true);
    expect(decl('#main .card', 'css/styles.css', 'border').overridden).toBeFalsy();
    expect(decl('.card', 'index.html', 'padding').overridden).toBe(true);
    expect(decl('.card', 'css/styles.css', 'padding')).toMatchObject({ important: true });
    expect(decl('.card', 'css/styles.css', 'padding').overridden).toBeFalsy();
    expect(s.attrs).toEqual([
      ['class', 'card'],
      ['style', 'margin: 2px; color: purple'],
    ]);
    expect(s.computed.some(([k]) => k === 'display')).toBe(true);
  });

  it('reports a missing element and edits styles and attributes live', () => {
    const { ask, doc } = runPage(site());
    expect(ask({ type: 'inspect:styles', rid: 1, id: 123456 })).toMatchObject({ found: false });
    const id = idOf(ask, '.card');
    const card = doc.querySelector<HTMLElement>('.card')!;
    expect(ask({ type: 'inspect:edit-style', rid: 2, id, prop: 'background-color', value: 'yellow' })).toMatchObject({ ok: true });
    expect(card.style.backgroundColor).toBe('yellow');
    expect(ask({ type: 'inspect:edit-style', rid: 3, id, prop: 'color', value: '' })).toMatchObject({ ok: true });
    expect(card.style.color).toBe('');
    // Rule edits change the stylesheet rule itself.
    const rule = ask<Msg & { rules: MatchedRule[] }>({ type: 'inspect:styles', rid: 4, id }).rules[0]!;
    expect(ask({ type: 'inspect:edit-style', rid: 5, id, prop: 'color', value: 'orange', rule: rule.key })).toMatchObject({ ok: true });
    const again = ask<Msg & { rules: MatchedRule[] }>({ type: 'inspect:styles', rid: 6, id }).rules[0]!;
    expect(again.decls.find((d) => d.name === 'color')!.value).toBe('orange');
    expect(ask({ type: 'inspect:edit-attr', rid: 7, id, name: 'data-x', value: '1' })).toMatchObject({ ok: true });
    expect(card.getAttribute('data-x')).toBe('1');
    expect(ask({ type: 'inspect:edit-attr', rid: 8, id, name: 'data-y', value: '2', oldName: 'data-x' })).toMatchObject({ ok: true });
    expect(card.hasAttribute('data-x')).toBe(false);
    expect(card.getAttribute('data-y')).toBe('2');
    expect(ask({ type: 'inspect:edit-attr', rid: 9, id, name: 'data-y', value: null })).toMatchObject({ ok: true });
    expect(card.hasAttribute('data-y')).toBe(false);
    expect(ask({ type: 'inspect:edit-attr', rid: 10, id, name: 'bad name', value: '1' })).toMatchObject({ ok: false });
  });
});

describe('inspector agent: pick mode', () => {
  it('picks the tapped element without triggering page handlers, then exits', async () => {
    const { send, doc, w, messages, last } = runPage(site());
    send({ type: 'inspect:enable' });
    send({ type: 'inspect:pick', on: true });
    expect(last('inspect:pick')).toMatchObject({ on: true });
    const btn = doc.getElementById('btn')!;
    btn.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
    expect((w as unknown as { clicked?: number }).clicked).toBeUndefined();
    const picked = last<Msg & { id: number; path: { label: string }[] }>('inspect:picked');
    expect(picked.path.map((c) => c.label)).toEqual(['html', 'body', 'main#main.wrap', 'button#btn']);
    expect(last('inspect:pick')).toMatchObject({ on: false });
    // A link tap in pick mode does not navigate either (the shim's capture listener never sees it).
    send({ type: 'inspect:pick', on: true });
    doc.getElementById('link')!.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(messages.some((m) => m.type === 'navigate')).toBe(false);
    expect(last<Msg & { path: { label: string }[] }>('inspect:picked').path.at(-1)!.label).toBe('a#link');
    // After the tap is over, the page gets its events again.
    await new Promise((r) => setTimeout(r, 500));
    btn.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
    expect((w as unknown as { clicked?: number }).clicked).toBe(1);
  });

  it('can be switched off without picking', () => {
    const { send, doc, w, last } = runPage(site());
    send({ type: 'inspect:pick', on: true });
    send({ type: 'inspect:pick', on: false });
    expect(last('inspect:pick')).toMatchObject({ on: false });
    doc.getElementById('btn')!.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
    expect((w as unknown as { clicked?: number }).clicked).toBe(1);
  });
});

describe('inspector agent: network log', () => {
  it('records fetch() of project files before the panel opens, and 404s', async () => {
    const { w, ask } = runPage(site());
    const r = await w.fetch('data.json');
    expect(await r.json()).toEqual({ n: 5 });
    const missing = await w.fetch('./nope.txt');
    expect(missing.status).toBe(404);
    await flush();
    const all = ask<Msg & { entries: NetworkEntry[] }>({ type: 'inspect:network-all', rid: 1 }).entries;
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ kind: 'fetch', method: 'GET', url: 'data.json', path: 'data.json', source: 'project', status: 200, type: 'json', size: 7, pending: false, hasBody: true });
    expect(all[0]!.resHeaders).toContainEqual(['content-type', 'application/json']);
    expect(all[1]).toMatchObject({ url: './nope.txt', path: 'nope.txt', status: 404, pending: false });
    const body = ask<Msg & { text?: string }>({ type: 'inspect:response', rid: 2, nid: all[0]!.nid });
    expect(body).toMatchObject({ mime: 'application/json', text: '{"n":5}' });
  });

  it('records XMLHttpRequest of project files with live events while enabled', async () => {
    const { w, send, messages, ask } = runPage(site());
    send({ type: 'inspect:enable' });
    await new Promise<void>((resolve) => {
      const x = new w.XMLHttpRequest();
      x.open('POST', 'img/logo.png');
      x.setRequestHeader('X-Test', '1');
      x.responseType = 'arraybuffer';
      x.onloadend = () => resolve();
      x.send('body');
    });
    await flush();
    const live = messages.filter((m) => m.type === 'inspect:network').map((m) => m.entry as NetworkEntry);
    expect(live.length).toBeGreaterThanOrEqual(2); // started, then completed
    expect(live[0]).toMatchObject({ kind: 'xhr', pending: true });
    const done = live.at(-1)!;
    expect(done).toMatchObject({ kind: 'xhr', method: 'POST', url: 'img/logo.png', source: 'project', status: 200, type: 'image', size: 8, pending: false });
    expect(done.reqHeaders).toEqual([['X-Test', '1']]);
    const preview = ask<Msg & { dataUrl?: string }>({ type: 'inspect:response', rid: 1, nid: done.nid });
    expect(preview.dataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it('records real network fetches with headers, captures text bodies while enabled, and failures', async () => {
    const fake = (input: unknown) =>
      String(input).includes('fail')
        ? Promise.reject(new TypeError('Failed to fetch'))
        : Promise.resolve(new Response('{"ok":true}', { status: 201, statusText: 'Created', headers: { 'content-type': 'application/json', 'x-a': 'b' } }));
    const { w, send, ask } = runPage(site(), { fetch: fake });
    send({ type: 'inspect:enable' });
    const r = await w.fetch('https://api.test/items', { method: 'post', headers: { Authorization: 'x' } });
    expect(r.status).toBe(201);
    await expect(w.fetch('https://api.test/fail')).rejects.toThrow('Failed to fetch');
    await flush();
    const [ok, bad] = ask<Msg & { entries: NetworkEntry[] }>({ type: 'inspect:network-all', rid: 1 }).entries;
    expect(ok).toMatchObject({ method: 'POST', source: 'network', status: 201, statusText: 'Created', type: 'json', size: 11, hasBody: true });
    expect(ok!.reqHeaders).toEqual([['Authorization', 'x']]);
    expect(ok!.resHeaders).toContainEqual(['x-a', 'b']);
    expect(bad).toMatchObject({ status: 0, pending: false, error: 'Failed to fetch' });
    expect(ask({ type: 'inspect:response', rid: 2, nid: ok!.nid })).toMatchObject({ text: '{"ok":true}' });
    send({ type: 'inspect:network-clear' });
    expect(ask<Msg & { entries: NetworkEntry[] }>({ type: 'inspect:network-all', rid: 3 }).entries).toEqual([]);
  });

  it('keeps only the last 300 entries', async () => {
    const { w, ask } = runPage(site());
    await Promise.all(Array.from({ length: 310 }, () => w.fetch('data.json')));
    await flush();
    const all = ask<Msg & { entries: NetworkEntry[] }>({ type: 'inspect:network-all', rid: 1 }).entries;
    expect(all).toHaveLength(300);
    expect(all[0]!.nid).toBe(11);
  });

});
