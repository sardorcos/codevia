/**
 * Session state shared by the GitHub panels: who is signed in, and API clients. The token itself
 * stays inside auth.ts / the secure store; nothing here renders or logs it.
 */
import { getAccessToken, getSession, signOut, type GitHubSession } from '../../github/auth';
import { GitHubClient } from '../../github/api';

/** What the UI may know about the account (no token). */
export interface AccountInfo {
  login: string;
  name: string | null;
  avatarUrl: string;
  htmlUrl: string;
  kind: GitHubSession['kind'];
}

const listeners = new Set<(account: AccountInfo | null) => void>();

export const toAccount = (s: GitHubSession | null): AccountInfo | null =>
  s ? { login: s.user.login, name: s.user.name, avatarUrl: s.user.avatarUrl, htmlUrl: s.user.htmlUrl, kind: s.kind } : null;

/** The signed-in account, or null (also when the secure store cannot be read). */
export async function currentAccount(): Promise<AccountInfo | null> {
  try {
    return toAccount(await getSession());
  } catch {
    return null;
  }
}

/** Tells every mounted panel that the account changed. */
export function notifyAccount(account: AccountInfo | null): void {
  for (const fn of [...listeners]) fn(account);
}

export function onAccountChange(fn: (account: AccountInfo | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function signOutAndNotify(): Promise<void> {
  await signOut();
  notifyAccount(null);
}

/** Client with the stored token (refreshed when needed). */
export const authedClient = (): GitHubClient => new GitHubClient(getAccessToken);

/** Client without a token: enough for public repositories (60 requests an hour per network). */
export const publicClient = (): GitHubClient => new GitHubClient(() => null);

/** Whether the device reports a connection (a hint only: requests may still fail). */
export const isOnline = (): boolean => (typeof navigator === 'undefined' ? true : navigator.onLine !== false);
