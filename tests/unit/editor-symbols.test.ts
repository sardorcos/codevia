import { describe, expect, it } from 'vitest';
import { textFile } from '../../src/core/types';
import type { Files } from '../../src/core/types';
import { buildSymbolIndex, findDefinitions, findReferences, listSymbols, updateSymbolIndex } from '../../src/editor/symbols';

const files = (o: Record<string, string>): Files => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, textFile(v)]));

const project = files({
  'src/main.js': `import { formatPrice } from './util.js';
import Cart from './cart';

const TAX = 0.2;
let total = 0;
export function render(items) {
  return items.map((i) => formatPrice(i.price));
}
const onClick = (e) => render([]);
class Widget {
  constructor() {}
  update(state) {
    if (state) {
      return 1;
    }
  }
}
`,
  'src/util.js': `export function formatPrice(n) {
  return n.toFixed(2);
}
export const round = (n) => Math.round(n);
`,
  'src/cart.ts': `export interface Item { price: number }
export type Id = string;
export default class Cart {
  private items: Item[] = [];
  add(item: Item): void {
    this.items.push(item);
  }
}
`,
  'lib/other.js': `function formatPrice(x) { return String(x); }
`,
  'app.py': `import helpers
from models import User

LIMIT = 10

def main():
    pass

class Shop:
    def buy(self, item):
        return helpers.total(item)
`,
  'helpers.py': `def total(item):
    return item
`,
  'models/__init__.py': `class User:
    pass
`,
  'index.php': `<?php
require 'lib.php';
function greet($name) {
    return "Hi $name";
}
class Page {
    public function render() {}
}
?>
<div id="app"></div>
`,
  'lib.php': `<?php
function helper() {}
`,
  'style.css': `:root { --accent: #40c8f6; }
.card, .card:hover > h2 { color: var(--accent); }
#main .btn-primary { margin: 0; }
@media (max-width: 600px) { .card { padding: 0; } }
`,
  'index.html': `<!doctype html>
<link rel="stylesheet" href="style.css">
<main id="main"><div class="card">x</div></main>
<script src="src/main.js"></script>
<style>.local { color: red; }</style>
`,
  'logo.png': '',
});
project['logo.png'] = { text: false, data: new Uint8Array([1, 2, 3]) };

const names = (path: string) => listSymbols(buildSymbolIndex(project), path).map((s) => `${s.kind}:${s.name}`);

describe('symbol index', () => {
  it('indexes JavaScript and TypeScript definitions', () => {
    expect(names('src/main.js')).toEqual([
      'variable:TAX',
      'variable:total',
      'function:render',
      'function:onClick',
      'class:Widget',
      'method:update',
    ]);
    expect(names('src/util.js')).toEqual(['function:formatPrice', 'function:round']);
    expect(names('src/cart.ts')).toEqual(['interface:Item', 'type:Id', 'class:Cart', 'method:add']);
    const render = listSymbols(buildSymbolIndex(project), 'src/main.js').find((s) => s.name === 'render')!;
    expect(render).toMatchObject({ line: 6, column: 16, exported: true, label: 'function render()' });
  });

  it('indexes Python, PHP, CSS and HTML', () => {
    expect(names('app.py')).toEqual(['variable:LIMIT', 'function:main', 'class:Shop', 'method:buy']);
    expect(names('index.php')).toEqual(['function:greet', 'class:Page', 'method:render', 'id:app']);
    expect(names('style.css')).toEqual([
      'css-variable:--accent',
      'selector:card',
      'selector:card',
      'selector:main',
      'selector:btn-primary',
      'selector:card',
    ]);
    expect(names('index.html')).toEqual(['id:main', 'selector:local']);
    const s = listSymbols(buildSymbolIndex(project), 'style.css');
    expect(s[1]).toMatchObject({ label: '.card', line: 2, column: 1 });
  });

  it('skips binary and unsupported files', () => {
    const index = buildSymbolIndex(project);
    expect(index.files.has('logo.png')).toBe(false);
    expect(listSymbols(index).length).toBeGreaterThan(20);
  });

  it('rebuilds only changed files', () => {
    const first = buildSymbolIndex(project);
    expect(first.rebuilt.length).toBe(first.files.size);
    const edited = { ...project, 'src/util.js': textFile('export function formatPrice(n) {}\nexport function extra() {}\n') };
    const second = buildSymbolIndex(edited, first);
    expect(second.rebuilt).toEqual(['src/util.js']);
    expect(second.files.get('src/main.js')).toBe(first.files.get('src/main.js'));
    expect(listSymbols(second, 'src/util.js').map((s) => s.name)).toEqual(['formatPrice', 'extra']);

    const third = updateSymbolIndex(second, 'src/new.js', 'export class Fresh {}');
    expect(listSymbols(third, 'src/new.js').map((s) => s.name)).toEqual(['Fresh']);
    expect(second.files.has('src/new.js')).toBe(false);
    expect(updateSymbolIndex(third, 'src/new.js', null).files.has('src/new.js')).toBe(false);
  });

  it('ranks definitions: same file, then imported files, then the rest', () => {
    const index = buildSymbolIndex(project);
    const fp = findDefinitions(index, 'formatPrice', 'src/main.js');
    expect(fp.map((d) => d.path)).toEqual(['src/util.js', 'lib/other.js']);
    expect(findDefinitions(index, 'formatPrice', 'lib/other.js')[0]!.path).toBe('lib/other.js');
    expect(findDefinitions(index, 'Cart', 'src/main.js')[0]).toMatchObject({ path: 'src/cart.ts', kind: 'class', line: 3 });
    expect(findDefinitions(index, 'render', 'src/main.js')[0]!.path).toBe('src/main.js');
    expect(findDefinitions(index, 'total', 'app.py')[0]).toMatchObject({ path: 'helpers.py', kind: 'function' });
    expect(findDefinitions(index, 'User', 'app.py')[0]!.path).toBe('models/__init__.py');
    expect(findDefinitions(index, 'helper', 'index.php')[0]!.path).toBe('lib.php');
    // HTML → CSS through <link>, and class / id names.
    expect(findDefinitions(index, 'card', 'index.html')[0]).toMatchObject({ path: 'style.css', kind: 'selector' });
    expect(findDefinitions(index, '--accent', 'style.css')[0]).toMatchObject({ kind: 'css-variable', line: 1 });
    // index.html loads src/main.js (ranked before unrelated files), then app.py, style.css by path.
    expect(findDefinitions(index, 'main', 'src/main.js').map((d) => `${d.kind}:${d.path}`)).toEqual(['id:index.html', 'function:app.py', 'selector:style.css']);
    expect(findDefinitions(index, 'nothing', 'src/main.js')).toEqual([]);
  });

  it('finds all references with line and preview', () => {
    const refs = findReferences(project, 'formatPrice', { fromPath: 'src/util.js' });
    expect(refs[0]).toEqual({ path: 'src/util.js', line: 1, column: 16, preview: 'export function formatPrice(n) {' });
    expect(refs.map((r) => `${r.path}:${r.line}`)).toEqual(['src/util.js:1', 'lib/other.js:1', 'src/main.js:1', 'src/main.js:7']);
    // Whole words only; CSS names with dashes.
    expect(findReferences(project, 'card').map((r) => r.path)).toEqual(['index.html', 'style.css', 'style.css', 'style.css']);
    expect(findReferences(project, '--accent').length).toBe(2);
    expect(findReferences(project, 'item', { limit: 2 }).length).toBe(2);
    expect(findReferences(project, 'a b')).toEqual([]);
  });
});
