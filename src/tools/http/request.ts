import { t } from '../../i18n';
import { textToBase64 } from '../../core/bytes';
import { parseJson } from '../json/format';

/** Pure request model of the HTTP client: variables, query merging, headers, auth, bodies and code export. */

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
export type Method = (typeof METHODS)[number];
export type BodyType = 'none' | 'json' | 'form' | 'text';
export type AuthType = 'none' | 'bearer' | 'basic';

export interface KV {
  key: string;
  value: string;
  enabled: boolean;
}

export interface Auth {
  type: AuthType;
  token: string;
  user: string;
  password: string;
}

export interface RequestDraft {
  method: Method;
  url: string;
  params: KV[];
  headers: KV[];
  bodyType: BodyType;
  /** JSON or raw text body. */
  body: string;
  /** form-urlencoded fields. */
  form: KV[];
  auth: Auth;
}

export interface Variable {
  key: string;
  value: string;
  /** Secret values are never written to storage (kept for the session only). */
  secret?: boolean;
}

export interface BuiltRequest {
  method: Method;
  url: string;
  headers: Record<string, string>;
  body: string | null;
  /** `{{name}}` placeholders that had no value. */
  unresolved: string[];
}

export class RequestError extends Error {}

export const MASK = '••••';

export const emptyDraft = (): RequestDraft => ({
  method: 'GET',
  url: '',
  params: [],
  headers: [],
  bodyType: 'none',
  body: '',
  form: [],
  auth: { type: 'none', token: '', user: '', password: '' },
});

/** Replaces `{{name}}` with variable values; unknown names stay as they are and are reported. */
export function interpolate(text: string, vars: readonly Variable[], unresolved?: Set<string>): string {
  if (!text.includes('{{')) return text;
  return text.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, name: string) => {
    const v = vars.find((x) => x.key === name);
    if (v) return v.value;
    unresolved?.add(name);
    return m;
  });
}

const hasBody = (m: Method) => m !== 'GET' && m !== 'HEAD';

const findHeader = (headers: Record<string, string>, name: string) => Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());

/** form-urlencoded like browsers do it (spaces become +). */
export const encodeForm = (fields: readonly KV[], map: (s: string) => string = (s) => s): string =>
  fields
    .filter((f) => f.enabled && f.key)
    .map((f) => `${encodeURIComponent(map(f.key)).replace(/%20/g, '+')}=${encodeURIComponent(map(f.value)).replace(/%20/g, '+')}`)
    .join('&');

/** Adds a scheme when missing (`example.com` → `https://example.com`; localhost gets http). */
export function normalizeUrl(raw: string): string {
  const s = raw.trim();
  if (!s) return s;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
  if (/^(localhost|127\.|0\.0\.0\.0|\[::1\]|10\.|192\.168\.)/i.test(s)) return `http://${s}`;
  return `https://${s}`;
}

/** Builds the request that will be sent. Throws RequestError with a user-facing message. */
export function buildRequest(draft: RequestDraft, vars: readonly Variable[] = []): BuiltRequest {
  const unresolved = new Set<string>();
  const sub = (s: string) => interpolate(s, vars, unresolved);
  const rawUrl = normalizeUrl(sub(draft.url));
  if (!rawUrl) throw new RequestError(t('Введите URL'));
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new RequestError(t('Некорректный URL: {url}', { url: rawUrl }));
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new RequestError(t('Поддерживаются только адреса http:// и https://'));
  for (const p of draft.params) if (p.enabled && p.key) url.searchParams.append(sub(p.key), sub(p.value));

  const headers: Record<string, string> = {};
  for (const h of draft.headers) {
    if (!h.enabled || !h.key.trim()) continue;
    const name = sub(h.key).trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new RequestError(t('Недопустимое имя заголовка: {name}', { name }));
    const existing = findHeader(headers, name);
    headers[existing ?? name] = sub(h.value);
  }

  const auth = draft.auth;
  if (auth.type !== 'none' && !findHeader(headers, 'authorization')) {
    if (auth.type === 'bearer') {
      const token = sub(auth.token).trim();
      if (token) headers['Authorization'] = `Bearer ${token}`;
    } else if (auth.user || auth.password) {
      headers['Authorization'] = `Basic ${textToBase64(`${sub(auth.user)}:${sub(auth.password)}`)}`;
    }
  }

  let body: string | null = null;
  if (hasBody(draft.method) && draft.bodyType !== 'none') {
    if (draft.bodyType === 'json') {
      body = sub(draft.body);
      if (body.trim()) {
        const r = parseJson(body);
        if (!r.ok) throw new RequestError(t('Тело JSON: строка {line}, столбец {column}: {message}', { line: r.error.line, column: r.error.column, message: r.error.message }));
      }
      if (!findHeader(headers, 'content-type')) headers['Content-Type'] = 'application/json';
    } else if (draft.bodyType === 'form') {
      body = encodeForm(draft.form, sub);
      if (!findHeader(headers, 'content-type')) headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
    } else {
      body = sub(draft.body);
      if (!findHeader(headers, 'content-type')) headers['Content-Type'] = 'text/plain;charset=UTF-8';
    }
  }
  return { method: draft.method, url: url.toString(), headers, body, unresolved: [...unresolved] };
}

const SECRET_HEADERS = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|x-access-token|x-csrf-token)$/i;

export const isSecretHeader = (name: string): boolean => SECRET_HEADERS.test(name.trim());

/**
 * Copy of the draft that is safe to store: auth secrets and secret headers are replaced by ••••.
 * (History and saved requests never keep credentials in plain text.)
 */
export function redactDraft(d: RequestDraft): RequestDraft {
  const hide = (v: string) => (v ? MASK : '');
  return {
    ...d,
    params: d.params.map((p) => ({ ...p })),
    form: d.form.map((p) => ({ ...p })),
    headers: d.headers.map((h) => (isSecretHeader(h.key) && !/\{\{[^}]+\}\}/.test(h.value) ? { ...h, value: hide(h.value) } : { ...h })),
    auth: {
      type: d.auth.type,
      token: /^\{\{[^}]+\}\}$/.test(d.auth.token.trim()) ? d.auth.token : hide(d.auth.token),
      user: d.auth.user,
      password: /^\{\{[^}]+\}\}$/.test(d.auth.password.trim()) ? d.auth.password : hide(d.auth.password),
    },
  };
}

/** True when the draft contains ••••, i.e. a secret must be entered again before sending. */
export const hasMaskedSecret = (d: RequestDraft): boolean =>
  d.auth.token === MASK || d.auth.password === MASK || d.headers.some((h) => h.enabled && h.value === MASK);

/** Single-quotes a string for POSIX shells. */
export const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export function toCurl(req: BuiltRequest): string {
  const first = ['curl'];
  if (req.method === 'HEAD') first.push('--head');
  else if (req.method !== 'GET' || req.body !== null) first.push('-X', req.method);
  first.push(shellQuote(req.url));
  const lines = [first.join(' ')];
  for (const [k, v] of Object.entries(req.headers)) lines.push(`-H ${shellQuote(`${k}: ${v}`)}`);
  if (req.body !== null) lines.push(`--data-raw ${shellQuote(req.body)}`);
  return lines.join(' \\\n  ');
}

export function toFetch(req: BuiltRequest): string {
  const lines = [`const response = await fetch(${JSON.stringify(req.url)}, {`, `  method: ${JSON.stringify(req.method)},`];
  const entries = Object.entries(req.headers);
  if (entries.length) {
    lines.push('  headers: {');
    for (const [k, v] of entries) lines.push(`    ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
    lines.push('  },');
  }
  if (req.body !== null) {
    const ct = req.headers[Object.keys(req.headers).find((k) => k.toLowerCase() === 'content-type') ?? ''] ?? '';
    const parsed = /json/i.test(ct) && req.body.trim() ? parseJson(req.body) : null;
    lines.push(parsed?.ok ? `  body: JSON.stringify(${JSON.stringify(parsed.value)}),` : `  body: ${JSON.stringify(req.body)},`);
  }
  lines.push('});');
  if (req.method === 'HEAD') lines.push('console.log(response.status, [...response.headers]);');
  else lines.push('const data = await response.text();', 'console.log(response.status, data);');
  return lines.join('\n');
}

/** Parses `a=1&b=2` (or a full URL) into rows, for pasting into the params editor. */
export function parseQuery(input: string): KV[] {
  const q = input.includes('?') ? input.slice(input.indexOf('?') + 1) : input;
  const out: KV[] = [];
  for (const [key, value] of new URLSearchParams(q.split('#')[0])) out.push({ key, value, enabled: true });
  return out;
}

/** Status colour class: 2xx ok, 3xx info, 4xx warning, 5xx and errors danger. */
export const statusTone = (status: number): 'ok' | 'info' | 'warn' | 'bad' =>
  status >= 200 && status < 300 ? 'ok' : status >= 300 && status < 400 ? 'info' : status >= 400 && status < 500 ? 'warn' : 'bad';

/** A file name for saving a response body: last URL segment, with an extension matching the content type. */
export function suggestFileName(url: string, contentType: string): string {
  const EXT: Record<string, string> = {
    'application/json': 'json', 'text/html': 'html', 'text/css': 'css', 'text/plain': 'txt', 'text/javascript': 'js',
    'application/javascript': 'js', 'application/xml': 'xml', 'text/xml': 'xml', 'text/csv': 'csv', 'image/png': 'png',
    'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'application/pdf': 'pdf',
    'text/markdown': 'md',
  };
  const type = contentType.split(';')[0]!.trim().toLowerCase();
  const ext = EXT[type] ?? (type.endsWith('+json') ? 'json' : type.startsWith('text/') ? 'txt' : 'bin');
  let name: string;
  try {
    name = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? '');
  } catch {
    name = '';
  }
  name = name.replace(/[^\w.-]+/g, '_').slice(0, 80);
  if (!name) return `response.${ext}`;
  return /\.[a-z0-9]{1,5}$/i.test(name) ? name : `${name}.${ext}`;
}
