import { describe, expect, it, vi } from 'vitest';
import { encodeUtf8 } from '../../src/core/bytes';
import { binaryFile, textFile, type Files, type GitHubLink } from '../../src/core/types';
import { zipFiles } from '../../src/core/zip';
import type { GitTree, NewTreeEntry, TreeEntry } from '../../src/github/api';
import { GitHubError } from '../../src/github/errors';
import { sha1Js } from '../../src/github/hash';
import {
  clone,
  defaultCommitMessage,
  executePull,
  executePush,
  fetchRemote,
  gitBlobSha1,
  isSyncablePath,
  mapLimit,
  planPull,
  planPush,
  status,
  type SyncApi,
} from '../../src/github/sync';

const sha = (s: string) => gitBlobSha1(encodeUtf8(s));

/** Builds a link whose baseTree matches the given text files. */
async function linkFor(files: Record<string, string>, extra: Partial<GitHubLink> = {}): Promise<GitHubLink> {
  const baseTree: Record<string, string> = {};
  for (const [p, c] of Object.entries(files)) baseTree[p] = await sha(c);
  return { owner: 'o', repo: 'r', branch: 'main', baseCommit: 'base0', baseTree, ...extra };
}

const textFiles = (files: Record<string, string>): Files =>
  Object.fromEntries(Object.entries(files).map(([p, c]) => [p, textFile(c)]));

/** A mock SyncApi that records calls; blobs are served from `blobs` by sha. */
function mockApi(overrides: Partial<SyncApi> = {}, blobs: Record<string, Uint8Array> = {}) {
  const calls: string[] = [];
  const api: SyncApi = {
    getBranch: vi.fn(async () => (calls.push('getBranch'), { name: 'main', commitSha: 'head1', treeSha: 'tree1' })),
    getCommit: vi.fn(async (_o, _r, s) => (calls.push(`getCommit:${s}`), { sha: s, treeSha: `tree-of-${s}` })),
    getTree: vi.fn(async () => (calls.push('getTree'), { sha: 'tree1', entries: [], truncated: false })),
    getBlob: vi.fn(async (_o, _r, s: string) => {
      calls.push(`getBlob:${s}`);
      const b = blobs[s];
      if (!b) throw new Error(`unknown blob ${s}`);
      return b;
    }),
    downloadZipball: vi.fn(async () => (calls.push('zipball'), new Uint8Array())),
    createBlob: vi.fn(async (_o, _r, bytes: Uint8Array) => (calls.push('createBlob'), gitBlobSha1(bytes))),
    createTree: vi.fn(async () => (calls.push('createTree'), 'newtree')),
    createCommit: vi.fn(async () => (calls.push('createCommit'), 'newcommit')),
    updateRef: vi.fn(async () => void calls.push('updateRef')),
    ...overrides,
  };
  return { api, calls };
}

describe('gitBlobSha1', () => {
  it('matches git for known blobs', async () => {
    expect(await sha('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
    expect(await gitBlobSha1(new Uint8Array())).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  });

  it('JS fallback agrees with WebCrypto', async () => {
    for (const s of ['', 'abc', 'x'.repeat(55), 'y'.repeat(64), 'z'.repeat(1000), 'Привет 🌍']) {
      const data = encodeUtf8(s);
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', data as BufferSource));
      expect(sha1Js(data)).toBe([...digest].map((x) => x.toString(16).padStart(2, '0')).join(''));
    }
    expect(sha1Js(encodeUtf8('abc'))).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
  });
});

describe('paths', () => {
  it('rejects paths the project cannot hold', () => {
    expect(isSyncablePath('src/app.js')).toBe(true);
    expect(isSyncablePath('.git/config')).toBe(false);
    expect(isSyncablePath('a/.DS_Store')).toBe(false);
    expect(isSyncablePath('what?.txt')).toBe(false);
    expect(isSyncablePath('../x')).toBe(false);
  });
});

describe('status', () => {
  it('reports added, modified and deleted files', async () => {
    const link = await linkFor({ 'index.html': '<h1>', 'style.css': 'a{}', 'old.js': 'x' });
    const files: Files = { ...textFiles({ 'index.html': '<h1>', 'style.css': 'b{}', 'new.js': 'y' }), 'img.png': binaryFile(new Uint8Array([1, 2])) };
    expect(await status(files, link)).toEqual({ added: ['img.png', 'new.js'], modified: ['style.css'], deleted: ['old.js'] });
  });

  it('hashes identical contents once per call', async () => {
    const link = await linkFor({});
    const files = textFiles({ 'a.txt': 'same', 'b.txt': 'same', 'c.txt': 'same' });
    const spy = vi.spyOn(crypto.subtle, 'digest');
    await status(files, link);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe('planPull (three-way)', () => {
  it('classifies every branch', async () => {
    const base = {
      'same.txt': 'same',
      'local.txt': 'base',
      'remote.txt': 'base',
      'both.txt': 'base',
      'identical.txt': 'base',
      'rdel.txt': 'base',
      'rdel-lmod.txt': 'base',
      'ldel-rmod.txt': 'base',
      'ldel.txt': 'base',
      'both-del.txt': 'base',
    };
    const link = await linkFor(base);
    const files = textFiles({
      'same.txt': 'same',
      'local.txt': 'mine',
      'remote.txt': 'base',
      'both.txt': 'mine',
      'identical.txt': 'new',
      'rdel.txt': 'base',
      'rdel-lmod.txt': 'mine',
      'added-local.txt': 'l',
      'added-both-same.txt': 'same-add',
      'added-both-diff.txt': 'mine',
    });
    const remoteTree: Record<string, string> = {
      'same.txt': await sha('same'),
      'local.txt': await sha('base'),
      'remote.txt': await sha('theirs'),
      'both.txt': await sha('theirs'),
      'identical.txt': await sha('new'),
      'ldel-rmod.txt': await sha('theirs'),
      'ldel.txt': await sha('base'),
      'added-remote.txt': await sha('r'),
      'added-both-same.txt': await sha('same-add'),
      'added-both-diff.txt': await sha('theirs'),
      '.git/HEAD': await sha('x'),
    };
    const plan = await planPull(files, link, remoteTree, 'head1');
    expect(plan.apply.map((a) => a.path)).toEqual(['added-remote.txt', 'remote.txt']);
    expect(plan.deleteLocal).toEqual(['rdel.txt']);
    expect(plan.keepLocal).toEqual(['added-local.txt', 'ldel.txt', 'local.txt']);
    expect(plan.conflicts).toEqual([
      { path: 'added-both-diff.txt', kind: 'both_added', remoteSha: await sha('theirs') },
      { path: 'both.txt', kind: 'both_modified', remoteSha: await sha('theirs') },
      { path: 'ldel-rmod.txt', kind: 'deleted_locally_modified_remotely', remoteSha: await sha('theirs') },
      { path: 'rdel-lmod.txt', kind: 'modified_locally_deleted_remotely' },
    ]);
    // identical.txt / added-both-same.txt (same change on both sides) and both-del.txt are not listed anywhere.
    const listed = [...plan.apply.map((a) => a.path), ...plan.deleteLocal, ...plan.keepLocal, ...plan.conflicts.map((c) => c.path)];
    expect(listed).not.toContain('identical.txt');
    expect(listed).not.toContain('added-both-same.txt');
    expect(listed).not.toContain('both-del.txt');
    expect(plan.upToDate).toBe(false);
    expect(plan.remoteTree['.git/HEAD']).toBeUndefined();
  });

  it('is up to date when nothing changed remotely', async () => {
    const link = await linkFor({ 'a.txt': 'a' });
    const plan = await planPull(textFiles({ 'a.txt': 'changed' }), link, { ...link.baseTree }, 'base0');
    expect(plan.upToDate).toBe(true);
    expect(plan.keepLocal).toEqual(['a.txt']);
  });

  it('executePull applies remote changes and resolutions; base becomes the remote tree', async () => {
    const link = await linkFor({ 'r.txt': 'base', 'c1.txt': 'base', 'c2.txt': 'base', 'gone.txt': 'base', 'mine.txt': 'base' });
    const files = textFiles({ 'r.txt': 'base', 'c1.txt': 'mine1', 'c2.txt': 'mine2', 'gone.txt': 'base', 'mine.txt': 'local edit' });
    const blobs = { [await sha('theirs-r')]: encodeUtf8('theirs-r'), [await sha('theirs-c1')]: encodeUtf8('theirs-c1'), [await sha('theirs-c2')]: encodeUtf8('theirs-c2') };
    const remoteTree = {
      'r.txt': await sha('theirs-r'),
      'c1.txt': await sha('theirs-c1'),
      'c2.txt': await sha('theirs-c2'),
      'mine.txt': await sha('base'),
      'bin.sh': await sha('base'),
    };
    blobs[await sha('base')] = encodeUtf8('base');
    const plan = await planPull(files, link, remoteTree, 'head1', { remoteModes: { 'bin.sh': '100755' } });
    const { api, calls } = mockApi({}, blobs);
    const res = await executePull(api, plan, { 'c1.txt': 'remote' });
    expect(res.files['r.txt']).toEqual(textFile('theirs-r'));
    expect(res.files['c1.txt']).toEqual(textFile('theirs-c1'));
    expect(res.files['c2.txt']).toEqual(textFile('mine2')); // unresolved → local kept
    expect(res.files['mine.txt']).toEqual(textFile('local edit'));
    expect(res.files['bin.sh']).toEqual(textFile('base'));
    expect(res.files['gone.txt']).toBeUndefined();
    expect(res.deleted).toEqual(['gone.txt']);
    expect(res.written.sort()).toEqual(['bin.sh', 'c1.txt', 'r.txt']);
    expect(res.link.baseCommit).toBe('head1');
    expect(res.link.baseTree).toEqual(remoteTree);
    expect(res.link.modes).toEqual({ 'bin.sh': '100755' });
    expect(calls.filter((c) => c.startsWith('getBlob')).length).toBe(3);
    // c2 kept locally now shows as a local modification to push.
    expect((await status(res.files, res.link)).modified).toEqual(['c2.txt', 'mine.txt']);
  });

  it('a remote resolution of a remote deletion deletes the local file', async () => {
    const link = await linkFor({ 'x.txt': 'base' });
    const plan = await planPull(textFiles({ 'x.txt': 'mine' }), link, {}, 'head1');
    const res = await executePull(mockApi().api, plan, { 'x.txt': 'remote' });
    expect(res.files['x.txt']).toBeUndefined();
    expect(res.deleted).toEqual(['x.txt']);
  });
});

describe('planPush', () => {
  it('honors .gitignore for new files only and flags secrets', async () => {
    const link = await linkFor({ 'dist/kept.js': 'old', 'index.html': 'a' });
    const files = textFiles({
      '.gitignore': 'dist/\n*.log\n',
      'dist/kept.js': 'new',
      'dist/new.js': 'x',
      'debug.log': 'x',
      'index.html': 'a',
      'app.js': 'const k = "AKIAABCDEFGHIJKLMNOP";',
      '.env': 'A=1',
    });
    const plan = await planPush(files, link);
    expect(plan.ignored.sort()).toEqual(['debug.log', 'dist/new.js']);
    expect(plan.changes.map((c) => [c.path, c.status])).toEqual([
      ['.env', 'added'],
      ['.gitignore', 'added'],
      ['app.js', 'added'],
      ['dist/kept.js', 'modified'],
    ]);
    expect(plan.secrets).toEqual([
      { path: '.env', reason: 'env_file' },
      { path: 'app.js', reason: 'aws_key' },
    ]);
  });

  it('opts.gitignore overrides the project file; deletions are listed', async () => {
    const link = await linkFor({ 'gone.txt': 'x' });
    const plan = await planPush(textFiles({ '.gitignore': '', 'a.tmp': '1' }), link, { gitignore: '*.tmp\n.gitignore' });
    expect(plan.changes).toEqual([{ path: 'gone.txt', status: 'deleted' }]);
    expect(plan.ignored.sort()).toEqual(['.gitignore', 'a.tmp']);
  });

  it('builds a default commit message', () => {
    expect(defaultCommitMessage([{ path: 'a/index.html', status: 'modified' }, { path: 'style.css', status: 'added' }])).toBe('Update index.html, style.css');
    expect(defaultCommitMessage([{ path: 'a', status: 'added' }, { path: 'b', status: 'added' }, { path: 'c', status: 'added' }, { path: 'd', status: 'added' }])).toBe('Add a, b, c and 1 more');
    expect(defaultCommitMessage([{ path: 'x.txt', status: 'deleted' }])).toBe('Delete x.txt');
  });
});

describe('executePush', () => {
  it('uploads blobs, builds the tree on the base tree, commits and fast-forwards', async () => {
    const link = await linkFor({ 'index.html': 'old', 'gone.txt': 'bye', 'run.sh': 'echo' }, { modes: { 'run.sh': '100755' } });
    const files = textFiles({ 'index.html': 'new', 'run.sh': 'echo 2', 'add.txt': 'hi', 'copy.txt': 'bye' });
    const plan = await planPush(files, link);
    const { api, calls } = mockApi();
    const next = await executePush(api, link, plan.changes, '  ');

    // copy.txt has the same content as gone.txt, already a blob in the repo: no upload.
    expect(calls).toEqual(['createBlob', 'createBlob', 'createBlob', 'getCommit:base0', 'createTree', 'createCommit', 'updateRef']);
    const [, , baseTree, entries] = vi.mocked(api.createTree).mock.calls[0]! as [string, string, string, NewTreeEntry[]];
    expect(baseTree).toBe('tree-of-base0');
    expect(entries).toEqual([
      { path: 'add.txt', mode: '100644', type: 'blob', sha: await sha('hi') },
      { path: 'copy.txt', mode: '100644', type: 'blob', sha: await sha('bye') },
      { path: 'gone.txt', mode: '100644', type: 'blob', sha: null },
      { path: 'index.html', mode: '100644', type: 'blob', sha: await sha('new') },
      { path: 'run.sh', mode: '100755', type: 'blob', sha: await sha('echo 2') },
    ]);
    expect(vi.mocked(api.createCommit).mock.calls[0]![2]).toEqual({
      message: 'Update add.txt, copy.txt, gone.txt and 2 more',
      tree: 'newtree',
      parents: ['base0'],
    });
    expect(vi.mocked(api.updateRef).mock.calls[0]).toEqual(['o', 'r', 'main', 'newcommit']);
    expect(next.baseCommit).toBe('newcommit');
    expect(next.baseTree).toEqual({
      'index.html': await sha('new'),
      'run.sh': await sha('echo 2'),
      'add.txt': await sha('hi'),
      'copy.txt': await sha('bye'),
    });
    expect(next.modes).toEqual({ 'run.sh': '100755' });
    expect(await status(files, next)).toEqual({ added: [], modified: [], deleted: [] });
  });

  it('prefixes paths with the subdir', async () => {
    const link = await linkFor({ 'a.txt': '1' }, { subdir: 'site' });
    const plan = await planPush(textFiles({ 'b.txt': '2' }), link);
    const { api } = mockApi();
    await executePush(api, link, plan.changes, 'msg');
    const entries = vi.mocked(api.createTree).mock.calls[0]![3];
    expect(entries.map((e) => [e.path, e.sha === null])).toEqual([
      ['site/a.txt', true],
      ['site/b.txt', false],
    ]);
  });

  it('maps 422 from the ref update to a conflict', async () => {
    const link = await linkFor({});
    const plan = await planPush(textFiles({ 'a.txt': '1' }), link);
    const { api } = mockApi({
      updateRef: vi.fn(async () => {
        throw new GitHubError('validation', { status: 422, detail: 'Update is not a fast forward' });
      }),
    });
    const err = await executePush(api, link, plan.changes, 'm').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect((err as GitHubError).code).toBe('conflict');
    expect((err as GitHubError).status).toBe(422);
  });

  it('refuses an empty push', async () => {
    const err = await executePush(mockApi().api, await linkFor({}), [], 'm').catch((e: unknown) => e);
    expect((err as GitHubError).key).toBe('nothing_to_push');
  });

  it('uploads at most 4 blobs in parallel', async () => {
    let inFlight = 0;
    let peak = 0;
    const { api } = mockApi({
      createBlob: vi.fn(async (_o, _r, bytes: Uint8Array) => {
        peak = Math.max(peak, ++inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return gitBlobSha1(bytes);
      }),
    });
    const files = textFiles(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i}.txt`, `content ${i}`])));
    const link = await linkFor({});
    await executePush(api, link, (await planPush(files, link)).changes, 'm');
    expect(api.createBlob).toHaveBeenCalledTimes(12);
    expect(peak).toBe(4);
  });
});

describe('mapLimit', () => {
  it('keeps order', async () => {
    expect(await mapLimit([3, 1, 2], 2, async (x) => x * 2)).toEqual([6, 2, 4]);
    expect(await mapLimit([], 4, async (x) => x)).toEqual([]);
  });
});

function entry(path: string, content: string | null, extra: Partial<TreeEntry> = {}): Promise<TreeEntry> {
  return (async () => ({
    path,
    mode: '100644',
    type: 'blob' as const,
    sha: content === null ? 'x' : await sha(content),
    size: content?.length ?? 0,
    ...extra,
  }))();
}

describe('fetchRemote / clone', () => {
  it('skips symlinks, submodules, unsupported names and case duplicates', async () => {
    const entries = await Promise.all([
      entry('src', null, { type: 'tree', mode: '040000' }),
      entry('src/a.js', 'a'),
      entry('run.sh', 'r', { mode: '100755' }),
      entry('link', null, { mode: '120000' }),
      entry('lib', null, { type: 'commit', mode: '160000' }),
      entry('q?.txt', 'q'),
      entry('README.md', 'x'),
      entry('readme.md', 'y'),
    ]);
    const { api } = mockApi({ getTree: vi.fn(async () => ({ sha: 'tree1', entries, truncated: false })) });
    const remote = await fetchRemote(api, { owner: 'o', repo: 'r', branch: 'main' });
    expect(Object.keys(remote.tree).sort()).toEqual(['README.md', 'run.sh', 'src/a.js']);
    expect(remote.modes).toEqual({ 'run.sh': '100755' });
    expect(remote.skipped.sort()).toEqual(['lib', 'link', 'q?.txt', 'readme.md']);
    expect(remote.head).toBe('head1');
  });

  it('throws tree_truncated for huge repositories', async () => {
    const { api } = mockApi({ getTree: vi.fn(async () => ({ sha: 't', entries: [], truncated: true })) });
    const err = await fetchRemote(api, { owner: 'o', repo: 'r', branch: 'main' }).catch((e: unknown) => e);
    expect((err as GitHubError).key).toBe('tree_truncated');
  });

  it('clones from the zipball, applies subdir and refetches blobs the archive lacks or alters', async () => {
    const zip = new Uint8Array(
      await (
        await zipFiles({
          'o-r-abc123/README.md': textFile('root readme'),
          'o-r-abc123/site/index.html': textFile('<h1>hi</h1>'),
          'o-r-abc123/site/img/logo.png': binaryFile(new Uint8Array([137, 80, 78, 71])),
          'o-r-abc123/site/version.txt': textFile('$Format:%H$ substituted'),
        })
      ).arrayBuffer(),
    );
    const trees: Record<string, GitTree> = {
      tree1: { sha: 'tree1', truncated: false, entries: [await entry('README.md', 'root readme'), await entry('site', null, { type: 'tree', mode: '040000', sha: 'siteTree' })] },
      siteTree: {
        sha: 'siteTree',
        truncated: false,
        entries: [
          await entry('index.html', '<h1>hi</h1>'),
          { path: 'img/logo.png', mode: '100644', type: 'blob', sha: await gitBlobSha1(new Uint8Array([137, 80, 78, 71])), size: 4 },
          await entry('version.txt', 'original'),
          await entry('tests/t.js', 'export-ignored'),
        ],
      },
    };
    const blobs = { [await sha('original')]: encodeUtf8('original'), [await sha('export-ignored')]: encodeUtf8('export-ignored') };
    const { api } = mockApi(
      {
        getTree: vi.fn(async (_o, _r, s: string) => trees[s]!),
        downloadZipball: vi.fn(async () => zip),
      },
      blobs,
    );
    const res = await clone(api, 'o', 'r', 'main', { subdir: '/site/' });
    expect(vi.mocked(api.downloadZipball).mock.calls[0]!.slice(0, 3)).toEqual(['o', 'r', 'head1']);
    expect(Object.keys(res.files).sort()).toEqual(['img/logo.png', 'index.html', 'tests/t.js', 'version.txt']);
    expect(res.files['index.html']).toEqual(textFile('<h1>hi</h1>'));
    expect(res.files['img/logo.png']!.text).toBe(false);
    expect(res.files['version.txt']).toEqual(textFile('original'));
    expect(res.files['tests/t.js']).toEqual(textFile('export-ignored'));
    expect(res.link).toMatchObject({ owner: 'o', repo: 'r', branch: 'main', baseCommit: 'head1', subdir: 'site' });
    expect(res.language).toBe('web');
    expect(await status(res.files, res.link)).toEqual({ added: [], modified: [], deleted: [] });
  });

  it('rejects a missing subdir', async () => {
    const { api } = mockApi({ getTree: vi.fn(async () => ({ sha: 'tree1', entries: [], truncated: false })) });
    const err = await clone(api, 'o', 'r', 'main', { subdir: 'nope' }).catch((e: unknown) => e);
    expect((err as GitHubError).key).toBe('subdir_not_found');
  });
});
