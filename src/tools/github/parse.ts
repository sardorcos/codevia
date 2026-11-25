/**
 * Pure helpers for the GitHub panels: parsing what the user types into "Clone by URL",
 * GitHub's repository-name rules, and a repository name suggested from a project name.
 */

export interface RepoRef {
  owner: string;
  repo: string;
  /** First segment after `/tree/` (or `/blob/`); may be only the start of a branch with slashes. */
  branch?: string;
  /** Rest of the path after the branch, without slashes at the ends. */
  subdir?: string;
  /** Every segment after `/tree/`, for resolveTreePath() once the branch names are known. */
  treePath?: string[];
}

/** GitHub user/organisation names: letters, digits and single hyphens, 1–39 characters. */
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

const isOwner = (s: string): boolean => OWNER_RE.test(s);
const isRepo = (s: string): boolean => REPO_RE.test(s) && s !== '.' && s !== '..';

function decode(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

/**
 * Parses `owner/repo`, `https://github.com/owner/repo(.git)`, `github.com/owner/repo`,
 * `git@github.com:owner/repo.git` and `…/tree/<branch>/<subdir>` (or `/blob/<branch>/<file>`, which
 * selects the file's folder). Returns null for anything else, including other hosts.
 */
export function parseRepoInput(input: string): RepoRef | null {
  let s = input.trim();
  if (!s) return null;
  let path: string;
  const ssh = /^(?:ssh:\/\/)?git@github\.com[:/](.+)$/i.exec(s);
  if (ssh) {
    path = ssh[1]!;
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^(www\.)?github\.com\//i.test(s)) {
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
    let url: URL;
    try {
      url = new URL(s);
    } catch {
      return null;
    }
    if (!/^https?:$/.test(url.protocol)) return null;
    if (!/^(www\.)?github\.com$/i.test(url.hostname)) return null;
    path = url.pathname;
  } else {
    // A bare `owner/repo` (optionally with /tree/… after it); no spaces, no other punctuation.
    if (/\s/.test(s) || s.includes(':')) return null;
    path = s.replace(/[?#].*$/, '');
  }

  const parts = path.split('/').filter(Boolean).map(decode);
  if (parts.length < 2) return null;
  const owner = parts[0]!;
  const repo = parts[1]!.replace(/\.git$/i, '');
  if (!isOwner(owner) || !isRepo(repo)) return null;
  const ref: RepoRef = { owner, repo };

  const kind = parts[2];
  const rest = parts.slice(3);
  if ((kind === 'tree' || kind === 'blob') && rest.length) {
    // For a file link, its folder is the subfolder.
    const segs = kind === 'blob' ? rest.slice(0, -1) : rest;
    if (!segs.length) return ref;
    ref.treePath = segs;
    ref.branch = segs[0];
    if (segs.length > 1) ref.subdir = segs.slice(1).join('/');
  }
  return ref;
}

/**
 * Splits `/tree/` segments into a branch and a subfolder now that the branch names are known:
 * the longest branch that matches the leading segments wins (`feature/x/src` → `feature/x` + `src`).
 */
export function resolveTreePath(treePath: readonly string[], branches: readonly string[]): { branch: string; subdir?: string } | null {
  const names = new Set(branches);
  for (let n = treePath.length; n >= 1; n--) {
    const branch = treePath.slice(0, n).join('/');
    if (names.has(branch)) {
      const subdir = treePath.slice(n).join('/');
      return subdir ? { branch, subdir } : { branch };
    }
  }
  return null;
}

export type RepoNameProblem = 'empty' | 'too_long' | 'chars' | 'reserved' | 'git_suffix';

/** GitHub repository-name rules. Returns the first problem, or null when the name is valid. */
export function validateRepoName(name: string): RepoNameProblem | null {
  if (!name) return 'empty';
  if (name.length > 100) return 'too_long';
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return 'chars';
  if (name === '.' || name === '..') return 'reserved';
  if (/\.git$/i.test(name)) return 'git_suffix';
  return null;
}

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', і: 'i', ї: 'yi', є: 'ye', ґ: 'g', ў: 'u', қ: 'q', ғ: 'g', ң: 'n',
  ү: 'u', ұ: 'u', һ: 'h', ә: 'a', ө: 'o',
};

/** A valid repository name derived from a project name ("Мой сайт" → "moy-sayt"). */
export function suggestRepoName(projectName: string): string {
  const latin = [...projectName.trim().toLowerCase()]
    .map((c) => TRANSLIT[c] ?? c)
    .join('')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '');
  let name = latin
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 100)
    .replace(/[-.]+$/g, '');
  if (/\.git$/.test(name)) name = name.slice(0, -4);
  return validateRepoName(name) ? 'codevia-project' : name;
}

/** `https://github.com/owner/repo[/tree/branch[/subdir]]`. */
export function repoWebUrl(link: { owner: string; repo: string; branch?: string; subdir?: string }): string {
  const enc = (s: string) => s.split('/').map(encodeURIComponent).join('/');
  let url = `https://github.com/${encodeURIComponent(link.owner)}/${encodeURIComponent(link.repo)}`;
  if (link.branch) url += `/tree/${enc(link.branch)}${link.subdir ? `/${enc(link.subdir)}` : ''}`;
  return url;
}

export const commitWebUrl = (link: { owner: string; repo: string }, sha: string): string =>
  `https://github.com/${encodeURIComponent(link.owner)}/${encodeURIComponent(link.repo)}/commit/${encodeURIComponent(sha)}`;

/** The default Pages address, `https://owner.github.io/repo/` (or the user site for `owner.github.io`). */
export function defaultPagesUrl(owner: string, repo: string): string {
  const host = `${owner.toLowerCase()}.github.io`;
  return repo.toLowerCase() === host ? `https://${host}/` : `https://${host}/${repo}/`;
}
