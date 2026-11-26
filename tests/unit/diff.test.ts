import { describe, expect, it } from 'vitest';
import { diffLines, diffStats, withContext } from '../../src/core/diff';

const apply = (lines: ReturnType<typeof diffLines>) => ({
  old: lines.filter((l) => l.kind !== 'add').map((l) => l.text).join('\n'),
  new: lines.filter((l) => l.kind !== 'del').map((l) => l.text).join('\n'),
});

describe('diffLines', () => {
  it('reconstructs both sides and finds minimal edits', () => {
    const a = 'a\nb\nc\nd\ne';
    const b = 'a\nB\nc\nd\ne\nf';
    const d = diffLines(a, b);
    expect(apply(d)).toEqual({ old: a, new: b });
    expect(diffStats(d)).toEqual({ added: 2, removed: 1 });
  });

  it('handles empty sides and identical text', () => {
    expect(diffStats(diffLines('', 'x\ny'))).toEqual({ added: 2, removed: 1 });
    expect(diffLines('same\ntext', 'same\ntext').every((l) => l.kind === 'same')).toBe(true);
  });

  it('numbers old and new lines', () => {
    const d = diffLines('one\ntwo', 'zero\none\ntwo');
    expect(d[0]).toEqual({ kind: 'add', text: 'zero', newNo: 1 });
    expect(d[1]).toEqual({ kind: 'same', text: 'one', oldNo: 1, newNo: 2 });
  });

  it('is correct on random edits', () => {
    for (let round = 0; round < 50; round++) {
      const base = Array.from({ length: 40 }, (_, i) => `line ${i % 7}`);
      const next = base.filter(() => Math.random() > 0.2).map((l) => (Math.random() > 0.9 ? l + '!' : l));
      const d = diffLines(base.join('\n'), next.join('\n'));
      expect(apply(d)).toEqual({ old: base.join('\n'), new: next.join('\n') });
    }
  });

  it('collapses unchanged regions', () => {
    const a = Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n');
    const b = a.replace('l15', 'X');
    const c = withContext(diffLines(a, b), 2);
    expect(c[0]).toEqual({ kind: 'skip', count: 13 });
    expect(c.at(-1)).toEqual({ kind: 'skip', count: 12 });
  });
});
