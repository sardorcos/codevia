// @vitest-environment jsdom
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import { emmetExtension, expandAbbreviation, looksLikeAbbreviation } from '../../src/editor/emmet';
import { emmetModeFor } from '../../src/editor/emmet-mode';
import { languageFor } from '../../src/editor/languages';

const views: EditorView[] = [];
afterEach(() => views.splice(0).forEach((v) => v.destroy()));

/** Headless editor with the text before `|` and the cursor at `|`. */
function editor(text: string, path: string): EditorView {
  const pos = text.indexOf('|');
  const doc = text.replace('|', '');
  const view = new EditorView({
    state: EditorState.create({ doc, selection: EditorSelection.cursor(pos), extensions: [languageFor(path), emmetExtension(path)] }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

function type(view: EditorView, text: string) {
  for (const ch of text) {
    const at = view.state.selection.main.head;
    view.dispatch({ changes: { from: at, insert: ch }, selection: { anchor: at + 1 }, userEvent: 'input.type' });
  }
}

describe('Emmet', () => {
  it('expands div.card>h2+p in HTML', () => {
    const view = editor('<body>\n|\n</body>', 'index.html');
    // Typed abbreviation
    view.dispatch({ changes: { from: 7, insert: 'div.card>h2+p' }, selection: { anchor: 7 + 13 } });
    expect(expandAbbreviation(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('<body>\n<div class="card">\n  <h2></h2>\n  <p></p>\n</div>\n</body>');
    // The cursor lands in the first field (inside <h2>).
    expect(view.state.doc.sliceString(view.state.selection.main.from - 4, view.state.selection.main.from)).toBe('<h2>');
  });

  it('expands ul>li*3', () => {
    const view = editor('ul>li*3|', 'index.html');
    expect(expandAbbreviation(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('<ul>\n  <li></li>\n  <li></li>\n  <li></li>\n</ul>');
  });

  it('expands CSS abbreviations', () => {
    const view = editor('.box {\n  m10|\n}', 'style.css');
    expect(expandAbbreviation(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('.box {\n  margin: 10px;\n}');
  });

  it('works in PHP templates, JSX and Markdown', () => {
    const php = editor('<?php $x = 1; ?>\nnav>a|', 'index.php');
    expandAbbreviation(php);
    expect(php.state.doc.toString()).toBe('<?php $x = 1; ?>\n<nav><a href=""></a></nav>');
    const jsx = editor('const A = () => (\n  div.card|\n);', 'App.jsx');
    expandAbbreviation(jsx);
    expect(jsx.state.doc.toString()).toBe('const A = () => (\n  <div className="card"></div>\n);');
    const md = editor('# Title\n\nul>li*2|', 'README.md');
    expandAbbreviation(md);
    expect(md.state.doc.toString()).toBe('# Title\n\n<ul>\n  <li></li>\n  <li></li>\n</ul>');
  });

  it('enables Emmet only for markup and stylesheet files', () => {
    expect(['index.html', 'a.php', 'a.css', 'a.scss', 'App.jsx', 'App.tsx', 'README.md', 'icon.svg'].map(emmetModeFor)).toEqual([
      'html',
      'html',
      'css',
      'scss',
      'jsx',
      'tsx',
      'markdown',
      'xml',
    ]);
    expect(emmetModeFor('main.py')).toBeNull();
    expect(emmetModeFor('app.js')).toBeNull();
  });

  it('tells abbreviations from prose in Markdown', () => {
    expect(looksLikeAbbreviation('ul>li*3')).toBe(true);
    expect(looksLikeAbbreviation('div.card')).toBe(true);
    expect(looksLikeAbbreviation('!')).toBe(true);
    expect(looksLikeAbbreviation('hello')).toBe(false);
    expect(looksLikeAbbreviation('file.txt')).toBe(false);
    expect(looksLikeAbbreviation('e.g')).toBe(false);
  });

  it('tracks an abbreviation while typing and offers it in autocomplete', async () => {
    const view = editor('|', 'index.html');
    type(view, 'ul>li*3');
    expect(view.contentDOM.querySelector('.emmet-tracker')?.textContent).toBe('ul>li*3');
    // Tab on the tracker expands it.
    runScopeHandlers(view, new KeyboardEvent('keydown', { key: 'Tab', keyCode: 9 }), 'editor');
    expect(view.state.doc.toString()).toBe('<ul>\n  <li></li>\n  <li></li>\n  <li></li>\n</ul>');
  });

  it('does not track identifiers inside PHP code', () => {
    const view = editor('<?php\n|\n?>', 'index.php');
    type(view, 'echo');
    expect(view.contentDOM.querySelector('.emmet-tracker')).toBeNull();
    const html = editor('<?php $a = 1; ?>\n|', 'index.php');
    type(html, 'p.note');
    expect(html.contentDOM.querySelector('.emmet-tracker')?.textContent).toBe('p.note');
  });
});
