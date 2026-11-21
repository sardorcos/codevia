// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { scanProject } from '../../src/core/diagnostics';
import { buildPreview, cspFor, escapeRawText } from '../../src/core/preview';
import { defaultEntry, detectLanguage, templateFiles } from '../../src/core/templates';
import { binaryFile, textFile, type Files } from '../../src/core/types';

const opts = { allowNetwork: false, token: 'tok' };
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const doc = (html: string) => new DOMParser().parseFromString(html, 'text/html');

describe('buildPreview', () => {
  const files: Files = {
    'pages/about.html': textFile(
      '<!doctype html><html><head lang="ru"><link rel="stylesheet" href="../css/a.css"><link rel="manifest" href="../site.webmanifest"></head><body><img src="/img/p.png" srcset="../img/p.png 2x"><script src="./x.js"></script><script type="module" src="../js/m.js"></script></body></html>',
    ),
    'css/a.css': textFile('@import "b.css"; body{background:url(../img/p.png)} /* </style> */'),
    'css/b.css': textFile('h1{color:red}'),
    'img/p.png': binaryFile(new Uint8Array([1, 2, 3])),
    'pages/x.js': textFile('const s = "</script>"; window.ok = s;'),
    'js/m.js': textFile("import { v } from './dep.js'; window.v = v;"),
    'js/dep.js': textFile('export const v = 42;'),
    'site.webmanifest': textFile('{}'),
  };

  it('resolves ./, ../ and / paths for CSS, images and scripts', () => {
    const { html, missing } = buildPreview(files, 'pages/about.html', files['pages/about.html']!.text ? (files['pages/about.html'] as { content: string }).content : '', opts);
    const d = doc(html);
    expect(missing).toEqual([]);
    const style = d.querySelector('style')!.textContent!;
    expect(style).toContain('h1{color:red}'); // @import inlined
    expect(style).toContain('url(data:image/png;base64,AQID)');
    expect(style).not.toMatch(/<\/style/i); // cannot close the element early
    expect(d.querySelector('img')!.getAttribute('src')).toBe('data:image/png;base64,AQID');
    expect(d.querySelector('img')!.getAttribute('srcset')).toBe('data:image/png;base64,AQID 2x');
    // manifest is not turned into a <style>
    expect(d.querySelectorAll('style').length).toBe(1);
    expect(html).toContain('<!doctype html>');
  });

  it('keeps "</script>" inside user JS intact by loading it as a data: URL', () => {
    const { html } = buildPreview(files, 'pages/about.html', (files['pages/about.html'] as { content: string }).content, opts);
    const scripts = [...doc(html).querySelectorAll('script[src]')];
    const classic = scripts.find((s) => !s.getAttribute('type'))!;
    expect(classic.getAttribute('src')).toBe(`data:text/javascript;base64,${b64('const s = "</script>"; window.ok = s;')}`);
  });

  it('rewrites ES module imports recursively', () => {
    const { html } = buildPreview(files, 'pages/about.html', (files['pages/about.html'] as { content: string }).content, opts);
    const mod = doc(html).querySelector('script[type=module]')!.getAttribute('src')!;
    const code = Buffer.from(mod.split(',')[1]!, 'base64').toString('utf8');
    expect(code).toContain(`from 'data:text/javascript;base64,${b64('export const v = 42;')}'`);
  });

  it('injects CSP and the runtime shim at the top of <head>, even when <head> has attributes', () => {
    const { html } = buildPreview(files, 'pages/about.html', (files['pages/about.html'] as { content: string }).content, opts);
    const head = doc(html).head;
    expect(head.children[0]!.getAttribute('charset')).toBe('utf-8');
    expect(head.children[1]!.getAttribute('http-equiv')).toBe('Content-Security-Policy');
    expect(head.children[2]!.tagName).toBe('SCRIPT');
    expect(head.children[2]!.textContent).toContain('"tok"');
  });

  it('reports missing local files', () => {
    const { missing } = buildPreview({ 'index.html': textFile('<img src="nope.png"><link rel="stylesheet" href="x.css">') }, 'index.html', '<img src="nope.png"><link rel="stylesheet" href="x.css">', opts);
    expect(missing.sort()).toEqual(['nope.png', 'x.css']);
  });

  it('CSP blocks the network unless allowed', () => {
    expect(cspFor(false)).toContain("connect-src 'none'");
    expect(cspFor(false)).not.toContain('https:');
    expect(cspFor(true)).toContain('connect-src https:');
  });

  it('escapes raw text terminators', () => {
    expect(escapeRawText('a</SCRIPT>b<!--', 'script')).toBe('a<\\/SCRIPT>b<\\!--');
  });
});

describe('diagnostics & templates', () => {
  it('finds broken JSON and missing references with line numbers', () => {
    const issues = scanProject(
      { 'index.html': textFile('<html>\n<img src="a.png">\n</html>'), 'data.json': textFile('{"a":}'), 'style.css': textFile('a{background:url(../../x.png)}') },
      'web',
    );
    expect(issues.find((i) => i.title === 'Не найден локальный файл')?.line).toBe(2);
    expect(issues.some((i) => i.title === 'Некорректный JSON')).toBe(true);
    expect(issues.some((i) => i.title === 'Ссылка выходит за пределы проекта')).toBe(true);
  });
  it('templates are internally consistent', () => {
    for (const t of ['web', 'python', 'php', 'empty'] as const) {
      const files = templateFiles(t, 'X');
      const lang = t === 'empty' ? 'web' : t;
      expect(scanProject(files, lang).filter((i) => i.severity === 'error')).toEqual([]);
      expect(defaultEntry(Object.keys(files), lang)).toBeTruthy();
    }
  });
  it('detects language and prefers root entry files', () => {
    expect(detectLanguage(['a.py', 'b.py', 'index.html'])).toBe('python');
    expect(detectLanguage(['index.php', 'x.html'])).toBe('php');
    expect(defaultEntry(['docs/index.html', 'index.html'], 'web')).toBe('index.html');
    expect(defaultEntry(['src/app/main.py', 'main.py'], 'python')).toBe('main.py');
  });
});
