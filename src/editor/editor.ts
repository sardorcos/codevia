import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab, redo, undo } from '@codemirror/commands';
import {
  bracketMatching,
  foldGutter,
  HighlightStyle,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
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
import { t as tr } from '../i18n';
import { colorSwatches } from './color-swatches';
import { snippetExtension } from './completions';
import { definitionExtension, goToDefinitionAtCursor, type DefinitionOptions } from './definition';
import { emmetIfLoaded, loadEmmet } from './emmet-lazy';
import { emmetModeFor } from './emmet-mode';
import { canFormat, formatDocument, type FormatOutcome } from './format';
import { languageFor } from './languages';
import { diagnosticsSummary, lintExtension, nextDiagnostic, type DiagnosticsSummary } from './lint';
import './editor.css';

export type { DefinitionOptions, DefinitionTrigger } from './definition';
export type { DiagnosticsSummary } from './lint';
export type { FormatOptions, FormatOutcome } from './format';

// Colours come from CSS variables (src/styles/app.css), so the editor follows the light and dark themes.
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: 'var(--syn-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--syn-string)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--syn-number)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.tagName, t.angleBracket], color: 'var(--syn-tag)' },
  { tag: [t.attributeName, t.propertyName], color: 'var(--syn-attr)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--syn-fn)' },
  { tag: [t.className, t.typeName, t.definition(t.typeName)], color: 'var(--syn-type)' },
  { tag: [t.heading], color: 'var(--syn-heading)', fontWeight: '700' },
  { tag: [t.link, t.url], color: 'var(--syn-link)', textDecoration: 'underline' },
  { tag: [t.invalid], color: 'var(--syn-invalid)' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'transparent', color: 'var(--syn-text)', fontSize: 'var(--code-font)' },
  '.cm-scroller': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    lineHeight: '1.6',
    paddingBottom: '40px',
    overscrollBehavior: 'contain',
  },
  '.cm-content': { caretColor: 'var(--cm-caret)', padding: '6px 0' },
  '.cm-gutters': { backgroundColor: 'var(--cm-gutter-bg)', color: 'var(--cm-gutter-text)', border: 'none', borderRight: '1px solid var(--cm-gutter-stroke)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--cm-active-gutter)', color: 'var(--cm-active-gutter-text)' },
  '.cm-activeLine': { backgroundColor: 'var(--cm-active-line)' },
  '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--cm-selection) !important' },
  '.cm-matchingBracket': { backgroundColor: 'var(--accent-weak)', outline: '1px solid var(--accent-stroke)' },
  '.cm-panels': { backgroundColor: 'var(--surface)', color: 'var(--text)', borderTop: '1px solid var(--stroke)' },
  '.cm-panels input, .cm-panels button': { fontSize: '16px', minHeight: '36px' },
  '.cm-tooltip': { backgroundColor: 'var(--tooltip-bg)', border: '1px solid var(--stroke2)', color: 'var(--text)' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--cm-selection)', color: 'var(--text)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--panel2)', border: 'none', color: 'var(--muted)' },
});

/** Options of createEditor(). Callbacks may be changed later with setOptions(). */
export interface EditorOptions extends DefinitionOptions {
  /** The diagnostics of the open file changed (for an error counter / "next error" button). */
  onDiagnostics?: (path: string, summary: DiagnosticsSummary) => void;
  /** Feature switches, all on by default. */
  emmet?: boolean;
  snippets?: boolean;
  lint?: boolean;
  colorSwatches?: boolean;
  /** Makes formatOnSave() format the file (a setting in the app). Off by default. */
  formatOnSave?: boolean;
  /** Returns the text of the project's `.prettierrc` (JSON), if it has one. */
  prettierrc?: () => string | undefined;
}

export interface EditorHost {
  view: EditorView;
  /** Path of the open file ('' when none). */
  readonly path: string;
  open(path: string, content: string): void;
  setWrap(on: boolean): void;
  insert(text: string): void;
  undo(): void;
  redo(): void;
  search(): void;
  goToLine(line: number): void;
  /** Puts the cursor at a 1-based line and 0-based column (e.g. a definition) and scrolls it into view. */
  revealPosition(line: number, column?: number): void;
  current(): string;
  forget(path: string): void;
  /** Drops every cached file state (called when switching projects). */
  reset(): void;
  rename(from: string, to: string): void;
  /** Changes options; feature switches apply to the open file at once and to other files when opened. */
  setOptions(opts: Partial<EditorOptions>): void;
  /** Formats the open file (Prettier / Python), as one undoable change. */
  format(): Promise<FormatOutcome>;
  /** Formats the open file only when `formatOnSave` is on; call it on an explicit save (⌘S, leaving the file). */
  formatOnSave(): Promise<FormatOutcome | null>;
  /** Error / warning counts of the open file. */
  diagnostics(): DiagnosticsSummary;
}

/**
 * One EditorView for the whole app; each file keeps its own EditorState (so undo history and
 * cursor survive switching tabs and re-renders).
 */
export function createEditor(onChange: (path: string, text: string) => void, wrap: boolean, options: EditorOptions = {}): EditorHost {
  const states = new Map<string, EditorState>();
  const wrapping = new Compartment();
  const features = new Compartment();
  let currentPath = '';
  let wrapOn = wrap;
  const opts: EditorOptions = { ...options };
  /** Bumped when a feature switch changes; files opened with an older version get reconfigured. */
  let featureVersion = 0;
  const builtWith = new Map<string, number>();

  // Callbacks go through `opts`, so setOptions() can replace them without rebuilding states.
  const definition: DefinitionOptions = {
    onGoToDefinition: (word, pos, path, via) => opts.onGoToDefinition?.(word, pos, path, via),
    hasDefinition: (word, path) => (opts.hasDefinition ? opts.hasDefinition(word, path) : true),
  };

  const featureExtensions = (path: string): Extension[] => [
    opts.emmet !== false ? (emmetIfLoaded()?.emmetExtension(path) ?? []) : [],
    opts.snippets !== false ? snippetExtension(path) : [],
    opts.lint !== false ? lintExtension(path, (summary) => opts.onDiagnostics?.(path, summary)) : [],
    opts.colorSwatches !== false ? colorSwatches() : [],
    definitionExtension(path, definition),
  ];

  /** Loads Emmet on first use, then applies it to the open file (and, via featureVersion, to cached ones). */
  const ensureEmmet = (path: string) => {
    if (opts.emmet === false || emmetIfLoaded() || !emmetModeFor(path)) return;
    void loadEmmet().then(() => {
      featureVersion++;
      if (currentPath && emmetModeFor(currentPath)) {
        view.dispatch({ effects: features.reconfigure(featureExtensions(currentPath)) });
        builtWith.set(currentPath, featureVersion);
      }
    });
  };

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
    // Needed by selectNextOccurrence (key bar, Mod-d) and Alt-click.
    EditorState.allowMultipleSelections.of(true),
    // Before the main keymap: Emmet's Tab (expand) must run before indentWithTab.
    features.of(featureExtensions(path)),
    keymap.of([
      { key: 'Shift-Alt-f', run: () => (void host.format(), true) },
      { key: 'F12', run: goToDefinitionAtCursor },
      { key: 'F8', run: nextDiagnostic },
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...completionKeymap,
      indentWithTab,
    ]),
    syntaxHighlighting(highlight),
    theme,
    languageFor(path),
    wrapping.of(wrapOn ? EditorView.lineWrapping : []),
    EditorView.contentAttributes.of({
      autocapitalize: 'off',
      autocorrect: 'off',
      spellcheck: 'false',
      'aria-label': tr('Код файла {path}', { path }),
    }),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) onChange(currentPath, u.state.doc.toString());
    }),
  ];

  const view = new EditorView({ state: EditorState.create({ doc: '' }) });
  // Not in the startup bundle, but fetched soon after start so it is ready before the first HTML file.
  if (opts.emmet !== false && typeof window !== 'undefined') setTimeout(() => void loadEmmet().catch(() => undefined), 2500);

  const host: EditorHost = {
    view,
    get path() {
      return currentPath;
    },
    open(path, content) {
      if (currentPath) states.set(currentPath, view.state);
      let state = states.get(path);
      if (!state || state.doc.toString() !== content) {
        // External change (restore, import) resets that file's history.
        state = EditorState.create({ doc: content, extensions: extensionsFor(path) });
        builtWith.set(path, featureVersion);
      }
      currentPath = path;
      view.setState(state);
      const effects = [wrapping.reconfigure(wrapOn ? EditorView.lineWrapping : [])];
      if (builtWith.get(path) !== featureVersion) {
        effects.push(features.reconfigure(featureExtensions(path)));
        builtWith.set(path, featureVersion);
      }
      view.dispatch({ effects });
      ensureEmmet(path);
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
    revealPosition(line, column = 0) {
      const l = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)));
      const pos = Math.min(l.to, l.from + Math.max(0, column));
      view.dispatch({ selection: EditorSelection.cursor(pos), effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
      view.focus();
    },
    goToLine(line) {
      const l = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)));
      view.dispatch({ selection: EditorSelection.cursor(l.from), scrollIntoView: true });
      view.focus();
    },
    current: () => view.state.doc.toString(),
    forget(path) {
      states.delete(path);
      builtWith.delete(path);
    },
    reset() {
      states.clear();
      builtWith.clear();
      currentPath = '';
      view.setState(EditorState.create({ doc: '' }));
    },
    rename(from, to) {
      const s = from === currentPath ? view.state : states.get(from);
      states.delete(from);
      if (s) states.set(to, s);
      if (from === currentPath) currentPath = to;
    },
    setOptions(next) {
      const switches: (keyof EditorOptions)[] = ['emmet', 'snippets', 'lint', 'colorSwatches'];
      const changed = switches.some((k) => k in next && next[k] !== opts[k]);
      Object.assign(opts, next);
      if (!changed) return;
      featureVersion++;
      if (currentPath) {
        view.dispatch({ effects: features.reconfigure(featureExtensions(currentPath)) });
        builtWith.set(currentPath, featureVersion);
        ensureEmmet(currentPath);
      }
    },
    format() {
      if (!currentPath) return Promise.resolve({ changed: false });
      return formatDocument(view, currentPath, { prettierrc: opts.prettierrc?.() });
    },
    async formatOnSave() {
      if (!opts.formatOnSave || !currentPath || !canFormat(currentPath)) return null;
      return host.format();
    },
    diagnostics: () => diagnosticsSummary(view.state),
  };
  return host;
}
