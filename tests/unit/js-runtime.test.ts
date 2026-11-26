import { describe, expect, it } from 'vitest';
import { compileModule, formatArgs, formatTable, inspect, joinPath, makeBuiltins, resolveModule } from '../../src/runtime/js-core';
import { OutputBatcher } from '../../src/runtime/protocol';

describe('module resolution', () => {
  const files = new Set(['main.js', 'lib/util.ts', 'lib/index.js', 'data.json', 'app/helpers.mjs']);
  const exists = (p: string) => files.has(p);

  it('resolves relative paths with and without extensions', () => {
    expect(resolveModule('main.js', './lib/util', exists)).toBe('lib/util.ts');
    expect(resolveModule('main.js', './lib', exists)).toBe('lib/index.js');
    expect(resolveModule('main.js', './data.json', exists)).toBe('data.json');
    expect(resolveModule('lib/util.ts', '../main', exists)).toBe('main.js');
    expect(resolveModule('main.js', './app/helpers.mjs', exists)).toBe('app/helpers.mjs');
  });

  it('maps .js specifiers to TypeScript sources', () => {
    expect(resolveModule('main.js', './lib/util.js', exists)).toBe('lib/util.ts');
  });

  it('rejects bare specifiers and paths escaping the project', () => {
    expect(resolveModule('main.js', 'lodash', exists)).toBeNull();
    expect(resolveModule('main.js', '../../etc/passwd', exists)).toBeNull();
    expect(joinPath('', '../x')).toBeNull();
  });
});

describe('compileModule', () => {
  it('turns ES modules and TypeScript into CommonJS', () => {
    const code = compileModule('a.ts', "import { x } from './b';\nexport const y: number = x + 1;\n");
    expect(code).toContain("require('./b')");
    expect(code).not.toContain(': number');
    expect(code).toContain('exports.y');
  });

  it('keeps line numbers', () => {
    const src = "const a = 1;\nexport function f(n: number): number {\n  return n * 2;\n}\n";
    expect(compileModule('a.ts', src).split('\n').length).toBe(src.split('\n').length);
  });

  it('compiles JSX only for .jsx/.tsx', () => {
    expect(compileModule('c.jsx', 'const e = <b>hi</b>;')).toContain('React.createElement');
  });

  it('reports syntax errors', () => {
    expect(() => compileModule('bad.js', 'const = 1;')).toThrow();
  });
});

describe('inspect / formatArgs', () => {
  it('formats like Node for common values', () => {
    expect(formatArgs(['hello', 42, true, null, undefined])).toBe('hello 42 true null undefined');
    expect(inspect({ a: 1, b: 'x', c: [1, 2] })).toBe("{ a: 1, b: 'x', c: [ 1, 2 ] }");
    expect(inspect(new Map([['k', 1]]))).toBe("Map(1) { 'k' => 1 }");
    expect(inspect(new Set([1]))).toBe('Set(1) { 1 }');
    expect(inspect([])).toBe('[]');
    expect(inspect(function named() {})).toBe('[Function: named]');
    expect(inspect(10n)).toBe('10n');
  });

  it('handles circular structures and depth', () => {
    const o: Record<string, unknown> = { name: 'loop' };
    o.self = o;
    expect(inspect(o)).toContain('[Circular *]');
    expect(inspect({ a: { b: { c: { d: { e: 1 } } } } })).toContain('[Object]');
  });

  it('supports printf placeholders', () => {
    expect(formatArgs(['%s is %d years', 'Ann', 30])).toBe('Ann is 30 years');
    expect(formatArgs(['%j', { a: 1 }])).toBe('{"a":1}');
    expect(formatArgs(['100%%'])).toBe('100%');
  });

  it('prints class instances with their name', () => {
    class Point {
      constructor(
        public x: number,
        public y: number,
      ) {}
    }
    expect(inspect(new Point(1, 2))).toBe('Point { x: 1, y: 2 }');
  });

  it('draws console.table', () => {
    const t = formatTable([{ a: 1, b: 2 }, { a: 3 }]);
    expect(t).toContain('(index)');
    expect(t.split('\n')).toHaveLength(6);
  });
});

describe('built-in fs and path', () => {
  it('reads and writes project files in memory', () => {
    const store = new Map<string, string | Uint8Array>([['data/a.txt', 'hi']]);
    const b = makeBuiltins({ read: (p) => store.get(p), write: (p, d) => store.set(p, d), list: () => [...store.keys()] }) as {
      fs: { readFileSync(p: string, e?: string): unknown; writeFileSync(p: string, d: string): void; existsSync(p: string): boolean; readdirSync(p?: string): string[] };
      path: { join(...p: string[]): string; extname(p: string): string; basename(p: string, e?: string): string };
    };
    expect(b.fs.readFileSync('data/a.txt', 'utf8')).toBe('hi');
    b.fs.writeFileSync('out.txt', 'ok');
    expect(store.get('out.txt')).toBe('ok');
    expect(b.fs.existsSync('data')).toBe(true);
    expect(b.fs.readdirSync('.')).toEqual(['data', 'out.txt']);
    expect(() => b.fs.readFileSync('nope.txt')).toThrow(/ENOENT/);
    expect(b.path.join('a', '../b', 'c.js')).toBe('b/c.js');
    expect(b.path.extname('x/y.tar.gz')).toBe('.gz');
    expect(b.path.basename('x/y.ts', '.ts')).toBe('y');
  });
});

describe('OutputBatcher', () => {
  it('batches by size and age and flushes on demand', () => {
    const sent: string[] = [];
    let t = 0;
    const b = new OutputBatcher((s) => sent.push(s), 10, 50, () => t);
    b.write('abc');
    b.write('def');
    expect(sent).toEqual([]);
    b.write('ghij');
    expect(sent).toEqual(['abcdefghij']);
    b.write('x');
    t = 60;
    b.write('y');
    expect(sent).toEqual(['abcdefghij', 'xy']);
    b.write('z');
    b.flush();
    expect(sent).toEqual(['abcdefghij', 'xy', 'z']);
  });

  it('turns 100k small writes into a few hundred messages', () => {
    let messages = 0;
    const b = new OutputBatcher(() => messages++, 4096, 1e9, () => 0);
    for (let i = 0; i < 100_000; i++) b.write(`${i}\n`);
    b.flush();
    expect(messages).toBeLessThan(200);
  });
});
