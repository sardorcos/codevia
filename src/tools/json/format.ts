import { t } from '../../i18n';

/** Pure JSON helpers: parsing with exact error positions, formatting, key sorting and JSONPath strings. */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };
export type PathSegment = string | number;

export interface JsonError {
  message: string;
  /** 0-based offset into the text. */
  offset: number;
  /** 1-based line and column. */
  line: number;
  column: number;
}

export type ParseResult = { ok: true; value: JsonValue } | { ok: false; error: JsonError };

export function offsetToLineCol(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let last = -1;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      last = i;
    }
  }
  return { line, column: end - last };
}

/**
 * Parses JSON. Uses the engine's JSON.parse for speed; when it fails, a small scanner finds the exact
 * position (Safari's messages carry no position at all).
 */
export function parseJson(input: string): ParseResult {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  if (!text.trim()) return { ok: false, error: { message: t('Пустой ввод'), offset: 0, line: 1, column: 1 } };
  try {
    return { ok: true, value: JSON.parse(text) as JsonValue };
  } catch (e) {
    const found = locateJsonError(text);
    const offset = found?.offset ?? 0;
    return { ok: false, error: { message: found?.message ?? String((e as Error).message), offset, ...offsetToLineCol(text, offset) } };
  }
}

const isWs = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;
const show = (ch: string | undefined) => (ch === undefined ? '' : JSON.stringify(ch).slice(1, -1) || ch);

/** Returns the first syntax error in `text`, or null when it is valid JSON. */
export function locateJsonError(text: string): { message: string; offset: number } | null {
  let i = 0;
  const n = text.length;
  class Fail {
    constructor(
      public message: string,
      public offset: number,
    ) {}
  }
  const fail = (message: string, at = i): never => {
    throw new Fail(message, at);
  };
  const ws = () => {
    while (i < n && isWs(text.charCodeAt(i))) i++;
  };
  const unexpected = (): never => (i >= n ? fail(t('Неожиданный конец данных')) : fail(t('Неожиданный символ «{ch}»', { ch: show(text[i]) })));

  const str = () => {
    i++; // opening quote
    for (;;) {
      if (i >= n) fail(t('Строка не закрыта кавычкой'));
      const c = text.charCodeAt(i);
      if (c === 34) {
        i++;
        return;
      }
      if (c < 32) fail(t('Управляющий символ внутри строки'));
      if (c === 92) {
        const e = text[i + 1];
        if (e === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) fail(t('Недопустимая escape-последовательность'));
          i += 6;
        } else if (e !== undefined && '"\\/bfnrt'.includes(e)) i += 2;
        else fail(t('Недопустимая escape-последовательность'));
      } else i++;
    }
  };

  const num = () => {
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i, i + 400));
    if (!m || !m[0] || m[0] === '-') fail(t('Недопустимое число'));
    const start = i;
    i += m![0].length;
    const next = text[i];
    if (next !== undefined && /[0-9.eE+\-a-zA-Z]/.test(next)) fail(t('Недопустимое число'), start);
  };

  const word = (w: string) => {
    if (text.startsWith(w, i)) i += w.length;
    else unexpected();
  };

  const value = (depth: number): void => {
    if (depth > 4000) fail(t('Слишком глубокая вложенность'));
    ws();
    if (i >= n) fail(t('Неожиданный конец данных'));
    const c = text[i];
    if (c === '{') {
      i++;
      ws();
      if (text[i] === '}') {
        i++;
        return;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') {
          if (text[i] === '}') fail(t('Лишняя запятая перед «}»'));
          if (i >= n) fail(t('Неожиданный конец данных'));
          fail(t('Ожидалось имя ключа в двойных кавычках'));
        }
        str();
        ws();
        if (text[i] !== ':') fail(i >= n ? t('Неожиданный конец данных') : t('Ожидалось двоеточие'));
        i++;
        value(depth + 1);
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === '}') {
          i++;
          return;
        }
        fail(i >= n ? t('Неожиданный конец данных') : t('Ожидалась запятая или «}»'));
      }
    }
    if (c === '[') {
      i++;
      ws();
      if (text[i] === ']') {
        i++;
        return;
      }
      for (;;) {
        ws();
        if (text[i] === ']') fail(t('Лишняя запятая перед «]»'));
        value(depth + 1);
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === ']') {
          i++;
          return;
        }
        fail(i >= n ? t('Неожиданный конец данных') : t('Ожидалась запятая или «]»'));
      }
    }
    if (c === '"') return str();
    if (c === '-' || (c !== undefined && c >= '0' && c <= '9')) return num();
    if (c === 't') return word('true');
    if (c === 'f') return word('false');
    if (c === 'n') return word('null');
    if (c === "'") fail(t('Строки в JSON пишутся в двойных кавычках'));
    unexpected();
  };

  try {
    if (text.charCodeAt(0) === 0xfeff) i = 1;
    value(0);
    ws();
    if (i < n) fail(t('Лишние данные после JSON'));
    return null;
  } catch (e) {
    if (e instanceof Fail) return { message: e.message, offset: e.offset };
    return { message: String(e), offset: i };
  }
}

export type Indent = 2 | 4 | '\t';

export const formatJson = (value: JsonValue, indent: Indent = 2): string => JSON.stringify(value, null, indent);

export const minifyJson = (value: JsonValue): string => JSON.stringify(value);

/** Returns a copy with the keys of every object sorted (code-point order, like `jq -S`). Arrays keep their order. */
export function sortKeysDeep(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const out: { [k: string]: JsonValue } = {};
    for (const k of Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) out[k] = sortKeysDeep(value[k]!);
    return out;
  }
  return value;
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** `['a', 0, 'b c']` → `$.a[0]["b c"]` */
export function jsonPath(path: readonly PathSegment[]): string {
  let s = '$';
  for (const seg of path) {
    if (typeof seg === 'number') s += `[${seg}]`;
    else if (IDENT.test(seg)) s += `.${seg}`;
    else s += `[${JSON.stringify(seg)}]`;
  }
  return s;
}

/** Follows a path into a value (undefined when it does not exist). */
export function getAtPath(value: JsonValue, path: readonly PathSegment[]): JsonValue | undefined {
  let cur: JsonValue | undefined = value;
  for (const seg of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = Array.isArray(cur) ? (typeof seg === 'number' ? cur[seg] : undefined) : Object.prototype.hasOwnProperty.call(cur, seg) ? cur[String(seg)] : undefined;
  }
  return cur;
}

export type JsonType = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

export const jsonType = (v: JsonValue): JsonType =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : (typeof v as 'object' | 'string' | 'number' | 'boolean');

export interface SearchHit {
  path: PathSegment[];
  /** Whether the key (property name) or the value matched. */
  inKey: boolean;
  inValue: boolean;
}

/**
 * Finds keys and primitive values containing `query` (case-insensitive). Depth-first, in document
 * order, stopping after `limit` hits.
 */
export function searchJson(root: JsonValue, query: string, limit = 2000): SearchHit[] {
  const q = query.toLowerCase();
  const hits: SearchHit[] = [];
  if (!q) return hits;
  const stack: Array<{ v: JsonValue; path: PathSegment[] }> = [{ v: root, path: [] }];
  while (stack.length && hits.length < limit) {
    const { v, path } = stack.pop()!;
    const last = path[path.length - 1];
    const inKey = typeof last === 'string' && last.toLowerCase().includes(q);
    let inValue = false;
    if (v === null || typeof v !== 'object') inValue = String(v).toLowerCase().includes(q);
    if (inKey || inValue) hits.push({ path, inKey, inValue });
    if (v && typeof v === 'object') {
      const kids: Array<{ v: JsonValue; path: PathSegment[] }> = Array.isArray(v)
        ? v.map((x, i) => ({ v: x, path: [...path, i] }))
        : Object.keys(v).map((k) => ({ v: v[k]!, path: [...path, k] }));
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
    }
  }
  return hits;
}
