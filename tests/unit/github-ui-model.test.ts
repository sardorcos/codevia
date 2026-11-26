import { describe, expect, it } from 'vitest';
import { encodeUtf8 } from '../../src/core/bytes';
import { textFile, type GitHubLink } from '../../src/core/types';
import { gitBlobSha1, type PullPlan, type PushChange, type PushPlan } from '../../src/github/sync';
import { ChangesModel, commitMessage, ConflictState, githubBadge, pullSummary, quickStatus } from '../../src/tools/github/model';
import { filterRepos, orderBranches } from '../../src/tools/github/repo-picker';
import { makeProject } from './helpers/fake-github';

const change = (path: string, status: PushChange['status'], secret?: PushChange['secret']): PushChange =>
  secret ? { path, status, secret, file: textFile('x') } : status === 'deleted' ? { path, status } : { path, status, file: textFile('x') };

const plan = (changes: PushChange[], ignored: string[] = []): PushPlan => ({
  changes,
  ignored,
  secrets: changes.filter((c) => c.secret).map((c) => ({ path: c.path, reason: c.secret! })),
});

describe('ChangesModel', () => {
  const base = () =>
    plan(
      [change('a.css', 'modified'), change('b.js', 'added'), change('.env', 'added', 'env_file'), change('old.txt', 'deleted'), change('c.html', 'modified')],
      ['debug.log'],
    );

  it('groups Modified / Added / Deleted and keeps the plan order inside groups', () => {
    const m = new ChangesModel(base());
    const g = m.groups();
    expect(g.modified.map((i) => i.path)).toEqual(['a.css', 'c.html']);
    expect(g.added.map((i) => i.path)).toEqual(['b.js', '.env']);
    expect(g.deleted.map((i) => i.path)).toEqual(['old.txt']);
    expect(m.ignored).toEqual(['debug.log']);
    expect(m.total).toBe(5);
  });

  it('selects everything except secrets at first', () => {
    const m = new ChangesModel(base());
    expect(m.selectedCount).toBe(4);
    expect(m.item('.env')!.selected).toBe(false);
    expect(m.allSelected).toBe(true);
    expect(m.block()).toBeNull();
    expect(m.selectedChanges().map((c) => c.path)).toEqual(['a.css', 'b.js', 'old.txt', 'c.html']);
  });

  it('toggles, selects all / none (never secrets in bulk), and blocks an empty commit', () => {
    const m = new ChangesModel(base());
    m.toggle('a.css');
    expect(m.item('a.css')!.selected).toBe(false);
    expect(m.allSelected).toBe(false);
    m.selectAll(true);
    expect(m.item('a.css')!.selected).toBe(true);
    expect(m.item('.env')!.selected).toBe(false);
    m.selectAll(false);
    expect(m.selectedCount).toBe(0);
    expect(m.block()).toBe('nothing_selected');
    m.toggle('nope.txt'); // unknown paths are ignored
    expect(m.selectedCount).toBe(0);
  });

  it('secret gate: a checked secret blocks the push until confirmed; unchecking or changing the set resets it', () => {
    const m = new ChangesModel(base());
    m.toggle('.env', true);
    expect(m.selectedSecrets().map((i) => i.path)).toEqual(['.env']);
    expect(m.block()).toBe('secrets_unconfirmed');
    m.confirmSecrets(true);
    expect(m.secretsConfirmed).toBe(true);
    expect(m.block()).toBeNull();
    expect(m.selectedChanges().map((c) => c.path)).toContain('.env');

    m.toggle('.env', false);
    expect(m.secretsConfirmed).toBe(false);
    m.confirmSecrets(true); // nothing to confirm
    expect(m.secretsConfirmed).toBe(false);
    m.toggle('.env', true);
    expect(m.block()).toBe('secrets_unconfirmed');
    m.confirmSecrets(true);
    m.selectAll(false);
    expect(m.secretsConfirmed).toBe(false);
  });

  it('carries selection and confirmation over when rebuilt, but not to new secrets', () => {
    const m = new ChangesModel(base());
    m.toggle('a.css', false);
    m.toggle('.env', true);
    m.confirmSecrets(true);
    const again = new ChangesModel(base(), m);
    expect(again.item('a.css')!.selected).toBe(false);
    expect(again.item('.env')!.selected).toBe(true);
    expect(again.secretsConfirmed).toBe(true);

    const withNewSecret = new ChangesModel(plan([...base().changes, change('id_rsa', 'added', 'key_file')]), m);
    expect(withNewSecret.item('id_rsa')!.selected).toBe(false);
    expect(withNewSecret.secretsConfirmed).toBe(true); // still only .env checked
    withNewSecret.toggle('id_rsa', true);
    expect(withNewSecret.block()).toBe('secrets_unconfirmed');

    // A file that changed status (e.g. now deleted) starts with the default again.
    const changed = new ChangesModel(plan([change('a.css', 'deleted')]), m);
    expect(changed.item('a.css')!.selected).toBe(true);
  });

  it('builds the commit message', () => {
    expect(commitMessage('  Fix menu ', '')).toBe('Fix menu');
    expect(commitMessage('Fix menu', ' Closes #1\n')).toBe('Fix menu\n\nCloses #1');
  });
});

describe('ConflictState', () => {
  const conflicts = [
    { path: 'a.html', kind: 'both_modified' as const, remoteSha: '1' },
    { path: 'b.css', kind: 'modified_locally_deleted_remotely' as const },
  ];

  it('keeps mine by default and records choices', () => {
    const s = new ConflictState(conflicts);
    expect(s.resolutions()).toEqual({ 'a.html': 'local', 'b.css': 'local' });
    expect(s.undecided).toBe(2);
    s.set('a.html', 'remote');
    expect(s.get('a.html')).toBe('remote');
    expect(s.decided('a.html')).toBe(true);
    expect(s.undecided).toBe(1);
    expect(s.counts()).toEqual({ local: 1, remote: 1 });
    s.set('other', 'remote'); // not a conflict: ignored
    expect(Object.keys(s.resolutions())).toEqual(['a.html', 'b.css']);
    s.setAll('remote');
    expect(s.resolutions()).toEqual({ 'a.html': 'remote', 'b.css': 'remote' });
    s.setAll('local');
    expect(s.counts()).toEqual({ local: 2, remote: 0 });
  });

  it('summarises a pull plan', () => {
    const p = { apply: [{ path: 'x', sha: '1' }], deleteLocal: ['y', 'z'], conflicts, keepLocal: ['k'] } as unknown as PullPlan;
    expect(pullSummary(p)).toEqual({ updated: 1, deleted: 2, conflicts: 2, keptLocal: 1 });
  });
});

describe('githubBadge / quickStatus', () => {
  async function linked() {
    const sha = await gitBlobSha1(encodeUtf8('<p>1</p>'));
    const link: GitHubLink = { owner: 'o', repo: 'r', branch: 'main', baseCommit: 'c1', baseTree: { 'index.html': sha, 'gone.css': 'x' } };
    return makeProject('badge', 'web', { 'index.html': textFile('<p>2</p>'), 'new.js': textFile('') }, { github: link });
  }

  it('is null for unlinked projects', async () => {
    const p = makeProject('plain', 'web', {});
    expect(githubBadge(p)).toBeNull();
    expect(await quickStatus(p)).toBeNull();
  });

  it('counts local changes without the network and shows them on the badge', async () => {
    const p = await linked();
    expect(githubBadge(p)).toEqual({ label: 'main' });
    expect(await quickStatus(p)).toEqual({ added: 1, modified: 1, deleted: 1, total: 3 });
    expect(githubBadge(p)).toEqual({ label: 'main', ahead: 3 });
    // A newer save invalidates the cached count until quickStatus runs again.
    const edited = { ...p, updatedAt: new Date(Date.now() + 5000).toISOString() };
    expect(githubBadge(edited)).toEqual({ label: 'main' });
  });

  it('shows no count when everything is pushed', async () => {
    const sha = await gitBlobSha1(encodeUtf8('same'));
    const p = makeProject('clean', 'web', { 'a.txt': textFile('same') }, { github: { owner: 'o', repo: 'r', branch: 'dev', baseCommit: 'c', baseTree: { 'a.txt': sha } } });
    expect(await quickStatus(p)).toEqual({ added: 0, modified: 0, deleted: 0, total: 0 });
    expect(githubBadge(p)).toEqual({ label: 'dev' });
  });
});

describe('repository list helpers', () => {
  const repo = (full: string, description: string | null = null) =>
    ({ id: full.length, name: full.split('/')[1], full_name: full, description }) as unknown as Parameters<typeof filterRepos>[0][number];

  it('filters by name and description', () => {
    const repos = [repo('me/portfolio', 'My site'), repo('me/api', 'Backend'), repo('org/Docs')];
    expect(filterRepos(repos, '').length).toBe(3);
    expect(filterRepos(repos, 'SITE').map((r) => r.full_name)).toEqual(['me/portfolio']);
    expect(filterRepos(repos, 'docs').map((r) => r.full_name)).toEqual(['org/Docs']);
  });

  it('puts the default branch first', () => {
    const b = (name: string) => ({ name, commit: { sha: '' }, protected: false });
    expect(orderBranches([b('feature'), b('main'), b('dev')], 'main')).toEqual(['main', 'dev', 'feature']);
    expect(orderBranches([b('dev')], 'main')).toEqual(['main', 'dev']);
  });
});
