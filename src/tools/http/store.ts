import { loadStored, saveStored } from '../shared';
import { METHODS, emptyDraft, redactDraft, type KV, type RequestDraft, type Variable } from './request';

/**
 * Persistence of the HTTP client (localStorage, best effort). Everything is stored redacted:
 * credentials are replaced by •••• and secret variables keep only their name. Secret values live in
 * memory for the current session so that remounting the tool does not lose them.
 */

export interface HistoryItem {
  at: string;
  draft: RequestDraft;
  status?: number;
  timeMs?: number;
}

export interface SavedRequest {
  name: string;
  draft: RequestDraft;
}

export const HISTORY_LIMIT = 50;

const sessionSecrets = new Map<string, string>();

const isKv = (x: unknown): x is KV => !!x && typeof x === 'object' && typeof (x as KV).key === 'string' && typeof (x as KV).value === 'string';

/** Validates a draft read from storage, filling in anything missing. */
export function sanitizeDraft(raw: unknown): RequestDraft {
  const d = emptyDraft();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Partial<RequestDraft>;
  if (typeof r.method === 'string' && (METHODS as readonly string[]).includes(r.method)) d.method = r.method;
  if (typeof r.url === 'string') d.url = r.url;
  const kvs = (v: unknown) => (Array.isArray(v) ? v.filter(isKv).map((x) => ({ key: x.key, value: x.value, enabled: x.enabled !== false })) : []);
  d.params = kvs(r.params);
  d.headers = kvs(r.headers);
  d.form = kvs(r.form);
  if (r.bodyType === 'json' || r.bodyType === 'form' || r.bodyType === 'text' || r.bodyType === 'none') d.bodyType = r.bodyType;
  if (typeof r.body === 'string') d.body = r.body;
  const a = r.auth;
  if (a && typeof a === 'object') {
    d.auth = {
      type: a.type === 'bearer' || a.type === 'basic' ? a.type : 'none',
      token: typeof a.token === 'string' ? a.token : '',
      user: typeof a.user === 'string' ? a.user : '',
      password: typeof a.password === 'string' ? a.password : '',
    };
  }
  return d;
}

export function loadHistory(): HistoryItem[] {
  const list = loadStored<unknown[]>('http.history', []);
  return (Array.isArray(list) ? list : [])
    .filter((x): x is HistoryItem => !!x && typeof x === 'object' && typeof (x as HistoryItem).at === 'string')
    .map((x) => ({ ...x, draft: sanitizeDraft(x.draft) }))
    .slice(0, HISTORY_LIMIT);
}

/** Adds a request to the front of the history (redacted; an identical previous entry is replaced). */
export function pushHistory(list: HistoryItem[], draft: RequestDraft, info: { status?: number; timeMs?: number }, at = new Date().toISOString()): HistoryItem[] {
  const safe = redactDraft(draft);
  const same = (x: HistoryItem) => JSON.stringify(x.draft) === JSON.stringify(safe);
  const next = [{ at, draft: safe, ...info }, ...list.filter((x) => !same(x))].slice(0, HISTORY_LIMIT);
  saveStored('http.history', next);
  return next;
}

/** Stores a history list as it is (its entries are already redacted). */
export function storeHistory(list: HistoryItem[]): void {
  saveStored('http.history', list.slice(0, HISTORY_LIMIT));
}

export function clearHistory(): void {
  saveStored('http.history', []);
}

export function loadSaved(): SavedRequest[] {
  const list = loadStored<unknown[]>('http.saved', []);
  return (Array.isArray(list) ? list : [])
    .filter((x): x is SavedRequest => !!x && typeof x === 'object' && typeof (x as SavedRequest).name === 'string')
    .map((x) => ({ name: x.name, draft: sanitizeDraft(x.draft) }));
}

export function storeSaved(list: SavedRequest[]): void {
  saveStored(
    'http.saved',
    list.map((x) => ({ name: x.name, draft: redactDraft(x.draft) })),
  );
}

export function loadVariables(): Variable[] {
  const list = loadStored<unknown[]>('http.vars', [{ key: 'baseUrl', value: 'https://httpbin.org' }]);
  return (Array.isArray(list) ? list : [])
    .filter((x): x is Variable => !!x && typeof x === 'object' && typeof (x as Variable).key === 'string')
    .map((x) => ({ key: x.key, secret: !!x.secret, value: x.secret ? (sessionSecrets.get(x.key) ?? '') : String(x.value ?? '') }));
}

export function storeVariables(vars: Variable[]): void {
  sessionSecrets.clear();
  for (const v of vars) if (v.secret && v.value) sessionSecrets.set(v.key, v.value);
  saveStored(
    'http.vars',
    vars.map((v) => ({ key: v.key, value: v.secret ? '' : v.value, secret: !!v.secret })),
  );
}

/** The draft being edited: stored redacted; its secrets are kept in memory for the session. */
let sessionDraft: RequestDraft | null = null;

export function loadCurrent(): RequestDraft {
  return sessionDraft ? structuredClone(sessionDraft) : sanitizeDraft(loadStored('http.current', null));
}

export function storeCurrent(d: RequestDraft): void {
  sessionDraft = structuredClone(d);
  saveStored('http.current', redactDraft(d));
}
