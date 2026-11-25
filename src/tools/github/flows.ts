/**
 * The GitHub flows behind the panels, without DOM: clone, push (with the pull check first), pull,
 * create / link a repository, change branch and publish to Pages. They take any object shaped like
 * GitHubClient (a mock in tests) and write to the project only through the ToolContext, and only
 * once everything needed has been downloaded, so a cancelled or failed action leaves it untouched.
 */
import { LIMITS, type Files, type GitHubLink, type Language, type ProjectFile } from '../../core/types';
import { defaultEntry } from '../../core/templates';
import type { GitHubClient, GitTree, TreeEntry } from '../../github/api';
import { GitHubError } from '../../github/errors';
import {
  clone,
  executePull,
  executePush,
  fetchRemote,
  linkToBranch,
  normalizeSubdir,
  planPull,
  planPush,
  type CloneResult,
  type ConflictResolution,
  type PullPlan,
  type PullResult,
  type PushChange,
  type PushPlan,
  type SyncApi,
} from '../../github/sync';
import type { ToolContext } from '../types';
import { PagesBuildError, StaleProjectError, type StageName } from './messages';
import { defaultPagesUrl } from './parse';

/** Everything the flows use from GitHubClient. */
export type GhApi = SyncApi &
  Pick<
    GitHubClient,
    'listRepos' | 'listBranches' | 'getRepo' | 'createRepo' | 'enablePages' | 'getPages' | 'latestPagesBuild' | 'createBranch' | 'findPullRequest' | 'createPullRequest'
  >;

/** The writes the flows make. */
export type ProjectWriter = Pick<ToolContext, 'project' | 'writeFiles' | 'replaceAllFiles' | 'updateMeta' | 'createProject'>;

export type Stage = StageName;

export type OnProgress = (stage: Stage, done?: number, total?: number) => void;

export interface FlowOptions {
  signal?: AbortSignal;
  onProgress?: OnProgress;
}

export function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Aborted', 'AbortError');
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal!));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Wraps an API object so every call fails fast once `signal` aborts (and pending calls reject at
 * once). Methods named in `uncancellable` always run to the end: e.g. the ref update of a push,
 * after which the new link must be saved whatever happens.
 */
export function guardApi<T extends object>(
  api: T,
  signal: AbortSignal | undefined,
  hooks: { before?: (method: string) => void; after?: (method: string, result: unknown) => void; uncancellable?: string[] } = {},
): T {
  return new Proxy(api, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== 'function' || typeof prop !== 'string') return value;
      return (...args: unknown[]) => {
        if (signal?.aborted) return Promise.reject(abortError(signal));
        hooks.before?.(prop);
        const run = Promise.resolve((value as (...a: unknown[]) => unknown).apply(target, args)).then((r) => {
          hooks.after?.(prop, r);
          return r;
        });
        if (!signal || hooks.uncancellable?.includes(prop)) return run;
        return new Promise((resolve, reject) => {
          if (signal.aborted) {
            run.catch(() => undefined);
            return reject(abortError(signal));
          }
          const onAbort = () => reject(abortError(signal));
          signal.addEventListener('abort', onAbort, { once: true });
          run.then(
            (v) => {
              signal.removeEventListener('abort', onAbort);
              resolve(v);
            },
            (e) => {
              signal.removeEventListener('abort', onAbort);
              reject(e);
            },
          );
        });
      };
    },
  });
}

// --- clone ---

export interface SkippedReport {
  /** Larger than the per-file limit. */
  large: string[];
  symlinks: string[];
  submodules: string[];
  /** Names the project cannot hold (e.g. `?` in a name, case-only duplicates). */
  other: string[];
}

export const skippedCount = (r: SkippedReport): number => r.large.length + r.symlinks.length + r.submodules.length + r.other.length;

/** Sorts the remote paths clone() left out by reason, using the tree listing. */
export function classifySkipped(skipped: readonly string[], entries: readonly TreeEntry[]): SkippedReport {
  const byPath = new Map(entries.map((e) => [e.path, e]));
  const report: SkippedReport = { large: [], symlinks: [], submodules: [], other: [] };
  for (const path of skipped) {
    const e = byPath.get(path);
    if (e?.type === 'commit') report.submodules.push(path);
    else if (e?.mode === '120000') report.symlinks.push(path);
    else if ((e?.size ?? 0) > LIMITS.maxFileBytes) report.large.push(path);
    else report.other.push(path);
  }
  return report;
}

export interface CloneTarget {
  owner: string;
  repo: string;
  branch: string;
  subdir?: string;
}

export interface ClonedProject {
  name: string;
  language: Language;
  files: Files;
  link: GitHubLink;
  entry?: string;
  skipped: SkippedReport;
}

/** Downloads a branch (clone()) and reports progress: reading → downloading → unpacking → verifying. */
export async function cloneRepository(api: SyncApi, target: CloneTarget, opts: FlowOptions = {}): Promise<ClonedProject> {
  const { onProgress, signal } = opts;
  let listing: GitTree | null = null;
  let blobs = 0;
  const guarded = guardApi(api, signal, {
    before: (m) => {
      if (m === 'downloadZipball') onProgress?.('downloading');
      else if (m === 'getBlob') onProgress?.('verifying', blobs++);
    },
    after: (m, r) => {
      if (m === 'getTree' && r && (r as GitTree).entries) listing = r as GitTree;
      else if (m === 'downloadZipball') onProgress?.('unpacking');
    },
  });
  onProgress?.('reading');
  const result: CloneResult = await clone(guarded, target.owner, target.repo, target.branch, { subdir: target.subdir, signal });
  const entries = (listing as GitTree | null)?.entries ?? [];
  const paths = Object.keys(result.files);
  const cloned: ClonedProject = {
    name: target.repo,
    language: result.language,
    files: result.files,
    link: result.link,
    skipped: classifySkipped(result.skipped, entries),
  };
  const entry = defaultEntry(paths, result.language);
  if (entry) cloned.entry = entry;
  return cloned;
}

/** Creates and opens the project for a finished clone. */
export async function createClonedProject(ctx: Pick<ProjectWriter, 'createProject'>, cloned: ClonedProject): Promise<void> {
  const meta: { github: GitHubLink; entry?: string } = { github: cloned.link };
  if (cloned.entry) meta.entry = cloned.entry;
  await ctx.createProject(cloned.name, cloned.language, cloned.files, meta);
}

// --- pull ---

/** Fetches the remote tree and compares it with the project (three-way). */
export async function preparePull(api: SyncApi, files: Files, link: GitHubLink, opts: FlowOptions = {}): Promise<PullPlan> {
  opts.onProgress?.('reading');
  const g = guardApi(api, opts.signal);
  const remote = await fetchRemote(g, { owner: link.owner, repo: link.repo, branch: link.branch, subdir: link.subdir });
  return planPull(files, link, remote.tree, remote.head, { remoteModes: remote.modes });
}

const sameFile = (a: ProjectFile | undefined, b: ProjectFile | undefined): boolean => {
  if (a === b) return true;
  if (!a || !b || a.text !== b.text) return false;
  if (a.text) return a.content === (b as typeof a).content;
  const x = a.data;
  const y = (b as typeof a).data;
  if (x.byteLength !== y.byteLength) return false;
  for (let i = 0; i < x.byteLength; i++) if (x[i] !== y[i]) return false;
  return true;
};

/** True when the project's files are still exactly those the plan was computed from. */
export function filesUnchanged(current: Files, planned: Files): boolean {
  const a = Object.keys(current);
  if (a.length !== Object.keys(planned).length) return false;
  return a.every((p) => sameFile(current[p], planned[p]));
}

/**
 * Downloads what the plan needs, then writes the project in one step (replaceAllFiles creates the
 * "Before pulling from GitHub" version) and saves the new link. Throws StaleProjectError, writing
 * nothing, when the files changed since the plan was made.
 */
export async function applyPull(
  api: SyncApi,
  ctx: Pick<ProjectWriter, 'project' | 'replaceAllFiles' | 'updateMeta'>,
  plan: PullPlan,
  resolutions: Record<string, ConflictResolution>,
  opts: FlowOptions & { label: string },
): Promise<PullResult> {
  let done = 0;
  const total = plan.apply.length + plan.conflicts.filter((c) => resolutions[c.path] === 'remote').length;
  const g = guardApi(api, opts.signal, { after: (m) => m === 'getBlob' && opts.onProgress?.('downloading', ++done, total) });
  opts.onProgress?.('downloading', 0, total);
  const result = await executePull(g, plan, resolutions);
  if (opts.signal?.aborted) throw abortError(opts.signal);
  const current = ctx.project();
  if (!current || !filesUnchanged(current.files, plan.files)) throw new StaleProjectError();
  opts.onProgress?.('saving');
  if (result.written.length || result.deleted.length) await ctx.replaceAllFiles(result.files, opts.label);
  await ctx.updateMeta({ github: result.link });
  return result;
}

// --- push ---

export type PushCheck =
  /** The branch has not moved: push can go ahead. */
  | { kind: 'ready' }
  /** The branch moved but nothing here changes (e.g. commits outside the subfolder): fast-forward the link first. */
  | { kind: 'fast_forward'; plan: PullPlan }
  /** GitHub has changes to bring in first. */
  | { kind: 'behind'; plan: PullPlan };

/** Step 1 of Commit & Push: is the branch still where the project's link says? */
export async function checkBeforePush(api: SyncApi, files: Files, link: GitHubLink, opts: FlowOptions = {}): Promise<PushCheck> {
  const plan = await preparePull(api, files, link, opts);
  if (plan.head === link.baseCommit) return { kind: 'ready' };
  if (!plan.apply.length && !plan.deleteLocal.length && !plan.conflicts.length) return { kind: 'fast_forward', plan };
  return { kind: 'behind', plan };
}

/**
 * Pushes `changes` as one commit and saves the new link. Once the branch update has been sent the
 * operation is not cancelled any more, so the saved link always matches GitHub. A moved branch
 * rejects with GitHubError `conflict`: pull first.
 */
export async function pushChanges(
  api: SyncApi,
  ctx: Pick<ProjectWriter, 'updateMeta'>,
  link: GitHubLink,
  changes: readonly PushChange[],
  message: string,
  opts: FlowOptions = {},
): Promise<GitHubLink> {
  const uploads = changes.filter((c) => c.status !== 'deleted').length;
  let uploaded = 0;
  const g = guardApi(api, opts.signal, {
    uncancellable: ['updateRef'],
    before: (m) => {
      if (m === 'createTree' || m === 'createCommit') opts.onProgress?.('committing');
      else if (m === 'updateRef') opts.onProgress?.('updating');
    },
    after: (m) => m === 'createBlob' && opts.onProgress?.('uploading', ++uploaded, uploads),
  });
  opts.onProgress?.('uploading', 0, uploads);
  const next = await executePush(g, link, changes, message);
  opts.onProgress?.('saving');
  await ctx.updateMeta({ github: next });
  return next;
}

// --- new / existing repository ---

/** The push plan of a project that is not linked yet: every file is new (`.gitignore` applies). */
export function planFirstPush(files: Files): Promise<PushPlan> {
  return planPush(files, { owner: '', repo: '', branch: '', baseCommit: '', baseTree: {} });
}

export interface NewRepoOptions {
  name: string;
  description?: string;
  private: boolean;
}

/** GitHub can take a moment before a just-created repository's branch is readable. */
async function linkWithRetry(api: SyncApi, owner: string, repo: string, branch: string): Promise<GitHubLink> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await linkToBranch(api, owner, repo, branch);
    } catch (e) {
      if (!(e instanceof GitHubError && (e.code === 'not_found' || e.key === 'repo_empty')) || attempt >= 4) throw e;
      await sleep(800 * (attempt + 1));
    }
  }
}

/**
 * Creates the repository (private by default, with an initial README so the Git Data API can build
 * on it), links the project to its default branch, then pushes the chosen files as the first
 * commit. `pick` chooses from the fresh plan (e.g. the files checked on screen).
 */
export async function createRepositoryAndPush(
  api: GhApi,
  ctx: Pick<ProjectWriter, 'project' | 'updateMeta'>,
  opts: NewRepoOptions & FlowOptions & { message: string; pick: (plan: PushPlan) => PushChange[] },
): Promise<{ link: GitHubLink; pushed: boolean }> {
  if (opts.signal?.aborted) throw abortError(opts.signal);
  opts.onProgress?.('creating');
  // Once the repository is being created it is always linked (not cancellable), so a cancel or a
  // failed push never leaves a repository on GitHub that the project does not know about.
  const repo = await api.createRepo({ name: opts.name, description: opts.description || undefined, private: opts.private, autoInit: true });
  const link = await linkWithRetry(api, repo.owner.login, repo.name, repo.default_branch || 'main');
  // Linked from here on: if the push fails, Commit & Push can simply be tried again.
  await ctx.updateMeta({ github: link });
  if (opts.signal?.aborted) throw abortError(opts.signal);
  const files = ctx.project()?.files ?? {};
  const changes = opts.pick(await planPush(files, link));
  if (!changes.length) return { link, pushed: false };
  const next = await pushChanges(api, ctx, link, changes, opts.message, opts);
  return { link: next, pushed: true };
}

/**
 * Plan for linking a project to an existing branch: with an empty base, files only on GitHub are
 * downloaded, files only here stay as new, and files that differ are conflicts.
 */
export async function prepareLink(api: SyncApi, files: Files, target: CloneTarget, opts: FlowOptions = {}): Promise<PullPlan> {
  opts.onProgress?.('reading');
  const g = guardApi(api, opts.signal);
  const remote = await fetchRemote(g, target);
  const link: GitHubLink = { owner: target.owner, repo: target.repo, branch: target.branch, baseCommit: remote.head, baseTree: {} };
  const subdir = normalizeSubdir(target.subdir);
  if (subdir) link.subdir = subdir;
  return planPull(files, link, remote.tree, remote.head, { remoteModes: remote.modes });
}

/**
 * Plan for switching the project to another branch: local changes are carried over, files the
 * other branch changed are taken, and files changed on both sides are conflicts.
 */
export async function prepareBranchSwitch(api: SyncApi, files: Files, link: GitHubLink, branch: string, opts: FlowOptions = {}): Promise<PullPlan> {
  return preparePull(api, files, { ...link, branch }, opts);
}

// --- Pages ---

export interface PagesResult {
  url: string;
  /** False when the build was still running when we stopped waiting. */
  built: boolean;
}

/**
 * Enables GitHub Pages for the link's branch if needed (root, or `/docs` when the project is the
 * `docs` folder), then waits for the build of the current commit.
 */
export async function publishPages(
  api: Pick<GhApi, 'getPages' | 'enablePages' | 'latestPagesBuild'>,
  link: GitHubLink,
  opts: FlowOptions & { pollMs?: number; timeoutMs?: number; now?: () => number } = {},
): Promise<PagesResult> {
  const now = opts.now ?? Date.now;
  const g = guardApi(api, opts.signal);
  const { owner, repo, branch } = link;
  const sourcePath: '/' | '/docs' = link.subdir === 'docs' ? '/docs' : '/';
  opts.onProgress?.('enabling');
  let pages = await g.getPages(owner, repo);
  if (!pages) {
    try {
      pages = await g.enablePages(owner, repo, branch, sourcePath);
    } catch (e) {
      // 409: enabled meanwhile.
      if (!(e instanceof GitHubError && e.status === 409)) throw e;
      pages = await g.getPages(owner, repo);
    }
  }
  let url = pages?.html_url || defaultPagesUrl(owner, repo);
  if (!url.endsWith('/')) url += '/';
  if (link.subdir && link.subdir !== 'docs') url += `${link.subdir.split('/').map(encodeURIComponent).join('/')}/`;

  const started = now();
  const timeout = opts.timeoutMs ?? 180_000;
  const poll = opts.pollMs ?? 3000;
  opts.onProgress?.('building');
  for (;;) {
    const build = await g.latestPagesBuild(owner, repo);
    if (build) {
      const current =
        !build.commit || build.commit === link.baseCommit || (build.created_at !== undefined && Date.parse(build.created_at) >= started - 10_000);
      if (build.status === 'errored' && current) throw new PagesBuildError(build.error?.message ?? null);
      if (build.status === 'built' && current) return { url, built: true };
    }
    if (now() - started >= timeout) return { url, built: false };
    await sleep(poll, opts.signal);
  }
}
