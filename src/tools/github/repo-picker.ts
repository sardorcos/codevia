/**
 * Repository list with search (private / fork badges, last push) and the branch picker, shared by
 * Clone and "Link existing repository".
 */
import { t } from '../../i18n';
import type { GitHubBranchSummary, GitHubRepo } from '../../github/api';
import type { GhApi } from './flows';
import { isAbortError } from './messages';
import { onAccountChange } from './session';
import { esc, fmtShortDate, icon, Life, renderError, spinnerLine } from './ui';

export interface RepoPickerOptions {
  onPick: (repo: GitHubRepo) => void;
  signIn?: () => void;
  /** Opens the page where the GitHub App gets access to more repositories (GitHub App sign-in only). */
  manageAccess?: () => void;
}

/** Filters by name / owner / description, case-insensitively. */
export function filterRepos(repos: readonly GitHubRepo[], query: string): GitHubRepo[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...repos];
  return repos.filter((r) => r.full_name.toLowerCase().includes(q) || (r.description ?? '').toLowerCase().includes(q));
}

/** Default branch first, then the rest by name. */
export function orderBranches(branches: readonly GitHubBranchSummary[], defaultBranch: string): string[] {
  const names = branches.map((b) => b.name).sort((a, b) => a.localeCompare(b));
  const i = names.indexOf(defaultBranch);
  if (i > 0) names.splice(i, 1);
  if (i !== 0) names.unshift(defaultBranch);
  return names;
}

const MAX_ROWS = 200;

let cache: { at: number; repos: GitHubRepo[] } | null = null;
onAccountChange(() => (cache = null));

export function mountRepoPicker(host: HTMLElement, api: Pick<GhApi, 'listRepos'>, life: Life, opts: RepoPickerOptions): void {
  host.innerHTML = `<div class="gh-repos">
    <div class="search-wrap">${icon('search')}<input class="text-input search-input" type="search" data-q placeholder="${esc(t('Поиск репозиториев'))}" aria-label="${esc(t('Поиск репозиториев'))}" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
    <div data-list>${spinnerLine(t('Загружаем репозитории…'))}</div>
  </div>`;
  const list = host.querySelector<HTMLElement>('[data-list]')!;
  const input = host.querySelector<HTMLInputElement>('[data-q]')!;
  let repos: GitHubRepo[] = [];

  const draw = () => {
    const shown = filterRepos(repos, input.value);
    const access = opts.manageAccess
      ? `<div class="gh-pad"><button class="btn ghost tiny" data-access>${icon('lock', 'sm')} ${esc(t('Не видите репозиторий? Дайте доступ'))}</button></div>`
      : '';
    if (!repos.length) {
      list.innerHTML = opts.manageAccess
        ? `<div class="empty-state">${esc(t('Codevia пока не видит ни одного репозитория. Дайте доступ к нужным репозиториям на GitHub.'))}<div class="btn-row center"><button class="btn primary" data-access>${esc(t('Выбрать репозитории'))}</button></div></div>`
        : `<div class="empty-state">${esc(t('Нет репозиториев. Создайте его на GitHub или клонируйте по ссылке.'))}</div>`;
      return;
    }
    if (!shown.length) {
      list.innerHTML = `<div class="empty-state">${esc(t('Ничего не найдено'))}</div>`;
      return;
    }
    list.innerHTML = `<div class="list" role="list">${shown
      .slice(0, MAX_ROWS)
      .map(
        (r) => `<div class="row" role="listitem"><button class="row-button" data-id="${r.id}">
          <div class="row-main">
            <span class="row-title">${esc(r.full_name)}</span>
            <span class="row-description">${r.private ? `<span class="pill">${esc(t('Приватный'))}</span> ` : ''}${r.fork ? `<span class="pill">${esc(t('Форк'))}</span> ` : ''}${esc(r.description ?? '')}</span>
          </div>
          <span class="row-meta">${esc(fmtShortDate(r.pushed_at))}</span>${icon('chevron', 'sm row-action')}
        </button></div>`,
      )
      .join('')}</div>${shown.length > MAX_ROWS ? `<p class="subtxt gh-pad">${esc(t('Показаны первые {count}. Уточните поиск.', { count: MAX_ROWS }))}</p>` : ''}${access}`;
  };

  list.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('[data-access]')) {
      opts.manageAccess?.();
      return;
    }
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-id]');
    const repo = b && repos.find((r) => String(r.id) === b.dataset.id);
    if (repo) opts.onPick(repo);
  });
  input.addEventListener('input', draw);

  const load = async (fresh = false) => {
    if (!fresh && cache && Date.now() - cache.at < 60_000) {
      repos = cache.repos;
      draw();
      return;
    }
    list.innerHTML = spinnerLine(t('Загружаем репозитории…'));
    const c = life.controller();
    try {
      const got = await api.listRepos();
      if (c.signal.aborted) return;
      repos = got;
      cache = { at: Date.now(), repos: got };
      draw();
    } catch (e) {
      if (life.dead || isAbortError(e)) return;
      renderError(list, e, { retry: () => void load(true), signIn: opts.signIn });
    } finally {
      life.release(c);
    }
  };
  void load();
}

/** Forgets the cached repository list (after creating a repository or signing out). */
export function clearRepoCache(): void {
  cache = null;
}

/** `<select>` options for branches. */
export const branchOptions = (names: readonly string[], selected: string): string =>
  names.map((n) => `<option value="${esc(n)}" ${n === selected ? 'selected' : ''}>${esc(n)}</option>`).join('');
