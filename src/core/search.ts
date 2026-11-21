import type { Files } from './types';

export interface SearchHit {
  path: string;
  line: number;
  /** Line text trimmed around the match. */
  snippet: string;
  /** Match offset inside `snippet`. */
  at: number;
}

/** Case-insensitive search through text files. Bounded so typing stays responsive on big projects. */
export function searchProject(files: Files, query: string, limit = 60, maxBytes = 8 * 1024 * 1024): { hits: SearchHit[]; truncated: boolean } {
  const q = query.toLowerCase();
  const hits: SearchHit[] = [];
  if (q.length < 2) return { hits, truncated: false };
  let scanned = 0;
  for (const path of Object.keys(files).sort()) {
    const f = files[path]!;
    if (!f.text) continue;
    scanned += f.content.length;
    if (scanned > maxBytes) return { hits, truncated: true };
    const lower = f.content.toLowerCase();
    for (let idx = lower.indexOf(q); idx >= 0; ) {
      const lineStart = f.content.lastIndexOf('\n', idx - 1) + 1;
      let lineEnd = f.content.indexOf('\n', idx);
      if (lineEnd < 0) lineEnd = f.content.length;
      const line = f.content.slice(0, lineStart).split('\n').length;
      const raw = f.content.slice(lineStart, lineEnd);
      const col = idx - lineStart;
      const start = Math.max(0, col - 40);
      const lead = raw.slice(start, col).replace(/^\s+/, '');
      const snippet = (start > 0 ? '…' : '') + lead + raw.slice(col, Math.min(raw.length, col + 80));
      hits.push({ path, line, snippet, at: (start > 0 ? 1 : 0) + lead.length });
      if (hits.length >= limit) return { hits, truncated: true };
      idx = lower.indexOf(q, lineEnd + 1); // one hit per line
    }
  }
  return { hits, truncated: false };
}
