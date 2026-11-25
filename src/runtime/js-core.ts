/**
 * The testable part of the JavaScript runtime: module resolution, transpilation (TypeScript, JSX and
 * ES modules → CommonJS via sucrase), a Node-like console formatter and tiny `fs`/`path` modules
 * backed by the project files. The worker (js.worker.ts) only wires these to messages.
 */
import { transform } from 'sucrase';

export const JS_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx'];
const RESOLVE_ORDER = ['', '.js', '.ts', '.mjs', '.cjs', '.jsx', '.tsx', '.json', '/index.js', '/index.ts', '/index.mjs'];

export const isScript = (path: string) => JS_EXTENSIONS.some((e) => path.endsWith(e));

/** Normalizes "a/./b/../c" → "a/c". Returns null for paths escaping the project. */
export function joinPath(base: string, rel: string): string | null {
  const parts = base ? base.split('/') : [];
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

export const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** Resolves a relative or project-absolute specifier to an existing project file. */
export function resolveModule(from: string, spec: string, exists: (p: string) => boolean): string | null {
  let base: string | null;
  if (spec.startsWith('./') || spec.startsWith('../')) base = joinPath(dirOf(from), spec);
  else if (spec.startsWith('/')) base = joinPath('', spec);
  else return null;
  if (base === null) return null;
  for (const suffix of RESOLVE_ORDER) {
    const p = base + suffix;
    if (p && exists(p)) return p;
  }
  // "import x from './util.js'" written for a TypeScript file util.ts.
  const m = /\.(m|c)?js$/.exec(base);
  if (m) {
    for (const ext of ['.ts', '.tsx', '.mts', '.cts']) {
      const p = base.slice(0, -m[0].length) + ext;
      if (exists(p)) return p;
    }
  }
  return null;
}

/** Transpiles one module to CommonJS. Line numbers are preserved (sucrase keeps them). */
export function compileModule(path: string, source: string): string {
  const transforms: ('typescript' | 'jsx' | 'imports' | 'flow')[] = ['imports'];
  if (/\.(m|c)?tsx?$/.test(path)) transforms.unshift('typescript');
  if (/\.[jt]sx$/.test(path)) transforms.push('jsx');
  return transform(source, {
    transforms,
    filePath: path,
    production: true,
    jsxRuntime: 'classic',
    disableESTransforms: true,
  }).code;
}

// ---------------------------------------------------------------------------------------------
// Console formatting, close to Node's util.inspect for the cases a learner meets.

export interface InspectOptions {
  depth?: number;
  maxItems?: number;
}

export function inspect(value: unknown, opts: InspectOptions = {}, seen = new Set<unknown>(), level = 0, nested = false): string {
  const depth = opts.depth ?? 2;
  const maxItems = opts.maxItems ?? 100;
  switch (typeof value) {
    case 'string':
      return nested ? `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'` : value;
    case 'number':
      return Object.is(value, -0) ? '-0' : String(value);
    case 'bigint':
      return `${value}n`;
    case 'boolean':
    case 'undefined':
      return String(value);
    case 'symbol':
      return value.toString();
    case 'function': {
      const fn = value as { name?: string; prototype?: unknown };
      const isClass = /^class[\s{]/.test(Function.prototype.toString.call(value));
      return isClass ? `[class ${fn.name || '(anonymous)'}]` : `[Function: ${fn.name || '(anonymous)'}]`;
    }
  }
  if (value === null) return 'null';
  const obj = value as object;
  if (seen.has(obj)) return '[Circular *]';
  if (obj instanceof Error) return obj.stack && level === 0 ? obj.stack : `[${obj.name}: ${obj.message}]`;
  if (obj instanceof Date) return isNaN(obj.getTime()) ? 'Invalid Date' : obj.toISOString();
  if (obj instanceof RegExp) return obj.toString();
  if (obj instanceof Promise) return 'Promise { <pending> }';
  if (level > depth) return Array.isArray(obj) ? '[Array]' : '[Object]';
  seen.add(obj);
  try {
    const inner = (v: unknown) => inspect(v, opts, seen, level + 1, true);
    const wrap = (open: string, items: string[], close: string, extra = 0) => {
      if (extra > 0) items.push(`... ${extra} more item${extra === 1 ? '' : 's'}`);
      if (!items.length) return `${open}${close}`;
      const one = `${open} ${items.join(', ')} ${close}`;
      if (one.length <= 72 && !one.includes('\n')) return one;
      const pad = '  '.repeat(level + 1);
      return `${open}\n${items.map((i) => pad + i).join(',\n')}\n${'  '.repeat(level)}${close}`;
    };
    if (Array.isArray(obj)) {
      const items = obj.slice(0, maxItems).map(inner);
      return wrap('[', items, ']', obj.length - items.length);
    }
    if (ArrayBuffer.isView(obj) && !(obj instanceof DataView)) {
      const arr = Array.from(obj as unknown as ArrayLike<number>);
      const items = arr.slice(0, maxItems).map(String);
      return `${obj.constructor.name}(${arr.length}) ` + wrap('[', items, ']', arr.length - items.length);
    }
    if (obj instanceof Map) {
      const items = [...obj].slice(0, maxItems).map(([k, v]) => `${inner(k)} => ${inner(v)}`);
      return `Map(${obj.size}) ` + wrap('{', items, '}', obj.size - items.length);
    }
    if (obj instanceof Set) {
      const items = [...obj].slice(0, maxItems).map(inner);
      return `Set(${obj.size}) ` + wrap('{', items, '}', obj.size - items.length);
    }
    const keys = Object.keys(obj);
    const items = keys.slice(0, maxItems).map((k) => {
      const key = /^[A-Za-z_$][\w$]*$/.test(k) ? k : `'${k}'`;
      return `${key}: ${inner((obj as Record<string, unknown>)[k])}`;
    });
    const ctor = Object.getPrototypeOf(obj)?.constructor?.name;
    const prefix = ctor && ctor !== 'Object' ? `${ctor} ` : Object.getPrototypeOf(obj) === null ? '[Object: null prototype] ' : '';
    return prefix + wrap('{', items, '}', keys.length - items.length);
  } finally {
    seen.delete(obj);
  }
}

/** console.log formatting: printf-style %s %d %i %f %o %O %j %c, then the rest separated by spaces. */
export function formatArgs(args: unknown[]): string {
  if (!args.length) return '';
  if (typeof args[0] === 'string' && /%[sdifoOjc%]/.test(args[0])) {
    let i = 1;
    const head = args[0].replace(/%([sdifoOjc%])/g, (m, f: string) => {
      if (f === '%') return '%';
      if (i >= args.length) return m;
      const a = args[i++];
      switch (f) {
        case 's':
          return typeof a === 'string' ? a : inspect(a, { depth: 1 }, new Set(), 0, true);
        case 'd':
        case 'i':
          return String(f === 'i' ? Math.trunc(Number(a)) : Number(a));
        case 'f':
          return String(Number(a));
        case 'j':
          try {
            return JSON.stringify(a);
          } catch {
            return '[Circular]';
          }
        case 'c':
          return '';
        default:
          return inspect(a, {}, new Set(), 0, true);
      }
    });
    return [head, ...args.slice(i).map((a) => inspect(a))].join(' ');
  }
  return args.map((a) => inspect(a)).join(' ');
}

/** console.table for arrays/objects of rows. */
export function formatTable(data: unknown): string {
  if (data === null || typeof data !== 'object') return formatArgs([data]);
  const rows = Object.entries(data as Record<string, unknown>);
  const cols: string[] = [];
  for (const [, row] of rows) {
    if (row && typeof row === 'object') for (const k of Object.keys(row)) if (!cols.includes(k)) cols.push(k);
  }
  const hasValues = rows.some(([, r]) => r === null || typeof r !== 'object');
  const header = ['(index)', ...cols, ...(hasValues ? ['Values'] : [])];
  const body = rows.map(([idx, r]) => {
    const cells = cols.map((c) => (r && typeof r === 'object' && c in r ? inspect((r as Record<string, unknown>)[c], { depth: 0 }, new Set(), 1, true) : ''));
    if (hasValues) cells.push(r === null || typeof r !== 'object' ? inspect(r, {}, new Set(), 1, true) : '');
    return [idx, ...cells];
  });
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((b) => b[i]!.length)));
  const line = (l: string, m: string, r: string) => l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r;
  const fmt = (cells: string[]) => '│' + cells.map((c, i) => ` ${c.padEnd(widths[i]!)} `).join('│') + '│';
  return [line('┌', '┬', '┐'), fmt(header), line('├', '┼', '┤'), ...body.map(fmt), line('└', '┴', '┘')].join('\n');
}

// ---------------------------------------------------------------------------------------------
// Minimal Node-like built-in modules over the project's files (in memory, per run).

export interface ProjectFS {
  read(path: string): string | Uint8Array | undefined;
  write(path: string, data: string | Uint8Array): void;
  list(): string[];
}

export function makeBuiltins(fs: ProjectFS, cwd = ''): Record<string, unknown> {
  const abs = (p: string) => {
    const s = String(p);
    return joinPath(s.startsWith('/') ? '' : cwd, s) ?? s;
  };
  const enoent = (p: string) => Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), { code: 'ENOENT' });
  const readFileSync = (p: string, enc?: string | { encoding?: string }) => {
    const data = fs.read(abs(p));
    if (data === undefined) throw enoent(p);
    const encoding = typeof enc === 'string' ? enc : enc?.encoding;
    if (typeof data === 'string') return encoding ? data : new TextEncoder().encode(data);
    return encoding ? new TextDecoder().decode(data) : data;
  };
  const writeFileSync = (p: string, data: string | Uint8Array) => fs.write(abs(p), typeof data === 'string' ? data : new Uint8Array(data));
  const existsSync = (p: string) => {
    const a = abs(p);
    return fs.read(a) !== undefined || fs.list().some((f) => f.startsWith(a + '/'));
  };
  const readdirSync = (p = '.') => {
    const a = abs(p);
    const prefix = a ? a + '/' : '';
    return [...new Set(fs.list().filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length).split('/')[0]!))].sort();
  };
  const fsModule = {
    readFileSync,
    writeFileSync,
    existsSync,
    readdirSync,
    appendFileSync: (p: string, data: string) => {
      const prev = fs.read(abs(p));
      writeFileSync(p, (typeof prev === 'string' ? prev : prev ? new TextDecoder().decode(prev) : '') + data);
    },
    promises: {
      readFile: async (p: string, enc?: string) => readFileSync(p, enc),
      writeFile: async (p: string, d: string | Uint8Array) => writeFileSync(p, d),
      readdir: async (p?: string) => readdirSync(p),
    },
  };
  const pathModule = {
    sep: '/',
    join: (...parts: string[]) => joinPath('', parts.filter(Boolean).join('/')) ?? '',
    resolve: (...parts: string[]) => '/' + (joinPath(cwd, parts.join('/')) ?? ''),
    dirname: (p: string) => dirOf(p) || '.',
    basename: (p: string, ext?: string) => {
      const b = p.split('/').pop() ?? '';
      return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b;
    },
    extname: (p: string) => {
      const b = p.split('/').pop() ?? '';
      const i = b.lastIndexOf('.');
      return i > 0 ? b.slice(i) : '';
    },
  };
  const utilModule = { inspect: (v: unknown, o?: InspectOptions) => inspect(v, o, new Set(), 0, true), format: (...a: unknown[]) => formatArgs(a) };
  class EventEmitter {
    private handlers = new Map<string, ((...a: unknown[]) => void)[]>();
    on(e: string, fn: (...a: unknown[]) => void) {
      this.handlers.set(e, [...(this.handlers.get(e) ?? []), fn]);
      return this;
    }
    once(e: string, fn: (...a: unknown[]) => void) {
      const w = (...a: unknown[]) => {
        this.off(e, w);
        fn(...a);
      };
      return this.on(e, w);
    }
    off(e: string, fn: (...a: unknown[]) => void) {
      this.handlers.set(e, (this.handlers.get(e) ?? []).filter((h) => h !== fn));
      return this;
    }
    emit(e: string, ...a: unknown[]) {
      const hs = this.handlers.get(e) ?? [];
      hs.forEach((h) => h(...a));
      return hs.length > 0;
    }
  }
  return {
    fs: fsModule,
    'node:fs': fsModule,
    'fs/promises': fsModule.promises,
    'node:fs/promises': fsModule.promises,
    path: pathModule,
    'node:path': pathModule,
    util: utilModule,
    'node:util': utilModule,
    events: EventEmitter,
    'node:events': EventEmitter,
  };
}
