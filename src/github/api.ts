/**
 * Typed client for the parts of the GitHub REST API Codevia uses. All traffic goes through
 * `githubRequest` (http.ts); the token comes from a provider so it can be refreshed lazily.
 */
import { base64ToBytes, bytesToBase64 } from '../core/bytes';
import { GitHubError } from './errors';
import { API_BASE, githubRequest, type GitHubRequest, type GitHubResponse } from './http';

export interface GitHubUser {
  login: string;
  id: number;
  name: string | null;
  avatar_url: string;
  html_url: string;
}

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string };
  private: boolean;
  /** True for forks of another repository. */
  fork?: boolean;
  description: string | null;
  default_branch: string;
  html_url: string;
  pushed_at: string | null;
  /** Approximate size in KB, as reported by GitHub. */
  size: number;
  permissions?: { admin?: boolean; push?: boolean; pull?: boolean };
}

export interface GitHubBranchSummary {
  name: string;
  commit: { sha: string };
  protected: boolean;
}

/** Branch head: the commit SHA and the SHA of its root tree. */
export interface BranchHead {
  name: string;
  commitSha: string;
  treeSha: string;
}

export interface CommitInfo {
  sha: string;
  treeSha: string;
}

export interface TreeEntry {
  path: string;
  /** `100644` file, `100755` executable, `120000` symlink, `040000` tree, `160000` submodule. */
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
}

export interface GitTree {
  sha: string;
  entries: TreeEntry[];
  /** True when GitHub cut the recursive listing short (very large repositories). */
  truncated: boolean;
}

/** Entry for `createTree`. `sha: null` deletes the path from `base_tree`. */
export interface NewTreeEntry {
  path: string;
  mode: string;
  type: 'blob';
  sha: string | null;
}

export interface GitHubPages {
  url: string;
  status: string | null;
  html_url?: string;
  source?: { branch: string; path: string };
}

export interface GitHubPagesBuild {
  status: 'queued' | 'building' | 'built' | 'errored' | string;
  error?: { message: string | null };
  commit?: string;
  created_at?: string;
}

export interface CreateRepoOptions {
  name: string;
  description?: string;
  /** Default true. */
  private?: boolean;
  /**
   * Create an initial commit (README). Default true: the Git Data API cannot write to an
   * empty repository, so the first push needs a commit to build on.
   */
  autoInit?: boolean;
}

export type TokenProvider = () => string | null | Promise<string | null>;

const seg = (s: string) => encodeURIComponent(s);
/** Encodes a ref/branch keeping `/` separators (branches like `feature/x`). */
const refPath = (ref: string) => ref.split('/').map(encodeURIComponent).join('/');

/** Returns the `rel="next"` URL of a Link header, if any. */
export function nextLink(link: string | undefined): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (m) return m[1]!;
  }
  return null;
}

export class GitHubClient {
  constructor(private readonly token: TokenProvider) {}

  private async call<T>(path: string, init: Omit<GitHubRequest, 'url' | 'token'> = {}): Promise<GitHubResponse<T>> {
    const url = path.startsWith('https://') ? path : `${API_BASE}${path}`;
    return githubRequest<T>({ ...init, url, token: await this.token() });
  }

  private async paginate<T>(path: string, query: GitHubRequest['query'], maxPages: number): Promise<T[]> {
    const out: T[] = [];
    let next: string | null = path;
    let first = true;
    for (let page = 0; next && page < maxPages; page++) {
      const res: GitHubResponse<T[]> = await this.call<T[]>(next, first ? { query } : {});
      first = false;
      out.push(...res.data);
      next = nextLink(res.headers['link']);
    }
    return out;
  }

  // --- user ---

  async getUser(): Promise<GitHubUser> {
    return (await this.call<GitHubUser>('/user')).data;
  }

  /** Repositories the user owns or collaborates on, most recently pushed first. */
  listRepos(opts: { maxPages?: number } = {}): Promise<GitHubRepo[]> {
    return this.paginate<GitHubRepo>(
      '/user/repos',
      { affiliation: 'owner,collaborator', sort: 'pushed', per_page: 100 },
      opts.maxPages ?? 10,
    );
  }

  listBranches(owner: string, repo: string, opts: { maxPages?: number } = {}): Promise<GitHubBranchSummary[]> {
    return this.paginate<GitHubBranchSummary>(`/repos/${seg(owner)}/${seg(repo)}/branches`, { per_page: 100 }, opts.maxPages ?? 5);
  }

  // --- repos & branches ---

  async getRepo(owner: string, repo: string): Promise<GitHubRepo> {
    return (await this.call<GitHubRepo>(`/repos/${seg(owner)}/${seg(repo)}`)).data;
  }

  async getBranch(owner: string, repo: string, branch: string): Promise<BranchHead> {
    const { data } = await this.call<{ name: string; commit: { sha: string; commit: { tree: { sha: string } } } }>(
      `/repos/${seg(owner)}/${seg(repo)}/branches/${refPath(branch)}`,
    );
    return { name: data.name, commitSha: data.commit.sha, treeSha: data.commit.commit.tree.sha };
  }

  async getCommit(owner: string, repo: string, sha: string): Promise<CommitInfo> {
    const { data } = await this.call<{ sha: string; tree: { sha: string } }>(`/repos/${seg(owner)}/${seg(repo)}/git/commits/${seg(sha)}`);
    return { sha: data.sha, treeSha: data.tree.sha };
  }

  async createRepo(opts: CreateRepoOptions): Promise<GitHubRepo> {
    const { data } = await this.call<GitHubRepo>('/user/repos', {
      method: 'POST',
      json: {
        name: opts.name,
        description: opts.description,
        private: opts.private ?? true,
        auto_init: opts.autoInit ?? true,
      },
    });
    return data;
  }

  // --- content ---

  async getTree(owner: string, repo: string, treeSha: string, recursive = true): Promise<GitTree> {
    const { data } = await this.call<{ sha: string; tree: TreeEntry[]; truncated?: boolean }>(
      `/repos/${seg(owner)}/${seg(repo)}/git/trees/${seg(treeSha)}`,
      { query: recursive ? { recursive: 1 } : undefined },
    );
    return { sha: data.sha, entries: data.tree, truncated: data.truncated === true };
  }

  /** Downloads one blob and returns its raw bytes. */
  async getBlob(owner: string, repo: string, sha: string): Promise<Uint8Array> {
    const { data } = await this.call<{ content: string; encoding: string }>(`/repos/${seg(owner)}/${seg(repo)}/git/blobs/${seg(sha)}`);
    if (data.encoding !== 'base64') throw new GitHubError('unknown', { detail: `Unexpected blob encoding ${data.encoding}` });
    return base64ToBytes(data.content.replace(/\s+/g, ''));
  }

  /** Downloads the ZIP archive of `ref` (a branch, tag or commit SHA). Redirects to codeload.github.com. */
  async downloadZipball(owner: string, repo: string, ref: string, signal?: AbortSignal): Promise<Uint8Array> {
    const { data } = await this.call<Uint8Array>(`/repos/${seg(owner)}/${seg(repo)}/zipball/${refPath(ref)}`, {
      responseType: 'binary',
      signal,
    });
    return data;
  }

  // --- Git Data API (writes) ---

  async createBlob(owner: string, repo: string, bytes: Uint8Array): Promise<string> {
    const { data } = await this.call<{ sha: string }>(`/repos/${seg(owner)}/${seg(repo)}/git/blobs`, {
      method: 'POST',
      json: { content: bytesToBase64(bytes), encoding: 'base64' },
    });
    return data.sha;
  }

  async createTree(owner: string, repo: string, baseTree: string, entries: NewTreeEntry[]): Promise<string> {
    const { data } = await this.call<{ sha: string }>(`/repos/${seg(owner)}/${seg(repo)}/git/trees`, {
      method: 'POST',
      json: { base_tree: baseTree, tree: entries },
    });
    return data.sha;
  }

  async createCommit(owner: string, repo: string, commit: { message: string; tree: string; parents: string[] }): Promise<string> {
    const { data } = await this.call<{ sha: string }>(`/repos/${seg(owner)}/${seg(repo)}/git/commits`, {
      method: 'POST',
      json: commit,
    });
    return data.sha;
  }

  /** Moves `heads/<branch>` to `sha`, fast-forward only. GitHub answers 422 when the branch moved. */
  async updateRef(owner: string, repo: string, branch: string, sha: string): Promise<void> {
    await this.call(`/repos/${seg(owner)}/${seg(repo)}/git/refs/heads/${refPath(branch)}`, {
      method: 'PATCH',
      json: { sha, force: false },
    });
  }

  // --- Pages ---

  async enablePages(owner: string, repo: string, branch: string, path: '/' | '/docs' = '/'): Promise<GitHubPages> {
    const { data } = await this.call<GitHubPages>(`/repos/${seg(owner)}/${seg(repo)}/pages`, {
      method: 'POST',
      json: { source: { branch, path } },
    });
    return data;
  }

  /** Pages settings, or null when Pages is not enabled for the repository. */
  async getPages(owner: string, repo: string): Promise<GitHubPages | null> {
    try {
      return (await this.call<GitHubPages>(`/repos/${seg(owner)}/${seg(repo)}/pages`)).data;
    } catch (e) {
      if (e instanceof GitHubError && e.code === 'not_found') return null;
      throw e;
    }
  }

  /** Latest Pages build, or null when there is none yet. */
  async latestPagesBuild(owner: string, repo: string): Promise<GitHubPagesBuild | null> {
    try {
      return (await this.call<GitHubPagesBuild>(`/repos/${seg(owner)}/${seg(repo)}/pages/builds/latest`)).data;
    } catch (e) {
      if (e instanceof GitHubError && e.code === 'not_found') return null;
      throw e;
    }
  }
}

/** Creates a client; pass e.g. `getAccessToken` from auth.ts. */
export const createGitHubClient = (token: TokenProvider): GitHubClient => new GitHubClient(token);
