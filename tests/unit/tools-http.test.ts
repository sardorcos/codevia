import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MASK, RequestError, buildRequest, emptyDraft, encodeForm, hasMaskedSecret, interpolate, normalizeUrl, parseQuery, redactDraft, shellQuote,
  statusTone, suggestFileName, toCurl, toFetch, type RequestDraft,
} from '../../src/tools/http/request';
import { TransportError, isLocalHost, lowerHeaders, nativeBodyToBytes, sendRequest } from '../../src/tools/http/transport';
import { HISTORY_LIMIT, loadHistory, loadSaved, loadVariables, pushHistory, sanitizeDraft, storeSaved, storeVariables } from '../../src/tools/http/store';
import { bytesToBase64, decodeUtf8, encodeUtf8 } from '../../src/core/bytes';

const draft = (patch: Partial<RequestDraft>): RequestDraft => ({ ...emptyDraft(), ...patch });

describe('request builder', () => {
  it('interpolates variables and reports unknown ones', () => {
    const missing = new Set<string>();
    expect(interpolate('{{baseUrl}}/a/{{ id }}/{{nope}}', [{ key: 'baseUrl', value: 'https://x.dev' }, { key: 'id', value: '7' }], missing)).toBe('https://x.dev/a/7/{{nope}}');
    expect([...missing]).toEqual(['nope']);
    const r = buildRequest(draft({ url: '{{baseUrl}}/get?x=1', params: [{ key: 'q', value: '{{term}}', enabled: true }] }), [
      { key: 'baseUrl', value: 'https://api.test' },
      { key: 'term', value: 'a b&c' },
    ]);
    expect(r.url).toBe('https://api.test/get?x=1&q=a+b%26c');
    expect(r.unresolved).toEqual([]);
  });

  it('merges query params with the URL query, skipping disabled and empty rows', () => {
    const r = buildRequest(
      draft({
        url: 'https://e.com/s?a=1&a=2',
        params: [
          { key: 'a', value: '3', enabled: true },
          { key: 'off', value: 'x', enabled: false },
          { key: '', value: 'empty', enabled: true },
          { key: 'ü', value: '✓', enabled: true },
        ],
      }),
    );
    expect(r.url).toBe('https://e.com/s?a=1&a=2&a=3&%C3%BC=%E2%9C%93');
  });

  it('adds a scheme, rejects other protocols and bad URLs', () => {
    expect(normalizeUrl('example.com/x')).toBe('https://example.com/x');
    expect(normalizeUrl('localhost:3000')).toBe('http://localhost:3000');
    expect(normalizeUrl('192.168.1.5/api')).toBe('http://192.168.1.5/api');
    expect(normalizeUrl('http://a.b')).toBe('http://a.b');
    expect(() => buildRequest(draft({ url: '' }))).toThrow(RequestError);
    expect(() => buildRequest(draft({ url: 'ftp://a.b' }))).toThrow('Поддерживаются только');
    expect(() => buildRequest(draft({ url: 'https://' }))).toThrow('Некорректный URL');
  });

  it('builds headers: case-insensitive merging, validation, auth', () => {
    const r = buildRequest(
      draft({
        url: 'https://e.com',
        headers: [
          { key: 'X-A', value: '1', enabled: true },
          { key: 'x-a', value: '2', enabled: true },
          { key: 'X-Off', value: '1', enabled: false },
        ],
        auth: { type: 'bearer', token: ' {{tok}} ', user: '', password: '' },
      }),
      [{ key: 'tok', value: 'abc' }],
    );
    expect(r.headers).toEqual({ 'X-A': '2', Authorization: 'Bearer abc' });
    expect(() => buildRequest(draft({ url: 'https://e.com', headers: [{ key: 'Bad Name', value: '', enabled: true }] }))).toThrow('Недопустимое имя заголовка');
    const basic = buildRequest(draft({ url: 'https://e.com', auth: { type: 'basic', token: '', user: 'Aladdin', password: 'open sesame' } }));
    expect(basic.headers.Authorization).toBe('Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==');
    const utf = buildRequest(draft({ url: 'https://e.com', auth: { type: 'basic', token: '', user: 'й', password: 'ü' } }));
    expect(utf.headers.Authorization).toBe(`Basic ${bytesToBase64(encodeUtf8('й:ü'))}`);
    // An explicit Authorization header wins over the auth helper.
    const own = buildRequest(draft({ url: 'https://e.com', headers: [{ key: 'authorization', value: 'Token x', enabled: true }], auth: { type: 'bearer', token: 't', user: '', password: '' } }));
    expect(own.headers).toEqual({ authorization: 'Token x' });
  });

  it('encodes bodies and sets the content type unless given', () => {
    const json = buildRequest(draft({ method: 'POST', url: 'https://e.com', bodyType: 'json', body: '{"n": {{n}}}' }), [{ key: 'n', value: '5' }]);
    expect(json.body).toBe('{"n": 5}');
    expect(json.headers['Content-Type']).toBe('application/json');
    expect(() => buildRequest(draft({ method: 'POST', url: 'https://e.com', bodyType: 'json', body: '{"a":}' }))).toThrow('Тело JSON: строка 1, столбец 6');
    const form = buildRequest(draft({ method: 'PUT', url: 'https://e.com', bodyType: 'form', form: [{ key: 'a b', value: 'x&y=z', enabled: true }, { key: 'c', value: '', enabled: true }, { key: 'd', value: '1', enabled: false }] }));
    expect(form.body).toBe('a+b=x%26y%3Dz&c=');
    expect(form.headers['Content-Type']).toBe('application/x-www-form-urlencoded;charset=UTF-8');
    const text = buildRequest(draft({ method: 'PATCH', url: 'https://e.com', bodyType: 'text', body: 'hi', headers: [{ key: 'content-type', value: 'text/csv', enabled: true }] }));
    expect(text.body).toBe('hi');
    expect(text.headers).toEqual({ 'content-type': 'text/csv' });
    // GET and HEAD never carry a body.
    expect(buildRequest(draft({ method: 'GET', url: 'https://e.com', bodyType: 'json', body: '{}' })).body).toBeNull();
    expect(buildRequest(draft({ method: 'HEAD', url: 'https://e.com', bodyType: 'text', body: 'x' })).headers).toEqual({});
    expect(encodeForm([{ key: 'k', value: 'v w', enabled: true }])).toBe('k=v+w');
  });

  it('parses a query string into rows', () => {
    expect(parseQuery('https://e.com/?a=1&b=two+words&c#frag')).toEqual([
      { key: 'a', value: '1', enabled: true },
      { key: 'b', value: 'two words', enabled: true },
      { key: 'c', value: '', enabled: true },
    ]);
  });
});

describe('code export', () => {
  const req = buildRequest(
    draft({ method: 'POST', url: 'https://api.test/items?x=1', bodyType: 'json', body: '{"name":"O\'Brien"}', headers: [{ key: 'Accept', value: 'application/json', enabled: true }] }),
  );

  it('quotes for the shell', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it('generates cURL', () => {
    expect(toCurl(req)).toBe(
      [
        `curl -X POST 'https://api.test/items?x=1' \\`,
        `  -H 'Accept: application/json' \\`,
        `  -H 'Content-Type: application/json' \\`,
        `  --data-raw '{"name":"O'\\''Brien"}'`,
      ].join('\n'),
    );
    expect(toCurl(buildRequest(draft({ url: 'https://e.com' })))).toBe(`curl 'https://e.com/'`);
    expect(toCurl(buildRequest(draft({ method: 'HEAD', url: 'https://e.com' })))).toBe(`curl --head 'https://e.com/'`);
    expect(toCurl(buildRequest(draft({ method: 'DELETE', url: 'https://e.com/1' })))).toBe(`curl -X DELETE 'https://e.com/1'`);
  });

  it('generates fetch()', () => {
    const code = toFetch(req);
    expect(code).toContain('await fetch("https://api.test/items?x=1", {');
    expect(code).toContain('method: "POST"');
    expect(code).toContain('"Content-Type": "application/json",');
    expect(code).toContain(`body: JSON.stringify({"name":"O'Brien"}),`);
    expect(toFetch(buildRequest(draft({ method: 'PUT', url: 'https://e.com', bodyType: 'text', body: 'a"b' })))).toContain('body: "a\\"b",');
    expect(toFetch(buildRequest(draft({ url: 'https://e.com' })))).not.toContain('headers');
    // Generated code is valid JavaScript.
    expect(() => new Function(`return (async () => { ${code} })`)).not.toThrow();
  });
});

describe('secrets never stored', () => {
  const secret = draft({
    url: 'https://e.com',
    headers: [
      { key: 'Authorization', value: 'Bearer real', enabled: true },
      { key: 'X-Api-Key', value: '{{key}}', enabled: true },
      { key: 'Cookie', value: 'sid=1', enabled: true },
      { key: 'Accept', value: 'text/html', enabled: true },
    ],
    auth: { type: 'basic', token: 'tok', user: 'me', password: 'pw' },
  });

  it('redacts auth fields and secret headers, keeping variable references', () => {
    const r = redactDraft(secret);
    expect(r.headers.map((h) => h.value)).toEqual([MASK, '{{key}}', MASK, 'text/html']);
    expect(r.auth).toEqual({ type: 'basic', token: MASK, user: 'me', password: MASK });
    expect(secret.headers[0]!.value).toBe('Bearer real'); // original untouched
    expect(hasMaskedSecret(r)).toBe(true);
    expect(hasMaskedSecret(secret)).toBe(false);
    expect(redactDraft(draft({ auth: { type: 'bearer', token: '{{token}}', user: '', password: '' } })).auth.token).toBe('{{token}}');
  });

  describe('storage', () => {
    let store: Record<string, string>;
    beforeEach(() => {
      store = {};
      vi.stubGlobal('localStorage', {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => void (store[k] = v),
        removeItem: (k: string) => void delete store[k],
      });
    });
    afterEach(() => vi.unstubAllGlobals());

    it('keeps the last 50 requests, redacted, newest first, without duplicates', () => {
      let h = loadHistory();
      for (let i = 0; i < 60; i++) h = pushHistory(h, draft({ url: `https://e.com/${i}` }), { status: 200 });
      h = pushHistory(h, secret, { status: 401 });
      h = pushHistory(h, secret, { status: 200 });
      expect(h).toHaveLength(HISTORY_LIMIT);
      expect(h[0]!.status).toBe(200);
      expect(h[1]!.draft.url).toBe('https://e.com/59');
      const raw = Object.values(store).join('\n');
      expect(raw).not.toContain('Bearer real');
      expect(raw).not.toContain('"pw"');
      expect(raw).not.toContain('sid=1');
      expect(loadHistory()).toHaveLength(HISTORY_LIMIT);
    });

    it('stores saved requests and variables without secrets', () => {
      storeSaved([{ name: 'Login', draft: secret }]);
      expect(JSON.stringify(store)).not.toContain('Bearer real');
      expect(loadSaved()[0]!.draft.auth.password).toBe(MASK);
      storeVariables([
        { key: 'baseUrl', value: 'https://e.com' },
        { key: 'token', value: 'top-secret', secret: true },
      ]);
      expect(JSON.stringify(store)).not.toContain('top-secret');
      // The session keeps the secret value in memory.
      expect(loadVariables()).toEqual([
        { key: 'baseUrl', value: 'https://e.com', secret: false },
        { key: 'token', value: 'top-secret', secret: true },
      ]);
    });

    it('survives broken or blocked storage', () => {
      store['codevia.tools.http.history'] = '{not json';
      expect(loadHistory()).toEqual([]);
      vi.stubGlobal('localStorage', {
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: () => {
          throw new Error('blocked');
        },
      });
      expect(loadSaved()).toEqual([]);
      expect(() => pushHistory([], draft({ url: 'https://e.com' }), {})).not.toThrow();
      expect(sanitizeDraft({ method: 'BREW', url: 5, params: [{ key: 'a' }, { key: 'b', value: 'c' }], auth: { type: 'x' } })).toMatchObject({
        method: 'GET',
        url: '',
        params: [{ key: 'b', value: 'c', enabled: true }],
        auth: { type: 'none' },
      });
    });
  });
});

describe('helpers', () => {
  it('colours statuses and suggests file names', () => {
    expect([200, 204, 301, 404, 500, 0].map(statusTone)).toEqual(['ok', 'ok', 'info', 'warn', 'bad', 'bad']);
    expect(suggestFileName('https://e.com/api/users', 'application/json; charset=utf-8')).toBe('users.json');
    expect(suggestFileName('https://e.com/img/logo.png?x', 'image/png')).toBe('logo.png');
    expect(suggestFileName('https://e.com/', 'text/html')).toBe('response.html');
    expect(suggestFileName('https://e.com/x', 'application/vnd.api+json')).toBe('x.json');
    expect(suggestFileName('https://e.com/x', 'application/octet-stream')).toBe('x.bin');
  });
});

describe('transport', () => {
  it('recognises hosts exempt from App Transport Security', () => {
    for (const h of ['localhost', '127.0.0.1', '192.168.0.10', 'mac.local', 'printer', '[::1]']) expect(isLocalHost(h), h).toBe(true);
    for (const h of ['example.com', 'api.local.dev']) expect(isLocalHost(h), h).toBe(false);
  });

  it('lower-cases header names and joins duplicates', () => {
    expect(lowerHeaders({ 'Content-Type': 'a', 'X-Multi': ['1', '2'], 'x-multi2': 3 })).toEqual({ 'content-type': 'a', 'x-multi': '1, 2', 'x-multi2': '3' });
  });

  it('decodes native bodies: base64 for binary, parsed or raw JSON', () => {
    const png = new Uint8Array([137, 80, 78, 71, 0, 255]);
    expect(nativeBodyToBytes(bytesToBase64(png), 'image/png')).toEqual(png);
    expect(decodeUtf8(nativeBodyToBytes(bytesToBase64(encodeUtf8('héllo')), 'text/plain'))).toBe('héllo');
    expect(JSON.parse(decodeUtf8(nativeBodyToBytes({ a: [1] }, 'application/json')))).toEqual({ a: [1] });
    expect(decodeUtf8(nativeBodyToBytes('{"raw":1}', 'application/json'))).toBe('{"raw":1}');
    expect(decodeUtf8(nativeBodyToBytes('hello', 'application/json'))).toBe('"hello"');
    expect(decodeUtf8(nativeBodyToBytes('{broken', 'application/problem+json'))).toBe('{broken');
    expect(decodeUtf8(nativeBodyToBytes(42, 'application/json'))).toBe('42');
    expect(nativeBodyToBytes(null, 'text/plain')).toEqual(new Uint8Array(0));
    expect(nativeBodyToBytes(new Uint8Array([1, 2]).buffer, '')).toEqual(new Uint8Array([1, 2]));
  });

  const base = { method: 'GET', url: 'https://api.test/x', headers: { A: '1' }, body: null, timeoutMs: 5000 };

  it('uses CapacitorHttp on native with arraybuffer responses and lower-cased headers', async () => {
    const request = vi.fn().mockResolvedValue({ status: 201, headers: { 'Content-Type': 'text/plain' }, data: bytesToBase64(encodeUtf8('ok')), url: 'https://api.test/x' });
    let clock = 100;
    const res = await sendRequest({ ...base, method: 'POST', body: '{"a":1}' }, { native: true, http: { request }, now: () => (clock += 25) });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ url: base.url, method: 'POST', data: '{"a":1}', responseType: 'arraybuffer', connectTimeout: 5000, readTimeout: 5000, headers: { A: '1' } }));
    expect(res).toMatchObject({ status: 201, headers: { 'content-type': 'text/plain' }, via: 'native', timeMs: 25 });
    expect(decodeUtf8(res.body)).toBe('ok');
  });

  it('explains App Transport Security failures for plain http on native', async () => {
    const request = vi.fn().mockRejectedValue(new Error('The resource could not be loaded because the App Transport Security policy requires the use of a secure connection.'));
    const e = await sendRequest({ ...base, url: 'http://example.com/' }, { native: true, http: { request } }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(TransportError);
    expect((e as TransportError).kind).toBe('blocked-http');
    expect((e as TransportError).message).toContain('App Transport Security');
    const local = await sendRequest({ ...base, url: 'http://localhost:8080/' }, { native: true, http: { request: vi.fn().mockRejectedValue(new Error('refused')) } }).catch((x: unknown) => x);
    expect((local as TransportError).kind).toBe('network');
  });

  it('only allows http(s)', async () => {
    const e = await sendRequest({ ...base, url: 'file:///etc/passwd' }, { native: true, http: { request: vi.fn() } }).catch((x: unknown) => x);
    expect((e as TransportError).kind).toBe('protocol');
  });

  it('cancels and times out (native requests cannot be aborted, so the result is ignored)', async () => {
    const never = { request: () => new Promise<never>(() => undefined) };
    const ctrl = new AbortController();
    const p = sendRequest({ ...base, signal: ctrl.signal }, { native: true, http: never });
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ kind: 'aborted' });
    vi.useFakeTimers();
    const slow = sendRequest({ ...base, timeoutMs: 1000 }, { native: true, http: never });
    const check = expect(slow).rejects.toMatchObject({ kind: 'timeout' });
    await vi.advanceTimersByTimeAsync(1001);
    await check;
    vi.useRealTimers();
  });

  it('uses fetch in a browser and explains CORS failures', async () => {
    const fetchOk = vi.fn().mockResolvedValue(new Response('{"x":1}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const res = await sendRequest({ ...base, method: 'PUT', body: 'b' }, { native: false, fetch: fetchOk });
    expect(fetchOk).toHaveBeenCalledWith(base.url, expect.objectContaining({ method: 'PUT', body: 'b', credentials: 'omit', redirect: 'follow' }));
    expect(res).toMatchObject({ status: 200, via: 'fetch', headers: { 'content-type': 'application/json' } });
    expect(decodeUtf8(res.body)).toBe('{"x":1}');
    const cors = await sendRequest(base, { native: false, fetch: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) }).catch((x: unknown) => x);
    expect((cors as TransportError).kind).toBe('cors');
    expect((cors as TransportError).message).toContain('CORS');
    // Aborting cancels the underlying fetch.
    let seen: AbortSignal | undefined;
    const hang = vi.fn((_u: string, init: RequestInit) => {
      seen = init.signal!;
      return new Promise<Response>(() => undefined);
    });
    const ctrl = new AbortController();
    const p = sendRequest({ ...base, signal: ctrl.signal }, { native: false, fetch: hang as unknown as typeof fetch });
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ kind: 'aborted' });
    expect(seen?.aborted).toBe(true);
  });
});
