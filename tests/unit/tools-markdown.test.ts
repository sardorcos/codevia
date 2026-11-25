// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { headingsOf, renderMarkdown, slugify } from '../../src/tools/markdown/render';
import { projectImageUrl } from '../../src/tools/markdown';
import { binaryFile, textFile } from '../../src/core/types';

const dom = (html: string) => {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div;
};

describe('renderMarkdown', () => {
  it('renders GitHub-flavoured Markdown: tables, task lists, fenced code, autolinks, strikethrough', () => {
    const html = renderMarkdown(`# Title

| a | b |
|---|:-:|
| 1 | 2 |

- [x] done
- [ ] todo

\`\`\`js
const x = 1 < 2;
\`\`\`

Visit https://example.com and ~~old~~.`);
    const d = dom(html);
    expect(d.querySelector('h1')!.id).toBe('md-title');
    expect(d.querySelectorAll('table td')).toHaveLength(2);
    const boxes = d.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(boxes).toHaveLength(2);
    expect(boxes[0]!.checked).toBe(true);
    expect(boxes[0]!.disabled).toBe(true);
    const code = d.querySelector('pre code')!;
    expect(code.className).toBe('language-js');
    expect(code.textContent).toBe('const x = 1 < 2;');
    expect(d.querySelector('a[href="https://example.com"]')!.getAttribute('rel')).toBe('noopener noreferrer');
    expect(d.querySelector('del')!.textContent).toBe('old');
  });

  it('removes scripts, event handlers, javascript: links, styles, forms and frames', () => {
    const html = renderMarkdown(`<script>alert(1)</script>
<img src="x.png" onerror="alert(2)">
[click](javascript:alert(3))
<a href="https://ok.test" target="_blank" onclick="x()">ok</a>
<iframe src="https://evil.test"></iframe>
<style>body{display:none}</style>
<div style="position:fixed">styled</div>
<form action="https://evil.test"><input type="text" name="q"><button>go</button></form>
<svg><script>alert(4)</script></svg>
<details><summary>More</summary>hidden</details>`);
    expect(html).not.toMatch(/<script|onerror|onclick|href="javascript:|<iframe|<style|style=|<form|<button|type="text"|<svg/i);
    const d = dom(html);
    expect(d.querySelector('a[href="https://ok.test"]')!.hasAttribute('target')).toBe(false);
    expect(d.querySelector('details summary')!.textContent).toBe('More');
    expect(d.textContent).toContain('styled');
    const link = dom(renderMarkdown('[click](javascript:alert(3)) [data](data:text/html,<b>x</b>) [ok](docs/a.md)'));
    expect([...link.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([null, null, 'docs/a.md']);
  });

  it('gives headings unique, prefixed ids for the outline', () => {
    const d = dom(renderMarkdown('# Intro\n## Install `npm`\n## Install `npm`\n### Привет, мир!', { idPrefix: 'x-' }));
    expect(headingsOf(d)).toEqual([
      { level: 1, text: 'Intro', id: 'x-intro' },
      { level: 2, text: 'Install npm', id: 'x-install-npm' },
      { level: 2, text: 'Install npm', id: 'x-install-npm-1' },
      { level: 3, text: 'Привет, мир!', id: 'x-привет-мир' },
    ]);
    expect(slugify('A & B <i>c</i>')).toBe('a-b-c');
  });

  it('resolves relative images through the callback, only to image data', () => {
    const html = renderMarkdown('![logo](img/logo.png) ![remote](https://x.test/a.png) ![bad](evil.png)', {
      resolveImage: (src) => (src === 'img/logo.png' ? 'data:image/png;base64,AAAA' : src === 'evil.png' ? 'javascript:alert(1)' : null),
    });
    const imgs = dom(html).querySelectorAll('img');
    expect(imgs[0]!.getAttribute('src')).toBe('data:image/png;base64,AAAA');
    expect(imgs[1]!.getAttribute('src')).toBe('https://x.test/a.png');
    expect(imgs[2]!.getAttribute('src')).toBe('evil.png');
  });

  it('builds data URLs for project images relative to the Markdown file', () => {
    const files = { 'docs/img/a.png': binaryFile(new Uint8Array([1, 2, 3])), 'docs/icon.svg': textFile('<svg/>'), 'docs/a.txt': textFile('x') };
    expect(projectImageUrl(files, 'docs/README.md', 'img/a.png')).toBe('data:image/png;base64,AQID');
    expect(projectImageUrl(files, 'docs/guide/x.md', '../icon.svg')).toBe(`data:image/svg+xml;base64,${btoa('<svg/>')}`);
    expect(projectImageUrl(files, 'docs/README.md', 'a.txt')).toBeNull();
    expect(projectImageUrl(files, 'docs/README.md', 'missing.png')).toBeNull();
    expect(projectImageUrl(files, 'README.md', '../../etc/passwd')).toBeNull();
  });

  it('returns an empty string for empty input', () => {
    expect(renderMarkdown('')).toBe('');
  });
});
