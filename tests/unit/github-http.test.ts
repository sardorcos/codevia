import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHubClient, nextLink } from '../../src/github/api';
import { GitHubError } from '../../src/github/errors';
import { assertAllowedUrl, errorFromResponse, githubRequest } from '../../src/github/http';

type Call = { url: string; init: RequestInit };
let calls: Call[];
let responder: (url: string, init: RequestInit) => Response;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const headersOf = (c: Call) => (c.init.headers ?? {}) as Record<string, string>;

beforeEach(() => {
  calls = [];
  responder = () => json({});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return responder(url, init);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('allowlist', () => {
  it('accepts only https GitHub hosts', () => {
    for (const ok of ['https://github.com/login', 'https://api.github.com/user', 'https://codeload.github.com/x', 'https://uploads.github.com/y']) {
      expect(() => assertAllowedUrl(ok)).not.toThrow();
    }
    for (const bad of [
      'http://api.github.com/user',
      'https://evil.com/',
      'https://api.github.com.evil.com/',
      'https://gist.github.com/',
      'https://user:pw@api.github.com/',
      'not a url',
    ]) {
      expect(() => assertAllowedUrl(bad), bad).toThrow(GitHubError);
    }
  });

  it('never sends requests to other hosts', async () => {
    await expect(githubRequest({ url: 'https://example.com/steal', token: 'secret' })).rejects.toMatchObject({ key: 'host_not_allowed' });
    expect(calls).toHaveLength(0);
  });

  it('refuses redirects to other hosts', async () => {
    responder = (url) => (url.includes('api.github.com') ? new Response(null, { status: 302, headers: { location: 'https://evil.example/x' } }) : json({}));
    await expect(githubRequest({ url: 'https://api.github.com/repos/o/r/zipball/main', token: 't' })).rejects.toMatchObject({ key: 'host_not_allowed' });
    expect(calls).toHaveLength(1);
  });
});

describe('token handling', () => {
  it('attaches the token and API headers only for api.github.com', async () => {
    await githubRequest({ url: 'https://api.github.com/user', token: 'tok123' });
    await githubRequest({ url: 'https://github.com/login/oauth/access_token', method: 'POST', form: { a: 'b' }, token: 'tok123' });
    await githubRequest({ url: 'https://codeload.github.com/o/r/zip/main', token: 'tok123', responseType: 'binary' });
    const [api, login, codeload] = calls.map(headersOf);
    expect(api).toMatchObject({ Authorization: 'Bearer tok123', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' });
    expect(login!['Authorization']).toBeUndefined();
    expect(login!['Accept']).toBe('application/json');
    expect(login!['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(calls[1]!.init.body).toBe('a=b');
    expect(codeload!['Authorization']).toBeUndefined();
    expect(codeload!['X-GitHub-Api-Version']).toBeUndefined();
  });

  it('a caller-supplied Authorization header is dropped', async () => {
    await githubRequest({ url: 'https://github.com/x', headers: { authorization: 'Bearer leaked' } });
    expect(Object.keys(headersOf(calls[0]!)).map((k) => k.toLowerCase())).not.toContain('authorization');
  });

  it('follows a redirect to codeload without the token and returns bytes', async () => {
    responder = (url) =>
      url.startsWith('https://api.github.com')
        ? new Response(null, { status: 302, headers: { location: 'https://codeload.github.com/o/r/legacy.zip/main?token=abc' } })
        : new Response(new Uint8Array([80, 75, 5, 6]), { status: 200, headers: { 'content-type': 'application/zip' } });
    const client = new GitHubClient(() => 'tok');
    const bytes = await client.downloadZipball('o', 'r', 'main');
    expect(bytes).toEqual(new Uint8Array([80, 75, 5, 6]));
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.github.com/repos/o/r/zipball/main',
      'https://codeload.github.com/o/r/legacy.zip/main?token=abc',
    ]);
    expect(headersOf(calls[0]!)['Authorization']).toBe('Bearer tok');
    expect(headersOf(calls[1]!)['Authorization']).toBeUndefined();
  });

  it('error messages and details never contain the token', async () => {
    responder = () => json({ message: 'Bad credentials for token ghp_abcdefghijklmnopqrstuvwxyz0123456789' }, 401);
    const err = (await githubRequest({ url: 'https://api.github.com/user', token: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' }).catch((e) => e)) as GitHubError;
    expect(err.code).toBe('auth');
    expect(JSON.stringify({ m: err.message, d: err.detail, s: String(err) })).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  });
});

describe('errors', () => {
  it('maps statuses to codes', () => {
    expect(errorFromResponse(401, {}, null).code).toBe('auth');
    expect(errorFromResponse(403, {}, { message: 'Resource not accessible by integration' })).toMatchObject({ code: 'auth', key: 'forbidden' });
    expect(errorFromResponse(404, {}, null).code).toBe('not_found');
    expect(errorFromResponse(409, {}, { message: 'Git Repository is empty.' })).toMatchObject({ code: 'validation', key: 'repo_empty' });
    expect(errorFromResponse(422, {}, { message: 'Validation Failed' })).toMatchObject({ code: 'validation', detail: 'Validation Failed' });
    expect(errorFromResponse(500, {}, null).code).toBe('unknown');
  });

  it('reads the rate-limit reset from headers', () => {
    const e = errorFromResponse(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1700000000' }, { message: 'API rate limit exceeded' });
    expect(e).toMatchObject({ code: 'rate_limit', resetAt: 1_700_000_000_000 });
    const before = Date.now();
    const s = errorFromResponse(429, { 'retry-after': '30' }, null);
    expect(s.code).toBe('rate_limit');
    expect(s.resetAt!).toBeGreaterThanOrEqual(before + 30_000);
  });

  it('network failures become network errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    await expect(githubRequest({ url: 'https://api.github.com/user' })).rejects.toMatchObject({ code: 'network' });
  });

  it('OAuth error bodies can be returned instead of thrown', async () => {
    responder = () => json({ error: 'authorization_pending' }, 400);
    const res = await githubRequest<{ error: string }>({ url: 'https://github.com/login/oauth/access_token', method: 'POST', allowClientErrors: true });
    expect(res.data.error).toBe('authorization_pending');
  });
});

describe('api client', () => {
  it('paginates with the Link header and sends query params', async () => {
    responder = (url) =>
      url.includes('page=2')
        ? json([{ name: 'b' }])
        : json([{ name: 'a' }], 200, { link: '<https://api.github.com/user/repos?page=2>; rel="next", <https://api.github.com/user/repos?page=2>; rel="last"' });
    const repos = await new GitHubClient(() => 't').listRepos();
    expect(repos.map((r) => r.name)).toEqual(['a', 'b']);
    const first = new URL(calls[0]!.url);
    expect(first.searchParams.get('sort')).toBe('pushed');
    expect(first.searchParams.get('per_page')).toBe('100');
    expect(nextLink(undefined)).toBeNull();
  });

  it('getBranch returns commit and tree SHAs; branch names keep slashes', async () => {
    responder = () => json({ name: 'feature/x', commit: { sha: 'c1', commit: { tree: { sha: 't1' } } } });
    const head = await new GitHubClient(() => 't').getBranch('o', 'r', 'feature/x');
    expect(head).toEqual({ name: 'feature/x', commitSha: 'c1', treeSha: 't1' });
    expect(calls[0]!.url).toBe('https://api.github.com/repos/o/r/branches/feature/x');
  });

  it('decodes blobs and encodes uploads as base64', async () => {
    responder = (_url, init) =>
      init.method === 'POST' ? json({ sha: 'new' }, 201) : json({ content: 'aGVs\nbG8K\n', encoding: 'base64' });
    const client = new GitHubClient(() => 't');
    expect(new TextDecoder().decode(await client.getBlob('o', 'r', 's'))).toBe('hello\n');
    expect(await client.createBlob('o', 'r', new TextEncoder().encode('hello\n'))).toBe('new');
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({ content: 'aGVsbG8K', encoding: 'base64' });
  });

  it('createTree / updateRef send the right payloads; createRepo is private by default', async () => {
    const client = new GitHubClient(() => 't');
    await client.createTree('o', 'r', 'base', [{ path: 'a', mode: '100644', type: 'blob', sha: null }]);
    await client.updateRef('o', 'r', 'main', 'c2');
    await client.createRepo({ name: 'site' });
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ base_tree: 'base', tree: [{ path: 'a', mode: '100644', type: 'blob', sha: null }] });
    expect(calls[1]!.init.method).toBe('PATCH');
    expect(calls[1]!.url).toBe('https://api.github.com/repos/o/r/git/refs/heads/main');
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({ sha: 'c2', force: false });
    expect(JSON.parse(calls[2]!.init.body as string)).toMatchObject({ name: 'site', private: true, auto_init: true });
  });

  it('getTree reports truncation; getPages returns null when disabled', async () => {
    responder = (url) => (url.includes('/pages') ? json({ message: 'Not Found' }, 404) : json({ sha: 't', tree: [], truncated: true }));
    const client = new GitHubClient(() => 't');
    expect((await client.getTree('o', 'r', 't')).truncated).toBe(true);
    expect(new URL(calls[0]!.url).searchParams.get('recursive')).toBe('1');
    expect(await client.getPages('o', 'r')).toBeNull();
    expect(await client.latestPagesBuild('o', 'r')).toBeNull();
  });
});
