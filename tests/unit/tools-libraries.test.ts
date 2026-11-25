import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LIBRARIES, bundledPath, libraryById, projectPath, type Library } from '../../src/tools/libraries/catalog';
import { addLibraryToHtml, detectLibrary, insertSnippet, removeLibraryFromHtml, rootPrefix, tagFor } from '../../src/tools/libraries/html';
import { entryHtml } from '../../src/tools/libraries';
import { textFile, type Project } from '../../src/core/types';
// @ts-expect-error -- plain .mjs build script without types
import { LIBS, PERMISSIVE } from '../../scripts/libs-manifest.mjs';

const lib = (id: string): Library => libraryById(id)!;

const PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Demo</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <h1>Hello</h1>
  <script src="app.js"></script>
</body>
</html>
`;

describe('addLibraryToHtml', () => {
  it('puts CSS before the page stylesheet and scripts before the page script', () => {
    const r = addLibraryToHtml(PAGE, lib('bootstrap'));
    expect(r.changed).toBe(true);
    expect(r.html).toBe(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Demo</title>
  <link rel="stylesheet" href="libs/bootstrap/bootstrap.min.css">
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <h1>Hello</h1>
  <script src="libs/bootstrap/bootstrap.bundle.min.js"></script>
  <script src="app.js"></script>
</body>
</html>
`);
  });

  it('is idempotent and keeps libraries in the order they were added', () => {
    const once = addLibraryToHtml(PAGE, lib('vue')).html;
    expect(addLibraryToHtml(once, lib('vue'))).toEqual({ html: once, changed: false });
    const two = addLibraryToHtml(once, lib('chartjs')).html;
    const order = ['libs/vue/', 'libs/chartjs/', 'app.js'].map((s) => two.indexOf(s));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(two.match(/vue\.global\.prod\.js/g)).toHaveLength(1);
  });

  it('adds Alpine with defer and Tailwind in <head>', () => {
    expect(addLibraryToHtml(PAGE, lib('alpinejs')).html).toContain('  <script src="libs/alpinejs/alpine.min.js" defer></script>\n  <script src="app.js">');
    const tw = addLibraryToHtml(PAGE, lib('tailwindcss')).html;
    expect(tw).toContain('  <script src="libs/tailwindcss/tailwindcss.js"></script>\n</head>');
  });

  it('places tags before </head> and </body> when the page has no stylesheet or script', () => {
    const bare = '<html>\n<head>\n<title>x</title>\n</head>\n<body>\n<p>x</p>\n</body>\n</html>';
    const r = addLibraryToHtml(bare, lib('bootstrap')).html;
    expect(r).toBe('<html>\n<head>\n<title>x</title>\n  <link rel="stylesheet" href="libs/bootstrap/bootstrap.min.css">\n</head>\n<body>\n<p>x</p>\n  <script src="libs/bootstrap/bootstrap.bundle.min.js"></script>\n</body>\n</html>');
  });

  it('handles fragments without <head>/<body>, tabs and one-line pages', () => {
    expect(addLibraryToHtml('<p>Hi</p>', lib('animatecss')).html).toBe('<link rel="stylesheet" href="libs/animatecss/animate.min.css">\n<p>Hi</p>');
    expect(addLibraryToHtml('<p>Hi</p>', lib('dayjs')).html).toBe('<p>Hi</p>\n<script src="libs/dayjs/dayjs.min.js"></script>\n');
    expect(addLibraryToHtml('<html><head><title>x</title></head><body>x</body></html>', lib('lodash')).html).toBe(
      '<html><head><title>x</title></head><body>x<script src="libs/lodash/lodash.min.js"></script></body></html>',
    );
    const tabs = '<html>\n<head>\n\t<title>x</title>\n</head>\n<body>\n</body>\n</html>';
    expect(addLibraryToHtml(tabs, lib('htmx')).html).toContain('\n\t<script src="libs/htmx/htmx.min.js"></script>\n</body>');
  });

  it('uses a ../ prefix for pages in sub-folders', () => {
    expect(rootPrefix('index.html')).toBe('');
    expect(rootPrefix('pages/a/index.html')).toBe('../../');
    const r = addLibraryToHtml(PAGE, lib('dayjs'), '../').html;
    expect(r).toContain('<script src="../libs/dayjs/dayjs.min.js"></script>');
    expect(addLibraryToHtml(r, lib('dayjs'), '../').changed).toBe(false);
    expect(detectLibrary(r, lib('dayjs'))).toBe('added');
  });

  it('adds only the missing file when a library is half there', () => {
    const half = PAGE.replace('</head>', '  <link rel="stylesheet" href="libs/bootstrap/bootstrap.min.css">\n</head>');
    const r = addLibraryToHtml(half, lib('bootstrap')).html;
    expect(r.match(/bootstrap\.min\.css/g)).toHaveLength(1);
    expect(r).toContain('bootstrap.bundle.min.js');
  });
});

describe('detectLibrary / removeLibraryFromHtml', () => {
  it('detects local copies and CDN includes', () => {
    expect(detectLibrary(PAGE, lib('vue'))).toBe('none');
    expect(detectLibrary(addLibraryToHtml(PAGE, lib('vue')).html, lib('vue'))).toBe('added');
    expect(detectLibrary('<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>', lib('bootstrap'))).toBe('other');
    expect(detectLibrary('<script src="https://cdn.tailwindcss.com"></script>', lib('tailwindcss'))).toBe('other');
    expect(detectLibrary('<script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js"></script>', lib('alpinejs'))).toBe('other');
    // Mentions in text are not includes.
    expect(detectLibrary('<p>We love bootstrap.min.css</p>', lib('bootstrap'))).toBe('none');
  });

  it('removes exactly what was added', () => {
    let html = PAGE;
    for (const id of ['bootstrap', 'alpinejs', 'tailwindcss']) html = addLibraryToHtml(html, lib(id)).html;
    let out = html;
    for (const id of ['tailwindcss', 'bootstrap', 'alpinejs']) out = removeLibraryFromHtml(out, lib(id)).html;
    expect(out).toBe(PAGE);
    expect(removeLibraryFromHtml(PAGE, lib('vue'))).toEqual({ html: PAGE, changed: false });
    // Leaves CDN tags of the same library alone.
    const cdn = '<script src="https://unpkg.com/vue@3/dist/vue.global.js"></script>';
    expect(removeLibraryFromHtml(cdn, lib('vue')).changed).toBe(false);
    // Inline tags and ../ prefixes.
    expect(removeLibraryFromHtml('<p>x</p><script src="../libs/vue/vue.global.prod.js"></script><p>y</p>', lib('vue')).html).toBe('<p>x</p><p>y</p>');
  });
});

describe('insertSnippet', () => {
  it('inserts before </body>, after the library scripts, indented, once', () => {
    const withVue = addLibraryToHtml(PAGE, lib('vue')).html;
    const r = insertSnippet(withVue, lib('vue').example.html);
    expect(r.changed).toBe(true);
    expect(r.html.indexOf('Vue.createApp')).toBeGreaterThan(r.html.indexOf('libs/vue/'));
    expect(r.html).toContain('\n  <div id="vue-counter">\n    <button');
    expect(r.html.trimEnd().endsWith('</script>\n</body>\n</html>')).toBe(true);
    expect(insertSnippet(r.html, lib('vue').example.html).changed).toBe(false);
    expect(insertSnippet('<p>x</p>', '<b>y</b>').html).toBe('<p>x</p>\n<b>y</b>\n');
  });
});

describe('catalog', () => {
  it('matches the build manifest and the installed packages', () => {
    const manifest = LIBS as Array<{ id: string; pkg: string; files: Array<[string, string]> }>;
    expect(LIBRARIES.map((l) => l.id)).toEqual(manifest.map((m) => m.id));
    for (const l of LIBRARIES) {
      const m = manifest.find((x) => x.id === l.id)!;
      expect(l.pkg, l.id).toBe(m.pkg);
      expect(l.files.map((f) => f.name), l.id).toEqual(m.files.map((f) => f[1]));
      const pkg = JSON.parse(readFileSync(`node_modules/${l.pkg}/package.json`, 'utf8')) as { version: string; license: string };
      expect(l.version, `${l.id} version`).toBe(pkg.version);
      expect(l.license, `${l.id} licence`).toBe(pkg.license);
      expect(PERMISSIVE.test(l.license), l.license).toBe(true);
      for (const [from] of m.files) expect(existsSync(`node_modules/${l.pkg}/${from}`), from).toBe(true);
    }
  });

  it('has the required libraries, unique ids and example snippets', () => {
    for (const id of ['tailwindcss', 'bootstrap', 'vue', 'alpinejs']) expect(libraryById(id), id).toBeDefined();
    expect(new Set(LIBRARIES.map((l) => l.id)).size).toBe(LIBRARIES.length);
    for (const l of LIBRARIES) {
      expect(l.example.html.length).toBeGreaterThan(10);
      expect(l.files.length).toBeGreaterThan(0);
      expect(bundledPath(l, l.files[0]!)).toBe(`libs/${l.id}/${l.version}/${l.files[0]!.name}`);
      expect(projectPath(l, l.files[0]!)).toBe(`libs/${l.id}/${l.files[0]!.name}`);
    }
    expect(tagFor(lib('alpinejs'), lib('alpinejs').files[0]!)).toBe('<script src="libs/alpinejs/alpine.min.js" defer></script>');
  });

  it('stays under 3 MB in total', () => {
    let total = 0;
    for (const m of LIBS as Array<{ pkg: string; files: Array<[string, string]> }>)
      for (const [from] of m.files) total += readFileSync(`node_modules/${m.pkg}/${from}`).length;
    expect(total).toBeLessThan(3 * 1024 * 1024);
  });

  it('finds the page to edit', () => {
    const p = (files: string[], entry?: string) =>
      ({ files: Object.fromEntries(files.map((f) => [f, textFile('')])), entry }) as unknown as Project;
    expect(entryHtml(null)).toBeNull();
    expect(entryHtml(p(['a.html', 'index.html']))).toBe('index.html');
    expect(entryHtml(p(['src/index.html', 'about.html'], 'src/index.html'))).toBe('src/index.html');
    expect(entryHtml(p(['main.py'], 'main.py'))).toBeNull();
    expect(entryHtml(p(['pages/b.html', 'z.htm']))).toBe('z.htm');
  });
});
