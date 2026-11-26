import { Capacitor, CapacitorHttp, type HttpOptions, type HttpResponse } from '@capacitor/core';
import { base64ToBytes, encodeUtf8 } from '../../core/bytes';
import { t } from '../../i18n';

/**
 * Sends HTTP requests for the HTTP client.
 * - In the iOS app: CapacitorHttp (native URLSession), so CORS and the page CSP do not apply.
 *   Plain http:// is subject to App Transport Security (local addresses are exempt).
 * - In a browser: fetch(), with the usual CORS rules and this page's Content-Security-Policy.
 */

export interface TransportRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface TransportResponse {
  status: number;
  statusText: string;
  /** Header names in lower case. */
  headers: Record<string, string>;
  body: Uint8Array;
  url: string;
  timeMs: number;
  via: 'native' | 'fetch';
}

export type TransportErrorKind = 'timeout' | 'aborted' | 'network' | 'blocked-http' | 'cors' | 'protocol';

export class TransportError extends Error {
  constructor(
    public kind: TransportErrorKind,
    message: string,
  ) {
    super(message);
  }
}

export interface TransportDeps {
  native?: boolean;
  http?: { request(o: HttpOptions): Promise<HttpResponse> };
  fetch?: typeof fetch;
  now?: () => number;
}

/** localhost, IP addresses, single-label names and .local hosts (exempt from App Transport Security). */
export function isLocalHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h.endsWith('.local') || h.endsWith('.localhost') || !h.includes('.') || /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':');
}

export const lowerHeaders = (h: Record<string, unknown> | null | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) {
    const key = k.toLowerCase();
    const val = Array.isArray(v) ? v.join(', ') : String(v ?? '');
    out[key] = out[key] ? `${out[key]}, ${val}` : val;
  }
  return out;
};

const isJsonType = (ct: string) => /[/+]json\b/i.test(ct);

/**
 * Turns CapacitorHttp's `data` into bytes. With responseType 'arraybuffer' native platforms return
 * base64, except for JSON content types, which arrive parsed (or as the raw string if invalid).
 */
export function nativeBodyToBytes(data: unknown, contentType: string): Uint8Array {
  if (data == null) return new Uint8Array(0);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof data === 'string') {
    if (isJsonType(contentType)) {
      // Raw JSON text (invalid JSON, or a plugin version that returns text) stays as it is;
      // a parsed JSON string value is serialised again.
      const trimmed = data.trim();
      try {
        JSON.parse(trimmed);
        return encodeUtf8(data);
      } catch {
        return encodeUtf8(/^[[{]/.test(trimmed) || !trimmed ? data : JSON.stringify(data));
      }
    }
    if (!data) return new Uint8Array(0);
    try {
      return base64ToBytes(data.replace(/\s+/g, ''));
    } catch {
      return encodeUtf8(data); // not base64: plain text from an older plugin
    }
  }
  return encodeUtf8(JSON.stringify(data, null, 2));
}

function abortError(): TransportError {
  return new TransportError('aborted', t('Запрос отменён'));
}

function timeoutError(ms: number): TransportError {
  return new TransportError('timeout', t('Нет ответа за {sec} с — превышено время ожидания', { sec: Math.round(ms / 1000) }));
}

/** Rejects when the signal aborts or the timer fires; the work itself may keep running natively. */
function guard<T>(work: Promise<T>, req: TransportRequest): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (req.signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => reject(timeoutError(req.timeoutMs)), req.timeoutMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    req.signal?.addEventListener('abort', onAbort, { once: true });
    work.then(
      (v) => {
        clearTimeout(timer);
        req.signal?.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        req.signal?.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

function checkUrl(url: string): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new TransportError('protocol', t('Некорректный URL: {url}', { url }));
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new TransportError('protocol', t('Поддерживаются только адреса http:// и https://'));
  return u;
}

const HTTP_HINT = () => t('iOS блокирует незащищённые адреса http:// (App Transport Security), кроме localhost, IP-адресов и имён .local. Используйте https://.');

async function sendNative(req: TransportRequest, deps: TransportDeps): Promise<TransportResponse> {
  const u = checkUrl(req.url);
  const http = deps.http ?? CapacitorHttp;
  const now = deps.now ?? (() => performance.now());
  const start = now();
  let res: HttpResponse;
  try {
    res = await guard(
      http.request({
        url: req.url,
        method: req.method,
        headers: req.headers,
        data: req.body ?? undefined,
        responseType: 'arraybuffer',
        connectTimeout: req.timeoutMs,
        readTimeout: req.timeoutMs,
        shouldEncodeUrlParams: false,
      }),
      req,
    );
  } catch (e) {
    if (e instanceof TransportError) throw e;
    const msg = String((e as Error)?.message ?? e);
    if (u.protocol === 'http:' && !isLocalHost(u.hostname)) throw new TransportError('blocked-http', `${HTTP_HINT()}\n${msg}`);
    if (/timed? ?out/i.test(msg)) throw timeoutError(req.timeoutMs);
    throw new TransportError('network', t('Сетевая ошибка: {message}', { message: msg }));
  }
  const headers = lowerHeaders(res.headers as Record<string, unknown>);
  return {
    status: res.status,
    statusText: '',
    headers,
    body: nativeBodyToBytes(res.data, headers['content-type'] ?? ''),
    url: res.url || req.url,
    timeMs: Math.max(0, Math.round(now() - start)),
    via: 'native',
  };
}

async function sendFetch(req: TransportRequest, deps: TransportDeps): Promise<TransportResponse> {
  checkUrl(req.url);
  const doFetch = deps.fetch ?? globalThis.fetch.bind(globalThis);
  const now = deps.now ?? (() => performance.now());
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  req.signal?.addEventListener('abort', onAbort, { once: true });
  const start = now();
  try {
    const res = await guard(
      (async () => {
        const r = await doFetch(req.url, {
          method: req.method,
          headers: req.headers,
          body: req.body ?? undefined,
          signal: ctrl.signal,
          redirect: 'follow',
          credentials: 'omit',
          cache: 'no-store',
        });
        return { r, body: new Uint8Array(await r.arrayBuffer()) };
      })(),
      req,
    );
    const headers: Record<string, string> = {};
    res.r.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    return { status: res.r.status, statusText: res.r.statusText, headers, body: res.body, url: res.r.url || req.url, timeMs: Math.max(0, Math.round(now() - start)), via: 'fetch' };
  } catch (e) {
    ctrl.abort();
    if (e instanceof TransportError) throw e;
    if ((e as Error)?.name === 'AbortError') throw abortError();
    throw new TransportError(
      'cors',
      t('Запрос не прошёл. В браузере действуют CORS и политика безопасности страницы (CSP): сервер должен явно разрешать такие запросы. В приложении на iPhone и iPad этих ограничений нет.'),
    );
  } finally {
    req.signal?.removeEventListener('abort', onAbort);
  }
}

export const usesNativeHttp = (): boolean => Capacitor.isNativePlatform();

export function sendRequest(req: TransportRequest, deps: TransportDeps = {}): Promise<TransportResponse> {
  const native = deps.native ?? usesNativeHttp();
  return native ? sendNative(req, deps) : sendFetch(req, deps);
}
