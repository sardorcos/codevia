// @vitest-environment jsdom
import { snippet } from '@codemirror/autocomplete';
import { forceLinting, setDiagnostics } from '@codemirror/lint';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { smartTab, toggleComment, indentMore, indentLess, selectNextOccurrence, nextDiagnostic, diagnosticsCount, goToDefinitionAtCursor } from '../../src/editor/commands';
import { wordAt } from '../../src/editor/definition';
import { createEditor, type EditorHost } from '../../src/editor/editor';
import { formatCode } from '../../src/editor/format-core';
import { setFormatBackend } from '../../src/editor/format';

let host: EditorHost | null = null;
afterEach(() => {
  host?.view.destroy();
  host = null;
  setFormatBackend(null);
});

function make(path: string, content: string, opts: Parameters<typeof createEditor>[2] = {}) {
  host = createEditor(() => undefined, false, opts);
  document.body.append(host.view.dom);
  host.open(path, content);
  return host;
}

const at = (h: EditorHost, pos: number) => h.view.dispatch({ selection: { anchor: pos } });

describe('editor host and key-bar commands', () => {
  it('finds the word at a position, with CSS dashes', () => {
    const state = make('a.css', '.btn-primary { color: var(--accent); }').view.state;
    expect(wordAt(state, 3, 'a.css')).toEqual({ word: 'btn-primary', from: 1, to: 12 });
    expect(wordAt(state, 28, 'a.css')!.word).toBe('--accent');
    const js = make('a.js', 'const $el = obj.prop_1; 42').view.state;
    expect(wordAt(js, 7, 'a.js')!.word).toBe('$el');
    expect(wordAt(js, 25, 'a.js')).toBeNull();
    expect(wordAt(js, 5, 'a.js')!.word).toBe('const');
  });

  it('calls onGoToDefinition from the key-bar command', () => {
    const onGoToDefinition = vi.fn();
    const h = make('src/main.js', 'render(items);', { onGoToDefinition });
    at(h, 3);
    expect(goToDefinitionAtCursor(h.view)).toBe(true);
    expect(onGoToDefinition).toHaveBeenCalledWith('render', 0, 'src/main.js', 'command');
    // Callbacks can be replaced later.
    const next = vi.fn();
    h.setOptions({ onGoToDefinition: next });
    goToDefinitionAtCursor(h.view);
    expect(next).toHaveBeenCalledTimes(1);
    at(h, 6); // on "("
    expect(goToDefinitionAtCursor(h.view)).toBe(true); // the word ends here
    h.view.dispatch({ changes: { from: 0, insert: '  ' } });
    at(h, 1);
    expect(goToDefinitionAtCursor(h.view)).toBe(false);
  });

  it('formats the open file through host.format()', async () => {
    setFormatBackend(formatCode);
    const h = make('a.css', 'a{color:red}');
    expect(await h.format()).toEqual({ changed: true });
    expect(h.current()).toBe('a {\n  color: red;\n}\n');
    expect(await h.formatOnSave()).toBeNull(); // off by default
    h.setOptions({ formatOnSave: true, prettierrc: () => '{"tabWidth": 4}' });
    expect(await h.formatOnSave()).toEqual({ changed: true });
    expect(h.current()).toBe('a {\n    color: red;\n}\n');
  });

  it('reveals a position, toggles comments and indents', () => {
    const h = make('a.js', 'let a = 1;\nlet b = 2;\nlet a2 = a;');
    h.revealPosition(2, 4);
    expect(h.view.state.selection.main.head).toBe(15);
    toggleComment(h.view);
    expect(h.current().split('\n')[1]).toBe('// let b = 2;');
    toggleComment(h.view);
    indentMore(h.view);
    expect(h.current().split('\n')[1]).toBe('  let b = 2;');
    indentLess(h.view);
    expect(h.current().split('\n')[1]).toBe('let b = 2;');
    h.view.dispatch({ selection: { anchor: 4, head: 5 } });
    selectNextOccurrence(h.view);
    expect(h.view.state.selection.ranges.length).toBe(2);
  });

  it('smartTab moves through snippet fields, else inserts an indent', () => {
    const h = make('main.py', 'x');
    at(h, 1);
    smartTab(h.view);
    expect(h.current()).toBe('x    ');
    snippet('def ${name}(${params}):\n\t${pass}')(h.view, null, 0, h.view.state.doc.length);
    const sel = () => h.view.state.sliceDoc(h.view.state.selection.main.from, h.view.state.selection.main.to);
    expect(sel()).toBe('name');
    smartTab(h.view);
    expect(sel()).toBe('params');
    smartTab(h.view);
    expect(sel()).toBe('pass');
    expect(h.current()).toBe('def name(params):\n    pass');
  });

  it('counts diagnostics and jumps to the next one', () => {
    const onDiagnostics = vi.fn();
    const h = make('a.js', 'aaa\nbbb\nccc', { onDiagnostics });
    expect(diagnosticsCount(h.view)).toBe(0);
    expect(nextDiagnostic(h.view)).toBe(false);
    h.view.dispatch(
      setDiagnostics(h.view.state, [
        { from: 4, to: 7, severity: 'error', message: 'E1' },
        { from: 8, to: 11, severity: 'warning', message: 'W1' },
      ]),
    );
    expect(diagnosticsCount(h.view)).toBe(2);
    expect(h.diagnostics()).toEqual({ errors: 1, warnings: 1, total: 2 });
    expect(onDiagnostics).toHaveBeenLastCalledWith('a.js', { errors: 1, warnings: 1, total: 2 });
    expect(nextDiagnostic(h.view)).toBe(true);
    expect(h.view.state.selection.main.from).toBe(4);
    expect(h.view.dom.querySelector('.cm-touch-lint')?.textContent).toBe('E1');
    nextDiagnostic(h.view);
    expect(h.view.state.selection.main.from).toBe(8);
  });

  it('lints real code after the delay', async () => {
    const onDiagnostics = vi.fn();
    const h = make('a.json', '{"a": 1,}', { onDiagnostics });
    forceLinting(h.view);
    await vi.waitFor(() => expect(onDiagnostics).toHaveBeenCalledWith('a.json', { errors: 1, warnings: 0, total: 1 }));
    h.setOptions({ lint: false });
    expect(h.diagnostics().total).toBe(0);
  });
});
