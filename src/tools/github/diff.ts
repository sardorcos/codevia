/**
 * A small line diff (Myers' O((N+M)·D) algorithm) for the changes and conflict views, plus helpers
 * that collapse long unchanged regions and pair lines for a side-by-side layout.
 */

export type DiffOp =
  | { type: 'equal'; text: string; a: number; b: number }
  | { type: 'del'; text: string; a: number }
  | { type: 'add'; text: string; b: number };

/** Collapsed run of unchanged lines (line numbers of its first line on both sides, 1-based). */
export interface DiffSkip {
  type: 'skip';
  count: number;
  a: number;
  b: number;
  /** The hidden lines, so the view can expand them. */
  ops: DiffOp[];
}

export type DiffRow = DiffOp | DiffSkip;

/** Splits text into lines; a final newline does not start an extra empty line. CRLF counts as LF. */
export function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Beyond this many edits Myers' search stops and the differing middle is shown as replaced. */
const DEFAULT_MAX_EDITS = 3000;

/**
 * Shortest edit script between `a` and `b` as `[kind, index]` steps (`e` equal, `d` delete from a,
 * `i` insert from b), or null when it needs more than `maxD` edits.
 */
function myers(a: readonly string[], b: readonly string[], maxD: number): Array<'e' | 'd' | 'i'> | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  const limit = Math.min(max, maxD);
  for (let d = 0; d <= limit; d++) {
    // State before step d, for k in [-d, d] (index k + d).
    trace.push(v.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, d, n, m);
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], dEnd: number, n: number, m: number): Array<'e' | 'd' | 'i'> {
  const out: Array<'e' | 'd' | 'i'> = [];
  let x = n;
  let y = m;
  for (let d = dEnd; d > 0; d--) {
    const V = trace[d]!;
    const at = (k: number) => V[k + d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      out.push('e');
      x--;
      y--;
    }
    out.push(x === prevX ? 'i' : 'd');
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    out.push('e');
    x--;
    y--;
  }
  return out.reverse();
}

/** Line diff of `oldText` → `newText`. Line numbers are 1-based. */
export function diffLines(oldText: string, newText: string, opts: { maxEdits?: number } = {}): DiffOp[] {
  return diffLineArrays(splitLines(oldText), splitLines(newText), opts);
}

export function diffLineArrays(a: readonly string[], b: readonly string[], opts: { maxEdits?: number } = {}): DiffOp[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const script = myers(midA, midB, opts.maxEdits ?? DEFAULT_MAX_EDITS) ?? [...midA.map(() => 'd' as const), ...midB.map(() => 'i' as const)];

  const ops: DiffOp[] = [];
  for (let i = 0; i < start; i++) ops.push({ type: 'equal', text: a[i]!, a: i + 1, b: i + 1 });
  let x = start;
  let y = start;
  for (const s of script) {
    if (s === 'e') {
      ops.push({ type: 'equal', text: a[x]!, a: x + 1, b: y + 1 });
      x++;
      y++;
    } else if (s === 'd') {
      ops.push({ type: 'del', text: a[x]!, a: x + 1 });
      x++;
    } else {
      ops.push({ type: 'add', text: b[y]!, b: y + 1 });
      y++;
    }
  }
  for (let i = endA; i < a.length; i++) ops.push({ type: 'equal', text: a[i]!, a: i + 1, b: i - endA + endB + 1 });
  return ops;
}

export function diffStats(ops: readonly DiffOp[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const o of ops) {
    if (o.type === 'add') added++;
    else if (o.type === 'del') removed++;
  }
  return { added, removed };
}

/**
 * Keeps `context` unchanged lines around each change and folds longer unchanged runs into one
 * `skip` row (a run shorter than `minSkip` hidden lines is shown as is).
 */
export function collapseUnchanged(ops: readonly DiffOp[], context = 3, minSkip = 2): DiffRow[] {
  const rows: DiffRow[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i]!.type !== 'equal') {
      rows.push(ops[i]!);
      i++;
      continue;
    }
    let j = i;
    while (j < ops.length && ops[j]!.type === 'equal') j++;
    const run = ops.slice(i, j);
    const keepBefore = i === 0 ? 0 : context;
    const keepAfter = j === ops.length ? 0 : context;
    const hidden = run.length - keepBefore - keepAfter;
    if (hidden >= minSkip) {
      rows.push(...run.slice(0, keepBefore));
      const skipped = run.slice(keepBefore, run.length - keepAfter);
      const first = skipped[0] as Extract<DiffOp, { type: 'equal' }>;
      rows.push({ type: 'skip', count: skipped.length, a: first.a, b: first.b, ops: skipped });
      rows.push(...run.slice(run.length - keepAfter));
    } else {
      rows.push(...run);
    }
    i = j;
  }
  return rows;
}

export interface SideRow {
  left?: Extract<DiffOp, { type: 'equal' | 'del' }>;
  right?: Extract<DiffOp, { type: 'equal' | 'add' }>;
  skip?: DiffSkip;
}

/** Pairs deletions with the additions that follow them, for a two-column view. */
export function sideBySide(rows: readonly DiffRow[]): SideRow[] {
  const out: SideRow[] = [];
  let i = 0;
  while (i < rows.length) {
    const r = rows[i]!;
    if (r.type === 'skip') {
      out.push({ skip: r });
      i++;
    } else if (r.type === 'equal') {
      out.push({ left: r, right: r });
      i++;
    } else {
      const dels: Array<Extract<DiffOp, { type: 'del' }>> = [];
      const adds: Array<Extract<DiffOp, { type: 'add' }>> = [];
      while (i < rows.length && rows[i]!.type === 'del') dels.push(rows[i++] as Extract<DiffOp, { type: 'del' }>);
      while (i < rows.length && rows[i]!.type === 'add') adds.push(rows[i++] as Extract<DiffOp, { type: 'add' }>);
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
        const row: SideRow = {};
        if (dels[k]) row.left = dels[k];
        if (adds[k]) row.right = adds[k];
        out.push(row);
      }
    }
  }
  return out;
}
