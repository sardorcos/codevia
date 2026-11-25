// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderJsonTree } from '../../src/tools/json/tree';
import type { JsonValue } from '../../src/tools/json/format';

const host = () => {
  const el = document.createElement('div');
  document.body.append(el);
  return el;
};
const rows = (el: HTMLElement) => [...el.querySelectorAll('.tool-jt-row')];
const click = (el: Element) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));

afterEach(() => {
  document.body.innerHTML = '';
});

describe('renderJsonTree', () => {
  it('renders the root and its children with types and counts', () => {
    const el = host();
    renderJsonTree(el, { name: 'Ann', age: 30, ok: true, none: null, tags: ['a', 'b'] });
    expect(el.querySelector('[role="tree"]')).not.toBeNull();
    expect(rows(el)).toHaveLength(6);
    expect(el.querySelector('.t-string')!.textContent).toBe('"Ann"');
    expect(el.querySelector('.t-number')!.textContent).toBe('30');
    expect(el.querySelector('.t-boolean')!.textContent).toBe('true');
    expect(el.querySelector('.t-null')!.textContent).toBe('null');
    // `tags` is collapsed and shows its item count.
    const tags = [...el.querySelectorAll('.tool-jt-node')].find((n) => n.querySelector('.tool-jt-key')?.textContent === 'tags')!;
    expect(tags.getAttribute('aria-expanded')).toBe('false');
    expect(tags.querySelector('.tool-jt-count')!.textContent).toBe('2');
  });

  it('renders children lazily when a node is expanded, and copies its path', () => {
    const el = host();
    const copy = vi.fn();
    renderJsonTree(el, { a: { b: [1, 2, 3] } }, { copy });
    expect(el.textContent).not.toContain('b');
    const a = rows(el).find((r) => r.textContent?.includes('a:'))!;
    click(a);
    const b = rows(el).find((r) => r.querySelector('.tool-jt-key')?.textContent === 'b')!;
    expect(b).toBeDefined();
    click(b);
    expect(rows(el)).toHaveLength(6);
    click(rows(el)[4]!); // b[1]
    expect(el.querySelector('.tool-jt-path')!.textContent).toBe('$.a.b[1]');
    click(el.querySelector('[data-jt="copy-path"]')!);
    expect(copy).toHaveBeenCalledWith('$.a.b[1]', 'path');
    click(el.querySelector('[data-jt="copy-value"]')!);
    expect(copy).toHaveBeenCalledWith('2', 'value');
  });

  it('splits 100 000 items into collapsed ranges instead of rendering them all', () => {
    const el = host();
    const big = { items: Array.from({ length: 100_000 }, (_, i) => ({ id: i })) } as JsonValue;
    const t0 = performance.now();
    renderJsonTree(el, big, { expandDepth: 2 });
    expect(performance.now() - t0).toBeLessThan(1000);
    // root, items, and 10 ranges of 10 000 (each splits again when opened)
    expect(el.querySelectorAll('.tool-jt-range')).toHaveLength(10);
    expect(el.querySelectorAll('.tool-jt-node').length).toBeLessThan(20);
    click(el.querySelector('.tool-jt-range')!.closest('.tool-jt-row')!);
    expect(el.querySelectorAll('.tool-jt-range')).toHaveLength(110);
    expect(el.querySelectorAll('.tool-jt-node').length).toBeLessThan(200);
  });

  it('searches, highlights, reveals hits inside ranges and steps through them', () => {
    const el = host();
    const data = { list: Array.from({ length: 1000 }, (_, i) => (i === 777 ? 'needle' : `hay${i}`)), needleKey: 1 } as JsonValue;
    const tree = renderJsonTree(el, data);
    expect(tree.search('NEEDLE')).toBe(2);
    const current = el.querySelector('.tool-jt-row.current')!;
    expect(current.querySelector('mark')!.textContent).toBe('needle');
    expect(current.textContent).toContain('777');
    expect(tree.next()).toBe(2);
    expect(el.querySelector('.tool-jt-row.current')!.textContent).toContain('needleKey');
    expect(tree.next()).toBe(1);
    expect(tree.search('zzz')).toBe(0);
    expect(el.querySelectorAll('mark')).toHaveLength(0);
  });

  it('supports keyboard navigation', () => {
    const el = host();
    renderJsonTree(el, { a: { b: 1 }, c: 2 });
    const first = rows(el)[0] as HTMLElement;
    first.focus();
    const key = (k: string) => (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    key('ArrowDown');
    expect(document.activeElement!.textContent).toContain('a');
    key('ArrowRight');
    expect(document.activeElement!.closest('.tool-jt-node')!.getAttribute('aria-expanded')).toBe('true');
    key('ArrowDown');
    expect(document.activeElement!.textContent).toContain('b');
    key('ArrowLeft');
    expect(document.activeElement!.textContent).toContain('a');
  });

  it('expands and collapses everything, replaces the value and cleans up', () => {
    const el = host();
    const tree = renderJsonTree(el, { a: { b: { c: 1 } } }, { expandDepth: 0 });
    expect(rows(el)).toHaveLength(1);
    tree.expandAll();
    expect(rows(el)).toHaveLength(4);
    tree.collapseAll();
    expect(rows(el)).toHaveLength(2);
    tree.setValue([1, 2]);
    expect(el.querySelectorAll('.t-number')).toHaveLength(0); // expandDepth 0 again
    tree.destroy();
    expect(el.innerHTML).toBe('');
  });
});
