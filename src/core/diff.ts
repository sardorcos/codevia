/**
 * Line diff (Myers' O(ND) algorithm) for history and source-control views.
 * Returns hunks of equal / added / removed lines; `context` collapses long unchanged regions.
 */
export type DiffLine = { kind: 'same' | 'add' | 'del'; text: string; oldNo?: number; newNo?: number };

export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const n = a.length;
  const m = b.length;
  // Fast paths for identical or completely new content.
  if (oldText === newText) return a.map((text, i) => ({ kind: 'same', text, oldNo: i + 1, newNo: i + 1 }));
  const max = n + m;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[max + k - 1]! < v[max + k + 1]!) ? v[max + k + 1]! : v[max + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[max + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
    // Very large, very different inputs: fall back to "all removed, all added".
    if (d > 4000) {
      return [...a.map((text, i): DiffLine => ({ kind: 'del', text, oldNo: i + 1 })), ...b.map((text, i): DiffLine => ({ kind: 'add', text, newNo: i + 1 }))];
    }
  }
  // Backtrack.
  const out: DiffLine[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const vd = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && vd[max + k - 1]! < vd[max + k + 1]!) ? k + 1 : k - 1;
    const prevX = vd[max + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      out.push({ kind: 'same', text: a[x - 1]!, oldNo: x, newNo: y });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) out.push({ kind: 'add', text: b[y - 1]!, newNo: y });
      else out.push({ kind: 'del', text: a[x - 1]!, oldNo: x });
    }
    x = prevX;
    y = prevY;
  }
  return out.reverse();
}

/** Keeps `context` unchanged lines around changes; longer unchanged runs become one `skip` marker. */
export function withContext(lines: DiffLine[], context = 3): (DiffLine | { kind: 'skip'; count: number })[] {
  const keep = new Uint8Array(lines.length);
  lines.forEach((l, i) => {
    if (l.kind !== 'same') for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) keep[j] = 1;
  });
  const out: (DiffLine | { kind: 'skip'; count: number })[] = [];
  let skipped = 0;
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (skipped) out.push({ kind: 'skip', count: skipped });
      skipped = 0;
      out.push(l);
    } else skipped++;
  });
  if (skipped) out.push({ kind: 'skip', count: skipped });
  return out;
}

export const diffStats = (lines: DiffLine[]) => ({
  added: lines.filter((l) => l.kind === 'add').length,
  removed: lines.filter((l) => l.kind === 'del').length,
});
