import { esc, icon } from '../../ui/dom';
import { t, fmtNumber } from '../../i18n';
import { onLongPress } from '../shared';
import { jsonPath, jsonType, searchJson, type JsonValue, type PathSegment, type SearchHit } from './format';
import '../tools.css';

/**
 * Collapsible JSON tree. Children are rendered only when a node is expanded, and containers with more
 * than `chunk` children are split into collapsed ranges ([0 … 99], [100 … 199] …), so an array of
 * 100 000 items costs a few hundred DOM nodes. Keyboard: ↑ ↓ move, → expands, ← collapses, Enter toggles.
 */

export interface JsonTreeOptions {
  /** Levels expanded initially (default 1: the root's children are visible). */
  expandDepth?: number;
  /** Children per range group (default 100). */
  chunk?: number;
  /** Accessible name of the tree. */
  label?: string;
  /** Copies text (default: navigator.clipboard). Used by the path bar and long-press. */
  copy?: (text: string, what: 'path' | 'value') => void;
  /** Called when the user selects a node. */
  onSelect?: (path: PathSegment[], value: JsonValue) => void;
  /** Shows the bar with the selected path and copy buttons (default true). */
  pathBar?: boolean;
}

export interface JsonTreeHandle {
  /** Highlights keys and values containing `query`, expands to them; returns the number of hits. */
  search(query: string): number;
  /** Moves to the next/previous hit; returns its 1-based index (0 without hits). */
  next(): number;
  prev(): number;
  expandAll(): void;
  collapseAll(): void;
  /** Replaces the value (keeps nothing of the old state). */
  setValue(value: JsonValue): void;
  destroy(): void;
}

interface Entry {
  path: PathSegment[];
  value: JsonValue;
  /** For range groups: the slice of children shown. */
  range?: [number, number];
}

const MAX_TEXT = 400;
const MAX_EXPAND_ALL = 3000;

const keyOf = (path: readonly PathSegment[]) => jsonPath(path);

function highlight(text: string, q: string, on: boolean): string {
  if (!on || !q) return esc(text);
  const lower = text.toLowerCase();
  let out = '';
  let from = 0;
  for (let i = lower.indexOf(q); i >= 0; i = lower.indexOf(q, i + q.length)) {
    out += esc(text.slice(from, i)) + `<mark>${esc(text.slice(i, i + q.length))}</mark>`;
    from = i + q.length;
  }
  return out + esc(text.slice(from));
}

const childCount = (v: JsonValue): number => (Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : 0);

export function renderJsonTree(container: HTMLElement, initial: JsonValue, opts: JsonTreeOptions = {}): JsonTreeHandle {
  const chunk = Math.max(10, opts.chunk ?? 100);
  const copy =
    opts.copy ??
    ((text: string) => {
      void navigator.clipboard?.writeText(text).catch(() => undefined);
    });
  let value = initial;
  let entries: Entry[] = [];
  let expanded = new Set<string>();
  let query = '';
  let hits: SearchHit[] = [];
  let hitIndex = new Map<string, SearchHit>();
  let current = -1;
  let selected: Entry | null = null;

  container.innerHTML = `<div class="tool-jt">
    <div class="tool-jt-tree" role="tree" aria-label="${esc(opts.label ?? t('Дерево JSON'))}"></div>
    ${
      opts.pathBar === false
        ? ''
        : `<div class="tool-jt-bar" hidden>
      <code class="tool-jt-path mono" aria-live="polite"></code>
      <button type="button" class="btn tiny secondary" data-jt="copy-path">${icon('copy', 'sm')}<span>${esc(t('Путь'))}</span></button>
      <button type="button" class="btn tiny secondary" data-jt="copy-value">${icon('copy', 'sm')}<span>${esc(t('Значение'))}</span></button>
    </div>`
    }
  </div>`;
  const tree = container.querySelector<HTMLElement>('.tool-jt-tree')!;
  const bar = container.querySelector<HTMLElement>('.tool-jt-bar');

  const initExpanded = () => {
    expanded = new Set();
    const depth = opts.expandDepth ?? 1;
    const walk = (v: JsonValue, path: PathSegment[], d: number) => {
      if (d >= depth || !v || typeof v !== 'object') return;
      expanded.add(keyOf(path));
      if (childCount(v) > chunk) return;
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, [...path, i], d + 1));
      else for (const k of Object.keys(v)) walk(v[k]!, [...path, k], d + 1);
    };
    walk(value, [], 0);
  };

  const rangeKey = (path: readonly PathSegment[], range: readonly [number, number]) => `${keyOf(path)}#${range[0]}-${range[1]}`;

  function childrenHtml(e: Entry, level: number): string {
    const v = e.value;
    const keys = Array.isArray(v) ? null : Object.keys(v as object);
    const total = keys ? keys.length : (v as JsonValue[]).length;
    const [from, to] = e.range ?? [0, total];
    const n = to - from;
    let html = '';
    if (n > chunk) {
      // Split into ranges; nested splitting keeps every level at most `chunk` wide.
      let size = chunk;
      while (n / size > chunk) size *= chunk;
      for (let s = from; s < to; s += size) {
        const end = Math.min(to, s + size);
        html += nodeHtml({ path: e.path, value: v, range: [s, end] }, level, null);
      }
      return html;
    }
    for (let i = from; i < to; i++) {
      const k: PathSegment = keys ? keys[i]! : i;
      const child = keys ? (v as Record<string, JsonValue>)[k as string]! : (v as JsonValue[])[i]!;
      html += nodeHtml({ path: [...e.path, k], value: child }, level, k);
    }
    return html;
  }

  function nodeHtml(e: Entry, level: number, key: PathSegment | null): string {
    const idx = entries.push(e) - 1;
    const isRange = !!e.range;
    const v = e.value;
    const type = jsonType(v);
    const isBox = isRange || type === 'object' || type === 'array';
    const k = isRange ? rangeKey(e.path, e.range!) : keyOf(e.path);
    const open = isBox && expanded.has(k);
    const hit = isRange ? undefined : hitIndex.get(k);
    let label: string;
    if (isRange) label = `<span class="tool-jt-range">[${e.range![0]} … ${e.range![1] - 1}]</span>`;
    else if (key !== null) {
      const name = typeof key === 'number' ? String(key) : key;
      label = `<span class="tool-jt-key ${typeof key === 'number' ? 'idx' : ''}">${highlight(name, query, !!hit?.inKey)}</span><span class="tool-jt-colon">:</span>`;
    } else label = `<span class="tool-jt-key root">$</span>`;
    let val = '';
    if (!isRange) {
      if (type === 'object' || type === 'array') {
        const c = childCount(v);
        const br = type === 'array' ? ['[', ']'] : ['{', '}'];
        val = `<span class="tool-jt-brace">${br[0]}</span><span class="tool-jt-count">${esc(fmtNumber(c))}</span><span class="tool-jt-brace">${br[1]}</span>`;
      } else {
        let text = type === 'string' ? JSON.stringify(v) : String(v);
        if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}…`;
        val = `<span class="tool-jt-v t-${type}">${highlight(text, query, !!hit?.inValue)}</span>`;
      }
    }
    const isCurrent = current >= 0 && hits[current] && !isRange && keyOf(hits[current]!.path) === k;
    return `<div class="tool-jt-node" role="treeitem" aria-level="${level}" ${isBox ? `aria-expanded="${open}"` : ''} data-i="${idx}" aria-selected="${selected === e}">
      <div class="tool-jt-row ${isCurrent ? 'current' : ''} ${hit ? 'hit' : ''}" tabindex="-1">
        <span class="tool-jt-tw" aria-hidden="true"></span>${label}${val}
      </div>${open ? `<div role="group" class="tool-jt-kids">${childrenHtml(e, level + 1)}</div>` : ''}</div>`;
  }

  function render() {
    entries = [];
    tree.innerHTML = nodeHtml({ path: [], value }, 1, null);
    const first = tree.querySelector<HTMLElement>('.tool-jt-row');
    if (first) first.tabIndex = 0;
  }

  const entryOf = (node: Element | null): Entry | null => {
    const i = node?.closest<HTMLElement>('.tool-jt-node')?.dataset.i;
    return i === undefined ? null : (entries[Number(i)] ?? null);
  };
  const entryKey = (e: Entry) => (e.range ? rangeKey(e.path, e.range) : keyOf(e.path));

  function rerender(node: HTMLElement) {
    const e = entryOf(node)!;
    const level = Number(node.getAttribute('aria-level'));
    const last = e.path[e.path.length - 1];
    const key = e.range ? null : e.path.length ? (last as PathSegment) : null;
    const wrap = document.createElement('div');
    wrap.innerHTML = nodeHtml(e, level, key);
    const fresh = wrap.firstElementChild as HTMLElement;
    node.replaceWith(fresh);
    return fresh;
  }

  function toggle(node: HTMLElement, open?: boolean) {
    if (!node.hasAttribute('aria-expanded')) return node;
    const e = entryOf(node)!;
    const k = entryKey(e);
    const want = open ?? !expanded.has(k);
    if (want === expanded.has(k)) return node;
    if (want) expanded.add(k);
    else expanded.delete(k);
    const fresh = rerender(node);
    focusRow(fresh.querySelector<HTMLElement>('.tool-jt-row')!);
    return fresh;
  }

  function select(node: HTMLElement) {
    const e = entryOf(node);
    if (!e || e.range) return;
    selected = e;
    tree.querySelectorAll('[aria-selected="true"]').forEach((n) => n.setAttribute('aria-selected', 'false'));
    node.setAttribute('aria-selected', 'true');
    if (bar) {
      bar.hidden = false;
      bar.querySelector('.tool-jt-path')!.textContent = jsonPath(e.path);
    }
    opts.onSelect?.(e.path, e.value);
  }

  const rows = () => [...tree.querySelectorAll<HTMLElement>('.tool-jt-row')];
  function focusRow(row: HTMLElement | undefined) {
    if (!row) return;
    tree.querySelectorAll<HTMLElement>('.tool-jt-row[tabindex="0"]').forEach((r) => (r.tabIndex = -1));
    row.tabIndex = 0;
    row.focus({ preventScroll: false });
  }

  const onClick = (ev: MouseEvent) => {
    const row = (ev.target as HTMLElement).closest<HTMLElement>('.tool-jt-row');
    if (!row) return;
    let node = row.parentElement!;
    if (node.hasAttribute('aria-expanded')) node = toggle(node);
    else focusRow(row);
    select(node);
  };

  const onKey = (ev: KeyboardEvent) => {
    const row = (ev.target as HTMLElement).closest<HTMLElement>('.tool-jt-row');
    if (!row) return;
    const node = row.parentElement!;
    const list = rows();
    const at = list.indexOf(row);
    const exp = node.getAttribute('aria-expanded');
    switch (ev.key) {
      case 'ArrowDown':
        focusRow(list[at + 1]);
        break;
      case 'ArrowUp':
        focusRow(list[at - 1]);
        break;
      case 'ArrowRight':
        if (exp === 'false') toggle(node, true);
        else if (exp === 'true') focusRow(list[at + 1]);
        break;
      case 'ArrowLeft':
        if (exp === 'true') toggle(node, false);
        else focusRow(node.parentElement?.closest('.tool-jt-node')?.querySelector<HTMLElement>('.tool-jt-row') ?? undefined);
        break;
      case 'Home':
        focusRow(list[0]);
        break;
      case 'End':
        focusRow(list[list.length - 1]);
        break;
      case 'Enter':
      case ' ':
        select(exp ? toggle(node) : node);
        break;
      default:
        return;
    }
    ev.preventDefault();
  };

  const onBar = (ev: MouseEvent) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-jt]');
    if (!b || !selected) return;
    if (b.dataset.jt === 'copy-path') copy(jsonPath(selected.path), 'path');
    else copy(typeof selected.value === 'string' ? selected.value : JSON.stringify(selected.value, null, 2), 'value');
  };

  tree.addEventListener('click', onClick);
  tree.addEventListener('keydown', onKey);
  bar?.addEventListener('click', onBar);
  const offLong = onLongPress(tree, '.tool-jt-row', (row) => {
    const e = entryOf(row);
    if (!e || e.range) return;
    select(row.parentElement!);
    copy(jsonPath(e.path), 'path');
  });

  /** Expands every ancestor (and range group) of `path`. */
  function reveal(path: readonly PathSegment[]) {
    let v: JsonValue = value;
    for (let d = 0; d < path.length; d++) {
      const prefix = path.slice(0, d);
      expanded.add(keyOf(prefix));
      const seg = path[d]!;
      const keys = Array.isArray(v) ? null : Object.keys(v as object);
      const idx = keys ? keys.indexOf(String(seg)) : Number(seg);
      const total = keys ? keys.length : (v as JsonValue[]).length;
      // Open the nested range groups that contain idx.
      let from = 0;
      let to = total;
      while (to - from > chunk) {
        let size = chunk;
        while ((to - from) / size > chunk) size *= chunk;
        const start = from + Math.floor((idx - from) / size) * size;
        const end = Math.min(to, start + size);
        expanded.add(rangeKey(prefix, [start, end]));
        from = start;
        to = end;
      }
      v = keys ? (v as Record<string, JsonValue>)[String(seg)]! : (v as JsonValue[])[idx]!;
    }
  }

  function goTo(i: number) {
    if (!hits.length) return 0;
    current = (i + hits.length) % hits.length;
    reveal(hits[current]!.path);
    render();
    const row = tree.querySelector<HTMLElement>('.tool-jt-row.current');
    if (row) {
      focusRow(row);
      row.scrollIntoView?.({ block: 'center' });
    }
    return current + 1;
  }

  initExpanded();
  render();

  return {
    search(q: string) {
      query = q.trim().toLowerCase();
      hits = query ? searchJson(value, query) : [];
      hitIndex = new Map(hits.map((h) => [keyOf(h.path), h]));
      current = -1;
      if (!hits.length) {
        render();
        return 0;
      }
      // Reveal a bounded number of hits up front; the rest open as you step to them.
      for (const h of hits.slice(0, 200)) reveal(h.path);
      goTo(0);
      return hits.length;
    },
    next: () => goTo(current + 1),
    prev: () => goTo(current - 1),
    expandAll() {
      let count = 0;
      const walk = (v: JsonValue, path: PathSegment[]) => {
        if (count > MAX_EXPAND_ALL || !v || typeof v !== 'object') return;
        if (childCount(v) > chunk) {
          expanded.add(keyOf(path));
          return;
        }
        expanded.add(keyOf(path));
        count++;
        if (Array.isArray(v)) v.forEach((x, i) => walk(x, [...path, i]));
        else for (const k of Object.keys(v)) walk(v[k]!, [...path, k]);
      };
      walk(value, []);
      render();
    },
    collapseAll() {
      expanded = new Set([keyOf([])]);
      render();
    },
    setValue(v: JsonValue) {
      value = v;
      query = '';
      hits = [];
      hitIndex = new Map();
      current = -1;
      selected = null;
      if (bar) bar.hidden = true;
      initExpanded();
      render();
    },
    destroy() {
      offLong();
      tree.removeEventListener('click', onClick);
      tree.removeEventListener('keydown', onKey);
      bar?.removeEventListener('click', onBar);
      container.innerHTML = '';
    },
  };
}
