// @vitest-environment jsdom
import { undo } from '@codemirror/commands';
import { history } from '@codemirror/commands';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import { FormatError, formatCode, formatPython, formatterFor, globMatch, mapCursor, resolvePrettierOptions } from '../../src/editor/format-core';
import { formatDocument, minimalChange, setFormatBackend } from '../../src/editor/format';

afterEach(() => setFormatBackend(null));

describe('formatCode (the worker logic)', () => {
  it('formats JavaScript', async () => {
    const res = await formatCode({ code: 'const a = {b:1,c:2}\nfunction f( x ){return x}', path: 'main.js' });
    expect(res.formatted).toBe('const a = { b: 1, c: 2 };\nfunction f(x) {\n  return x;\n}\n');
  });

  it('formats HTML with embedded CSS and JS', async () => {
    const code = '<div><p>hi</p><span>x</span></div>\n<style>a{color:red}</style>\n<script>let x=1</script>';
    const res = await formatCode({ code, path: 'index.html' });
    expect(res.formatted).toBe(
      '<div>\n  <p>hi</p>\n  <span>x</span>\n</div>\n<style>\n  a {\n    color: red;\n  }\n</style>\n<script>\n  let x = 1;\n</script>\n',
    );
  });

  it('formats CSS, JSON and TypeScript', async () => {
    expect((await formatCode({ code: 'a{color:red;margin:0}', path: 'style.css' })).formatted).toBe('a {\n  color: red;\n  margin: 0;\n}\n');
    expect((await formatCode({ code: '{"a":1,"b":[1,2]}', path: 'data.json' })).formatted).toBe('{ "a": 1, "b": [1, 2] }\n');
    expect((await formatCode({ code: 'let x:number=1', path: 'a.ts' })).formatted).toBe('let x: number = 1;\n');
  });

  it('formats PHP with @prettier/plugin-php', async () => {
    const res = await formatCode({ code: '<?php\n$a=[1,2];foreach($a as $x){echo $x;}', path: 'index.php' });
    expect(res.formatted).toBe('<?php\n$a = [1, 2];\nforeach ($a as $x) {\n    echo $x;\n}\n');
  });

  it('respects .prettierrc and its overrides', async () => {
    const rc = JSON.stringify({ semi: false, singleQuote: true, plugins: ['evil'], overrides: [{ files: '*.css', options: { tabWidth: 4 } }] });
    expect((await formatCode({ code: 'const a = "x";', path: 'a.js', prettierrc: rc })).formatted).toBe("const a = 'x'\n");
    expect((await formatCode({ code: 'a{color:red}', path: 'a.css', prettierrc: rc })).formatted).toBe('a {\n    color: red;\n}\n');
    expect(resolvePrettierOptions(rc, 'x.js')).toEqual({ semi: false, singleQuote: true });
    expect(resolvePrettierOptions('not json', 'x.js')).toEqual({});
    expect(globMatch('*.{js,ts}', 'src/a.ts')).toBe(true);
    expect(globMatch('src/**/*.js', 'src/a/b.js')).toBe(true);
    expect(globMatch('src/**/*.js', 'lib/b.js')).toBe(false);
  });

  it('keeps the cursor at the same code', async () => {
    const code = 'const a = {b:1,c:2}';
    const res = await formatCode({ code, path: 'a.js', cursorOffset: code.indexOf('c:') });
    expect(res.formatted.slice(res.cursorOffset, res.cursorOffset + 2)).toBe('c:');
    expect(mapCursor('a  b', 'a b', 3)).toBe(2);
  });

  it('reports syntax errors with a position', async () => {
    const err = await formatCode({ code: 'const = 1', path: 'a.js' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FormatError);
    expect((err as FormatError).line).toBe(1);
    expect((err as FormatError).message).toMatch(/Unexpected token/);
  });

  it('formats Python conservatively', async () => {
    const code = 'def f():\n\tx = 1   \n\ts = """keep   \n\tthis   \n"""\n\treturn x\n\n\n\n';
    expect(formatPython(code)).toBe('def f():\n    x = 1\n    s = """keep   \n\tthis   \n"""\n    return x\n');
    expect((await formatCode({ code: 'print(1)', path: 'main.py' })).formatted).toBe('print(1)\n');
    expect(formatPython('')).toBe('');
  });

  it('knows which files it can format', () => {
    expect(['a.js', 'a.tsx', 'a.json', 'package.json', 'tsconfig.json', 'a.html', 'a.scss', 'a.md', 'a.yml', 'a.php', 'a.py', 'a.txt'].map(formatterFor)).toEqual([
      'babel',
      'typescript',
      'json',
      'json-stringify',
      'jsonc',
      'html',
      'scss',
      'markdown',
      'yaml',
      'php',
      'python',
      null,
    ]);
  });
});

describe('formatDocument', () => {
  const views: EditorView[] = [];
  afterEach(() => views.splice(0).forEach((v) => v.destroy()));
  const make = (doc: string, cursor = 0) => {
    const view = new EditorView({
      state: EditorState.create({ doc, selection: EditorSelection.cursor(cursor), extensions: [history()] }),
      parent: document.body,
    });
    views.push(view);
    return view;
  };

  it('applies the result as one undoable change and keeps the cursor near its code', async () => {
    setFormatBackend(formatCode);
    const code = 'const a = {b:1,c:2}\nfunction f( x ){return x}';
    const view = make(code, code.indexOf('return'));
    expect(await formatDocument(view, 'main.js')).toEqual({ changed: true });
    const text = view.state.doc.toString();
    expect(text).toBe('const a = { b: 1, c: 2 };\nfunction f(x) {\n  return x;\n}\n');
    const head = view.state.selection.main.head;
    expect(text.slice(head, head + 6)).toBe('return');
    expect(await formatDocument(view, 'main.js')).toEqual({ changed: false });
    undo(view);
    expect(view.state.doc.toString()).toBe(code);
  });

  it('returns errors instead of throwing', async () => {
    setFormatBackend(formatCode);
    const view = make('const = 1');
    const res = await formatDocument(view, 'a.js');
    expect(res.changed).toBe(false);
    expect(res.error).toMatch(/^Не удалось отформатировать: .*Unexpected token/);
    expect((await formatDocument(view, 'notes.txt')).error).toBe('Для этого типа файлов форматирование недоступно');
  });

  it('does not apply a stale result', async () => {
    setFormatBackend(async (req) => ({ formatted: req.code + '\n// formatted', cursorOffset: 0 }));
    const view = make('x');
    const pending = formatDocument(view, 'a.js');
    view.dispatch({ changes: { from: 1, insert: 'y' } });
    expect((await pending).changed).toBe(false);
    expect(view.state.doc.toString()).toBe('xy');
  });

  it('computes the minimal change', () => {
    expect(minimalChange('abcdef', 'abXYef')).toEqual({ from: 2, to: 4, insert: 'XY' });
    expect(minimalChange('same', 'same')).toEqual({ from: 4, to: 4, insert: '' });
  });
});
