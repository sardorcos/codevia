import { describe, expect, it } from 'vitest';
import {
  commitWebUrl,
  defaultPagesUrl,
  parseRepoInput,
  repoWebUrl,
  resolveTreePath,
  suggestRepoName,
  validateRepoName,
} from '../../src/tools/github/parse';

describe('parseRepoInput', () => {
  it('accepts owner/repo and GitHub URLs in their usual forms', () => {
    const want = { owner: 'sardorcos', repo: 'codevia' };
    for (const input of [
      'sardorcos/codevia',
      'sardorcos/codevia.git',
      '  sardorcos/codevia  ',
      'https://github.com/sardorcos/codevia',
      'https://github.com/sardorcos/codevia/',
      'https://github.com/sardorcos/codevia.git',
      'http://github.com/sardorcos/codevia',
      'https://www.github.com/sardorcos/codevia',
      'github.com/sardorcos/codevia',
      'https://github.com/sardorcos/codevia?tab=readme#top',
      'https://github.com/sardorcos/codevia/issues/12',
      'git@github.com:sardorcos/codevia.git',
      'ssh://git@github.com/sardorcos/codevia.git',
    ]) {
      expect(parseRepoInput(input), input).toEqual(want);
    }
  });

  it('reads branch and subfolder from /tree/ links, and the folder of a /blob/ link', () => {
    expect(parseRepoInput('https://github.com/o/r/tree/main')).toEqual({ owner: 'o', repo: 'r', branch: 'main', treePath: ['main'] });
    expect(parseRepoInput('https://github.com/o/r/tree/dev/apps/site/')).toEqual({
      owner: 'o',
      repo: 'r',
      branch: 'dev',
      subdir: 'apps/site',
      treePath: ['dev', 'apps', 'site'],
    });
    expect(parseRepoInput('o/r/tree/main/docs')).toMatchObject({ branch: 'main', subdir: 'docs' });
    expect(parseRepoInput('https://github.com/o/r/blob/main/site/index.html')).toMatchObject({ branch: 'main', subdir: 'site' });
    expect(parseRepoInput('https://github.com/o/r/blob/main/index.html')).toMatchObject({ branch: 'main', treePath: ['main'] });
    expect(parseRepoInput('https://github.com/o/r/tree/f%C3%A9ature')).toMatchObject({ branch: 'féature' });
  });

  it('rejects other hosts and malformed input', () => {
    for (const bad of [
      '',
      'codevia',
      'https://gitlab.com/o/r',
      'https://github.com.evil.com/o/r',
      'https://gist.github.com/o/r',
      'ftp://github.com/o/r',
      'o r/x',
      '-bad/repo',
      'bad-/repo',
      'a--b/repo',
      `${'x'.repeat(40)}/repo`,
      'o/..',
      'o/re po',
      'javascript:alert(1)',
      'https://github.com/o',
    ]) {
      expect(parseRepoInput(bad), bad).toBeNull();
    }
  });
});

describe('resolveTreePath', () => {
  it('prefers the longest matching branch name', () => {
    expect(resolveTreePath(['feature', 'x', 'src'], ['main', 'feature/x'])).toEqual({ branch: 'feature/x', subdir: 'src' });
    expect(resolveTreePath(['feature', 'x'], ['feature', 'feature/x'])).toEqual({ branch: 'feature/x' });
    expect(resolveTreePath(['main', 'a', 'b'], ['main'])).toEqual({ branch: 'main', subdir: 'a/b' });
    expect(resolveTreePath(['nope'], ['main'])).toBeNull();
  });
});

describe('repository names', () => {
  it('validates against GitHub rules', () => {
    expect(validateRepoName('my-site_2.0')).toBeNull();
    expect(validateRepoName('')).toBe('empty');
    expect(validateRepoName('x'.repeat(101))).toBe('too_long');
    expect(validateRepoName('x'.repeat(100))).toBeNull();
    expect(validateRepoName('мой')).toBe('chars');
    expect(validateRepoName('a b')).toBe('chars');
    expect(validateRepoName('a/b')).toBe('chars');
    expect(validateRepoName('.')).toBe('reserved');
    expect(validateRepoName('..')).toBe('reserved');
    expect(validateRepoName('site.git')).toBe('git_suffix');
    expect(validateRepoName('site.GIT')).toBe('git_suffix');
  });

  it('suggests a valid name from a project name', () => {
    expect(suggestRepoName('Мой сайт')).toBe('moy-sayt');
    expect(suggestRepoName('Portfolio 2024!')).toBe('portfolio-2024');
    expect(suggestRepoName('Café — menu')).toBe('cafe-menu');
    expect(suggestRepoName('  ...dots...  ')).toBe('dots');
    expect(suggestRepoName('app.git')).toBe('app');
    expect(suggestRepoName('日本語')).toBe('codevia-project');
    expect(suggestRepoName('')).toBe('codevia-project');
    const long = suggestRepoName('a'.repeat(150));
    expect(long).toHaveLength(100);
    for (const n of ['Мой сайт', 'x'.repeat(300), 'Тест.git', '-x-']) expect(validateRepoName(suggestRepoName(n)), n).toBeNull();
  });
});

describe('URLs', () => {
  it('builds github.com and Pages addresses', () => {
    expect(repoWebUrl({ owner: 'o', repo: 'r' })).toBe('https://github.com/o/r');
    expect(repoWebUrl({ owner: 'o', repo: 'r', branch: 'feature/x', subdir: 'my site' })).toBe('https://github.com/o/r/tree/feature/x/my%20site');
    expect(commitWebUrl({ owner: 'o', repo: 'r' }, 'abc')).toBe('https://github.com/o/r/commit/abc');
    expect(defaultPagesUrl('Octo', 'site')).toBe('https://octo.github.io/site/');
    expect(defaultPagesUrl('Octo', 'octo.github.io')).toBe('https://octo.github.io/');
  });
});
