import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAccessToken,
  getSession,
  isDeviceFlowAvailable,
  pollForToken,
  signInWithToken,
  signOut,
  startDeviceFlow,
  completeDeviceSignIn,
} from '../../src/github/auth';
import { GitHubError } from '../../src/github/errors';
import { createMemoryStore, setSecureStore, type SecureStore } from '../../src/github/secure-store';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const USER = { login: 'octo', id: 1, name: 'Octo Cat', avatar_url: 'https://avatars/1', html_url: 'https://github.com/octo' };

let tokenReplies: unknown[];
let fetchMock: ReturnType<typeof vi.fn>;
let store: SecureStore;

beforeEach(() => {
  vi.stubEnv('VITE_GITHUB_CLIENT_ID', 'Iv1.test');
  store = createMemoryStore();
  setSecureStore(store);
  tokenReplies = [];
  fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    if (url === 'https://github.com/login/device/code') {
      return json({ device_code: 'dc', user_code: 'WDJB-MJHT', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 });
    }
    if (url === 'https://github.com/login/oauth/access_token') {
      const next = tokenReplies.shift();
      if (next instanceof Error) throw next;
      return json(next ?? { error: 'authorization_pending' }, (next as { status?: number })?.status ?? 200);
    }
    if (url === 'https://api.github.com/user') {
      const auth = (init.headers as Record<string, string>)['Authorization'];
      return auth === 'Bearer good' || auth === 'Bearer gho_new' || auth === 'Bearer refreshed' ? json(USER) : json({ message: 'Bad credentials' }, 401);
    }
    return json({ message: 'Not Found' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  setSecureStore(null);
});

const tokenCalls = () => fetchMock.mock.calls.filter(([u]) => u === 'https://github.com/login/oauth/access_token');

describe('device flow', () => {
  it('is unavailable without a client id', async () => {
    vi.stubEnv('VITE_GITHUB_CLIENT_ID', '');
    expect(isDeviceFlowAvailable()).toBe(false);
    await expect(startDeviceFlow()).rejects.toMatchObject({ key: 'device_flow_unavailable' });
  });

  it('starts with the client id and returns the user code', async () => {
    const before = Date.now();
    const start = await startDeviceFlow();
    expect(start).toMatchObject({ deviceCode: 'dc', userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device', interval: 5 });
    expect(start.expiresAt).toBeGreaterThanOrEqual(before + 900_000);
    expect(fetchMock.mock.calls[0]![1].body).toBe('client_id=Iv1.test');
  });

  it('polls through pending and slow_down (+5 s) until a token arrives', async () => {
    vi.useFakeTimers();
    tokenReplies = [
      { error: 'authorization_pending' },
      { error: 'slow_down', interval: 10 },
      { error: 'authorization_pending', status: 400 },
      { access_token: 'gho_new', expires_in: 28800, refresh_token: 'ghr_r', refresh_token_expires_in: 15897600 },
    ];
    const p = pollForToken('dc', 5);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(tokenCalls()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(tokenCalls()).toHaveLength(1); // pending
    await vi.advanceTimersByTimeAsync(5_000);
    expect(tokenCalls()).toHaveLength(2); // slow_down → interval becomes 10 s
    await vi.advanceTimersByTimeAsync(9_999);
    expect(tokenCalls()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(tokenCalls()).toHaveLength(3); // pending (as 400)
    await vi.advanceTimersByTimeAsync(10_000);
    const tokens = await p;
    expect(tokenCalls()).toHaveLength(4);
    expect(tokens.accessToken).toBe('gho_new');
    expect(tokens.refreshToken).toBe('ghr_r');
    expect(tokens.expiresAt).toBe(Date.now() + 28_800_000);
    expect(tokenCalls()[0]![1].body).toBe('client_id=Iv1.test&device_code=dc&grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code');
  });

  it('slow_down without an interval adds 5 seconds', async () => {
    vi.useFakeTimers();
    tokenReplies = [{ error: 'slow_down' }, { access_token: 'x' }];
    const p = pollForToken('dc', 5);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(tokenCalls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await p).accessToken).toBe('x');
  });

  it('stops on expired_token and access_denied', async () => {
    vi.useFakeTimers();
    tokenReplies = [{ error: 'expired_token' }];
    const expired = pollForToken('dc', 1).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await expired).toMatchObject({ code: 'auth', key: 'device_code_expired' });

    tokenReplies = [{ error: 'access_denied' }];
    const denied = pollForToken('dc', 1).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await denied).toMatchObject({ code: 'auth', key: 'access_denied' });
  });

  it('stops locally once the code expiry passes', async () => {
    vi.useFakeTimers();
    const p = pollForToken('dc', 5, undefined, Date.now() + 7_000).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await p).toMatchObject({ key: 'device_code_expired' });
    expect(tokenCalls()).toHaveLength(1);
  });

  it('tolerates a few network errors, then gives up', async () => {
    vi.useFakeTimers();
    tokenReplies = [new TypeError('offline'), { access_token: 'ok' }];
    const p = pollForToken('dc', 1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await p).accessToken).toBe('ok');

    tokenReplies = [1, 2, 3, 4].map(() => new TypeError('offline'));
    const q = pollForToken('dc', 1).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await q).toMatchObject({ code: 'network' });
  });

  it('can be aborted', async () => {
    vi.useFakeTimers();
    const ctrl = new AbortController();
    const p = pollForToken('dc', 5, ctrl.signal).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    ctrl.abort();
    const err = await p;
    expect((err as Error).name).toBe('AbortError');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tokenCalls()).toHaveLength(1);
  });

  it('completes sign-in: loads the profile and stores the session in the secure store only', async () => {
    const session = await completeDeviceSignIn({ accessToken: 'gho_new', expiresAt: Date.now() + 3_600_000, refreshToken: 'ghr' });
    expect(session.user).toEqual({ id: 1, login: 'octo', name: 'Octo Cat', avatarUrl: 'https://avatars/1', htmlUrl: 'https://github.com/octo' });
    expect(session.kind).toBe('device');
    expect(JSON.parse((await store.get('github.session'))!).accessToken).toBe('gho_new');
    expect(await getAccessToken()).toBe('gho_new');
  });
});

describe('personal access token', () => {
  it('validates the token with GET /user', async () => {
    const session = await signInWithToken('  good \n');
    expect(session).toMatchObject({ kind: 'pat', accessToken: 'good', user: { login: 'octo' } });
    expect((await getSession())?.user.login).toBe('octo');
  });

  it('rejects an invalid token and stores nothing', async () => {
    const err = await signInWithToken('bad').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect(err).toMatchObject({ code: 'auth', key: 'invalid_token' });
    expect(await getSession()).toBeNull();
  });

  it('signOut removes the session', async () => {
    await signInWithToken('good');
    await signOut();
    expect(await getSession()).toBeNull();
    expect(await getAccessToken()).toBeNull();
  });
});

describe('token refresh', () => {
  const expired = { accessToken: 'old', expiresAt: Date.now() - 1, refreshToken: 'ghr', kind: 'device', user: { id: 1, login: 'octo', name: null, avatarUrl: '', htmlUrl: '' } };

  it('refreshes an expired device token when GitHub allows it', async () => {
    await store.set('github.session', JSON.stringify(expired));
    tokenReplies = [{ access_token: 'refreshed', expires_in: 28800 }];
    expect(await getAccessToken()).toBe('refreshed');
    expect(tokenCalls()[0]![1].body).toBe('client_id=Iv1.test&grant_type=refresh_token&refresh_token=ghr');
    expect((await getSession())?.accessToken).toBe('refreshed');
  });

  it('asks to reconnect when the refresh is refused', async () => {
    await store.set('github.session', JSON.stringify(expired));
    tokenReplies = [{ error: 'incorrect_client_credentials' }];
    await expect(getAccessToken()).rejects.toMatchObject({ code: 'auth', key: 'session_expired' });
  });

  it('drops an unreadable stored session', async () => {
    await store.set('github.session', '{broken');
    expect(await getSession()).toBeNull();
    expect(await store.get('github.session')).toBeNull();
  });
});
