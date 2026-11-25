/**
 * Formatting logic shared by the format worker and tests: Prettier (standalone build, plugins loaded
 * on demand with dynamic import so they stay out of the main bundle) and a conservative Python
 * formatter. Pure apart from the lazy imports; runs in a Worker or on the main thread.
 */
import type { Options, Plugin } from 'prettier';
import { formatterFor, type ParserName } from './format-kind';

export interface FormatRequest {
  code: string;
  path: string;
  /** Contents of the project's `.prettierrc` (JSON), if any. */
  prettierrc?: string;
  cursorOffset?: number;
}

export interface FormatResult {
  formatted: string;
  cursorOffset: number;
}

export class FormatError extends Error {
  constructor(
    message: string,
    readonly line?: number,
    readonly column?: number,
  ) {
    super(message);
  }
}


const base = (path: string) => path.split('/').pop() ?? '';

export { canFormat, formatterFor } from './format-kind';

/** Options a `.prettierrc` may set (no `plugins` or `parser`: those would load code or break formatting). */
const ALLOWED = new Set([
  'printWidth', 'tabWidth', 'useTabs', 'semi', 'singleQuote', 'jsxSingleQuote', 'quoteProps', 'trailingComma', 'bracketSpacing',
  'objectWrap', 'bracketSameLine', 'arrowParens', 'proseWrap', 'htmlWhitespaceSensitivity', 'endOfLine', 'embeddedLanguageFormatting',
  'singleAttributePerLine', 'experimentalTernaries', 'experimentalOperatorPosition', 'vueIndentScriptAndStyle',
  // @prettier/plugin-php
  'phpVersion', 'trailingCommaPHP', 'braceStyle',
]);

const pick = (o: unknown): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  if (o && typeof o === 'object' && !Array.isArray(o)) for (const [k, v] of Object.entries(o)) if (ALLOWED.has(k)) out[k] = v;
  return out;
};

/** Minimal glob for `.prettierrc` overrides: `*`, `**`, `?`, `{a,b}`; patterns without `/` match the file name. */
export function globMatch(pattern: string, path: string): boolean {
  const target = pattern.includes('/') ? path.replace(/^\.?\//, '') : base(path);
  let re = '';
  const p = pattern.replace(/^\.?\//, '');
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === '*' && p[i + 1] === '*') {
      re += '.*';
      i++;
      if (p[i + 1] === '/') i++;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = p.indexOf('}', i);
      if (end < 0) re += '\\{';
      else {
        re += `(?:${p
          .slice(i + 1, end)
          .split(',')
          .map((s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
          .join('|')})`;
        i = end;
      }
    } else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`).test(target);
}

/** Options from a `.prettierrc` (JSON) for `path`: top-level options plus matching `overrides`. */
export function resolvePrettierOptions(rc: string | undefined, path: string): Record<string, unknown> {
  if (!rc?.trim()) return {};
  let cfg: unknown;
  try {
    cfg = JSON.parse(rc);
  } catch {
    return {};
  }
  if (!cfg || typeof cfg !== 'object') return {};
  const out = pick(cfg);
  const overrides = (cfg as { overrides?: unknown }).overrides;
  if (Array.isArray(overrides)) {
    for (const o of overrides) {
      if (!o || typeof o !== 'object') continue;
      const { files, excludeFiles, options } = o as { files?: unknown; excludeFiles?: unknown; options?: unknown };
      const list = (v: unknown) => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
      if (list(files).some((g) => globMatch(g, path)) && !list(excludeFiles).some((g) => globMatch(g, path))) Object.assign(out, pick(options));
    }
  }
  return out;
}

// ------------------------------------------------------------------ Python

/**
 * Conservative Python formatter (no Black in the browser): removes trailing whitespace outside
 * multi-line strings, turns tab indentation into 4 spaces, normalizes line endings and leaves exactly
 * one newline at the end of the file.
 */
export function formatPython(code: string): string {
  const lines = code.replace(/\r\n?/g, '\n').split('\n');
  let inString: string | null = null;
  const out = lines.map((line) => {
    const startedInString = inString !== null;
    // Track triple-quoted strings so their contents stay untouched.
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!;
      if (inString) {
        if (c === '\\') i++;
        else if (line.startsWith(inString, i)) {
          i += inString.length - 1;
          inString = null;
        }
      } else if (c === '#') break;
      else if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
        inString = line.slice(i, i + 3);
        i += 2;
      } else if (c === '"' || c === "'") {
        const end = findQuoteEnd(line, i, c);
        i = end;
      }
    }
    if (startedInString) return line; // inside a multi-line string: keep as is
    const indent = /^[ \t]*/.exec(line)![0];
    const fixed = indent.replace(/\t/g, '    ') + line.slice(indent.length);
    // A line that opens a multi-line string keeps its trailing spaces (they are string content).
    return inString ? fixed : fixed.replace(/[ \t]+$/, '');
  });
  while (out.length && out[out.length - 1]!.trim() === '') out.pop();
  return out.length ? out.join('\n') + '\n' : '';
}

function findQuoteEnd(line: string, start: number, q: string): number {
  for (let i = start + 1; i < line.length; i++) {
    if (line[i] === '\\') i++;
    else if (line[i] === q) return i;
  }
  return line.length;
}

// ------------------------------------------------------------------ Prettier

let prettierMod: Promise<typeof import('prettier/standalone')> | null = null;
const pluginCache = new Map<string, Promise<Plugin>>();

const PLUGIN_LOADERS: Record<string, () => Promise<Plugin>> = {
  babel: () => import('prettier/plugins/babel') as Promise<Plugin>,
  estree: () => import('prettier/plugins/estree') as Promise<Plugin>,
  typescript: () => import('prettier/plugins/typescript') as Promise<Plugin>,
  html: () => import('prettier/plugins/html') as Promise<Plugin>,
  postcss: () => import('prettier/plugins/postcss') as Promise<Plugin>,
  markdown: () => import('prettier/plugins/markdown') as Promise<Plugin>,
  yaml: () => import('prettier/plugins/yaml') as Promise<Plugin>,
  php: () => import('@prettier/plugin-php/standalone').then((m) => ((m as { default?: Plugin }).default ?? m) as Plugin),
};

/** Plugins each parser needs (HTML and Markdown also format their embedded scripts and styles). */
const PLUGINS_FOR: Record<ParserName, string[]> = {
  babel: ['babel', 'estree'],
  json: ['babel', 'estree'],
  json5: ['babel', 'estree'],
  jsonc: ['babel', 'estree'],
  'json-stringify': ['babel', 'estree'],
  typescript: ['typescript', 'estree'],
  html: ['html', 'babel', 'estree', 'postcss'],
  vue: ['html', 'babel', 'estree', 'postcss'],
  css: ['postcss'],
  scss: ['postcss'],
  less: ['postcss'],
  markdown: ['markdown', 'babel', 'estree', 'postcss', 'html', 'yaml'],
  yaml: ['yaml'],
  php: ['php'],
};

const loadPlugin = (name: string): Promise<Plugin> => {
  let p = pluginCache.get(name);
  if (!p) {
    p = PLUGIN_LOADERS[name]!();
    p.catch(() => pluginCache.delete(name));
    pluginCache.set(name, p);
  }
  return p;
};

/** Formats code. Throws FormatError with the parser's message (and position) on syntax errors. */
export async function formatCode(req: FormatRequest): Promise<FormatResult> {
  const kind = formatterFor(req.path);
  const cursor = Math.max(0, Math.min(req.cursorOffset ?? 0, req.code.length));
  if (!kind) throw new FormatError('unsupported');
  if (kind === 'python') {
    const formatted = formatPython(req.code);
    return { formatted, cursorOffset: mapCursor(req.code, formatted, cursor) };
  }
  const [prettier, ...plugins] = await Promise.all([(prettierMod ??= import('prettier/standalone')), ...PLUGINS_FOR[kind].map(loadPlugin)]);
  const rc = resolvePrettierOptions(req.prettierrc, req.path);
  const options: Options = {
    ...rc,
    parser: kind,
    plugins,
    filepath: req.path,
    cursorOffset: cursor,
  };
  if (kind === 'php') {
    // "auto"/"composer" read composer.json from disk (node only); pick a fixed modern version instead.
    const v = (options as { phpVersion?: unknown }).phpVersion;
    if (typeof v !== 'string' || !/^\d+(\.\d+)?$/.test(v)) (options as { phpVersion?: string }).phpVersion = '8.3';
  }
  try {
    const res = await prettier.formatWithCursor(req.code, options as Options & { cursorOffset: number });
    const guess = res.cursorOffset < 0 ? mapCursor(req.code, res.formatted, cursor) : res.cursorOffset;
    return { formatted: res.formatted, cursorOffset: snapCursor(req.code, cursor, res.formatted, guess) };
  } catch (e) {
    const err = e as Error & { loc?: { start?: { line?: number; column?: number } } };
    const first = String(err.message ?? e).split('\n')[0]!.replace(/\s*\(\d+:\d+\)\s*$/, '');
    throw new FormatError(first, err.loc?.start?.line, err.loc?.start?.column);
  }
}

/** Keeps the cursor at the same non-whitespace character after whitespace-only changes. */
export function mapCursor(before: string, after: string, cursor: number): number {
  let count = 0;
  for (let i = 0; i < cursor && i < before.length; i++) if (!/\s/.test(before[i]!)) count++;
  let i = 0;
  for (; i < after.length && count > 0; i++) if (!/\s/.test(after[i]!)) count--;
  // The cursor was in front of code: keep it in front of the same code, not before the new whitespace.
  if (cursor < before.length && !/\s/.test(before[cursor]!)) while (i < after.length && /\s/.test(after[i]!)) i++;
  return Math.min(i, after.length);
}

/**
 * Prettier's cursor tracking can land a few characters off (at the start of the enclosing node).
 * Moves `guess` to the nearest place where the code that followed the cursor appears again.
 */
export function snapCursor(before: string, cursor: number, after: string, guess: number): number {
  const token = before.slice(cursor).replace(/\s+/g, '').slice(0, 12);
  if (token.length < 3) return guess;
  const matchesAt = (p: number) => {
    let k = 0;
    for (let i = p; i < after.length && k < token.length; i++) {
      if (/\s/.test(after[i]!)) continue;
      if (after[i] !== token[k]) return k;
      k++;
    }
    return k;
  };
  const need = Math.min(token.length, 6);
  for (let d = 0; d <= 80; d++) {
    for (const p of d ? [guess + d, guess - d] : [guess]) {
      if (p < 0 || p > after.length || /\s/.test(after[p] ?? '')) continue;
      if (matchesAt(p) >= need) return p;
    }
  }
  return guess;
}
