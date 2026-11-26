/**
 * The GitHub sync engine: clone, status, three-way pull and single-commit push.
 *
 * Pure apart from the injected `SyncApi`, so it is fully testable. Files are compared by git blob
 * SHA-1 computed locally (see docs/GITHUB.md): local vs `link.baseTree` vs the remote tree.
 * Nothing here writes to storage; callers persist the returned Files and link.
 */
import { encodeUtf8 } from '../core/bytes';
import { toProjectFile } from '../core/files';
import { basename, isJunkPath, normalizePath, sanitizeImportName } from '../core/paths';
import { detectLanguage } from '../core/templates';
import { LIMITS, type Files, type GitHubLink, type Language, type ProjectFile } from '../core/types';
import { stripCommonRoot, unzip, ZipError } from '../core/zip';
import type { BranchHead, CommitInfo, GitTree, NewTreeEntry } from './api';
import { GitHubError } from './errors';
import { createGitignore } from './gitignore';
import { gitBlobSha1 } from './hash';
import { detectSecret, type SecretReason } from './secrets';

export type { GitHubLink };
export { gitBlobSha1 };

/** Blobs uploaded / downloaded in parallel. */
export const SYNC_CONCURRENCY = 4;
const REGULAR_MODE = '100644';
const SYMLINK_MODE = '120000';

/** The part of GitHubClient the engine uses. Inject a mock in tests. */
export interface SyncApi {
  getBranch(owner: string, repo: string, branch: string): Promise<BranchHead>;
  getCommit(owner: string, repo: string, sha: string): Promise<CommitInfo>;
  getTree(owner: string, repo: string, treeSha: string, recursive?: boolean): Promise<GitTree>;
  getBlob(owner: string, repo: string, sha: string): Promise<Uint8Array>;
  downloadZipball(owner: string, repo: string, ref: string, signal?: AbortSignal): Promise<Uint8Array>;
  createBlob(owner: string, repo: string, bytes: Uint8Array): Promise<string>;
  createTree(owner: string, repo: string, baseTree: string, entries: NewTreeEntry[]): Promise<string>;
  createCommit(owner: string, repo: string, commit: { message: string; tree: string; parents: string[] }): Promise<string>;
  updateRef(owner: string, repo: string, branch: string, sha: string): Promise<void>;
}

// --- helpers ---

const fileBytes = (f: ProjectFile): Uint8Array => (f.text ? encodeUtf8(f.content) : f.data);

/** Runs `fn` over `items` with at most `limit` calls in flight; results keep input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Caches git SHAs by content (text by string, binary by array identity). */
export class ShaCache {
  private readonly text = new Map<string, Promise<string>>();
  private readonly binary = new WeakMap<Uint8Array, Promise<string>>();

  sha(file: ProjectFile): Promise<string> {
    if (file.text) {
      let p = this.text.get(file.content);
      if (!p) this.text.set(file.content, (p = gitBlobSha1(encodeUtf8(file.content))));
      return p;
    }
    let p = this.binary.get(file.data);
    if (!p) this.binary.set(file.data, (p = gitBlobSha1(file.data)));
    return p;
  }
}

/**
 * True for paths the engine can sync: valid project paths, no archive junk, nothing inside `.git`.
 * Remote files with other paths are left alone (never downloaded, never deleted).
 */
export function isSyncablePath(path: string): boolean {
  try {
    return (
      normalizePath(path) === path &&
      sanitizeImportName(path) === path &&
      !isJunkPath(path) &&
      !path.split('/').includes('.git')
    );
  } catch {
    return false;
  }
}

/** Trims slashes and validates a repository subfolder; '' → undefined. */
export function normalizeSubdir(subdir: string | undefined): string | undefined {
  const s = (subdir ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!s) return undefined;
  try {
    return normalizePath(s);
  } catch {
    throw new GitHubError('validation', { key: 'subdir_not_found' });
  }
}

/** Project path → repository path. */
export const toRepoPath = (path: string, subdir?: string): string => (subdir ? `${subdir}/${path}` : path);

/** Repository path → project path, or null when outside `subdir`. */
export function fromRepoPath(repoPath: string, subdir?: string): string | null {
  if (!subdir) return repoPath;
  return repoPath.startsWith(subdir + '/') ? repoPath.slice(subdir.length + 1) : null;
}

/** Git SHA of every syncable local file. */
export async function localShas(files: Files, cache = new ShaCache()): Promise<Record<string, string>> {
  const paths = Object.keys(files).filter(isSyncablePath);
  const shas = await Promise.all(paths.map((p) => cache.sha(files[p]!)));
  const out: Record<string, string> = {};
  paths.forEach((p, i) => (out[p] = shas[i]!));
  return out;
}

// --- remote state ---

export interface RemoteState {
  /** Head commit of the branch. */
  head: string;
  /** Project path → blob SHA for every syncable file (relative to `subdir`). */
  tree: Record<string, string>;
  /** Non-regular modes (e.g. `100755`) of files in `tree`. */
  modes: Record<string, string>;
  /** Total size in bytes of the files in `tree`. */
  size: number;
  /** Remote paths the app leaves alone: symlinks, submodules, unsupported names, oversized files. */
  skipped: string[];
}

export interface RemoteTarget {
  owner: string;
  repo: string;
  branch: string;
  subdir?: string;
}

async function subtreeSha(api: SyncApi, t: RemoteTarget, rootTree: string, subdir: string): Promise<string> {
  let sha = rootTree;
  for (const name of subdir.split('/')) {
    const tree = await api.getTree(t.owner, t.repo, sha, false);
    const entry = tree.entries.find((e) => e.type === 'tree' && e.path === name);
    if (!entry) throw new GitHubError('not_found', { key: 'subdir_not_found' });
    sha = entry.sha;
  }
  return sha;
}

/** Reads the branch head and its (sub)tree. Throws `tree_truncated` when GitHub cuts the listing. */
export async function fetchRemote(api: SyncApi, target: RemoteTarget): Promise<RemoteState> {
  const subdir = normalizeSubdir(target.subdir);
  const head = await api.getBranch(target.owner, target.repo, target.branch);
  const treeSha = subdir ? await subtreeSha(api, target, head.treeSha, subdir) : head.treeSha;
  const listing = await api.getTree(target.owner, target.repo, treeSha, true);
  if (listing.truncated) throw new GitHubError('validation', { key: 'tree_truncated' });

  const state: RemoteState = { head: head.commitSha, tree: {}, modes: {}, size: 0, skipped: [] };
  const seen = new Set<string>();
  for (const e of listing.entries) {
    if (e.type === 'tree') continue;
    const lower = e.path.toLowerCase();
    const ok =
      e.type === 'blob' &&
      e.mode !== SYMLINK_MODE &&
      isSyncablePath(e.path) &&
      (e.size ?? 0) <= LIMITS.maxFileBytes &&
      !seen.has(lower); // case-only duplicates cannot coexist on iOS
    if (!ok) {
      state.skipped.push(e.path);
      continue;
    }
    seen.add(lower);
    state.tree[e.path] = e.sha;
    state.size += e.size ?? 0;
    if (e.mode !== REGULAR_MODE) state.modes[e.path] = e.mode;
  }
  return state;
}

// --- clone ---

export interface CloneOptions {
  subdir?: string;
  signal?: AbortSignal;
}

export interface CloneResult {
  files: Files;
  link: GitHubLink;
  /** Detected project language (index.html → web, main.py → python, index.php → php). */
  language: Language;
  /** Remote paths not brought into the project (see RemoteState.skipped). */
  skipped: string[];
}

/**
 * Downloads a branch as a new project: zipball of the head commit (root folder stripped, `subdir`
 * applied, size limits enforced), then the tree for `baseTree`. Files the archive lacks or that
 * differ from the tree (`.gitattributes` export rules) are fetched as blobs.
 */
export async function clone(api: SyncApi, owner: string, repo: string, branch: string, opts: CloneOptions = {}): Promise<CloneResult> {
  const subdir = normalizeSubdir(opts.subdir);
  const remote = await fetchRemote(api, { owner, repo, branch, subdir });
  if (Object.keys(remote.tree).length > LIMITS.maxFilesPerProject || remote.size > LIMITS.maxProjectBytes) {
    throw new GitHubError('validation', { key: 'repo_too_large' });
  }

  const zip = await api.downloadZipball(owner, repo, remote.head, opts.signal);
  if (zip.byteLength > LIMITS.maxZipBytes) throw new GitHubError('validation', { key: 'repo_too_large' });
  let unpacked: Files;
  try {
    // Single files are size-checked via the tree, so one large asset does not fail the whole clone.
    unpacked = (await unzip(zip, { maxFileBytes: LIMITS.maxProjectBytes })).files;
  } catch (e) {
    if (e instanceof ZipError) throw new GitHubError('validation', { key: 'zip_invalid', detail: e.message });
    throw e;
  }

  const files: Files = {};
  for (const [path, f] of Object.entries(stripCommonRoot(unpacked).files)) {
    const local = fromRepoPath(path, subdir);
    if (local !== null && remote.tree[local] !== undefined) files[local] = f;
  }

  const cache = new ShaCache();
  const refetch: string[] = [];
  await mapLimit(Object.keys(remote.tree), 16, async (path) => {
    const f = files[path];
    if (!f || (await cache.sha(f)) !== remote.tree[path]) refetch.push(path);
  });
  await mapLimit(refetch, SYNC_CONCURRENCY, async (path) => {
    files[path] = toProjectFile(path, await api.getBlob(owner, repo, remote.tree[path]!));
  });

  const link: GitHubLink = { owner, repo, branch, baseCommit: remote.head, baseTree: { ...remote.tree } };
  if (Object.keys(remote.modes).length) link.modes = { ...remote.modes };
  if (subdir) link.subdir = subdir;
  return { files, link, language: detectLanguage(Object.keys(files)), skipped: remote.skipped };
}

/**
 * Link for a project that is about to be pushed into an existing branch for the first time
 * (e.g. right after createRepo with an initial README). Every local file counts as added and
 * nothing remote is deleted; remote-only files arrive with the next pull.
 */
export async function linkToBranch(api: SyncApi, owner: string, repo: string, branch: string, subdir?: string): Promise<GitHubLink> {
  const head = await api.getBranch(owner, repo, branch);
  const link: GitHubLink = { owner, repo, branch, baseCommit: head.commitSha, baseTree: {} };
  const sub = normalizeSubdir(subdir);
  if (sub) link.subdir = sub;
  return link;
}

/** Downloads one remote file as a ProjectFile (for diffs of conflicts). */
export async function fetchRemoteFile(api: SyncApi, link: GitHubLink, path: string, sha: string): Promise<ProjectFile> {
  return toProjectFile(path, await api.getBlob(link.owner, link.repo, sha));
}

// --- status ---

export interface SyncStatus {
  added: string[];
  modified: string[];
  deleted: string[];
}

/** Local changes since `link.baseCommit` (sorted). */
export async function status(files: Files, link: GitHubLink, cache = new ShaCache()): Promise<SyncStatus> {
  const local = await localShas(files, cache);
  const out: SyncStatus = { added: [], modified: [], deleted: [] };
  for (const [path, sha] of Object.entries(local)) {
    const base = link.baseTree[path];
    if (base === undefined) out.added.push(path);
    else if (base !== sha) out.modified.push(path);
  }
  for (const path of Object.keys(link.baseTree)) if (local[path] === undefined) out.deleted.push(path);
  out.added.sort();
  out.modified.sort();
  out.deleted.sort();
  return out;
}

// --- pull ---

export type ConflictKind = 'both_modified' | 'both_added' | 'modified_locally_deleted_remotely' | 'deleted_locally_modified_remotely';

export interface PullConflict {
  path: string;
  kind: ConflictKind;
  /** Remote blob SHA; absent when the file was deleted on GitHub. */
  remoteSha?: string;
}

export interface PullPlan {
  /** Inputs the plan was computed from. */
  link: GitHubLink;
  files: Files;
  head: string;
  remoteTree: Record<string, string>;
  remoteModes: Record<string, string>;
  /** Changed (or added) on GitHub only: download these. */
  apply: Array<{ path: string; sha: string }>;
  /** Deleted on GitHub and unchanged locally. */
  deleteLocal: string[];
  /** Changed on both sides with different results. */
  conflicts: PullConflict[];
  /** Changed locally only: kept, and pushed later. */
  keepLocal: string[];
  /** Nothing changed on GitHub since `link.baseCommit`. */
  upToDate: boolean;
}

/**
 * Three-way comparison of local files, `link.baseTree` and the remote tree. A file changed the
 * same way on both sides is not a conflict. Use `fetchRemote` for `remoteTree` / `remoteHead`.
 */
export async function planPull(
  files: Files,
  link: GitHubLink,
  remoteTree: Record<string, string>,
  remoteHead: string,
  opts: { remoteModes?: Record<string, string>; cache?: ShaCache } = {},
): Promise<PullPlan> {
  const local = await localShas(files, opts.cache);
  const remote: Record<string, string> = {};
  for (const [p, sha] of Object.entries(remoteTree)) if (isSyncablePath(p)) remote[p] = sha;

  const plan: PullPlan = {
    link,
    files,
    head: remoteHead,
    remoteTree: remote,
    remoteModes: opts.remoteModes ?? {},
    apply: [],
    deleteLocal: [],
    conflicts: [],
    keepLocal: [],
    upToDate: false,
  };
  const paths = new Set([...Object.keys(local), ...Object.keys(link.baseTree), ...Object.keys(remote)]);
  for (const path of [...paths].sort()) {
    const L = local[path];
    const B = link.baseTree[path];
    const R = remote[path];
    if (R === B) {
      if (L !== B) plan.keepLocal.push(path);
    } else if (L === B) {
      if (R === undefined) plan.deleteLocal.push(path);
      else plan.apply.push({ path, sha: R });
    } else if (L !== R) {
      const kind: ConflictKind =
        B === undefined
          ? 'both_added'
          : L === undefined
            ? 'deleted_locally_modified_remotely'
            : R === undefined
              ? 'modified_locally_deleted_remotely'
              : 'both_modified';
      plan.conflicts.push(R === undefined ? { path, kind } : { path, kind, remoteSha: R });
    }
    // L === R !== B: changed identically on both sides; nothing to do.
  }
  plan.upToDate = remoteHead === link.baseCommit && !plan.apply.length && !plan.deleteLocal.length && !plan.conflicts.length;
  return plan;
}

/** `local` keeps the project's version (pushed later); `remote` takes GitHub's. Default `local`. */
export type ConflictResolution = 'local' | 'remote';

export interface PullResult {
  files: Files;
  link: GitHubLink;
  /** Paths whose content changed: save these. */
  written: string[];
  /** Paths removed: delete these (before writing, for case-only renames on iOS). */
  deleted: string[];
}

/**
 * Applies a pull plan: downloads `apply` and conflicts resolved as `remote`, deletes `deleteLocal`.
 * Unresolved conflicts keep the local version. The new link's base is the remote tree, so kept
 * local versions show up as local changes to push.
 */
export async function executePull(
  api: SyncApi,
  plan: PullPlan,
  resolutions: Record<string, ConflictResolution> = {},
): Promise<PullResult> {
  const { owner, repo } = plan.link;
  const downloads = [...plan.apply];
  const deleted = [...plan.deleteLocal];
  for (const c of plan.conflicts) {
    if (resolutions[c.path] !== 'remote') continue;
    if (c.remoteSha) downloads.push({ path: c.path, sha: c.remoteSha });
    else if (plan.files[c.path]) deleted.push(c.path);
  }

  const bySha = new Map<string, Promise<Uint8Array>>();
  const fetched = await mapLimit(downloads, SYNC_CONCURRENCY, async ({ path, sha }) => {
    let p = bySha.get(sha);
    if (!p) bySha.set(sha, (p = api.getBlob(owner, repo, sha)));
    return [path, toProjectFile(path, await p)] as const;
  });

  const files: Files = { ...plan.files };
  for (const path of deleted) delete files[path];
  for (const [path, file] of fetched) files[path] = file;

  const link: GitHubLink = { ...plan.link, baseCommit: plan.head, baseTree: { ...plan.remoteTree } };
  const modes: Record<string, string> = {};
  for (const [p, m] of Object.entries(plan.remoteModes)) if (link.baseTree[p] !== undefined) modes[p] = m;
  if (Object.keys(modes).length) link.modes = modes;
  else delete link.modes;
  return { files, link, written: fetched.map(([p]) => p), deleted };
}

// --- push ---

export interface PushChange {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  /** Local git blob SHA (absent for deletions). */
  sha?: string;
  /** Content to upload (absent for deletions). */
  file?: ProjectFile;
  /** Set when the file looks like a secret: warn before pushing. */
  secret?: SecretReason;
}

export interface PushPlan {
  changes: PushChange[];
  /** New files skipped because `.gitignore` matches them. */
  ignored: string[];
  /** Changes flagged as likely secrets. */
  secrets: Array<{ path: string; reason: SecretReason }>;
}

/**
 * Local changes to send. `.gitignore` (from `opts.gitignore`, else the project's root
 * `.gitignore`) applies to new files only: as in git, tracked files stay tracked.
 */
export async function planPush(files: Files, link: GitHubLink, opts: { gitignore?: string; cache?: ShaCache } = {}): Promise<PushPlan> {
  const cache = opts.cache ?? new ShaCache();
  const st = await status(files, link, cache);
  const rootIgnore = files['.gitignore'];
  const ignore = createGitignore(opts.gitignore ?? (rootIgnore?.text ? rootIgnore.content : ''));
  const plan: PushPlan = { changes: [], ignored: [], secrets: [] };

  const upload = async (path: string, kind: 'added' | 'modified') => {
    const file = files[path]!;
    const change: PushChange = { path, status: kind, sha: await cache.sha(file), file };
    const secret = detectSecret(path, file);
    if (secret) {
      change.secret = secret;
      plan.secrets.push({ path, reason: secret });
    }
    plan.changes.push(change);
  };
  for (const path of st.added) {
    if (ignore.ignores(path)) plan.ignored.push(path);
    else await upload(path, 'added');
  }
  for (const path of st.modified) await upload(path, 'modified');
  for (const path of st.deleted) plan.changes.push({ path, status: 'deleted' });
  plan.changes.sort((a, b) => a.path.localeCompare(b.path));
  return plan;
}

/** Prefilled commit message, e.g. "Update index.html, style.css". */
export function defaultCommitMessage(changes: readonly PushChange[]): string {
  if (!changes.length) return 'Update';
  const verb = changes.every((c) => c.status === 'added') ? 'Add' : changes.every((c) => c.status === 'deleted') ? 'Delete' : 'Update';
  const names = [...new Set(changes.map((c) => basename(c.path)))];
  const shown = names.slice(0, 3).join(', ');
  return names.length > 3 ? `${verb} ${shown} and ${names.length - 3} more` : `${verb} ${shown}`;
}

/**
 * Pushes `changes` as one commit on top of `link.baseCommit`:
 * blobs (at most 4 in parallel; content already in the base tree is not re-uploaded) → tree on the
 * base commit's tree (deletions as `sha: null`) → commit → fast-forward ref update.
 * A 422 from the ref update means the branch moved: GitHubError `conflict`, pull first.
 * Returns the new link.
 */
export async function executePush(api: SyncApi, link: GitHubLink, changes: readonly PushChange[], message: string): Promise<GitHubLink> {
  if (!changes.length) throw new GitHubError('validation', { key: 'nothing_to_push' });
  const { owner, repo } = link;
  const known = new Set(Object.values(link.baseTree));
  const uploads = new Map<string, Promise<string>>();
  const shas = new Map<string, string>();

  await mapLimit(
    changes.filter((c) => c.status !== 'deleted'),
    SYNC_CONCURRENCY,
    async (c) => {
      if (!c.file) throw new GitHubError('validation', { detail: `No content for ${c.path}` });
      const bytes = fileBytes(c.file);
      const local = c.sha ?? (await gitBlobSha1(bytes));
      let p = uploads.get(local);
      if (!p) uploads.set(local, (p = known.has(local) ? Promise.resolve(local) : api.createBlob(owner, repo, bytes)));
      shas.set(c.path, await p);
    },
  );

  const base = await api.getCommit(owner, repo, link.baseCommit);
  const entries: NewTreeEntry[] = changes.map((c) => ({
    path: toRepoPath(c.path, link.subdir),
    mode: link.modes?.[c.path] ?? REGULAR_MODE,
    type: 'blob',
    sha: c.status === 'deleted' ? null : shas.get(c.path)!,
  }));
  const tree = await api.createTree(owner, repo, base.treeSha, entries);
  const commit = await api.createCommit(owner, repo, {
    message: message.trim() || defaultCommitMessage(changes),
    tree,
    parents: [link.baseCommit],
  });
  try {
    await api.updateRef(owner, repo, link.branch, commit);
  } catch (e) {
    if (e instanceof GitHubError && e.status === 422) throw new GitHubError('conflict', { status: 422, detail: e.detail });
    throw e;
  }

  const baseTree = { ...link.baseTree };
  const modes = { ...(link.modes ?? {}) };
  for (const c of changes) {
    if (c.status === 'deleted') {
      delete baseTree[c.path];
      delete modes[c.path];
    } else {
      baseTree[c.path] = shas.get(c.path)!;
    }
  }
  const next: GitHubLink = { ...link, baseCommit: commit, baseTree };
  if (Object.keys(modes).length) next.modes = modes;
  else delete next.modes;
  return next;
}
