/**
 * GitHub sign-in: OAuth Device Flow for the Codevia GitHub App (no client secret, no redirect URI),
 * with a fine-grained personal access token as the fallback. The session (token + profile) is
 * kept only in the secure store (Keychain on iOS, memory on web).
 */
import { GitHubClient, type GitHubUser } from './api';
import { GitHubError } from './errors';
import { errorFromResponse, githubRequest, type GitHubRequest } from './http';
import { getSecureStore } from './secure-store';

const SESSION_KEY = 'github.session';
const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
/** Refresh this long before the access token actually expires. */
const EXPIRY_MARGIN = 60_000;
/** Consecutive network failures tolerated while polling (phones switch networks). */
const MAX_POLL_NETWORK_ERRORS = 3;

/** Page where the user can revoke the app's access entirely. */
export const GITHUB_AUTHORIZATIONS_URL = 'https://github.com/settings/apps/authorizations';

export interface DeviceFlowStart {
  deviceCode: string;
  /** Code the user types on GitHub, e.g. `WDJB-MJHT`. */
  userCode: string;
  verificationUri: string;
  /** Minimum seconds between polls. */
  interval: number;
  /** When the codes stop working (ms since epoch). */
  expiresAt: number;
}

export interface TokenSet {
  accessToken: string;
  /** Access token expiry (ms since epoch); absent for non-expiring tokens. */
  expiresAt?: number;
  refreshToken?: string;
  refreshTokenExpiresAt?: number;
}

export interface GitHubSession extends TokenSet {
  kind: 'device' | 'pat';
  user: { id: number; login: string; name: string | null; avatarUrl: string; htmlUrl: string };
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
  interval?: number;
}

/**
 * POSTs to an OAuth endpoint on github.com. Those report problems as `{ error }` bodies (with
 * status 200 or 4xx), so such bodies are returned; other failures throw GitHubError.
 */
async function oauthPost<T extends { error?: string }>(url: string, form: Record<string, string>, signal?: AbortSignal): Promise<T> {
  const req: GitHubRequest = { url, method: 'POST', form, signal, allowClientErrors: true };
  const res = await githubRequest<T>(req);
  if (res.status >= 400 && !(res.data && typeof res.data === 'object' && typeof res.data.error === 'string')) {
    throw errorFromResponse(res.status, res.headers, res.data);
  }
  return res.data;
}

/** The GitHub App's client id from the build env; empty when the device flow is not configured. */
export function githubClientId(): string {
  const id: unknown = import.meta.env.VITE_GITHUB_CLIENT_ID;
  return typeof id === 'string' ? id.trim() : '';
}

/**
 * Page where the user chooses which repositories the GitHub App may access (a GitHub App token only
 * sees repositories the app is installed on). Empty when the build has no app slug.
 */
export function githubAppInstallUrl(): string {
  const slug: unknown = import.meta.env.VITE_GITHUB_APP_SLUG;
  return typeof slug === 'string' && /^[a-z0-9-]+$/.test(slug.trim()) ? `https://github.com/apps/${slug.trim()}/installations/new` : '';
}

/** False when the build has no client id: only a personal access token can be used. */
export const isDeviceFlowAvailable = (): boolean => githubClientId() !== '';

function requireClientId(): string {
  const id = githubClientId();
  if (!id) throw new GitHubError('validation', { key: 'device_flow_unavailable' });
  return id;
}

/** Step 1: asks GitHub for a device code and the user code to show. */
export async function startDeviceFlow(signal?: AbortSignal): Promise<DeviceFlowStart> {
  const data = await oauthPost<{
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval?: number;
    error?: string;
  }>(DEVICE_CODE_URL, { client_id: requireClientId() }, signal);
  if (!data || data.error || !data.device_code) {
    throw new GitHubError(data?.error === 'device_flow_disabled' ? 'validation' : 'unknown', {
      key: data?.error === 'device_flow_disabled' ? 'device_flow_unavailable' : undefined,
      detail: data?.error,
    });
  }
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    interval: Math.max(1, data.interval ?? 5),
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function toTokenSet(data: TokenResponse, now = Date.now()): TokenSet {
  const set: TokenSet = { accessToken: data.access_token! };
  if (data.expires_in) set.expiresAt = now + data.expires_in * 1000;
  if (data.refresh_token) set.refreshToken = data.refresh_token;
  if (data.refresh_token_expires_in) set.refreshTokenExpiresAt = now + data.refresh_token_expires_in * 1000;
  return set;
}

/**
 * Step 2: polls until the user approves on GitHub. Handles `authorization_pending`,
 * `slow_down` (+5 s), `expired_token` and `access_denied`. Rejects with an AbortError when
 * `signal` aborts. Pass `expiresAt` from startDeviceFlow to stop as soon as the code expires.
 */
export async function pollForToken(
  deviceCode: string,
  interval: number,
  signal?: AbortSignal,
  expiresAt?: number,
): Promise<TokenSet> {
  const clientId = requireClientId();
  let wait = Math.max(1, interval);
  let networkErrors = 0;
  for (;;) {
    await sleep(wait * 1000, signal);
    if (expiresAt !== undefined && Date.now() >= expiresAt) throw new GitHubError('auth', { key: 'device_code_expired' });
    let data: TokenResponse;
    try {
      data = await oauthPost<TokenResponse>(TOKEN_URL, { client_id: clientId, device_code: deviceCode, grant_type: DEVICE_GRANT }, signal);
      networkErrors = 0;
    } catch (e) {
      if (e instanceof GitHubError && e.code === 'network' && ++networkErrors <= MAX_POLL_NETWORK_ERRORS) continue;
      throw e;
    }
    if (data?.access_token) return toTokenSet(data);
    switch (data?.error) {
      case 'authorization_pending':
        break;
      case 'slow_down':
        wait = Math.max(wait + 5, data.interval ?? 0);
        break;
      case 'expired_token':
        throw new GitHubError('auth', { key: 'device_code_expired' });
      case 'access_denied':
        throw new GitHubError('auth', { key: 'access_denied' });
      default:
        throw new GitHubError('unknown', { detail: data?.error_description ?? data?.error ?? 'Unexpected token response' });
    }
  }
}

function sessionFrom(tokens: TokenSet, user: GitHubUser, kind: GitHubSession['kind']): GitHubSession {
  return {
    ...tokens,
    kind,
    user: { id: user.id, login: user.login, name: user.name, avatarUrl: user.avatar_url, htmlUrl: user.html_url },
  };
}

async function saveSession(session: GitHubSession): Promise<void> {
  await getSecureStore().set(SESSION_KEY, JSON.stringify(session));
}

/** Step 3: loads the profile with the new token and stores the session. */
export async function completeDeviceSignIn(tokens: TokenSet): Promise<GitHubSession> {
  const user = await new GitHubClient(() => tokens.accessToken).getUser();
  const session = sessionFrom(tokens, user, 'device');
  await saveSession(session);
  return session;
}

/** Signs in with a personal access token, validated with `GET /user`. */
export async function signInWithToken(pat: string): Promise<GitHubSession> {
  const token = pat.trim();
  if (!token || /\s/.test(token)) throw new GitHubError('auth', { key: 'invalid_token' });
  let user: GitHubUser;
  try {
    user = await new GitHubClient(() => token).getUser();
  } catch (e) {
    if (e instanceof GitHubError && e.status === 401) throw new GitHubError('auth', { status: 401, key: 'invalid_token' });
    throw e;
  }
  const session = sessionFrom({ accessToken: token }, user, 'pat');
  await saveSession(session);
  return session;
}

/** The stored session, or null. The access token may be expired; use getAccessToken for requests. */
export async function getSession(): Promise<GitHubSession | null> {
  const raw = await getSecureStore().get(SESSION_KEY);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as GitHubSession;
    if (typeof s?.accessToken === 'string' && s.user?.login) return s;
  } catch {
    /* fall through: unreadable entry */
  }
  await getSecureStore().remove(SESSION_KEY);
  return null;
}

/** Removes the token from the secure store. Full revocation happens at GITHUB_AUTHORIZATIONS_URL. */
export async function signOut(): Promise<void> {
  await getSecureStore().remove(SESSION_KEY);
}

let refreshing: Promise<GitHubSession> | null = null;

/**
 * Tries the refresh-token grant. GitHub may require a client secret for it, which the app
 * must not contain; then this fails and the user simply runs the device flow again.
 */
async function refreshSession(session: GitHubSession): Promise<GitHubSession> {
  const clientId = githubClientId();
  const usable =
    clientId && session.refreshToken && (!session.refreshTokenExpiresAt || session.refreshTokenExpiresAt > Date.now());
  if (!usable) throw new GitHubError('auth', { key: 'session_expired' });
  let data: TokenResponse;
  try {
    data = await oauthPost<TokenResponse>(TOKEN_URL, {
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: session.refreshToken!,
    });
  } catch (e) {
    if (e instanceof GitHubError && e.code === 'network') throw e;
    throw new GitHubError('auth', { key: 'session_expired' });
  }
  if (!data?.access_token) throw new GitHubError('auth', { key: 'session_expired', detail: data?.error });
  const next: GitHubSession = { ...session, ...toTokenSet(data) };
  await saveSession(next);
  return next;
}

/**
 * A usable access token: refreshes an expiring device-flow token when possible.
 * Null when not signed in; throws GitHubError(`auth`, `session_expired`) when the user must reconnect.
 */
export async function getAccessToken(): Promise<string | null> {
  const session = await getSession();
  if (!session) return null;
  if (!session.expiresAt || session.expiresAt - EXPIRY_MARGIN > Date.now()) return session.accessToken;
  refreshing ??= refreshSession(session).finally(() => (refreshing = null));
  return (await refreshing).accessToken;
}
