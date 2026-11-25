import { describe, expect, it } from 'vitest';
import { collapseUnchanged, diffLineArrays, diffLines, diffStats, sideBySide, splitLines, type DiffOp } from '../../src/tools/github/diff';

/** Rebuilds both sides from the ops. */
function sides(ops: DiffOp[]): { a: string[]; b: string[] } {
  const a: string[] = [];
  const b: string[] = [];
  for (const o of ops) {
    if (o.type !== 'add') a.push(o.text);
    if (o.type !== 'del') b.push(o.text);
  }
  return { a, b };
}

/** LCS length by dynamic programming (reference for minimality). */
function lcs(a: string[], b: string[]): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
  return dp[a.length]![b.length]!;
}

function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

describe('splitLines', () => {
  it('ignores the final newline and treats CRLF as LF', () => {
    expect(splitLines('')).toEqual([]);
    expect(splitLines('a')).toEqual(['a']);
    expect(splitLines('a\n')).toEqual(['a']);
    expect(splitLines('a\r\nb\r\n')).toEqual(['a', 'b']);
    expect(splitLines('a\n\n')).toEqual(['a', '']);
  });
});

describe('diffLines', () => {
  it('finds a minimal edit for simple cases, with line numbers', () => {
    expect(diffLines('a\nb\nc\n', 'a\nB\nc\n')).toEqual([
      { type: 'equal', text: 'a', a: 1, b: 1 },
      { type: 'del', text: 'b', a: 2 },
      { type: 'add', text: 'B', b: 2 },
      { type: 'equal', text: 'c', a: 3, b: 3 },
    ]);
    expect(diffLines('', 'x\ny')).toEqual([
      { type: 'add', text: 'x', b: 1 },
      { type: 'add', text: 'y', b: 2 },
    ]);
    expect(diffLines('x\ny', '')).toEqual([
      { type: 'del', text: 'x', a: 1 },
      { type: 'del', text: 'y', a: 2 },
    ]);
    expect(diffLines('same\n', 'same\n')).toEqual([{ type: 'equal', text: 'same', a: 1, b: 1 }]);
    expect(diffLines('', '')).toEqual([]);
  });

  it('classic Myers example: ABCABBA → CBABAC has 5 edits', () => {
    const ops = diffLineArrays([...'ABCABBA'], [...'CBABAC']);
    expect(diffStats(ops)).toEqual({ added: 2, removed: 3 });
    expect(sides(ops)).toEqual({ a: [...'ABCABBA'], b: [...'CBABAC'] });
  });

  it('is correct and minimal on random inputs', () => {
    const r = rng(42);
    for (let round = 0; round < 300; round++) {
      const alphabet = 'abcde'.slice(0, 1 + Math.floor(r() * 5));
      const gen = () => Array.from({ length: Math.floor(r() * 14) }, () => alphabet[Math.floor(r() * alphabet.length)]!);
      const a = gen();
      const b = gen();
      const ops = diffLineArrays(a, b);
      expect(sides(ops)).toEqual({ a, b });
      const { added, removed } = diffStats(ops);
      const common = lcs(a, b);
      expect(added, `${a.join('')} → ${b.join('')}`).toBe(b.length - common);
      expect(removed).toBe(a.length - common);
      // line numbers count up on each side
      let na = 0;
      let nb = 0;
      for (const o of ops) {
        if (o.type !== 'add') expect(o.a).toBe(++na);
        if (o.type !== 'del') expect(o.b).toBe(++nb);
      }
    }
  });

  it('falls back to a replace block beyond the edit limit, still correct', () => {
    const a = Array.from({ length: 50 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 50 }, (_, i) => `b${i}`);
    const ops = diffLineArrays(['top', ...a, 'end'], ['top', ...b, 'end'], { maxEdits: 10 });
    expect(sides(ops)).toEqual({ a: ['top', ...a, 'end'], b: ['top', ...b, 'end'] });
    expect(ops[0]).toMatchObject({ type: 'equal', text: 'top' });
    expect(ops[ops.length - 1]).toMatchObject({ type: 'equal', text: 'end', a: 52, b: 52 });
  });

  it('handles a large file with a few changes quickly', () => {
    const a = Array.from({ length: 20000 }, (_, i) => `line ${i}`);
    const b = [...a];
    b[100] = 'changed';
    b.splice(15000, 1);
    b.push('tail');
    const t0 = Date.now();
    const ops = diffLineArrays(a, b);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(diffStats(ops)).toEqual({ added: 2, removed: 2 });
  });
});

describe('collapseUnchanged', () => {
  const file = (n: number) => Array.from({ length: n }, (_, i) => `l${i + 1}`).join('\n');

  it('keeps context around changes and folds the rest', () => {
    const before = file(30);
    const after = before.replace('l15', 'L15');
    const rows = collapseUnchanged(diffLines(before, after), 3);
    expect(rows.map((r) => (r.type === 'skip' ? `skip${r.count}@${r.a}` : r.type))).toEqual([
      'skip11@1',
      'equal',
      'equal',
      'equal',
      'del',
      'add',
      'equal',
      'equal',
      'equal',
      'skip12@19',
    ]);
    const skip = rows[0]!;
    expect(skip.type === 'skip' && skip.ops.map((o) => o.text)).toEqual(Array.from({ length: 11 }, (_, i) => `l${i + 1}`));
  });

  it('does not fold short runs, and folds an unchanged file into one row', () => {
    const rows = collapseUnchanged(diffLines('a\nb\nc\nd\ne\nf\ng\nh\n', 'a\nb\nc\nd\nE\nf\ng\nh\n'), 3, 2);
    // Only "a" would be hidden before the change: a single line is shown rather than folded.
    expect(rows.some((r) => r.type === 'skip')).toBe(false);
    const rows2 = collapseUnchanged(diffLines('a\nb\nX\nd\ne', 'a\nb\nY\nd\ne'), 3);
    expect(rows2.every((r) => r.type !== 'skip')).toBe(true);
    const same = collapseUnchanged(diffLines(file(10), file(10)), 3);
    expect(same).toEqual([expect.objectContaining({ type: 'skip', count: 10 })]);
  });
});

describe('sideBySide', () => {
  it('pairs deletions with following additions', () => {
    const rows = sideBySide(collapseUnchanged(diffLines('a\nb\nc\nd', 'a\nB\nC\nX\nd'), 3));
    expect(rows.map((r) => [r.left?.text ?? null, r.right?.text ?? null])).toEqual([
      ['a', 'a'],
      ['b', 'B'],
      ['c', 'C'],
      [null, 'X'],
      ['d', 'd'],
    ]);
    const onlyAdds = sideBySide(diffLines('', 'n'));
    expect(onlyAdds).toEqual([{ right: { type: 'add', text: 'n', b: 1 } }]);
  });
});
