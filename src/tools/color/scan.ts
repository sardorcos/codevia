import type { Files } from '../../core/types';
import { textFile } from '../../core/types';
import { extOf } from '../../core/paths';
import { NAMED_COLORS, formatLike, parseColor, roundRgba, sameColor, toHex, type RGBA } from './convert';

/**
 * Finds colours written in CSS, HTML and SVG source and replaces them. Only places where a colour can
 * actually be (declaration values, <style> blocks, style="" and presentation attributes such as fill="")
 * are looked at, so `#header` selectors, `href="#top"` anchors and `&#123;` entities are not colours.
 */

export type SourceKind = 'css' | 'html' | 'svg';

export interface ColorToken {
  start: number;
  end: number;
  raw: string;
  rgba: RGBA;
}

export function sourceKind(path: string): SourceKind | null {
  const ext = extOf(path);
  if (['css', 'scss', 'sass', 'less'].includes(ext)) return 'css';
  if (['html', 'htm', 'vue', 'svelte', 'php'].includes(ext)) return 'html';
  if (ext === 'svg') return 'svg';
  return null;
}

/** Copy of `css` where comments, strings and url(...) contents are blanked (same length, so offsets hold). */
function maskCss(css: string): string {
  const out = css.split('');
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < css.length) {
    const c = css[i];
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      const stop = end < 0 ? css.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== c && css[j] !== '\n') j += css[j] === '\\' ? 2 : 1;
      blank(i, Math.min(css.length, j + 1));
      i = j + 1;
    } else if ((c === 'u' || c === 'U') && /^url\(/i.test(css.slice(i, i + 4))) {
      const end = css.indexOf(')', i + 4);
      const stop = end < 0 ? css.length : end;
      blank(i + 4, stop);
      i = stop + 1;
    } else i++;
  }
  return out.join('');
}

/** Properties where a bare word may be a named colour (elsewhere `red` could be a font or an animation name). */
const COLOR_PROP = /^(--.*|color|background(-color)?|border(-(top|right|bottom|left|block|inline)(-(start|end))?)?(-color)?|outline(-color)?|fill|stroke|(box|text)-shadow|caret-color|accent-color|column-rule(-color)?|text-decoration(-color)?|text-emphasis(-color)?|stop-color|flood-color|lighting-color|scrollbar-color)$/i;

const TOKEN = /#[0-9a-fA-F]{3,8}|\b(?:rgba?|hsla?)\([^()]*\)|[a-zA-Z]+/g;

function tokensInValue(text: string, masked: string, from: number, to: number, prop: string, out: ColorToken[]): void {
  const value = masked.slice(from, to);
  const namesOk = COLOR_PROP.test(prop.trim());
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(value); m; m = TOKEN.exec(value)) {
    const raw = m[0];
    const before = value[m.index - 1] ?? '';
    const after = value[m.index + raw.length] ?? '';
    const word = /[\w-]/;
    if (raw.startsWith('#')) {
      if (word.test(after) || ![4, 5, 7, 9].includes(raw.length)) continue;
    } else if (raw.endsWith(')')) {
      if (word.test(before)) continue;
    } else if (!namesOk || word.test(before) || word.test(after) || after === '(' || !Object.prototype.hasOwnProperty.call(NAMED_COLORS, raw.toLowerCase())) continue;
    const rgba = parseColor(raw);
    if (!rgba) continue;
    const start = from + m.index;
    out.push({ start, end: start + raw.length, raw: text.slice(start, start + raw.length), rgba });
  }
}

/** Scans CSS (a stylesheet, or a declaration list when `declarations` is true); offsets are relative to `src`. */
function scanCss(src: string, declarations: boolean, out: ColorToken[]): void {
  const masked = maskCss(src);
  let segStart = 0;
  let depth = declarations ? 1 : 0;
  const flush = (end: number) => {
    if (depth <= 0) return;
    const seg = masked.slice(segStart, end);
    const colon = seg.indexOf(':');
    if (colon > 0) tokensInValue(src, masked, segStart + colon + 1, end, seg.slice(0, colon), out);
  };
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === '{') {
      depth++;
      segStart = i + 1;
    } else if (c === ';' || c === '}') {
      flush(i);
      if (c === '}') depth = Math.max(0, depth - 1);
      segStart = i + 1;
    }
  }
  flush(masked.length);
}

function scanCssAt(text: string, base: number, length: number, declarations: boolean, out: ColorToken[]): void {
  const local: ColorToken[] = [];
  scanCss(text.slice(base, base + length), declarations, local);
  for (const tok of local) out.push({ ...tok, start: tok.start + base, end: tok.end + base });
}

const PRESENTATION = /\s(fill|stroke|stop-color|flood-color|lighting-color|color|bgcolor)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const STYLE_ATTR = /\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const STYLE_TAG = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;

/** All colour tokens of a source file, in order. */
export function findColorTokens(text: string, kind: SourceKind): ColorToken[] {
  const out: ColorToken[] = [];
  if (kind === 'css') {
    scanCssAt(text, 0, text.length, false, out);
    return out;
  }
  for (const m of text.matchAll(STYLE_TAG)) {
    const inner = m[1]!;
    scanCssAt(text, m.index! + m[0].indexOf(inner, m[0].indexOf('>')), inner.length, false, out);
  }
  for (const m of text.matchAll(STYLE_ATTR)) {
    const v = m[1] ?? m[2] ?? '';
    const at = m.index! + m[0].length - v.length - 1;
    scanCssAt(text, at, v.length, true, out);
  }
  for (const m of text.matchAll(PRESENTATION)) {
    const v = m[2] ?? m[3] ?? '';
    const trimmed = v.trim();
    if (!trimmed || /^(none|currentcolor|inherit|transparent)$/i.test(trimmed)) continue;
    const rgba = parseColor(trimmed);
    if (!rgba) continue;
    const at = m.index! + m[0].length - v.length - 1 + v.indexOf(trimmed);
    out.push({ start: at, end: at + trimmed.length, raw: trimmed, rgba });
  }
  return out.sort((a, b) => a.start - b.start);
}

export interface ColorUsage {
  /** Normalised hex (#rrggbb or #rrggbbaa). */
  key: string;
  rgba: RGBA;
  count: number;
  /** How it is written → number of times. */
  variants: Record<string, number>;
  files: string[];
}

const decode = (f: Files[string]) => (f.text ? f.content : null);

/** Colours used in the project's CSS/HTML/SVG files, most used first. */
export function scanProjectColors(files: Files): ColorUsage[] {
  const map = new Map<string, ColorUsage>();
  for (const [path, f] of Object.entries(files)) {
    const kind = sourceKind(path);
    const text = kind && decode(f);
    if (!kind || text == null) continue;
    for (const tok of findColorTokens(text, kind)) {
      const rgba = roundRgba(tok.rgba);
      const key = toHex(rgba);
      let u = map.get(key);
      if (!u) map.set(key, (u = { key, rgba, count: 0, variants: {}, files: [] }));
      u.count++;
      u.variants[tok.raw] = (u.variants[tok.raw] ?? 0) + 1;
      if (!u.files.includes(path)) u.files.push(path);
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/** Replaces every occurrence of `target` in `text`, keeping the notation of each occurrence. */
export function replaceColorInText(text: string, kind: SourceKind, target: RGBA, replacement: RGBA): { text: string; count: number } {
  let out = '';
  let last = 0;
  let count = 0;
  for (const tok of findColorTokens(text, kind)) {
    if (!sameColor(tok.rgba, target) || tok.start < last) continue;
    out += text.slice(last, tok.start) + formatLike(replacement, tok.raw);
    last = tok.end;
    count++;
  }
  return { text: count ? out + text.slice(last) : text, count };
}

/** Replaces `target` in all CSS/HTML/SVG files; returns only the files that changed. */
export function replaceColorInFiles(files: Files, target: RGBA, replacement: RGBA): { changed: Files; count: number } {
  const changed: Files = {};
  let count = 0;
  for (const [path, f] of Object.entries(files)) {
    const kind = sourceKind(path);
    const text = kind && decode(f);
    if (!kind || text == null) continue;
    const r = replaceColorInText(text, kind, target, replacement);
    if (r.count) {
      changed[path] = textFile(r.text);
      count += r.count;
    }
  }
  return { changed, count };
}
