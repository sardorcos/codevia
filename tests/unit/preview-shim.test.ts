// @vitest-environment jsdom
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { buildPreview } from '../../src/core/preview';
import { binaryFile, textFile, type Files } from '../../src/core/types';

/** Builds a preview page and runs it in jsdom, collecting the messages it posts to the parent. */
function runPage(files: Files, entry = 'index.html') {
  const { html } = buildPreview(files, entry, (files[entry] as { content: string }).content, { allowNetwork: false, token: 't' });
  const messages: Record<string, unknown>[] = [];
  const dom = new JSDOM(html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, ''), { runScripts: 'dangerously', url: 'https://host.test/preview-host.html' });
  const w = dom.window as unknown as { parent: { postMessage(m: unknown): void }; document: Document };
  Object.defineProperty(dom.window, 'parent', { value: { postMessage: (m: Record<string, unknown>) => messages.push(m) } });
  return { dom, w, messages };
}

describe('preview runtime shim', () => {
  it('serves project files to XMLHttpRequest (R12)', async () => {
    const { dom } = runPage({ 'index.html': textFile('<p>x</p>'), 'data.json': textFile('{"n":5}') });
    const result = await new Promise<unknown>((resolve) => {
      const x = new (dom.window as unknown as { XMLHttpRequest: new () => XMLHttpRequest }).XMLHttpRequest();
      x.open('GET', 'data.json');
      x.responseType = 'json';
      x.onload = () => resolve([x.status, x.response]);
      x.send();
    });
    expect(result).toEqual([200, { n: 5 }]);
  });

  it('turns GET and POST form submissions into navigation (R13)', () => {
    const { w, messages } = runPage({
      'index.html': textFile('<form id="g" action="result.php"><input name="q" value="a b"></form><form id="p" method="post" action="save.php"><input name="n" value="1"></form>'),
    });
    const fire = (id: string) => w.document.getElementById(id)!.dispatchEvent(new (w.document.defaultView as unknown as { Event: typeof Event }).Event('submit', { cancelable: true }));
    fire('g');
    fire('p');
    const nav = messages.filter((m) => m.type === 'navigate');
    expect(nav[0]).toMatchObject({ path: 'result.php', query: 'q=a%20b' });
    expect(nav[1]).toMatchObject({ path: 'save.php', post: 'n=1' });
  });

  it('encodes a repeated image once (R10)', () => {
    const img = binaryFile(new Uint8Array([137, 80, 78, 71, 1, 2, 3]));
    const { html } = buildPreview({ 'index.html': textFile(''), 'a.png': img }, 'index.html', '<img src="a.png"><img src="a.png">', { allowNetwork: false, token: 't' });
    const urls = html.match(/data:image\/png;base64,[A-Za-z0-9+/=]+/g) ?? [];
    expect(new Set(urls).size).toBe(1);
  });

  it('transpiles TypeScript scripts when a transpiler is given', () => {
    const files = { 'index.html': textFile(''), 'app.ts': textFile('const n: number = 1; console.log(n);') };
    const { html } = buildPreview(files, 'index.html', '<script src="app.ts"></script>', {
      allowNetwork: false,
      token: 't',
      transpile: (_p, code) => code.replace(': number', ''),
    });
    const src = /<script src="data:text\/javascript;base64,([^"]+)"/.exec(html)![1]!;
    expect(Buffer.from(src, 'base64').toString()).toBe('const n = 1; console.log(n);');
  });
});
