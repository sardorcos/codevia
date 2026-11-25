/**
 * The single HTTP gateway for everything GitHub. On iOS requests go through the native
 * `CapacitorHttp` (no CORS, CSP stays `connect-src 'self'`); in dev/web and tests through `fetch`.
 *
 * Rules enforced here and nowhere else:
 * - only the hosts in ALLOWED_HOSTS can be reached, including after redirects;
 * - the token is attached only to `api.github.com`;
 * - tokens never appear in errors or logs (this module does not log at all).
 */
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { base64ToBytes, decodeUtf8 } from '../core/bytes';
import { GitHubError, type GitHubErrorCode, type GitHubMessageKey } from './errors';

export const ALLOWED_HOSTS: readonly string[] = ['github.com', 'api.github.com', 'codeload.github.com', 'uploads.github.com'];
export const API_HOST = 'api.github.com';
export const API_BASE = `https://${API_HOST}`;
export const API_VERSION = '2022-11-28';

const MAX_REDIRECTS = 5;
const CONNECT_TIMEOUT = 30_000;
const READ_TIMEOUT = 60_000;

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface GitHubRequest {
  /** Absolute https URL on an allowed host. */
  url: string;
  method?: HttpMethod;
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON request body. */
  json?: unknown;
  /** `application/x-www-form-urlencoded` body (used by the OAuth endpoints on github.com). */
  form?: Record<string, string>;
  /** Access token; sent only when the request goes to api.github.com. */
  token?: string | null;
  /** `binary` returns the body as Uint8Array (zipball). Default `json`. */
  responseType?: 'json' | 'binary';
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /**
   * Return 4xx responses instead of throwing (the OAuth endpoints report `{ error }` bodies that
   * the caller interprets). 5xx and network failures still throw.
   */
  allowClientErrors?: boolean;
}

export interface GitHubResponse<T> {
  status: number;
  /** Response headers with lower-case names. */
  headers: Record<string, string>;
  data: T;
  /** Final URL after redirects. */
  url: string;
}

/** What a transport sends: method, final URL, headers and an optional string body. */
interface RawRequest {
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  body?: string;
  binary: boolean;
  signal?: AbortSignal;
}

/** What a transport returns. `data` is a Uint8Array for binary requests, otherwise a string or parsed JSON. */
interface RawResponse {
  status: number;
  headers: Record<string, string>;
  data: unknown;
  url: string;
}

/** Parses `url` and throws unless it is https on an allowed host. */
export function assertAllowedUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new GitHubError('validation', { key: 'host_not_allowed' });
  }
  if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.includes(parsed.hostname) || parsed.username || parsed.password) {
    throw new GitHubError('validation', { key: 'host_not_allowed' });
  }
  return parsed;
}

function withQuery(url: string, query: GitHubRequest['query']): string {
  if (!query) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(query)) if (v !== undefined) u.searchParams.set(k, String(v));
  return u.toString();
}

/** Headers for one hop. The token and API headers are added only for api.github.com. */
function headersFor(url: URL, token: string | null | undefined, base: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { ...base };
  for (const k of Object.keys(h)) if (k.toLowerCase() === 'authorization') delete h[k];
  if (url.hostname === API_HOST) {
    h['Accept'] = 'application/vnd.github+json';
    h['X-GitHub-Api-Version'] = API_VERSION;
    if (token) h['Authorization'] = `Bearer ${token}`;
  } else if (url.hostname === 'github.com') {
    h['Accept'] = 'application/json';
  }
  return h;
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Aborted', 'AbortError');
}

/** Rejects as soon as `signal` aborts (CapacitorHttp itself cannot be cancelled). */
function raceAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

function lowerHeaders(h: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) out[k.toLowerCase()] = String(v);
  return out;
}

/**
 * Native transport. Redirects are disabled so every hop is checked against the allowlist.
 * iOS returns binary bodies (`responseType: 'arraybuffer'`) as base64 strings, and any
 * `application/json` body as an already-parsed value.
 */
async function nativeTransport(req: RawRequest): Promise<RawResponse> {
  const res = await raceAbort(
    CapacitorHttp.request({
      url: req.url,
      method: req.method,
      headers: req.headers,
      data: req.body,
      responseType: req.binary ? 'arraybuffer' : 'text',
      disableRedirects: true,
      connectTimeout: CONNECT_TIMEOUT,
      readTimeout: READ_TIMEOUT,
    }),
    req.signal,
  );
  const headers = lowerHeaders(res.headers);
  let data: unknown = res.data;
  if (req.binary && typeof data === 'string') {
    const isJson = (headers['content-type'] ?? '').includes('application/json');
    data = isJson ? data : base64ToBytes(data);
  }
  return { status: res.status, headers, data, url: res.url || req.url };
}

/** Web/dev/test transport. The browser follows redirects itself; the final URL is checked afterwards. */
async function fetchTransport(req: RawRequest): Promise<RawResponse> {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
    redirect: 'follow',
    credentials: 'omit',
    signal: req.signal,
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
  const data = req.binary ? new Uint8Array(await res.arrayBuffer()) : await res.text();
  return { status: res.status, headers, data, url: res.url || req.url };
}

const isNative = (): boolean => Capacitor.isNativePlatform();

/** Turns a raw body into JSON when possible (strings, or bytes of an error response). */
function parseJsonBody(data: unknown): unknown {
  if (data instanceof Uint8Array) data = decodeUtf8(data);
  if (typeof data !== 'string') return data;
  if (!data.trim()) return null;
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}

/** Reads the rate-limit reset time (ms since epoch) from GitHub's headers, if any. */
export function rateLimitReset(headers: Record<string, string>, now = Date.now()): number | undefined {
  const retryAfter = Number(headers['retry-after']);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return now + retryAfter * 1000;
  const reset = Number(headers['x-ratelimit-reset']);
  if (Number.isFinite(reset) && reset > 0) return reset * 1000;
  return undefined;
}

/** Maps a non-2xx response to a typed GitHubError. */
export function errorFromResponse(status: number, headers: Record<string, string>, body: unknown): GitHubError {
  const detail =
    body && typeof body === 'object' && typeof (body as { message?: unknown }).message === 'string'
      ? (body as { message: string }).message
      : typeof body === 'string'
        ? body.slice(0, 200)
        : undefined;
  const lower = (detail ?? '').toLowerCase();
  const limited = headers['x-ratelimit-remaining'] === '0' || lower.includes('rate limit');
  let code: GitHubErrorCode = 'unknown';
  let key: GitHubMessageKey | undefined;
  if (status === 429 || (status === 403 && limited)) code = 'rate_limit';
  else if (status === 401) code = 'auth';
  else if (status === 403) {
    code = 'auth';
    key = 'forbidden';
  } else if (status === 404) code = 'not_found';
  else if (status === 409) {
    code = 'conflict';
    if (lower.includes('empty')) {
      code = 'validation';
      key = 'repo_empty';
    }
  } else if (status === 422 || status === 400) code = 'validation';
  return new GitHubError(code, {
    status,
    key,
    detail,
    resetAt: code === 'rate_limit' ? rateLimitReset(headers) : undefined,
  });
}

/**
 * Performs one logical request (following up to five redirects, each re-checked against the
 * allowlist; the token is dropped as soon as a hop leaves api.github.com). Non-2xx → GitHubError.
 */
export async function githubRequest<T = unknown>(req: GitHubRequest): Promise<GitHubResponse<T>> {
  const binary = req.responseType === 'binary';
  let method: HttpMethod = req.method ?? 'GET';
  let url = assertAllowedUrl(withQuery(req.url, req.query));
  let body: string | undefined;
  const extra: Record<string, string> = {};
  if (req.json !== undefined) {
    body = JSON.stringify(req.json);
    extra['Content-Type'] = 'application/json';
  } else if (req.form) {
    body = new URLSearchParams(req.form).toString();
    extra['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  const transport = isNative() ? nativeTransport : fetchTransport;

  for (let hop = 0; ; hop++) {
    const headers = headersFor(url, req.token, body ? { ...req.headers, ...extra } : req.headers);
    let res: RawResponse;
    try {
      res = await transport({ method, url: url.toString(), headers, body, binary, signal: req.signal });
    } catch (e) {
      if (req.signal?.aborted) throw abortError(req.signal);
      if (e instanceof GitHubError) throw e;
      throw new GitHubError('network', { detail: e instanceof Error ? e.message : undefined });
    }
    // Fetch followed redirects on its own: make sure it did not end up somewhere else.
    if (res.url && res.url !== url.toString()) assertAllowedUrl(res.url);

    const location = res.headers['location'];
    if (res.status >= 300 && res.status < 400 && location) {
      if (hop >= MAX_REDIRECTS) throw new GitHubError('network', { status: res.status, detail: 'Too many redirects' });
      url = assertAllowedUrl(new URL(location, url).toString());
      if (res.status !== 307 && res.status !== 308) {
        method = 'GET';
        body = undefined;
      }
      continue;
    }
    const clientError = res.status >= 400 && res.status < 500;
    if ((res.status < 200 || res.status >= 300) && !(clientError && req.allowClientErrors && !binary)) {
      throw errorFromResponse(res.status, res.headers, parseJsonBody(res.data));
    }
    let data: unknown = res.data;
    if (binary) {
      if (!(data instanceof Uint8Array)) throw new GitHubError('unknown', { status: res.status, detail: 'Expected binary data' });
    } else {
      data = parseJsonBody(data);
    }
    return { status: res.status, headers: res.headers, data: data as T, url: res.url || url.toString() };
  }
}
