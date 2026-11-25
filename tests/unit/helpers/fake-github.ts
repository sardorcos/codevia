/**
 * An in-memory GitHub for flow tests: commits, flat trees, blobs, a fast-forward-only ref update
 * (422 when the branch moved) and Pages. Implements every GitHubClient method the GitHub UI uses.
 */
import { vi } from 'vitest';
import { encodeUtf8 } from '../../../src/core/bytes';
import { textFile, type Files } from '../../../src/core/types';
import { zipFiles } from '../../../src/core/zip';
import type { GitHubBranchSummary, GitHubPages, GitHubPagesBuild, GitHubRepo, GitTree, NewTreeEntry, TreeEntry } from '../../../src/github/api';
import { GitHubError } from '../../../src/github/errors';
import { gitBlobSha1 } from '../../../src/github/sync';
import type { GhApi, ProjectWriter } from '../../../src/tools/github/flows';
import type { GitHubLink, Language, Project, ProjectMeta } from '../../../src/core/types';

export interface FakeEntry {
  sha: string;
  mode: string;
  type: 'blob' | 'commit';
  size?: number;
}

export class FakeGitHub implements GhApi {
  blobs = new Map<string, Uint8Array>();
  trees = new Map<string, Record<string, FakeEntry>>();
  commits = new Map<string, { tree: string; parents: string[]; message: string }>();
  refs: Record<string, string> = {};
  pages: GitHubPages | null = null;
  builds: Array<GitHubPagesBuild | null> = [];
  createdRepos: Array<{ name: string; private?: boolean; autoInit?: boolean }> = [];
  private n = 0;

  constructor(
    readonly owner = 'octo',
    readonly repo = 'site',
  ) {}

  private id(prefix: string): string {
    return `${prefix}${++this.n}`;
  }

  async addBlob(content: string | Uint8Array): Promise<string> {
    const bytes = typeof content === 'string' ? encodeUtf8(content) : content;
    const sha = await gitBlobSha1(bytes);
    this.blobs.set(sha, bytes);
    return sha;
  }

  /** Commits `files` on top of the branch (null deletes); extra entries (symlinks, submodules) go in as given. */
  async commit(branch: string, files: Record<string, string | null>, extra: Record<string, FakeEntry> = {}): Promise<string> {
    const parent = this.refs[branch];
    const base = parent ? { ...this.trees.get(this.commits.get(parent)!.tree)! } : {};
    for (const [path, content] of Object.entries(files)) {
      if (content === null) delete base[path];
      else {
        const sha = await this.addBlob(content);
        base[path] = { sha, mode: '100644', type: 'blob', size: encodeUtf8(content).byteLength };
      }
    }
    Object.assign(base, extra);
    const tree = this.id('tree');
    this.trees.set(tree, base);
    const sha = this.id('commit');
    this.commits.set(sha, { tree, parents: parent ? [parent] : [], message: 'remote edit' });
    this.refs[branch] = sha;
    return sha;
  }

  /** Text content of the branch head. */
  headFiles(branch = 'main'): Record<string, string> {
    const tree = this.trees.get(this.commits.get(this.refs[branch]!)!.tree)!;
    const out: Record<string, string> = {};
    for (const [p, e] of Object.entries(tree)) if (e.type === 'blob') out[p] = new TextDecoder().decode(this.blobs.get(e.sha) ?? new Uint8Array());
    return out;
  }

  private check(owner: string, repo: string) {
    if (owner !== this.owner || repo !== this.repo) throw new GitHubError('not_found', { status: 404 });
  }

  getBranch = vi.fn(async (owner: string, repo: string, branch: string) => {
    this.check(owner, repo);
    const sha = this.refs[branch];
    if (!sha) throw new GitHubError('not_found', { status: 404 });
    return { name: branch, commitSha: sha, treeSha: this.commits.get(sha)!.tree };
  });

  getCommit = vi.fn(async (_o: string, _r: string, sha: string) => {
    const c = this.commits.get(sha);
    if (!c) throw new GitHubError('not_found', { status: 404 });
    return { sha, treeSha: c.tree };
  });

  /** Tree ids are `<root>` or `<root>:<dir>/`; the flat root map is sliced per prefix. */
  getTree = vi.fn(async (_o: string, _r: string, treeSha: string, recursive = true): Promise<GitTree> => {
    const [root, prefix = ''] = treeSha.split(':') as [string, string?];
    const flat = this.trees.get(root);
    if (!flat) throw new GitHubError('not_found', { status: 404 });
    const entries: TreeEntry[] = [];
    const dirs = new Set<string>();
    for (const [path, e] of Object.entries(flat)) {
      if (!path.startsWith(prefix)) continue;
      const rel = path.slice(prefix.length);
      const slash = rel.indexOf('/');
      if (!recursive && slash >= 0) {
        dirs.add(rel.slice(0, slash));
        continue;
      }
      entries.push({ path: rel, mode: e.mode, type: e.type, sha: e.sha, size: e.size });
    }
    for (const d of dirs) entries.push({ path: d, mode: '040000', type: 'tree', sha: `${root}:${prefix}${d}/` });
    return { sha: treeSha, entries, truncated: false };
  });

  getBlob = vi.fn(async (_o: string, _r: string, sha: string) => {
    const b = this.blobs.get(sha);
    if (!b) throw new GitHubError('not_found', { status: 404 });
    return b;
  });

  downloadZipball = vi.fn(async (owner: string, repo: string, ref: string, _signal?: AbortSignal) => {
    this.check(owner, repo);
    const commit = this.commits.get(ref) ? ref : this.refs[ref]!;
    const tree = this.trees.get(this.commits.get(commit)!.tree)!;
    const files: Files = {};
    for (const [p, e] of Object.entries(tree)) {
      if (e.type !== 'blob') continue;
      const bytes = this.blobs.get(e.sha) ?? encodeUtf8('target');
      files[`${owner}-${repo}-${commit.slice(0, 7)}/${p}`] = { text: false, data: bytes };
    }
    if (!Object.keys(files).length) files[`${owner}-${repo}/.keep`] = textFile('');
    return new Uint8Array(await (await zipFiles(files)).arrayBuffer());
  });

  createBlob = vi.fn(async (_o: string, _r: string, bytes: Uint8Array) => this.addBlob(bytes));

  createTree = vi.fn(async (_o: string, _r: string, baseTree: string, entries: NewTreeEntry[]) => {
    const flat = { ...(this.trees.get(baseTree) ?? {}) };
    for (const e of entries) {
      if (e.sha === null) delete flat[e.path];
      else flat[e.path] = { sha: e.sha, mode: e.mode, type: 'blob', size: this.blobs.get(e.sha)?.byteLength };
    }
    const id = this.id('tree');
    this.trees.set(id, flat);
    return id;
  });

  createCommit = vi.fn(async (_o: string, _r: string, c: { message: string; tree: string; parents: string[] }) => {
    const id = this.id('commit');
    this.commits.set(id, { tree: c.tree, parents: c.parents, message: c.message });
    return id;
  });

  updateRef = vi.fn(async (_o: string, _r: string, branch: string, sha: string) => {
    const c = this.commits.get(sha)!;
    if (c.parents[0] !== this.refs[branch]) throw new GitHubError('validation', { status: 422, detail: 'Update is not a fast forward' });
    this.refs[branch] = sha;
  });

  listRepos = vi.fn(async () => [this.repoInfo()]);

  listBranches = vi.fn(async (): Promise<GitHubBranchSummary[]> =>
    Object.entries(this.refs).map(([name, sha]) => ({ name, commit: { sha }, protected: false })),
  );

  getRepo = vi.fn(async () => this.repoInfo());

  createRepo = vi.fn(async (opts: { name: string; private?: boolean; autoInit?: boolean }) => {
    this.createdRepos.push(opts);
    (this as { repo: string }).repo = opts.name;
    await this.commit('main', { 'README.md': `# ${opts.name}\n` });
    return { ...this.repoInfo(), private: opts.private ?? true };
  });

  enablePages = vi.fn(async (_o: string, _r: string, branch: string, path: '/' | '/docs' = '/') => {
    this.pages = { url: '', status: null, html_url: `https://${this.owner}.github.io/${this.repo}/`, source: { branch, path } };
    return this.pages;
  });

  getPages = vi.fn(async () => this.pages);

  latestPagesBuild = vi.fn(async () => (this.builds.length > 1 ? this.builds.shift()! : (this.builds[0] ?? null)));

  repoInfo(): GitHubRepo {
    return {
      id: 1,
      name: this.repo,
      full_name: `${this.owner}/${this.repo}`,
      owner: { login: this.owner },
      private: false,
      description: null,
      default_branch: 'main',
      html_url: `https://github.com/${this.owner}/${this.repo}`,
      pushed_at: null,
      size: 1,
    };
  }
}

/** A ToolContext-like writer holding one project, recording what was written. */
export function fakeWriter(initial: Project | null = null) {
  let current = initial;
  const log: string[] = [];
  const writer: ProjectWriter & { log: string[]; set(p: Project): void } = {
    log,
    set: (p) => (current = p),
    project: () => current,
    writeFiles: vi.fn(async (files: Files, opts?: { remove?: string[]; snapshotLabel?: string }) => {
      log.push(`writeFiles:${opts?.snapshotLabel ?? ''}`);
      const next = { ...current!.files, ...files };
      for (const p of opts?.remove ?? []) delete next[p];
      current = { ...current!, files: next, updatedAt: new Date().toISOString() };
    }),
    replaceAllFiles: vi.fn(async (files: Files, label: string) => {
      log.push(`replaceAllFiles:${label}`);
      current = { ...current!, files: { ...files }, updatedAt: new Date().toISOString() };
    }),
    updateMeta: vi.fn(async (patch: Partial<Pick<ProjectMeta, 'github' | 'entry' | 'name' | 'language'>>) => {
      log.push('updateMeta');
      const next = { ...current!, ...patch } as Project;
      if ('github' in patch && patch.github === undefined) delete next.github;
      current = next;
    }),
    createProject: vi.fn(async (name: string, language: Language, files: Files, meta?: { github?: GitHubLink; entry?: string }) => {
      log.push(`createProject:${name}`);
      current = makeProject(name, language, files, meta);
    }),
  };
  return writer;
}

export function makeProject(name: string, language: Language, files: Files, meta: { github?: GitHubLink; entry?: string } = {}): Project {
  const now = new Date().toISOString();
  return {
    id: `p-${name}`,
    name,
    language,
    createdAt: now,
    updatedAt: now,
    folder: name,
    fileCount: Object.keys(files).length,
    size: 0,
    schema: 2,
    files,
    ...meta,
  };
}
