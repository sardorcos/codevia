import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab, redo, undo } from '@codemirror/commands';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { php } from '@codemirror/lang-php';
import { python } from '@codemirror/lang-python';
import {
  bracketMatching,
  foldGutter,
  HighlightStyle,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
  type LanguageSupport,
} from '@codemirror/language';
import { highlightSelectionMatches, openSearchPanel, search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorSelection, EditorState, type Extension } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { extOf } from '../core/paths';

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: '#ffcf87' },
  { tag: [t.string, t.special(t.string), t.regexp], color: '#b7d98f' },
  { tag: [t.number, t.bool, t.null, t.atom], color: '#dab3e7' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: '#7d90a4', fontStyle: 'italic' },
  { tag: [t.tagName, t.angleBracket], color: '#f5b58e' },
  { tag: [t.attributeName, t.propertyName], color: '#8bc5ed' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#80d9ec' },
  { tag: [t.className, t.typeName, t.definition(t.typeName)], color: '#9fe3c7' },
  { tag: [t.heading], color: '#f2f4f7', fontWeight: '700' },
  { tag: [t.link, t.url], color: '#40c8f6', textDecoration: 'underline' },
  { tag: [t.invalid], color: '#ef757e' },
]);

const theme = EditorView.theme(
  {
    '&': { height: '100%', backgroundColor: 'transparent', color: '#dfebfa', fontSize: 'var(--code-font)' },
    '.cm-scroller': {
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      lineHeight: '1.6',
      paddingBottom: '40px',
      overscrollBehavior: 'contain',
    },
    '.cm-content': { caretColor: '#fafafa', padding: '6px 0' },
    '.cm-gutters': { backgroundColor: '#0c1016', color: '#8792a3', border: 'none', borderRight: '1px solid #1c222b' },
    '.cm-activeLineGutter': { backgroundColor: '#151b24', color: '#c5ceda' },
    '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.035)' },
    '&.cm-focused .cm-cursor': { borderLeftColor: '#40c8f6', borderLeftWidth: '2px' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'rgba(64,200,246,0.28) !important' },
    '.cm-matchingBracket': { backgroundColor: 'rgba(64,200,246,0.2)', outline: '1px solid rgba(64,200,246,0.5)' },
    '.cm-panels': { backgroundColor: '#14171c', color: '#f2f4f7', borderTop: '1px solid #282d37' },
    '.cm-panels input, .cm-panels button': { fontSize: '16px', minHeight: '36px' },
    '.cm-tooltip': { backgroundColor: '#1a1e24', border: '1px solid #343946', color: '#f2f4f7' },
    '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'rgba(64,200,246,0.25)', color: '#fff' },
    '.cm-foldPlaceholder': { backgroundColor: '#20252d', border: 'none', color: '#929ba9' },
  },
  { dark: true },
);

function languageFor(path: string): LanguageSupport | Extension {
  switch (extOf(path)) {
    case 'html':
    case 'htm':
      return html();
    case 'css':
    case 'scss':
    case 'less':
      return css();
    case 'js':
    case 'mjs':
    case 'cjs':
      return javascript();
    case 'jsx':
      return javascript({ jsx: true });
    case 'ts':
      return javascript({ typescript: true });
    case 'tsx':
      return javascript({ jsx: true, typescript: true });
    case 'json':
    case 'webmanifest':
      return json();
    case 'php':
    case 'phtml':
      return php();
    case 'py':
      return python();
    case 'md':
    case 'markdown':
      return markdown();
    case 'svg':
    case 'xml':
      return html({ matchClosingTags: true, selfClosingTags: true });
    default:
      return [];
  }
}

export interface EditorHost {
  view: EditorView;
  open(path: string, content: string): void;
  setWrap(on: boolean): void;
  insert(text: string): void;
  undo(): void;
  redo(): void;
  search(): void;
  goToLine(line: number): void;
  current(): string;
  forget(path: string): void;
  rename(from: string, to: string): void;
}

/**
 * One EditorView for the whole app; each file keeps its own EditorState (so undo history and
 * cursor survive switching tabs and re-renders).
 */
export function createEditor(onChange: (path: string, text: string) => void, wrap: boolean): EditorHost {
  const states = new Map<string, EditorState>();
  const wrapping = new Compartment();
  let currentPath = '';
  let wrapOn = wrap;

  const extensionsFor = (path: string): Extension[] => [
    lineNumbers(),
    highlightActiveLineGutter(),
    foldGutter(),
    history(),
    drawSelection(),
    rectangularSelection(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    autocompletion({ activateOnTyping: true }),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    indentUnit.of(extOf(path) === 'py' ? '    ' : '  '),
    EditorState.tabSize.of(extOf(path) === 'py' ? 4 : 2),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
    syntaxHighlighting(highlight),
    theme,
    languageFor(path),
    wrapping.of(wrapOn ? EditorView.lineWrapping : []),
    EditorView.contentAttributes.of({
      autocapitalize: 'off',
      autocorrect: 'off',
      spellcheck: 'false',
      'aria-label': `Код файла ${path}`,
    }),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) onChange(currentPath, u.state.doc.toString());
    }),
  ];

  const view = new EditorView({ state: EditorState.create({ doc: '' }) });

  const host: EditorHost = {
    view,
    open(path, content) {
      if (currentPath) states.set(currentPath, view.state);
      let state = states.get(path);
      if (!state || state.doc.toString() !== content) {
        // External change (restore, import) resets that file's history.
        state = EditorState.create({ doc: content, extensions: extensionsFor(path) });
      }
      currentPath = path;
      view.setState(state);
      view.dispatch({ effects: wrapping.reconfigure(wrapOn ? EditorView.lineWrapping : []) });
    },
    setWrap(on) {
      wrapOn = on;
      view.dispatch({ effects: wrapping.reconfigure(on ? EditorView.lineWrapping : []) });
    },
    insert(text) {
      const pairs: Record<string, string> = { '{}': '{}', '[]': '[]', '()': '()', '<>': '<>', '""': '""', "''": "''" };
      const sel = view.state.selection.main;
      if (pairs[text]) {
        const [open, close] = [text[0]!, text[1]!];
        const inner = view.state.sliceDoc(sel.from, sel.to);
        view.dispatch({
          changes: { from: sel.from, to: sel.to, insert: open + inner + close },
          selection: inner ? EditorSelection.range(sel.from + 1, sel.from + 1 + inner.length) : EditorSelection.cursor(sel.from + 1),
          userEvent: 'input.type',
        });
      } else {
        view.dispatch(view.state.replaceSelection(text), { userEvent: 'input.type' });
      }
      view.focus();
    },
    undo() {
      undo(view);
      view.focus();
    },
    redo() {
      redo(view);
      view.focus();
    },
    search() {
      openSearchPanel(view);
    },
    goToLine(line) {
      const l = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)));
      view.dispatch({ selection: EditorSelection.cursor(l.from), scrollIntoView: true });
      view.focus();
    },
    current: () => view.state.doc.toString(),
    forget(path) {
      states.delete(path);
    },
    rename(from, to) {
      const s = from === currentPath ? view.state : states.get(from);
      states.delete(from);
      if (s) states.set(to, s);
      if (from === currentPath) currentPath = to;
    },
  };
  return host;
}
