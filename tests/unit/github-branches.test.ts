import { describe, expect, it } from 'vitest';
import { branchNameProblem } from '../../src/tools/github/parse';
import { FakeGitHub } from './helpers/fake-github';

describe('branch names', () => {
  it('accepts normal names and rejects what git rejects', () => {
    for (const ok of ['feature/login', 'fix-123', 'release/1.1.0', 'user/anna/try']) expect(branchNameProblem(ok), ok).toBeNull();
    expect(branchNameProblem('  ')).toBe('empty');
    for (const bad of ['has space', 'a..b', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', '/lead', 'trail/', 'end.', 'x.lock', 'a//b', '@', 'a@{b', '.hidden', 'dir/.dot'])
      expect(branchNameProblem(bad), bad).toBe('invalid');
  });
});

describe('branches and pull requests on the fake GitHub', () => {
  it('creates a branch, refuses duplicates, opens one PR per head and refuses an empty PR', async () => {
    const gh = new FakeGitHub();
    const base = await gh.commit('main', { 'index.html': '<h1>Hi</h1>' });
    await gh.createBranch('o', 'r', 'feature/a', base);
    await expect(gh.createBranch('o', 'r', 'feature/a', base)).rejects.toMatchObject({ status: 422 });
    await expect(gh.createPullRequest('o', 'r', { title: 'Empty', head: 'feature/a', base: 'main' })).rejects.toMatchObject({ status: 422 });
    await gh.commit('feature/a', { 'index.html': '<h1>Hello</h1>' });
    const pr = await gh.createPullRequest('o', 'r', { title: 'Greeting', head: 'feature/a', base: 'main' });
    expect(pr.number).toBe(1);
    expect(await gh.findPullRequest('o', 'r', 'feature/a', 'main')).toMatchObject({ number: 1, title: 'Greeting' });
    expect(await gh.findPullRequest('o', 'r', 'feature/b', 'main')).toBeNull();
  });
});
