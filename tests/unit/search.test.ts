import { describe, expect, it } from 'vitest';
import { searchProject } from '../../src/core/search';
import { binaryFile, textFile } from '../../src/core/types';

describe('searchProject', () => {
  const files = {
    'a.js': textFile('const Button = 1;\nfunction click() {}\n// button again'),
    'b.css': textFile('.button { color: red }'),
    'img.png': binaryFile(new Uint8Array([98, 117, 116, 116, 111, 110])),
  };
  it('finds case-insensitive matches with line numbers, one per line, skipping binaries', () => {
    const { hits } = searchProject(files, 'button');
    expect(hits.map((h) => `${h.path}:${h.line}`)).toEqual(['a.js:1', 'a.js:3', 'b.css:1']);
    const h = hits[0]!;
    expect(h.snippet.slice(h.at, h.at + 6)).toBe('Button');
  });
  it('ignores 1-char queries and respects the limit', () => {
    expect(searchProject(files, 'b').hits).toEqual([]);
    const r = searchProject({ 'x.txt': textFile('ab\n'.repeat(100)) }, 'ab', 10);
    expect(r.hits.length).toBe(10);
    expect(r.truncated).toBe(true);
  });
});
