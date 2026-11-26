/**
 * Typed errors for the GitHub integration. User-facing texts live in one English map so the UI can
 * translate them by key; `GitHubError.key` names the entry, `message` is its English text.
 */

export type GitHubErrorCode = 'auth' | 'not_found' | 'conflict' | 'rate_limit' | 'network' | 'validation' | 'unknown';

/** English user-facing messages, keyed by error code or by a more specific reason. */
export const GITHUB_MESSAGES = {
  auth: 'GitHub did not accept the sign-in. Connect your account again.',
  not_found: 'Not found on GitHub, or the app has no access to it.',
  conflict: 'The branch changed on GitHub. Get the latest changes first, then push again.',
  rate_limit: 'GitHub request limit reached. Try again later.',
  network: 'Could not reach GitHub. Check your connection.',
  validation: 'GitHub rejected the request.',
  unknown: 'Something went wrong while talking to GitHub.',
  forbidden: 'The app does not have permission for this. Check which repositories it can access on GitHub.',
  session_expired: 'Your GitHub session has expired. Connect your account again.',
  host_not_allowed: 'This address is not allowed.',
  device_flow_unavailable: 'Sign-in with GitHub is not set up in this build. Use a personal access token instead.',
  device_code_expired: 'The code has expired. Start connecting again.',
  access_denied: 'Access was denied on GitHub.',
  invalid_token: 'This token is not valid. Check that it was copied completely.',
  repo_empty: 'This repository is empty.',
  repo_too_large: 'This repository is too large to download.',
  tree_truncated: 'This repository has too many files. Choose a subfolder to work with.',
  subdir_not_found: 'This folder does not exist in the repository.',
  zip_invalid: 'The repository archive could not be read.',
  nothing_to_push: 'There are no changes to push.',
} as const;

export type GitHubMessageKey = keyof typeof GITHUB_MESSAGES;

export interface GitHubErrorInit {
  status?: number;
  /** Specific message key; defaults to the code. */
  key?: GitHubMessageKey;
  /** Developer detail (GitHub's own message), already free of secrets. */
  detail?: string;
  /** For `rate_limit`: when requests are allowed again (ms since epoch). */
  resetAt?: number;
}

export class GitHubError extends Error {
  readonly status: number;
  readonly code: GitHubErrorCode;
  readonly key: GitHubMessageKey;
  readonly detail?: string;
  readonly resetAt?: number;

  constructor(code: GitHubErrorCode, init: GitHubErrorInit = {}) {
    const key = init.key ?? code;
    super(GITHUB_MESSAGES[key]);
    this.name = 'GitHubError';
    this.code = code;
    this.key = key;
    this.status = init.status ?? 0;
    if (init.detail) this.detail = redactSecrets(init.detail).slice(0, 500);
    if (init.resetAt !== undefined) this.resetAt = init.resetAt;
  }
}

export const isGitHubError = (e: unknown): e is GitHubError => e instanceof GitHubError;

/** Removes anything that looks like a GitHub token or bearer credential from a string. */
export function redactSecrets(s: string): string {
  return s
    .replace(/\b(gh[pousr]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+)/g, '[redacted]')
    .replace(/(bearer|token)\s+[A-Za-z0-9._-]+/gi, '$1 [redacted]');
}
