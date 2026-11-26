/**
 * Clone panel: pick a repository (or paste a link), a branch and an optional subfolder, download it
 * and open it as a new project.
 */
import { githubAppInstallUrl } from '../../github/auth';
import { plural, t } from '../../i18n';
import { GitHubError } from '../../github/errors';
import type { ToolContext } from '../types';
import { mountAccount } from './account';
import { cloneRepository, createClonedProject, skippedCount, type ClonedProject, type GhApi, type SkippedReport } from './flows';
import { errorText, isAbortError, stageText } from './messages';
import { parseRepoInput, resolveTreePath, type RepoRef } from './parse';
import { branchOptions, mountRepoPicker, orderBranches } from './repo-picker';
import { authedClient, currentAccount, onAccountChange, publicClient, signOutAndNotify, type AccountInfo } from './session';
import { callout, esc, icon, Life, Nav, renderError, spinnerLine, Task } from './ui';

/** Clone-by-URL field. Calls `onRef` with a parsed reference. */
export function urlForm(host: HTMLElement, onRef: (ref: RepoRef) => void): void {
  host.innerHTML = `<form class="gh-url stack" novalidate>
    <label class="field-label" for="gh-url">${esc(t('Клонировать по ссылке'))}</label>
    <div class="gh-inline">
      <input id="gh-url" class="text-input mono" inputmode="url" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"
        placeholder="github.com/owner/repo" aria-describedby="gh-url-error">
      <button class="btn primary" type="submit">${esc(t('Далее'))}</button>
    </div>
    <div id="gh-url-error" class="field-error" role="alert"></div>
  </form>`;
  const form = host.querySelector('form')!;
  const input = host.querySelector<HTMLInputElement>('#gh-url')!;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const ref = parseRepoInput(input.value);
    const err = host.querySelector<HTMLElement>('#gh-url-error')!;
    if (!ref) {
      err.textContent = t('Это не похоже на ссылку на репозиторий GitHub. Пример: github.com/owner/repo');
      input.setAttribute('aria-invalid', 'true');
      return;
    }
    err.textContent = '';
    input.removeAttribute('aria-invalid');
    onRef(ref);
  });
}

function skippedSection(title: string, paths: string[]): string {
  if (!paths.length) return '';
  const shown = paths.slice(0, 50);
  return `<details class="gh-details"><summary>${esc(title)} · ${paths.length}</summary><ul class="gh-paths mono">${shown.map((p) => `<li>${esc(p)}</li>`).join('')}${
    paths.length > shown.length ? `<li class="subtxt">${esc(t('и ещё {count}', { count: paths.length - shown.length }))}</li>` : ''
  }</ul></details>`;
}

export function skippedReportHtml(r: SkippedReport): string {
  if (!skippedCount(r)) return '';
  return `<div class="gh-skipped">
    ${callout(esc(t('Некоторые файлы репозитория не перенесены в проект. На GitHub они останутся как есть.')), 'warning')}
    ${skippedSection(t('Большие файлы (больше 15 МБ)'), r.large)}
    ${skippedSection(t('Символические ссылки'), r.symlinks)}
    ${skippedSection(t('Подмодули'), r.submodules)}
    ${skippedSection(t('Неподдерживаемые имена'), r.other)}
  </div>`;
}

export function mountCloneTool(root: HTMLElement, ctx: ToolContext): () => void {
  const life = new Life();
  const nav = new Nav(root, life);
  let account: AccountInfo | null = null;
  const api = (): GhApi => (account ? authedClient() : publicClient());

  life.onDispose(
    onAccountChange((a) => {
      account = a;
      if (nav.depth === 1) nav.refresh();
    }),
  );

  const main = {
    title: t('Клонировать с GitHub'),
    render(body: HTMLElement) {
      const sub = life.child();
      body.innerHTML = `<div class="gh-section" data-url></div><div class="gh-section gh-rest" data-rest></div>`;
      urlForm(body.querySelector('[data-url]')!, (ref) => nav.push(optionsScreen(ref)));
      const rest = body.querySelector<HTMLElement>('[data-rest]')!;
      if (account) {
        rest.innerHTML = `<h3 class="section-heading">${esc(t('Ваши репозитории'))}</h3><div data-picker></div>`;
        mountRepoPicker(rest.querySelector('[data-picker]')!, authedClient(), sub, {
          onPick: (r) => nav.push(optionsScreen({ owner: r.owner.login, repo: r.name }, r.default_branch, r.private)),
          signIn: reconnect,
          manageAccess: account?.kind === 'device' && githubAppInstallUrl() ? () => ctx.openExternal(githubAppInstallUrl()) : undefined,
        });
      } else {
        rest.innerHTML = `<p class="gh-note">${esc(t('Публичные репозитории можно клонировать по ссылке без входа. Чтобы видеть свои и приватные репозитории, подключите GitHub.'))}</p><div data-account></div>`;
        mountAccount(rest.querySelector('[data-account]')!, ctx, sub, { compact: true });
      }
      return () => sub.dispose();
    },
  };

  /** After an auth error: forget the dead session, then show the sign-in. */
  const reconnect = () => {
    void signOutAndNotify()
      .catch(() => undefined)
      .then(() => !life.dead && nav.push(accountScreen()));
  };

  const accountScreen = () => ({
    title: t('Аккаунт GitHub'),
    render(body: HTMLElement) {
      const sub = life.child();
      mountAccount(body, ctx, sub, { onSignedIn: () => nav.home() });
      return () => sub.dispose();
    },
  });

  function optionsScreen(ref: RepoRef, knownDefault?: string, knownPrivate?: boolean) {
    return {
      title: `${ref.owner}/${ref.repo}`,
      render(body: HTMLElement) {
        let branches: string[] = [];
        let defaultBranch = knownDefault ?? '';
        let isPrivate = knownPrivate ?? false;
        let branch = ref.branch ?? '';
        let subdir = ref.subdir ?? '';
        let hint = '';

        const drawForm = () => {
          body.innerHTML = `<form class="gh-section stack" novalidate data-form>
            <div class="gh-repo-head">${icon('folder', 'sm')}<span class="mono truncate">${esc(ref.owner)}/${esc(ref.repo)}</span>${isPrivate ? `<span class="pill">${esc(t('Приватный'))}</span>` : ''}</div>
            ${hint ? callout(esc(hint), 'warning') : ''}
            <div class="field"><label class="field-label" for="gh-branch">${esc(t('Ветка'))}</label>
              <select id="gh-branch" class="select">${branchOptions(branches, branch)}</select></div>
            <div class="field"><label class="field-label" for="gh-subdir">${esc(t('Подпапка (необязательно)'))}</label>
              <input id="gh-subdir" class="text-input mono" value="${esc(subdir)}" placeholder="${esc(t('например, site'))}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">
              <div class="form-help">${esc(t('Только эта папка станет проектом. Удобно для больших репозиториев.'))}</div></div>
            <button class="btn primary full" type="submit">${icon('download', 'sm')}<span>${esc(t('Клонировать'))}</span></button>
          </form>`;
          const form = body.querySelector<HTMLFormElement>('[data-form]')!;
          form.addEventListener('submit', (e) => {
            e.preventDefault();
            branch = body.querySelector<HTMLSelectElement>('#gh-branch')!.value;
            subdir = body.querySelector<HTMLInputElement>('#gh-subdir')!.value.trim().replace(/^\/+|\/+$/g, '');
            void run();
          });
          if (hint) body.querySelector<HTMLInputElement>('#gh-subdir')?.focus();
        };

        const load = async () => {
          body.innerHTML = spinnerLine(t('Загружаем ветки…'));
          const c = life.controller();
          try {
            const client = api();
            if (!defaultBranch) {
              const info = await client.getRepo(ref.owner, ref.repo);
              defaultBranch = info.default_branch;
              isPrivate = info.private;
            }
            const list = await client.listBranches(ref.owner, ref.repo);
            if (c.signal.aborted) return;
            branches = orderBranches(list, defaultBranch);
            if (ref.treePath) {
              const resolved = resolveTreePath(ref.treePath, branches);
              if (resolved) {
                branch = resolved.branch;
                subdir = resolved.subdir ?? '';
              }
            }
            if (!branches.includes(branch)) branch = branches[0] ?? defaultBranch;
            drawForm();
          } catch (e) {
            if (life.dead || isAbortError(e)) return;
            renderError(body, e, { retry: () => void load(), signIn: reconnect, extra: extraHint(e) });
          } finally {
            life.release(c);
          }
        };

        const extraHint = (e: unknown): string => {
          if (!(e instanceof GitHubError)) return '';
          if (!account && e.code === 'not_found') return esc(t('Если репозиторий приватный, подключите GitHub.'));
          if (!account && e.code === 'rate_limit') return esc(t('После входа в GitHub лимит запросов намного выше.'));
          return '';
        };

        const run = async () => {
          const task = new Task(body, life, { title: t('Клонирование') });
          let cloned: ClonedProject;
          try {
            cloned = await cloneRepository(
              api(),
              { owner: ref.owner, repo: ref.repo, branch, subdir: subdir || undefined },
              { signal: task.signal, onProgress: (s, done) => task.step(stageText(s, 'clone'), s === 'verifying' ? done : undefined) },
            );
            task.lockCancel();
            task.step(stageText('creating', 'clone'));
            await createClonedProject(ctx, cloned);
          } catch (e) {
            task.done();
            if (life.dead) return;
            if (isAbortError(e)) {
              drawForm();
              return;
            }
            ctx.haptic('error');
            if (e instanceof GitHubError && (e.key === 'repo_too_large' || e.key === 'tree_truncated')) {
              hint = `${errorText(e)} ${t('Укажите подпапку, например ту, где лежит сайт.')}`;
              drawForm();
              return;
            }
            if (e instanceof GitHubError && e.key === 'subdir_not_found') {
              hint = errorText(e);
              drawForm();
              return;
            }
            renderError(body, e, { retry: () => drawForm(), signIn: reconnect, extra: extraHint(e) });
            return;
          }
          task.done();
          ctx.haptic('success');
          const n = skippedCount(cloned.skipped);
          ctx.toast(n ? plural(n, 'Проект создан. Пропущено файлов: {count}') : t('Проект «{name}» создан', { name: cloned.name }), 'success');
          if (life.dead) return;
          body.innerHTML = `<div class="gh-section stack">
            ${callout(esc(t('Проект «{name}» создан и связан с {repo}.', { name: cloned.name, repo: `${ref.owner}/${ref.repo}` })), 'success')}
            ${skippedReportHtml(cloned.skipped)}
            <button class="btn primary full" data-done>${esc(t('Готово'))}</button>
          </div>`;
          body.querySelector('[data-done]')!.addEventListener('click', () => ctx.close());
        };

        if (branches.length) drawForm();
        else void load();
      },
    };
  }

  root.innerHTML = spinnerLine(t('Загрузка…'));
  void currentAccount().then((a) => {
    if (life.dead) return;
    account = a;
    nav.reset(main);
  });
  return () => life.dispose();
}
