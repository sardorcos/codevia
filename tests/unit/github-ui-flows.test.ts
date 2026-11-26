import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { textFile, type Files } from '../../src/core/types';
import { GitHubClient } from '../../src/github/api';
import { GitHubError } from '../../src/github/errors';
import { defaultCommitMessage, planPush, status } from '../../src/github/sync';
import {
  applyPull,
  checkBeforePush,
  classifySkipped,
  cloneRepository,
  createClonedProject,
  createRepositoryAndPush,
  guardApi,
  planFirstPush,
  prepareBranchSwitch,
  prepareLink,
  preparePull,
  publishPages,
  pushChanges,
  type Stage,
} from '../../src/tools/github/flows';
import { PagesBuildError, StaleProjectError } from '../../src/tools/github/messages';
import { ChangesModel, ConflictState } from '../../src/tools/github/model';
import { FakeGitHub, fakeWriter, makeProject } from './helpers/fake-github';

const text = (files: Files, path: string) => {
  const f = files[path];
  return f && f.text ? f.content : undefined;
};

/** A server with a small site and a project cloned from it. */
async function clonedSetup(extraRemote: Record<string, string> = {}) {
  const gh = new FakeGitHub();
  await gh.commit('main', { 'index.html': '<h1>Hi</h1>\n', 'style.css': 'body{}\n', 'about.html': 'about\n', ...extraRemote });
  const ctx = fakeWriter();
  const cloned = await cloneRepository(gh, { owner: 'octo', repo: 'site', branch: 'main' });
  await createClonedProject(ctx, cloned);
  return { gh, ctx, cloned };
}

const edit = (ctx: ReturnType<typeof fakeWriter>, changes: Record<string, string | null>) => {
  const p = ctx.project()!;
  const files = { ...p.files };
  for (const [path, c] of Object.entries(changes)) {
    if (c === null) delete files[path];
    else files[path] = textFile(c);
  }
  ctx.set({ ...p, files, updatedAt: new Date(Date.now() + 1000).toISOString() });
};

describe('clone → modify → push', () => {
  it('clones with progress, reports skipped files, creates the project with link and entry', async () => {
    const gh = new FakeGitHub();
    const target = await gh.addBlob('index.html');
    await gh.commit(
      'main',
      { 'index.html': '<p>x</p>\n', 'js/app.js': 'go()\n' },
      {
        'link.html': { sha: target, mode: '120000', type: 'blob', size: 10 },
        'vendor/lib': { sha: 'abc', mode: '160000', type: 'commit' },
        'big.bin': { sha: target, mode: '100644', type: 'blob', size: 16 * 1024 * 1024 },
      },
    );
    const stages: Stage[] = [];
    const ctx = fakeWriter();
    const cloned = await cloneRepository(gh, { owner: 'octo', repo: 'site', branch: 'main' }, { onProgress: (s) => stages.push(s) });
    expect(stages.slice(0, 3)).toEqual(['reading', 'downloading', 'unpacking']);
    expect(cloned.skipped).toEqual({ large: ['big.bin'], symlinks: ['link.html'], submodules: ['vendor/lib'], other: [] });
    expect(cloned.language).toBe('web');
    expect(cloned.entry).toBe('index.html');

    await createClonedProject(ctx, cloned);
    const p = ctx.project()!;
    expect(ctx.createProject).toHaveBeenCalledWith('site', 'web', expect.any(Object), { github: cloned.link, entry: 'index.html' });
    expect(Object.keys(p.files).sort()).toEqual(['index.html', 'js/app.js']);
    expect(p.github!.baseCommit).toBe(gh.refs.main);
    expect(await status(p.files, p.github!)).toEqual({ added: [], modified: [], deleted: [] });
  });

  it('pushes the selected changes, keeps unchecked secrets local and saves the new link', async () => {
    const { gh, ctx } = await clonedSetup();
    edit(ctx, { 'index.html': '<h1>Hello</h1>\n', 'new.js': 'x()\n', 'style.css': null, '.env': 'KEY=1\n' });
    let p = ctx.project()!;

    const model = new ChangesModel(await planPush(p.files, p.github!));
    expect(model.groups().modified.map((i) => i.path)).toEqual(['index.html']);
    expect(model.groups().added.map((i) => i.path)).toEqual(['.env', 'new.js']);
    expect(model.groups().deleted.map((i) => i.path)).toEqual(['style.css']);
    expect(model.item('.env')).toMatchObject({ secret: 'env_file', selected: false });
    expect(model.block()).toBeNull();

    expect((await checkBeforePush(gh, p.files, p.github!)).kind).toBe('ready');
    const changes = model.selectedChanges();
    const stages: Stage[] = [];
    const next = await pushChanges(gh, ctx, p.github!, changes, defaultCommitMessage(changes), { onProgress: (s) => stages.push(s) });

    expect(stages).toEqual(['uploading', 'uploading', 'uploading', 'committing', 'committing', 'updating', 'saving']);
    expect(gh.refs.main).toBe(next.baseCommit);
    expect(gh.headFiles()).toEqual({ 'index.html': '<h1>Hello</h1>\n', 'about.html': 'about\n', 'new.js': 'x()\n' });
    p = ctx.project()!;
    expect(p.github).toEqual(next);
    expect(await status(p.files, p.github!)).toEqual({ added: ['.env'], modified: [], deleted: [] });
  });

  it('a cancelled push before the branch update writes nothing; the branch update itself is never cut off', async () => {
    const { gh, ctx } = await clonedSetup();
    edit(ctx, { 'index.html': 'changed\n' });
    const p = ctx.project()!;
    const changes = (await planPush(p.files, p.github!)).changes;

    const c1 = new AbortController();
    gh.createBlob.mockImplementationOnce(async () => {
      c1.abort();
      return 'never';
    });
    await expect(pushChanges(gh, ctx, p.github!, changes, 'm', { signal: c1.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(gh.updateRef).not.toHaveBeenCalled();
    expect(ctx.updateMeta).not.toHaveBeenCalled();

    const c2 = new AbortController();
    const realUpdate = gh.updateRef.getMockImplementation()!;
    gh.updateRef.mockImplementationOnce(async (...args) => {
      c2.abort();
      await realUpdate(...args);
    });
    const next = await pushChanges(gh, ctx, p.github!, changes, 'm', { signal: c2.signal });
    expect(gh.refs.main).toBe(next.baseCommit);
    expect(ctx.project()!.github!.baseCommit).toBe(next.baseCommit);
  });
});

describe('pull with a conflict → resolve → files written', () => {
  async function conflictSetup() {
    const s = await clonedSetup();
    edit(s.ctx, { 'index.html': '<h1>Mine</h1>\n', 'about.html': 'about (local)\n' });
    await s.gh.commit('main', { 'index.html': '<h1>Theirs</h1>\n', 'new.html': 'new\n', 'style.css': null });
    return s;
  }

  it('plans updates, deletions and conflicts', async () => {
    const { gh, ctx } = await conflictSetup();
    const p = ctx.project()!;
    const plan = await preparePull(gh, p.files, p.github!);
    expect(plan.apply.map((a) => a.path)).toEqual(['new.html']);
    expect(plan.deleteLocal).toEqual(['style.css']);
    expect(plan.conflicts).toEqual([expect.objectContaining({ path: 'index.html', kind: 'both_modified' })]);
    expect(plan.keepLocal).toEqual(['about.html']);
  });

  it('takes GitHub’s version when chosen, writing everything in one step with a version first', async () => {
    const { gh, ctx } = await conflictSetup();
    const p = ctx.project()!;
    const plan = await preparePull(gh, p.files, p.github!);
    const state = new ConflictState(plan.conflicts);
    expect(state.get('index.html')).toBe('local');
    state.set('index.html', 'remote');

    await applyPull(gh, ctx, plan, state.resolutions(), { label: 'Before pulling from GitHub' });
    expect(ctx.log).toEqual(['createProject:site', 'replaceAllFiles:Before pulling from GitHub', 'updateMeta']);
    const after = ctx.project()!;
    expect(text(after.files, 'index.html')).toBe('<h1>Theirs</h1>\n');
    expect(text(after.files, 'new.html')).toBe('new\n');
    expect(after.files['style.css']).toBeUndefined();
    expect(text(after.files, 'about.html')).toBe('about (local)\n');
    expect(after.github!.baseCommit).toBe(gh.refs.main);
    expect(await status(after.files, after.github!)).toEqual({ added: [], modified: ['about.html'], deleted: [] });
  });

  it('keeps mine by default; the kept version is then a local change to push', async () => {
    const { gh, ctx } = await conflictSetup();
    const p = ctx.project()!;
    const plan = await preparePull(gh, p.files, p.github!);
    await applyPull(gh, ctx, plan, new ConflictState(plan.conflicts).resolutions(), { label: 'L' });
    const after = ctx.project()!;
    expect(text(after.files, 'index.html')).toBe('<h1>Mine</h1>\n');
    expect((await status(after.files, after.github!)).modified).toEqual(['about.html', 'index.html']);
    // …and it can be pushed right away.
    const changes = (await planPush(after.files, after.github!)).changes;
    await pushChanges(gh, ctx, after.github!, changes, 'merge');
    expect(gh.headFiles()['index.html']).toBe('<h1>Mine</h1>\n');
  });

  it('writes nothing when the project changed after the plan was made', async () => {
    const { gh, ctx } = await conflictSetup();
    const p = ctx.project()!;
    const plan = await preparePull(gh, p.files, p.github!);
    edit(ctx, { 'about.html': 'edited meanwhile\n' });
    await expect(applyPull(gh, ctx, plan, {}, { label: 'L' })).rejects.toBeInstanceOf(StaleProjectError);
    expect(ctx.replaceAllFiles).not.toHaveBeenCalled();
    expect(ctx.updateMeta).not.toHaveBeenCalled();
  });

  it('a pull that changes no file only moves the link (no version is created)', async () => {
    const { gh, ctx } = await clonedSetup();
    const p = ctx.project()!;
    const plan = await preparePull(gh, p.files, p.github!);
    expect(plan.upToDate).toBe(true);
    await applyPull(gh, ctx, plan, {}, { label: 'L' });
    expect(ctx.replaceAllFiles).not.toHaveBeenCalled();
  });
});

describe('push rejected with conflict → pull first', () => {
  it('rejects with code conflict, leaves the link alone, then succeeds after pulling', async () => {
    const { gh, ctx } = await clonedSetup();
    edit(ctx, { 'index.html': 'local\n' });
    await gh.commit('main', { 'about.html': 'remote edit\n' });
    const remoteHead = gh.refs.main;
    let p = ctx.project()!;
    const changes = (await planPush(p.files, p.github!)).changes;

    const err = await pushChanges(gh, ctx, p.github!, changes, 'm').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect((err as GitHubError).code).toBe('conflict');
    expect(gh.refs.main).toBe(remoteHead);
    expect(ctx.updateMeta).not.toHaveBeenCalled();

    // The "pull first" path: Commit & Push checks first and finds the branch moved.
    const check = await checkBeforePush(gh, p.files, p.github!);
    expect(check.kind).toBe('behind');
    if (check.kind !== 'behind') return;
    await applyPull(gh, ctx, check.plan, {}, { label: 'Before pulling from GitHub' });
    p = ctx.project()!;
    expect(text(p.files, 'about.html')).toBe('remote edit\n');
    const retry = (await planPush(p.files, p.github!)).changes;
    expect(retry.map((c) => c.path)).toEqual(['index.html']);
    await pushChanges(gh, ctx, p.github!, retry, 'm');
    expect(gh.headFiles()).toMatchObject({ 'index.html': 'local\n', 'about.html': 'remote edit\n' });
  });

  it('a branch that moved only outside the project folder is a fast-forward', async () => {
    const gh = new FakeGitHub();
    await gh.commit('main', { 'site/index.html': 'a\n', 'docs/readme.md': 'r\n' });
    const ctx = fakeWriter();
    await createClonedProject(ctx, await cloneRepository(gh, { owner: 'octo', repo: 'site', branch: 'main', subdir: 'site' }));
    expect(Object.keys(ctx.project()!.files)).toEqual(['index.html']);
    await gh.commit('main', { 'docs/readme.md': 'changed\n' });
    edit(ctx, { 'index.html': 'b\n' });
    const p = ctx.project()!;
    const check = await checkBeforePush(gh, p.files, p.github!);
    expect(check.kind).toBe('fast_forward');
    if (check.kind !== 'fast_forward') return;
    await applyPull(gh, ctx, check.plan, {}, { label: 'L' });
    const link = ctx.project()!.github!;
    expect(link.baseCommit).toBe(gh.refs.main);
    await pushChanges(gh, ctx, link, (await planPush(ctx.project()!.files, link)).changes, 'm');
    expect(gh.headFiles()).toEqual({ 'site/index.html': 'b\n', 'docs/readme.md': 'changed\n' });
  });
});

describe('create / link repository, change branch', () => {
  it('creates a private repository, links it and pushes the first commit without unchecked secrets', async () => {
    const gh = new FakeGitHub('octo', 'placeholder');
    const ctx = fakeWriter(makeProject('My Site', 'web', { 'index.html': textFile('<p>hi</p>'), '.env': textFile('A=1'), 'notes.log': textFile('x'), '.gitignore': textFile('*.log\n') }));
    const first = new ChangesModel(await planFirstPush(ctx.project()!.files));
    expect(first.ignored).toEqual(['notes.log']);
    expect(first.item('.env')!.selected).toBe(false);

    const res = await createRepositoryAndPush(gh, ctx, {
      name: 'my-site',
      private: true,
      message: 'Initial commit',
      pick: (plan) => new ChangesModel(plan, first).selectedChanges(),
    });
    expect(gh.createdRepos).toEqual([{ name: 'my-site', description: undefined, private: true, autoInit: true }]);
    expect(res.pushed).toBe(true);
    expect(gh.headFiles()).toEqual({ 'README.md': '# my-site\n', 'index.html': '<p>hi</p>', '.gitignore': '*.log\n' });
    expect(ctx.project()!.github).toMatchObject({ owner: 'octo', repo: 'my-site', branch: 'main', baseCommit: gh.refs.main });
  });

  it('links to an existing repository: remote-only files arrive, local-only stay new, differing ones conflict', async () => {
    const gh = new FakeGitHub();
    await gh.commit('main', { 'index.html': 'remote\n', 'same.txt': 'same\n', 'remote.txt': 'r\n' });
    const ctx = fakeWriter(makeProject('p', 'web', { 'index.html': textFile('local\n'), 'same.txt': textFile('same\n'), 'local.txt': textFile('l\n') }));
    const plan = await prepareLink(gh, ctx.project()!.files, { owner: 'octo', repo: 'site', branch: 'main' });
    expect(plan.apply.map((a) => a.path)).toEqual(['remote.txt']);
    expect(plan.conflicts).toEqual([expect.objectContaining({ path: 'index.html', kind: 'both_added' })]);
    expect(plan.keepLocal).toEqual(['local.txt']);
    await applyPull(gh, ctx, plan, {}, { label: 'Before linking to GitHub' });
    const p = ctx.project()!;
    expect(p.github!.baseCommit).toBe(gh.refs.main);
    expect(await status(p.files, p.github!)).toEqual({ added: ['local.txt'], modified: ['index.html'], deleted: [] });
  });

  it('switches branch carrying local changes over', async () => {
    const { gh, ctx } = await clonedSetup();
    gh.refs.dev = gh.refs.main!;
    await gh.commit('dev', { 'style.css': 'dev{}\n' });
    edit(ctx, { 'about.html': 'local about\n' });
    const p = ctx.project()!;
    const plan = await prepareBranchSwitch(gh, p.files, p.github!, 'dev');
    expect(plan.apply.map((a) => a.path)).toEqual(['style.css']);
    await applyPull(gh, ctx, plan, {}, { label: 'Before changing branch' });
    const after = ctx.project()!;
    expect(after.github!.branch).toBe('dev');
    expect(text(after.files, 'style.css')).toBe('dev{}\n');
    expect(text(after.files, 'about.html')).toBe('local about\n');
  });
});

describe('cancellation', () => {
  it('cancelling a clone during the download creates no project', async () => {
    const gh = new FakeGitHub();
    await gh.commit('main', { 'index.html': 'x' });
    const ctx = fakeWriter();
    const c = new AbortController();
    gh.downloadZipball.mockImplementationOnce(() => new Promise(() => c.abort()));
    await expect(cloneRepository(gh, { owner: 'octo', repo: 'site', branch: 'main' }, { signal: c.signal }).then((r) => createClonedProject(ctx, r))).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(ctx.createProject).not.toHaveBeenCalled();
  });

  it('guardApi refuses calls after abort and keeps uncancellable ones running', async () => {
    const c = new AbortController();
    let finished = false;
    const api = {
      slow: () => new Promise<string>((r) => setTimeout(() => ((finished = true), r('done')), 5)),
      fast: async () => 1,
    };
    const g = guardApi(api, c.signal, { uncancellable: ['slow'] });
    const p = g.slow();
    c.abort();
    await expect(p).resolves.toBe('done');
    expect(finished).toBe(true);
    await expect(g.fast()).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('publish to Pages', () => {
  const link = { owner: 'octo', repo: 'site', branch: 'main', baseCommit: 'c9', baseTree: {} };

  it('enables Pages when needed and waits for the build of the current commit', async () => {
    const gh = new FakeGitHub();
    gh.builds = [null, { status: 'building', commit: 'c9' }, { status: 'built', commit: 'c9' }];
    const stages: Stage[] = [];
    const res = await publishPages(gh, link, { pollMs: 0, onProgress: (s) => stages.push(s) });
    expect(gh.enablePages).toHaveBeenCalledWith('octo', 'site', 'main', '/');
    expect(res).toEqual({ url: 'https://octo.github.io/site/', built: true });
    expect(stages).toEqual(['enabling', 'building']);
    expect(gh.latestPagesBuild).toHaveBeenCalledTimes(3);
  });

  it('uses /docs for a docs project and a subfolder path otherwise; does not re-enable', async () => {
    const gh = new FakeGitHub();
    gh.builds = [{ status: 'built', commit: 'c9' }];
    await publishPages(gh, { ...link, subdir: 'docs' }, { pollMs: 0 });
    expect(gh.enablePages).toHaveBeenCalledWith('octo', 'site', 'main', '/docs');
    const res = await publishPages(gh, { ...link, subdir: 'web/app' }, { pollMs: 0 });
    expect(gh.enablePages).toHaveBeenCalledTimes(1);
    expect(res.url).toBe('https://octo.github.io/site/web/app/');
  });

  it('reports a failed build and gives up waiting after the timeout', async () => {
    const gh = new FakeGitHub();
    gh.builds = [{ status: 'errored', commit: 'c9', error: { message: 'Liquid error' } }];
    await expect(publishPages(gh, link, { pollMs: 0 })).rejects.toEqual(new PagesBuildError('Liquid error'));

    gh.builds = [{ status: 'building', commit: 'c9' }];
    let t = 0;
    const res = await publishPages(gh, link, { pollMs: 0, timeoutMs: 100, now: () => (t += 60) });
    expect(res.built).toBe(false);
  });
});

describe('public repositories without a token', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ name: 'main', commit: { sha: 's', commit: { tree: { sha: 't' } } } }), { status: 200 })),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('GitHubClient with a null token sends no Authorization header', async () => {
    const head = await new GitHubClient(() => null).getBranch('o', 'r', 'main');
    expect(head).toEqual({ name: 'main', commitSha: 's', treeSha: 't' });
    const init = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit;
    const headers = Object.keys(init.headers as Record<string, string>).map((h) => h.toLowerCase());
    expect(headers).not.toContain('authorization');
  });
});

describe('classifySkipped', () => {
  it('sorts by reason', () => {
    expect(
      classifySkipped(
        ['a', 'b', 'c', 'd?x'],
        [
          { path: 'a', mode: '120000', type: 'blob', sha: '1' },
          { path: 'b', mode: '160000', type: 'commit', sha: '2' },
          { path: 'c', mode: '100644', type: 'blob', sha: '3', size: 20 * 1024 * 1024 },
        ],
      ),
    ).toEqual({ symlinks: ['a'], submodules: ['b'], large: ['c'], other: ['d?x'] });
  });
});
