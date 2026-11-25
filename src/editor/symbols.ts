import { dirname, extOf, isExternalRef, resolveRelative } from '../core/paths';
import type { Files } from '../core/types';

/**
 * Project-wide definitions index (regex based, fast enough to rebuild on every save). Used for
 * "go to definition", "go to symbol" and "find all references". Incremental: files whose text did not
 * change keep their entries.
 */
export type SymbolKind = 'function' | 'class' | 'variable' | 'method' | 'selector' | 'css-variable' | 'id' | 'interface' | 'type';

export interface SymbolDef {
  /** Name as used in code: `card` for `.card`, `--accent` for a CSS variable, `main` for `id="main"`. */
  name: string;
  /** Text shown in lists, e.g. `.card`, `#main`, `function load()`. */
  label: string;
  kind: SymbolKind;
  path: string;
  /** 1-based line and 0-based column of the name. */
  line: number;
  column: number;
  /** Offset of the name in the file. */
  from: number;
  exported?: boolean;
}

interface FileEntry {
  content: string;
  symbols: SymbolDef[];
  /** Project paths this file imports / includes / links (resolved). */
  imports: string[];
}

export interface SymbolIndex {
  readonly files: ReadonlyMap<string, FileEntry>;
  /** Paths whose entries were (re)computed by the last build (for tests and diagnostics). */
  readonly rebuilt: readonly string[];
}

const MAX_FILE = 1_000_000;

type Lang = 'js' | 'py' | 'php' | 'css' | 'html' | null;

function langOf(path: string): Lang {
  const ext = extOf(path);
  if (['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts'].includes(ext)) return 'js';
  if (ext === 'py') return 'py';
  if (ext === 'php' || ext === 'phtml') return 'php';
  if (['css', 'scss', 'less'].includes(ext)) return 'css';
  if (['html', 'htm', 'svg', 'vue', 'svelte'].includes(ext)) return 'html';
  return null;
}

/** Line starts of a text, for offset → line/column. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

function locate(starts: number[], offset: number): { line: number; column: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - starts[lo]! };
}

/** Replaces comments (and, optionally, strings) with spaces, keeping offsets. */
function stripComments(text: string, lang: Lang): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  if (lang === 'py') return text.replace(/#[^\n]*/g, blank);
  if (lang === 'html') return text.replace(/<!--[\s\S]*?(-->|$)/g, blank);
  if (lang === 'css') return text.replace(/\/\*[\s\S]*?(\*\/|$)/g, blank);
  // js / php: block comments and line comments not inside strings (good enough for an index).
  return text.replace(/\/\*[\s\S]*?(\*\/|$)/g, blank).replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, pre: string) => pre + blank(m.slice(pre.length)));
}

const JS_RESERVED = new Set('if for while switch catch function return typeof new else do try with await yield delete void in of'.split(' '));

function scan(path: string, text: string): FileEntry {
  const lang = langOf(path);
  const symbols: SymbolDef[] = [];
  const imports = new Set<string>();
  if (!lang || text.length > MAX_FILE) return { content: text, symbols, imports: [] };
  const src = stripComments(text, lang);
  const starts = lineStarts(text);
  const add = (name: string, kind: SymbolKind, from: number, label = name, exported = false) => {
    const { line, column } = locate(starts, from);
    symbols.push({ name, label, kind, path, line, column, from, ...(exported ? { exported } : {}) });
  };
  const each = (re: RegExp, fn: (m: RegExpExecArray) => void) => {
    re.lastIndex = 0;
    for (let m: RegExpExecArray | null; (m = re.exec(src)); ) {
      fn(m);
      if (m[0] === '') re.lastIndex++;
    }
  };
  const nameAt = (m: RegExpExecArray, group: number) => m.index + m[0].lastIndexOf(m[group]!);
  const ref = (spec: string) => {
    if (!spec || isExternalRef(spec)) return;
    const r = resolveRelative(path, spec);
    if (r) imports.add(r);
  };

  if (lang === 'js') {
    each(/^[ \t]*(export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm, (m) =>
      add(m[2]!, 'function', nameAt(m, 2), `function ${m[2]}()`, !!m[1]),
    );
    each(/^[ \t]*(export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm, (m) => add(m[2]!, 'class', nameAt(m, 2), `class ${m[2]}`, !!m[1]));
    each(/^[ \t]*(export\s+)?(?:declare\s+)?(const|let|var)\s+([A-Za-z_$][\w$]*)/gm, (m) => {
      const after = src.slice(m.index + m[0].length, m.index + m[0].length + 200);
      const fn = /^\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/.test(after);
      add(m[3]!, fn ? 'function' : 'variable', nameAt(m, 3), `${m[2]} ${m[3]}`, !!m[1]);
    });
    // Destructuring at the top: const { a, b } = …
    each(/^(export\s+)?(?:const|let|var)\s*\{([^}]*)\}\s*=/gm, (m) => {
      const body = m[2]!;
      const base = m.index + m[0].indexOf('{') + 1;
      for (const part of body.matchAll(/(?:[\w$]+\s*:\s*)?([A-Za-z_$][\w$]*)\s*(?:=[^,]*)?(?:,|$)/g)) {
        if (part[1]) add(part[1], 'variable', base + part.index! + part[0].indexOf(part[1], part[0].indexOf(':') + 1), part[1], !!m[1]);
      }
    });
    each(/^[ \t]*(export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/gm, (m) => add(m[2]!, 'interface', nameAt(m, 2), `interface ${m[2]}`, !!m[1]));
    each(/^[ \t]*(export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*=/gm, (m) => add(m[2]!, 'type', nameAt(m, 2), `type ${m[2]}`, !!m[1]));
    each(/^[ \t]*(export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/gm, (m) => add(m[2]!, 'type', nameAt(m, 2), `enum ${m[2]}`, !!m[1]));
    // Class methods: an indented `name(…) {` that is not a call or a control statement.
    each(
      /^[ \t]+(?:(?:public|private|protected|static|async|readonly|override|get|set)\s+)*\*?\s*(#?[A-Za-z_$][\w$]*)\s*(?:<[^>\n]*>)?\(([^()\n]|\([^()\n]*\))*\)[ \t]*(?::[ \t]*[^{;=\n]+)?\{/gm,
      (m) => {
        const name = m[1]!;
        if (!JS_RESERVED.has(name) && name !== 'constructor') add(name, 'method', nameAt(m, 1), `${name}()`);
      },
    );
    // Object methods and function-valued properties: `name: function`, `name: (…) =>`.
    each(/^[ \t]+([A-Za-z_$][\w$]*)\s*:\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>)/gm, (m) => add(m[1]!, 'method', nameAt(m, 1), `${m[1]}()`));
    each(/\b(?:import|export)\s+(?:[^'"`;]*?\sfrom\s+)?['"]([^'"]+)['"]/g, (m) => ref(m[1]!));
    each(/\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g, (m) => ref(m[1]!));
  } else if (lang === 'py') {
    each(/^([ \t]*)(?:async\s+)?def\s+([A-Za-z_]\w*)/gm, (m) => add(m[2]!, m[1] ? 'method' : 'function', nameAt(m, 2), `def ${m[2]}()`));
    each(/^[ \t]*class\s+([A-Za-z_]\w*)/gm, (m) => add(m[1]!, 'class', nameAt(m, 1), `class ${m[1]}`));
    each(/^([A-Z_a-z]\w*)\s*(?::[^=\n]+)?=(?!=)/gm, (m) => add(m[1]!, 'variable', m.index, m[1]));
    each(/^[ \t]*from\s+(\.*)([\w.]*)\s+import\b/gm, (m) => pyRef(path, m[1]!, m[2]!).forEach((r) => imports.add(r)));
    each(/^[ \t]*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm, (m) => m[1]!.split(',').forEach((x) => pyRef(path, '', x.trim()).forEach((r) => imports.add(r))));
  } else if (lang === 'php') {
    each(/^[ \t]*((?:(?:public|private|protected|static|abstract|final)\s+)*)function\s+&?\s*([A-Za-z_]\w*)/gm, (m) =>
      add(m[2]!, m[1] || /^[ \t]+/.test(m[0]) ? 'method' : 'function', nameAt(m, 2), `function ${m[2]}()`),
    );
    each(/^[ \t]*(?:(?:abstract|final|readonly)\s+)*(class|interface|trait|enum)\s+([A-Za-z_]\w*)/gm, (m) =>
      add(m[2]!, m[1] === 'interface' ? 'interface' : 'class', nameAt(m, 2), `${m[1]} ${m[2]}`),
    );
    each(/^[ \t]*const\s+([A-Za-z_]\w*)\s*=/gm, (m) => add(m[1]!, 'variable', nameAt(m, 1), `const ${m[1]}`));
    each(/\bdefine\(\s*['"]([A-Za-z_]\w*)['"]/g, (m) => add(m[1]!, 'variable', nameAt(m, 1), m[1]));
    each(/\b(?:require|include)(?:_once)?\s*\(?\s*(?:__DIR__\s*\.\s*)?['"]\/?([^'"]+)['"]/g, (m) => ref(m[1]!));
    scanHtml(src, add, ref);
  } else if (lang === 'css') {
    scanCss(src, 0, add, ref);
  } else if (lang === 'html') {
    scanHtml(src, add, ref);
  }
  return { content: text, symbols, imports: [...imports].filter((p) => p !== path) };
}

type Add = (name: string, kind: SymbolKind, from: number, label?: string, exported?: boolean) => void;

function scanCss(src: string, offset: number, add: Add, ref: (s: string) => void): void {
  // Selectors: the text before each `{`, since the previous `{`, `}` or `;`.
  let segStart = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'") {
      const end = src.indexOf(c, i + 1);
      i = end < 0 ? src.length : end;
    } else if (c === '{') {
      const sel = src.slice(segStart, i);
      if (!/^\s*@/.test(sel)) {
        for (const m of sel.matchAll(/([.#])(-?[A-Za-z_][\w-]*)/g)) add(m[2]!, 'selector', offset + segStart + m.index! + 1, m[1]! + m[2]!);
      }
      segStart = i + 1;
    } else if (c === '}' || c === ';') {
      segStart = i + 1;
    }
  }
  for (const m of src.matchAll(/(?:^|[{;\s])(--[A-Za-z_][\w-]*)\s*:/g)) add(m[1]!, 'css-variable', offset + m.index! + m[0].indexOf(m[1]!), m[1]!);
  for (const m of src.matchAll(/@import\s+(?:url\()?\s*['"]?([^'")\s;]+)/g)) ref(m[1]!);
}

function scanHtml(src: string, add: Add, ref: (s: string) => void): void {
  for (const m of src.matchAll(/\sid\s*=\s*(["']?)([^"'\s>]+)\1/gi)) add(m[2]!, 'id', m.index! + m[0].lastIndexOf(m[2]!), `#${m[2]}`);
  for (const m of src.matchAll(/<(?:script|img|iframe|source)\b[^>]*?\ssrc\s*=\s*["']([^"']+)["']/gi)) ref(m[1]!);
  for (const m of src.matchAll(/<link\b[^>]*?\shref\s*=\s*["']([^"']+)["']/gi)) ref(m[1]!);
  for (const m of src.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    const body = m[1]!;
    scanCss(body, m.index! + m[0].indexOf('>') + 1, add, ref);
  }
}

function pyRef(path: string, dots: string, mod: string): string[] {
  const parts = mod ? mod.split('.') : [];
  let base = dirname(path);
  if (dots.length > 1) for (let i = 1; i < dots.length; i++) base = dirname(base);
  // Absolute imports resolve from the project root and from the file's folder (scripts run from there).
  const roots = dots ? [base] : ['', dirname(path)];
  const out: string[] = [];
  for (const root of roots) {
    const stem = [root, ...parts].filter(Boolean).join('/');
    if (stem) out.push(`${stem}.py`, `${stem}/__init__.py`);
  }
  return out;
}

const textOf = (files: Files, path: string): string | null => {
  const f = files[path];
  return f && f.text ? f.content : null;
};

/**
 * Builds the index of `files`. Pass the previous index to reuse the entries of unchanged files
 * (compared by content), which makes rebuilding after an edit cost only the edited file.
 */
export function buildSymbolIndex(files: Files, prev?: SymbolIndex): SymbolIndex {
  const out = new Map<string, FileEntry>();
  const rebuilt: string[] = [];
  for (const path of Object.keys(files).sort()) {
    const text = textOf(files, path);
    if (text === null || !langOf(path)) continue;
    const old = prev?.files.get(path);
    if (old && old.content === text) out.set(path, old);
    else {
      out.set(path, scan(path, text));
      rebuilt.push(path);
    }
  }
  return { files: out, rebuilt };
}

/** Updates one file (content `null` removes it). Returns a new index; the old one is unchanged. */
export function updateSymbolIndex(index: SymbolIndex, path: string, content: string | null): SymbolIndex {
  const files = new Map(index.files);
  if (content === null || !langOf(path)) files.delete(path);
  else if (files.get(path)?.content !== content) files.set(path, scan(path, content));
  return { files, rebuilt: content === null ? [] : [path] };
}

/** Symbols of one file (in order) or of the whole project (by path, then position). */
export function listSymbols(index: SymbolIndex, path?: string): SymbolDef[] {
  if (path !== undefined) return [...(index.files.get(path)?.symbols ?? [])].sort((a, b) => a.from - b.from);
  return [...index.files.values()].flatMap((e) => [...e.symbols].sort((a, b) => a.from - b.from));
}

/** Files imported by `path`, resolved to indexed paths (tries the usual extensions and index files). */
export function importsOf(index: SymbolIndex, path: string): string[] {
  const entry = index.files.get(path);
  if (!entry) return [];
  const out: string[] = [];
  for (const target of entry.imports) {
    const candidates = [target, ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.d.ts'].map((e) => target + e), ...['ts', 'tsx', 'js', 'jsx'].map((e) => `${target}/index.${e}`)];
    // `./util.js` written in TypeScript sources refers to `./util.ts`.
    if (/\.js$/.test(target)) candidates.push(target.replace(/\.js$/, '.ts'), target.replace(/\.js$/, '.tsx'));
    const hit = candidates.find((c) => index.files.has(c));
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}

/** Names a word may be defined under: `.card` / `#main` / `--x` forms are normalized to plain names. */
function normalizeWord(word: string): string {
  return word.replace(/^[.#]/, '');
}

/**
 * Definitions of `word`, best first: the file itself, then files it imports (directly, then
 * transitively), then files that import it, then the rest of the project.
 */
export function findDefinitions(index: SymbolIndex, word: string, fromPath: string): SymbolDef[] {
  const name = normalizeWord(word);
  if (!name) return [];
  const rank = new Map<string, number>([[fromPath, 0]]);
  // Breadth-first over imports: direct imports rank 1, their imports 2, …
  let frontier = [fromPath];
  for (let depth = 1; frontier.length && depth < 6; depth++) {
    const next: string[] = [];
    for (const p of frontier) {
      for (const imp of importsOf(index, p)) {
        if (!rank.has(imp)) {
          rank.set(imp, depth);
          next.push(imp);
        }
      }
    }
    frontier = next;
  }
  for (const [p] of index.files) if (!rank.has(p) && importsOf(index, p).includes(fromPath)) rank.set(p, 50);
  const hits: SymbolDef[] = [];
  for (const entry of index.files.values()) for (const s of entry.symbols) if (s.name === name) hits.push(s);
  const kindRank = (s: SymbolDef) => (s.kind === 'method' ? 1 : 0);
  return hits.sort(
    (a, b) =>
      (rank.get(a.path) ?? 100) - (rank.get(b.path) ?? 100) ||
      kindRank(a) - kindRank(b) ||
      Number(!!b.exported) - Number(!!a.exported) ||
      a.path.localeCompare(b.path) ||
      a.from - b.from,
  );
}

export interface Reference {
  path: string;
  /** 1-based line and 0-based column. */
  line: number;
  column: number;
  preview: string;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whole-word occurrences of `word` in every text file of the project (definitions included),
 * the current file first. `limit` caps the result for huge projects.
 */
export function findReferences(files: Files, word: string, opts: { fromPath?: string; limit?: number } = {}): Reference[] {
  const name = normalizeWord(word);
  if (!/^-{0,2}[A-Za-z_$][\w$-]*$/.test(name)) return [];
  const limit = opts.limit ?? 500;
  const re = new RegExp(`(?<![\\w$-])${escapeRe(name)}(?![\\w$-])`, 'g');
  const paths = Object.keys(files).sort((a, b) => Number(b === opts.fromPath) - Number(a === opts.fromPath) || a.localeCompare(b));
  const out: Reference[] = [];
  for (const path of paths) {
    const text = textOf(files, path);
    if (text === null || text.length > MAX_FILE || /(^|\/)(node_modules|\.git)\//.test(path)) continue;
    if (!text.includes(name)) continue;
    const starts = lineStarts(text);
    re.lastIndex = 0;
    for (let m: RegExpExecArray | null; (m = re.exec(text)); ) {
      const { line, column } = locate(starts, m.index);
      const lineText = text.slice(starts[line - 1], (starts[line] ?? text.length + 1) - 1);
      out.push({ path, line, column, preview: lineText.trim().slice(0, 200) });
      if (out.length >= limit) return out;
    }
  }
  return out;
}
