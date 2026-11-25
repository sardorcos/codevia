import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { languageFor } from '../../src/editor/languages';
import { computeDiagnostics, isJsonc, lintHtmlTags, lintJson, validateJson } from '../../src/editor/lint';

const diag = (doc: string, path: string) => computeDiagnostics(EditorState.create({ doc, extensions: [languageFor(path)] }), path);
const at = (doc: string, needle: string, offset = 0) => doc.indexOf(needle) + offset;

describe('JavaScript / TypeScript lint', () => {
  it('reports a syntax error at its exact position', async () => {
    const doc = 'const a = 1;\nconst b = ;\n';
    const d = await diag(doc, 'main.js');
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ from: at(doc, '= ;', 2), to: at(doc, '= ;', 3), severity: 'error' });
    expect(d[0]!.message).toMatch(/^Синтаксическая ошибка: Unexpected token/);
  });

  it('knows TypeScript and JSX', async () => {
    expect(await diag('const x: number = 1;\ninterface A { b: string }\n', 'a.ts')).toEqual([]);
    expect(await diag('const x: number = 1;', 'a.js')).toHaveLength(1);
    expect(await diag('export const A = () => <div className="x">{1}</div>;', 'a.jsx')).toEqual([]);
    // React code in a .js file is fine too.
    expect(await diag('const A = () => <b>hi</b>;', 'a.js')).toEqual([]);
    const unterminated = 'function f() {\n  return <div>;\n}';
    const d = await diag(unterminated, 'a.tsx');
    expect(d).toHaveLength(1);
    expect(d[0]!.from).toBeGreaterThan(unterminated.indexOf('<div>'));
  });

  it('flags duplicate keys in object literals, not getter/setter pairs', async () => {
    const doc = 'const o = { a: 1, "a": 2, get b() { return 1 }, set b(v) {}, [k]: 1, c, 1: 0, 1.0: 2 };';
    const d = await diag(doc, 'a.js');
    expect(d.map((x) => [x.severity, doc.slice(x.from, x.to)])).toEqual([
      ['warning', '"a"'],
      ['warning', '1.0'],
    ]);
    expect(d[0]!.message).toBe('Повторяющийся ключ «a» в объекте');
  });

  it('is quiet on valid code and empty files', async () => {
    expect(await diag('', 'a.js')).toEqual([]);
    expect(await diag('async function f() { for await (const x of y) {} }\nclass A { #p = 1; static { } }\n', 'a.js')).toEqual([]);
  });
});

describe('JSON lint', () => {
  it('points at the exact position', () => {
    const doc = '{\n  "a": 1,\n  "b": 2,\n}';
    const d = lintJson(doc);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ from: doc.lastIndexOf('}'), severity: 'error', message: 'Лишняя запятая' });
    expect(validateJson('{"a": tru}')).toEqual({ pos: 6, message: 'Неожиданный символ «t»' });
    expect(validateJson('{"a": 1')).toEqual({ pos: 7, message: 'Неожиданный конец файла' });
    expect(validateJson("{'a': 1}")).toMatchObject({ pos: 1 });
    expect(validateJson('[1, 2] x')).toMatchObject({ pos: 7, message: 'Лишние данные после JSON' });
    expect(validateJson('{"a": "x\ny"}')).toMatchObject({ pos: 8, message: 'Незакрытая строка' });
    expect(validateJson('{"a": 01}')).toMatchObject({ pos: 7, message: 'Неверное число' });
    expect(validateJson('{"a": "\\q"}')).toMatchObject({ pos: 7, message: 'Неверная escape-последовательность' });
    expect(validateJson('{"a": [1, {"b": null}], "c": -1.5e3, "d": "\\u00e9"}')).toBeNull();
  });

  it('allows comments and trailing commas in tsconfig-style files only', () => {
    const doc = '{\n  // comment\n  "a": [1, 2,],\n  /* b */ "b": true,\n}';
    expect(isJsonc('tsconfig.json')).toBe(true);
    expect(isJsonc('.vscode/settings.json')).toBe(true);
    expect(isJsonc('data.json')).toBe(false);
    expect(lintJson(doc, true)).toEqual([]);
    expect(lintJson(doc, false)[0]).toMatchObject({ from: doc.indexOf('//'), message: 'Комментарии в JSON не допускаются' });
    expect(lintJson('   ')).toEqual([]);
    expect(lintJson('{"ok": true}')).toEqual([]);
  });

  it('runs through computeDiagnostics by file name', async () => {
    expect(await diag('{"a": 1,}', 'package.json')).toHaveLength(1);
    expect(await diag('{"a": 1,}', 'tsconfig.json')).toEqual([]);
  });
});

describe('HTML lint', () => {
  it('reports unclosed and mismatched tags at the tags', () => {
    const doc = '<div class="a">\n  <section>\n    <p>text\n  </div>\n<span>x</b>';
    const d = lintHtmlTags(doc);
    const show = d.map((x) => [doc.slice(x.from, x.to), x.message]);
    expect(show).toEqual([
      ['<section>', 'Тег <section> не закрыт'],
      ['</div>', 'Ожидался </section>, а найден </div>'],
      ['<span>', 'Тег <span> не закрыт'],
      ['</b>', 'Закрывающий тег </b> без открывающего'],
    ]);
  });

  it('accepts void elements, optional end tags, comments, scripts and self-closing tags', () => {
    const doc = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>a < b</title>
<script>if (a < b && c > d) document.write("<div>")</script>
<style>a > b { color: red }</style></head>
<body>
<!-- <div> -->
<ul><li>one<li>two</ul>
<table><tr><td>1<td>2</table>
<p>para<p>another
<img src="a.png" alt="x > y"><br><input disabled>
<svg><path d="M0 0"/></svg>
</body></html>`;
    expect(lintHtmlTags(doc)).toEqual([]);
  });

  it('ignores PHP blocks in .php files', async () => {
    const doc = '<?php if ($x > 1) { echo "<b>"; } ?>\n<div><?= $y ?></div>\n';
    expect(lintHtmlTags(doc, { php: true })).toEqual([]);
    expect(await diag(doc, 'index.php')).toEqual([]);
  });

  it('merges with the parse tree for .html files', async () => {
    const doc = '<main>\n<div>\n</main>';
    const d = await diag(doc, 'index.html');
    expect(d.map((x) => doc.slice(x.from, x.to))).toEqual(['<div>', '</main>']);
    expect(await diag('<p>Hello <b>world</b></p>', 'a.html')).toEqual([]);
  });
});

describe('Lezer-based lint', () => {
  it('finds CSS and Python syntax errors', async () => {
    const css = 'a { color: red; }\nb { color: ; }}\n';
    const cd = await diag(css, 'style.css');
    expect(cd.length).toBeGreaterThan(0);
    expect(cd.every((x) => x.severity === 'error' && x.message === 'Синтаксическая ошибка')).toBe(true);
    expect(await diag('a { color: red; }\n@media (max-width: 1px) { b { margin: 0 auto; } }\n', 'style.css')).toEqual([]);

    const py = 'def f(x):\n    return x +\n\nprint(f(1))\n';
    const pd = await diag(py, 'main.py');
    expect(pd.length).toBeGreaterThan(0);
    expect(pd[0]!.from).toBeGreaterThanOrEqual(py.indexOf('+'));
    expect(await diag('def f(x):\n    return [i for i in x if i]\n\nclass A:\n    pass\n', 'main.py')).toEqual([]);
  });

  it('finds PHP errors and leaves Markdown alone', async () => {
    const php = '<?php\nfunction f( {\n  echo 1;\n}\n';
    expect((await diag(php, 'a.php')).length).toBeGreaterThan(0);
    expect(await diag('<?php\nfunction f($a) {\n  return $a * 2;\n}\n', 'a.php')).toEqual([]);
    expect(await diag('# Title\n\nSome *text* with `code` and <br> html.\n', 'README.md')).toEqual([]);
    expect(await diag('anything', 'notes.txt')).toEqual([]);
  });
});
