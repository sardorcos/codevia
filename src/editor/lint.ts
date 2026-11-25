import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import {
  forEachDiagnostic,
  lintGutter,
  linter,
  nextDiagnostic as cmNextDiagnostic,
  setDiagnosticsEffect,
  type Diagnostic,
} from '@codemirror/lint';
import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, showTooltip, type Tooltip } from '@codemirror/view';
import { basename, extOf } from '../core/paths';
import { t } from '../i18n';
import { langIdOf } from './languages';

export type { Diagnostic };

/** Delay between the last edit and a lint run, ms. */
export const LINT_DELAY = 400;

const clampDiag = (d: Diagnostic, len: number): Diagnostic => {
  const from = Math.max(0, Math.min(d.from, len));
  return { ...d, from, to: Math.max(from, Math.min(d.to, len)) };
};

// ------------------------------------------------------------------ JSON

/** JSON files that allow comments and trailing commas (tsconfig and editor settings). */
export const isJsonc = (path: string): boolean =>
  /^(tsconfig|jsconfig)(\..*)?\.json$/i.test(basename(path)) || /(^|\/)\.vscode\//.test(path) || /\.jsonc$/i.test(path) || /^\.(eslintrc|babelrc|swcrc)(\.json)?$/i.test(basename(path));

interface JsonError {
  pos: number;
  message: string;
}

/** Strict JSON validator with exact positions (JSON.parse messages differ per engine and lack positions on WebKit). */
export function validateJson(text: string, jsonc = false): JsonError | null {
  let i = 0;
  const n = text.length;
  class Fail extends Error {
    constructor(
      public pos: number,
      message: string,
    ) {
      super(message);
    }
  }
  const fail = (pos: number, message: string): never => {
    throw new Fail(pos, message);
  };
  const unexpected = (pos: number): never =>
    pos >= n ? fail(n, t('Неожиданный конец файла')) : fail(pos, t('Неожиданный символ «{char}»', { char: text[pos]! }));
  const ws = () => {
    for (;;) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13) i++;
      else if (c === 47 /* / */ && (text[i + 1] === '/' || text[i + 1] === '*')) {
        if (!jsonc) fail(i, t('Комментарии в JSON не допускаются'));
        if (text[i + 1] === '/') {
          const end = text.indexOf('\n', i);
          i = end < 0 ? n : end;
        } else {
          const end = text.indexOf('*/', i + 2);
          if (end < 0) fail(i, t('Незакрытый комментарий'));
          i = end + 2;
        }
      } else return;
    }
  };
  const string = () => {
    const start = i++;
    for (;;) {
      if (i >= n) fail(start, t('Незакрытая строка'));
      const c = text[i]!;
      if (c === '"') {
        i++;
        return;
      }
      if (c === '\n' || c.charCodeAt(0) < 32) fail(i, c === '\n' ? t('Незакрытая строка') : t('Управляющий символ в строке'));
      if (c === '\\') {
        const e = text[i + 1];
        if (e === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) fail(i, t('Неверная escape-последовательность'));
          i += 6;
        } else if (e !== undefined && '"\\/bfnrt'.includes(e)) i += 2;
        else fail(i, t('Неверная escape-последовательность'));
      } else i++;
    }
  };
  const number = () => {
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i, i + 400));
    if (!m) fail(i, t('Неверное число'));
    i += m![0].length;
    if (/[\w.]/.test(text[i] ?? '')) fail(i, t('Неверное число'));
  };
  const literal = (word: string) => {
    if (text.startsWith(word, i)) i += word.length;
    else unexpected(i);
  };
  const value = (depth: number): void => {
    if (depth > 500) fail(i, t('Слишком глубокая вложенность'));
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      ws();
      if (text[i] === '}') {
        i++;
        return;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') {
          if (text[i] === '}' && jsonc) {
            i++;
            return;
          }
          if (text[i] === '}') fail(i, t('Лишняя запятая'));
          fail(i >= n ? n : i, i >= n ? t('Неожиданный конец файла') : t('Ожидалось имя свойства в двойных кавычках'));
        }
        string();
        ws();
        if (text[i] !== ':') fail(i, t('Ожидалось «{char}»', { char: ':' }));
        i++;
        value(depth + 1);
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === '}') {
          i++;
          return;
        }
        if (i >= n) fail(n, t('Неожиданный конец файла'));
        fail(i, t('Ожидалось «{char}»', { char: ', }' }));
      }
    }
    if (c === '[') {
      i++;
      ws();
      if (text[i] === ']') {
        i++;
        return;
      }
      for (;;) {
        ws();
        if (text[i] === ']') {
          if (jsonc) {
            i++;
            return;
          }
          fail(i, t('Лишняя запятая'));
        }
        value(depth + 1);
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === ']') {
          i++;
          return;
        }
        if (i >= n) fail(n, t('Неожиданный конец файла'));
        fail(i, t('Ожидалось «{char}»', { char: ', ]' }));
      }
    }
    if (c === '"') return string();
    if (c === '-' || (c !== undefined && c >= '0' && c <= '9')) return number();
    if (c === 't') return literal('true');
    if (c === 'f') return literal('false');
    if (c === 'n') return literal('null');
    if (c === "'") fail(i, t('Строки в JSON пишутся в двойных кавычках'));
    unexpected(i);
  };
  try {
    value(0);
    ws();
    if (i < n) fail(i, t('Лишние данные после JSON'));
    return null;
  } catch (e) {
    if (e instanceof Fail) return { pos: e.pos, message: e.message };
    throw e;
  }
}

/** JSON diagnostics: one error at the exact position (none for an empty file). */
export function lintJson(text: string, jsonc = false): Diagnostic[] {
  if (!text.trim()) return [];
  if (!jsonc) {
    try {
      JSON.parse(text);
      return [];
    } catch {
      /* locate it below */
    }
  }
  const err = validateJson(text, jsonc);
  if (!err) return [];
  const to = Math.min(text.length, err.pos + 1);
  return [{ from: Math.min(err.pos, text.length), to, severity: 'error', source: 'JSON', message: err.message }];
}

// ------------------------------------------------------------------ HTML tags

const VOID = new Set('area base br col embed hr img input link meta param source track wbr command keygen menuitem frame'.split(' '));
/** Elements whose end tag may be omitted (HTML spec); never reported as unclosed. */
const OPTIONAL_END = new Set('html head body p li dt dd option optgroup tr td th thead tbody tfoot colgroup caption rt rp'.split(' '));
const RAW_TEXT = /<(script|style|textarea|title)\b[^>]*>[\s\S]*?(?=<\/\1\s*>)/gi;

const blank = (s: string) => s.replace(/[^\n]/g, ' ');

/**
 * Unclosed and mismatched tags. Comments, raw-text elements (script, style, textarea, title),
 * doctype and, with `php`, `<?php … ?>` blocks are ignored. `xml` makes every element need closing.
 */
export function lintHtmlTags(text: string, opts: { php?: boolean; xml?: boolean } = {}): Diagnostic[] {
  let src = text.replace(/<!--[\s\S]*?(-->|$)/g, blank).replace(/<!\[CDATA\[[\s\S]*?(\]\]>|$)/g, blank);
  if (opts.php) src = src.replace(/<\?(php|=)?[\s\S]*?(\?>|$)/g, blank);
  src = src.replace(/<![^>]*>/g, blank).replace(/<\?[\s\S]*?\?>/g, blank);
  if (!opts.xml) src = src.replace(RAW_TEXT, (m) => m.slice(0, m.indexOf('>') + 1) + blank(m.slice(m.indexOf('>') + 1)));
  const out: Diagnostic[] = [];
  const stack: { name: string; from: number; to: number }[] = [];
  const norm = (s: string) => (opts.xml ? s : s.toLowerCase());
  const optional = (name: string) => !opts.xml && OPTIONAL_END.has(name);
  const unclosed = (e: { name: string; from: number; to: number }) =>
    out.push({ from: e.from, to: e.to, severity: 'error', source: 'HTML', message: t('Тег <{tag}> не закрыт', { tag: e.name }) });
  const re = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+(?:[^>"']|"[^"]*"|'[^']*')*)?)\s*(\/?)>/g;
  for (let m: RegExpExecArray | null; (m = re.exec(src)); ) {
    const name = norm(m[2]!);
    const from = m.index;
    const to = from + m[0].length;
    if (!m[1]) {
      if (/\/\s*>$/.test(m[0]) || (!opts.xml && VOID.has(name))) continue;
      stack.push({ name, from, to });
      continue;
    }
    if (!opts.xml && VOID.has(name)) continue;
    let k = stack.length - 1;
    while (k >= 0 && stack[k]!.name !== name) k--;
    if (k < 0) {
      out.push({ from, to, severity: 'error', source: 'HTML', message: t('Закрывающий тег </{tag}> без открывающего', { tag: name }) });
      continue;
    }
    const skipped = stack.splice(k).slice(1).filter((e) => !optional(e.name));
    if (skipped.length) {
      out.push({
        from,
        to,
        severity: 'error',
        source: 'HTML',
        message: t('Ожидался </{expected}>, а найден </{tag}>', { expected: skipped[skipped.length - 1]!.name, tag: name }),
      });
      skipped.forEach(unclosed);
    }
  }
  stack.filter((e) => !optional(e.name)).forEach(unclosed);
  return out.sort((a, b) => a.from - b.from);
}

// ------------------------------------------------------------------ Lezer trees

/** Error nodes of the (fully parsed) syntax tree, merged into ranges. */
export function treeErrors(state: EditorState, timeout = 300): Diagnostic[] {
  const tree = ensureSyntaxTree(state, state.doc.length, timeout) ?? syntaxTree(state);
  const len = state.doc.length;
  const ranges: { from: number; to: number }[] = [];
  tree.iterate({
    enter(node) {
      if (!node.type.isError) return;
      const from = node.from;
      let to = node.to;
      if (to === from) {
        // Zero-width error: mark the character there (or the one before, at the end of a line / the file).
        const line = state.doc.lineAt(from);
        to = from < line.to ? from + 1 : from;
      }
      const last = ranges[ranges.length - 1];
      if (last && from <= last.to + 1) last.to = Math.max(last.to, to);
      else ranges.push({ from, to });
    },
  });
  return ranges.map((r) => ({ from: r.from, to: Math.min(r.to, len), severity: 'error', source: 'syntax', message: t('Синтаксическая ошибка') }));
}

/** Repeated keys in object literals (JavaScript/TypeScript). Getter/setter pairs and computed keys are fine. */
export function duplicateKeys(state: EditorState): Diagnostic[] {
  const tree = ensureSyntaxTree(state, state.doc.length, 300) ?? syntaxTree(state);
  const out: Diagnostic[] = [];
  tree.iterate({
    enter(node) {
      if (node.name !== 'ObjectExpression') return;
      const seen = new Set<string>();
      for (let p = node.node.firstChild; p; p = p.nextSibling) {
        if (p.name !== 'Property') continue;
        const first = p.firstChild;
        if (!first || first.name === 'get' || first.name === 'set' || first.name === 'Spread' || first.name === '[') continue;
        if (!['PropertyDefinition', 'String', 'Number'].includes(first.name)) continue;
        let key = state.sliceDoc(first.from, first.to);
        if (first.name === 'String') key = key.slice(1, -1);
        else if (first.name === 'Number') key = String(Number(key.replace(/_/g, '')));
        if (seen.has(key)) {
          out.push({ from: first.from, to: first.to, severity: 'warning', source: 'JS', message: t('Повторяющийся ключ «{key}» в объекте', { key }) });
        }
        seen.add(key);
      }
    },
  });
  return out;
}

// ------------------------------------------------------------------ JavaScript / TypeScript

type Sucrase = typeof import('sucrase');
let sucrase: Promise<Sucrase> | null = null;

function syntaxErrorAt(text: string, transforms: ('jsx' | 'typescript')[], mod: Sucrase): { pos: number; message: string } | null {
  try {
    mod.transform(text, { transforms, disableESTransforms: true });
    return null;
  } catch (e) {
    const err = e as Error & { pos?: number };
    return { pos: typeof err.pos === 'number' ? err.pos : 0, message: String(err.message ?? e).replace(/\s*\(\d+:\d+\)\s*$/, '') };
  }
}

/** Syntax errors of a JS/TS file with exact positions (sucrase's parser, loaded on first use). */
export async function lintScript(text: string, opts: { typescript?: boolean; jsx?: boolean }): Promise<Diagnostic[]> {
  if (!text.trim()) return [];
  const mod = await (sucrase ??= import('sucrase'));
  const base: ('jsx' | 'typescript')[] = opts.typescript ? ['typescript'] : [];
  let err = syntaxErrorAt(text, opts.jsx ? [...base, 'jsx'] : base, mod);
  // Plain .js files often contain JSX (React): accept them when they parse as JSX.
  if (err && !opts.jsx && !opts.typescript && syntaxErrorAt(text, ['jsx'], mod) === null) err = null;
  if (!err) return [];
  const pos = Math.max(0, Math.min(err.pos, text.length));
  const end = pos < text.length && text[pos] !== '\n' ? pos + 1 : pos;
  return [{ from: pos, to: end, severity: 'error', source: 'JS', message: t('Синтаксическая ошибка: {message}', { message: err.message }) }];
}

// ------------------------------------------------------------------ per file

/** All diagnostics of a document (the lint source of the editor; usable without a view). */
export async function computeDiagnostics(state: EditorState, path: string): Promise<Diagnostic[]> {
  const text = state.doc.toString();
  const len = text.length;
  if (len > 2_000_000) return [];
  const lang = langIdOf(path);
  let out: Diagnostic[];
  switch (lang) {
    case 'javascript':
    case 'typescript': {
      const ext = extOf(path);
      try {
        out = await lintScript(text, { typescript: lang === 'typescript', jsx: ext === 'jsx' || ext === 'tsx' });
      } catch {
        out = treeErrors(state); // sucrase failed to load
      }
      out = out.concat(duplicateKeys(state));
      break;
    }
    case 'json':
      out = lintJson(text, isJsonc(path));
      break;
    case 'html':
      out = mergeSyntax(treeErrors(state), lintHtmlTags(text));
      break;
    case 'xml':
      out = mergeSyntax(treeErrors(state), lintHtmlTags(text, { xml: true }));
      break;
    case 'php':
      out = mergeSyntax(treeErrors(state), lintHtmlTags(text, { php: true }));
      break;
    case 'css':
    case 'python':
    case 'markdown':
      out = treeErrors(state);
      break;
    default:
      out = [];
  }
  return out.map((d) => clampDiag(d, len)).sort((a, b) => a.from - b.from);
}

/** Drops generic syntax errors that overlap a more specific tag diagnostic. */
function mergeSyntax(syntax: Diagnostic[], specific: Diagnostic[]): Diagnostic[] {
  const kept = syntax.filter((s) => !specific.some((d) => s.from < d.to + 1 && d.from < s.to + 1));
  return kept.concat(specific);
}

// ------------------------------------------------------------------ touch tooltip

const showTouchTip = StateEffect.define<number | null>();

/** Tap a squiggle or a gutter marker to read the message (hover tooltips do not exist on touch screens). */
const touchTip = StateField.define<Tooltip | null>({
  create: () => null,
  update(tip, tr) {
    for (const e of tr.effects) if (e.is(showTouchTip)) return e.value === null ? null : tipAt(tr.state, e.value);
    if (tr.docChanged || tr.selection) return null;
    if (tip && tr.effects.some((e) => e.is(setDiagnosticsEffect))) return tipAt(tr.state, tip.pos);
    return tip;
  },
  provide: (f) => showTooltip.from(f),
});

/** Diagnostics touching `pos` (or on its line, when `line` is set). */
function diagnosticsAt(state: EditorState, pos: number, line = false): (Diagnostic & { from: number; to: number })[] {
  const found: (Diagnostic & { from: number; to: number })[] = [];
  const l = state.doc.lineAt(pos);
  forEachDiagnostic(state, (d, from, to) => {
    if (line ? from <= l.to && to >= l.from : from <= pos && to >= pos) found.push({ ...d, from, to });
  });
  return found;
}

function tipAt(state: EditorState, pos: number, line = false): Tooltip | null {
  const list = diagnosticsAt(state, pos, line);
  if (!list.length) return null;
  return {
    pos: line ? list[0]!.from : pos,
    above: true,
    create() {
      const dom = document.createElement('div');
      dom.className = 'cm-touch-lint';
      dom.setAttribute('role', 'status');
      for (const d of list) {
        const item = document.createElement('div');
        item.className = `cm-touch-lint-item cm-touch-lint-${d.severity}`;
        item.textContent = d.message;
        dom.append(item);
      }
      return { dom };
    },
  };
}

/** Shows the message of the diagnostic at `pos` (or on the line of `pos` with `line`). */
export function showDiagnosticAt(view: EditorView, pos: number, line = false): boolean {
  const list = diagnosticsAt(view.state, pos, line);
  if (!list.length) return false;
  view.dispatch({ effects: showTouchTip.of(line ? list[0]!.from : pos) });
  return true;
}

const touchHandlers = ViewPlugin.define((view) => {
  const onClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('.cm-gutter-lint')) {
      const block = view.lineBlockAtHeight(e.clientY - view.documentTop);
      showDiagnosticAt(view, block.from, true);
      return;
    }
    if (!view.contentDOM.contains(target)) return;
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    if (pos !== null) showDiagnosticAt(view, pos);
  };
  view.dom.addEventListener('click', onClick);
  return { destroy: () => view.dom.removeEventListener('click', onClick) };
});

// ------------------------------------------------------------------ public API

export interface DiagnosticsSummary {
  errors: number;
  warnings: number;
  total: number;
}

export function diagnosticsSummary(state: EditorState): DiagnosticsSummary {
  let errors = 0;
  let warnings = 0;
  forEachDiagnostic(state, (d) => {
    if (d.severity === 'error') errors++;
    else warnings++;
  });
  return { errors, warnings, total: errors + warnings };
}

/** Number of diagnostics (errors + warnings) of the open file, for a counter in the UI. */
export const diagnosticsCount = (view: EditorView): number => diagnosticsSummary(view.state).total;

/** Moves to the next diagnostic (wrapping around) and shows its message. False when there is none. */
export function nextDiagnostic(view: EditorView): boolean {
  if (!diagnosticsCount(view)) return false;
  cmNextDiagnostic(view);
  showDiagnosticAt(view, view.state.selection.main.from);
  view.focus();
  return true;
}

/** Lint extension of a file: squiggles, gutter markers, tap-to-read tooltips; `onChange` gets the counts. */
export function lintExtension(path: string, onChange?: (summary: DiagnosticsSummary) => void): Extension {
  const lang = langIdOf(path);
  if (lang === 'text' || lang === 'yaml') return [];
  return [
    linter((view) => computeDiagnostics(view.state, path), {
      delay: LINT_DELAY,
      // No hover tooltip while the tapped one is open (Safari also sends a hover on tap).
      tooltipFilter: (diags, state) => (state.field(touchTip, false) ? [] : [...diags]),
    }),
    lintGutter(),
    touchTip,
    touchHandlers,
    onChange
      ? EditorView.updateListener.of((u) => {
          if (u.transactions.some((tr) => tr.effects.some((e) => e.is(setDiagnosticsEffect)))) onChange(diagnosticsSummary(u.state));
        })
      : [],
  ];
}
