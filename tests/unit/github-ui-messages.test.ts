import { afterEach, describe, expect, it } from 'vitest';
import { englishTexts, setLang } from '../../src/i18n';
import { en as core } from '../../src/i18n/en';
import githubEn from '../../src/i18n/en/github';
import { GITHUB_MESSAGES, GitHubError, type GitHubMessageKey } from '../../src/github/errors';
import { SECRET_MESSAGES, type SecretReason } from '../../src/github/secrets';
import { errorText, githubMessageTexts, needsSignIn, PagesBuildError, secretText, secretTexts, StaleProjectError } from '../../src/tools/github/messages';

afterEach(() => setLang('ru'));

describe('GitHub error texts', () => {
  it('has a translated text for every GITHUB_MESSAGES key', () => {
    setLang('ru');
    const texts = githubMessageTexts();
    expect(Object.keys(texts).sort()).toEqual(Object.keys(GITHUB_MESSAGES).sort());
    for (const [key, text] of Object.entries(texts)) expect(text, key).toMatch(/[А-Яа-яЁё]/);
  });

  it('in English, matches the core’s English messages exactly', () => {
    setLang('en');
    for (const key of Object.keys(GITHUB_MESSAGES) as GitHubMessageKey[]) {
      const code = key in { auth: 1, not_found: 1, conflict: 1, rate_limit: 1, network: 1, validation: 1, unknown: 1 } ? key : 'validation';
      expect(errorText(new GitHubError(code as GitHubError['code'], { key })), key).toBe(GITHUB_MESSAGES[key]);
    }
  });

  it('has a translated text for every SECRET_MESSAGES reason', () => {
    setLang('en');
    expect(Object.keys(secretTexts()).sort()).toEqual(Object.keys(SECRET_MESSAGES).sort());
    for (const reason of Object.keys(SECRET_MESSAGES) as SecretReason[]) expect(secretText(reason)).toBe(SECRET_MESSAGES[reason]);
  });

  it('adds when to retry after a rate limit', () => {
    setLang('en');
    const e = new GitHubError('rate_limit', { status: 403, resetAt: Date.now() + 5 * 60_000 });
    expect(errorText(e)).toBe(`${GITHUB_MESSAGES.rate_limit} Try again in 5 min.`);
  });

  it('never shows GitHub’s detail or anything token-like', () => {
    setLang('en');
    const e = new GitHubError('unknown', { detail: 'Bad credentials for ghp_abcdefghijklmnopqrstuvwxyz0123456789' });
    expect(errorText(e)).toBe(GITHUB_MESSAGES.unknown);
    expect(errorText(new Error('token ghp_secret leaked'))).toBe(GITHUB_MESSAGES.unknown);
    expect(errorText(new StaleProjectError())).toMatch(/changed/);
    expect(errorText(new PagesBuildError('x'))).toMatch(/build/);
    expect(errorText(new DOMException('Aborted', 'AbortError'))).toBe('Cancelled.');
  });

  it('knows which errors need signing in again', () => {
    expect(needsSignIn(new GitHubError('auth', { key: 'session_expired' }))).toBe(true);
    expect(needsSignIn(new GitHubError('auth', { status: 401 }))).toBe(true);
    expect(needsSignIn(new GitHubError('auth', { key: 'forbidden' }))).toBe(false);
    expect(needsSignIn(new GitHubError('network'))).toBe(false);
  });
});

describe('en/github.ts', () => {
  const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

  it('keeps placeholders, has no Russian left and agrees with the core dictionary on shared keys', () => {
    for (const [key, value] of Object.entries(githubEn)) {
      for (const form of value.split('|')) expect(placeholders(form), key).toEqual(placeholders(key));
      expect(value, key).not.toMatch(/[А-Яа-яЁё«»]/);
      if (Object.prototype.hasOwnProperty.call(core, key)) expect(value, key).toBe(core[key]);
    }
  });

  it('is part of the English dictionary', () => {
    expect(englishTexts()['Закоммитить и отправить']).toBe('Commit & Push');
  });
});
