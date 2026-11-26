/**
 * Source control panel of a project: link or create a repository, the changes list with diffs,
 * Commit & Push, Pull with conflict choices, branch switching and publishing to GitHub Pages.
 */
import { basename, dirname } from '../../core/paths';
import type { Files, GitHubLink, Project, ProjectFile } from '../../core/types';
import { githubAppInstallUrl } from '../../github/auth';
import { plural, t } from '../../i18n';
import { GitHubError, isGitHubError } from '../../github/errors';
import { defaultCommitMessage, fetchRemoteFile, planPush, ShaCache, type PullConflict, type PullPlan } from '../../github/sync';
import { copyText } from '../../platform/native';
import type { ToolContext } from '../types';
import { mountAccount } from './account';
import { mountDiff } from './diffview';
import {
  applyPull,
  checkBeforePush,
  createRepositoryAndPush,
  planFirstPush,
  prepareBranchSwitch,
  prepareLink,
  preparePull,
  publishPages,
  pushChanges,
  type GhApi,
} from './flows';
import { errorText, isAbortError, PagesBuildError, repoNameText, secretText, stageText, StaleProjectError } from './messages';
import { ChangesModel, commitMessage, ConflictState, lastSyncTime, markSynced, pullSummary, quickStatus, type ChangeItem } from './model';
import { branchNameProblem, commitWebUrl, repoWebUrl, suggestRepoName, validateRepoName } from './parse';
import { branchOptions, clearRepoCache, mountRepoPicker, orderBranches } from './repo-picker';
import { authedClient, currentAccount, isOnline, onAccountChange, signOutAndNotify, type AccountInfo } from './session';
import { callout, esc, fmtShortDate, icon, Life, Nav, renderError, spinnerLine, statusBadge, Task, type Screen } from './ui';

const textOf = (f: ProjectFile | undefined): string | null => (f ? (f.text ? f.content : null) : '');

function conflictKindText(c: PullConflict): string {
  switch (c.kind) {
    case 'both_modified':
      return t('Изменён и здесь, и на GitHub');
    case 'both_added':
      return t('Добавлен и здесь, и на GitHub');
    case 'modified_locally_deleted_remotely':
      return t('Изменён здесь, удалён на GitHub');
    case 'deleted_locally_modified_remotely':
      return t('Удалён здесь, изменён на GitHub');
  }
}

/** Opens a URL from Pages / the commit toast etc. with the system share sheet, falling back to copying. */
async function shareUrl(url: string, ctx: ToolContext): Promise<void> {
  const nav = globalThis.navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
  if (nav?.share) {
    try {
      await nav.share({ url });
      return;
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return;
    }
  }
  if (await copyText(url)) ctx.toast(t('Ссылка скопирована'), 'success');
}

type PullMode = 'pull' | 'link' | 'branch';

export function mountSyncTool(root: HTMLElement, ctx: ToolContext): () => void {
  const life = new Life();
  const nav = new Nav(root, life);
  const shaCache = new ShaCache();
  const baseFiles = new Map<string, ProjectFile>();
  let account: AccountInfo | null = null;
  let online = isOnline();
  let model: ChangesModel | null = null;
  let subject = '';
  let subjectEdited = false;
  let description = '';
  let remote: { base: string; behind: number; at: number } | null = null;
  let lastPush: { sha: string; owner: string; repo: string } | null = null;
  let busy = false;

  const api = (): GhApi => authedClient();
  const project = (): Project | null => ctx.project();
  const link = (): GitHubLink | undefined => project()?.github;
  const canNetwork = (): boolean => online && !!account;

  life.onDispose(
    onAccountChange((a) => {
      account = a;
      if (nav.depth === 1) nav.refresh();
    }),
  );
  const onNet = () => {
    online = isOnline();
    if (nav.depth === 1) nav.refresh();
  };
  life.listen(window, 'online', onNet);
  life.listen(window, 'offline', onNet);

  // Re-read the changes when the project is edited while the panel is open (iPad side pane).
  let seen: { files: Files | null; updatedAt: string; base: string } = { files: null, updatedAt: '', base: '' };
  let refreshChanges: (() => void) | null = null;
  life.interval(() => {
    const p = project();
    if (!p || busy) return;
    const base = p.github?.baseCommit ?? '';
    if (p.files !== seen.files || p.updatedAt !== seen.updatedAt || base !== seen.base) refreshChanges?.();
  }, 1500);

  /** After an auth error: forget the dead session, then show the sign-in. */
  const reconnect = () => {
    void signOutAndNotify()
      .catch(() => undefined)
      .then(() => !life.dead && nav.push(accountScreen()));
  };

  const accountScreen = (): Screen => ({
    title: t('Аккаунт GitHub'),
    render(body) {
      const sub = life.child();
      mountAccount(body, ctx, sub, { onSignedIn: () => nav.home() });
      return () => sub.dispose();
    },
  });

  /** A screen that runs one action with a progress card; leaving it cancels the action while allowed. */
  function opScreen(title: string, run: (task: Task, body: HTMLElement) => Promise<void>): Screen {
    return {
      title,
      render(body) {
        busy = true;
        const task = new Task(body, life, { title });
        let finished = false;
        void run(task, body).finally(() => {
          finished = true;
          busy = false;
          task.done();
        });
        return () => {
          if (!finished && body.querySelector('[data-cancel]')) task.controller.abort();
        };
      },
    };
  }

  // ------------------------------------------------------------------ main

  const main: Screen = {
    title: t('GitHub'),
    render(body) {
      const p = project();
      if (!p) {
        body.innerHTML = `<div class="empty-state">${esc(t('Откройте проект, чтобы работать с GitHub.'))}</div>`;
        return;
      }
      return p.github ? renderLinked(body, p, p.github) : renderUnlinked(body, p);
    },
  };

  function networkBanner(): string {
    if (!online) return callout(esc(t('Нет подключения к интернету. Изменения видны, а отправить и получить их можно, когда сеть появится.')), 'warning');
    if (!account)
      return callout(
        esc(t('GitHub не подключён. Локальные изменения видны, но чтобы отправлять и получать их, подключите аккаунт.')),
        'warning',
        `<div class="btn-row gh-callout-actions"><button class="btn primary tiny" data-signin>${esc(t('Подключить GitHub'))}</button></div>`,
      );
    return '';
  }

  function renderUnlinked(body: HTMLElement, p: Project): void | (() => void) {
    body.innerHTML = `<div class="gh-section stack">
      <div class="gh-hero">${icon('branch', 'xl')}<h3 class="gh-h3">${esc(t('Проект не связан с GitHub'))}</h3>
      <p class="subtxt">${esc(t('Создайте новый репозиторий из «{name}» или свяжите проект с уже существующим.', { name: p.name }))}</p></div>
      ${networkBanner()}
      <button class="btn primary full" data-create ${canNetwork() ? '' : 'disabled'}>${icon('plus', 'sm')}<span>${esc(t('Создать репозиторий'))}</span></button>
      <button class="btn secondary full" data-link ${canNetwork() ? '' : 'disabled'}>${esc(t('Связать с существующим репозиторием'))}</button>
    </div>`;
    body.querySelector('[data-signin]')?.addEventListener('click', () => nav.push(accountScreen()));
    body.querySelector('[data-create]')!.addEventListener('click', () => nav.push(createRepoScreen()));
    body.querySelector('[data-link]')!.addEventListener('click', () => nav.push(linkPickScreen()));
  }

  function renderLinked(body: HTMLElement, p: Project, l: GitHubLink): () => void {
    const synced = lastSyncTime(p.id);
    const isWeb = p.language === 'web';
    body.innerHTML = `<div class="gh-section">
      <div class="gh-card gh-header">
        <div class="gh-head-row">${icon('branch')}
          <div class="grow"><div class="gh-repo mono truncate">${esc(l.owner)}/${esc(l.repo)}</div>
            <div class="subtxt truncate">${esc(l.branch)}${l.subdir ? ` · ${esc(l.subdir)}/` : ''}</div></div>
          <button class="icon-btn" data-web aria-label="${esc(t('Открыть на github.com'))}">${icon('external')}</button>
        </div>
        <div class="gh-counts" data-counts></div>
        <div class="btn-row">
          <button class="btn secondary tiny" data-pull ${canNetwork() ? '' : 'disabled'}>${icon('download', 'sm')}<span>${esc(t('Получить'))}</span></button>
          ${isWeb ? `<button class="btn secondary tiny" data-pages ${canNetwork() ? '' : 'disabled'}>${icon('share', 'sm')}<span>${esc(t('Опубликовать сайт'))}</span></button>` : ''}
        </div>
        ${l.pagesUrl ? `<div class="gh-site subtxt">${esc(t('Сайт:'))} <button class="link-btn" data-site>${esc(l.pagesUrl)}</button></div>` : ''}
      </div>
      ${networkBanner()}
      <div data-lastpush></div>
      <div class="section-heading"><span data-changes-title>${esc(t('Изменения'))}</span><button class="btn ghost tiny" data-all hidden></button></div>
      <div data-changes>${spinnerLine(t('Сравниваем файлы…'))}</div>
      <div data-commit></div>
      <h3 class="section-heading">${esc(t('Репозиторий'))}</h3>
      <div class="list">
        <div class="row"><button class="row-button" data-branch ${canNetwork() ? '' : 'disabled'}>${icon('branch', 'sm')}<span class="row-main"><span class="row-title">${esc(t('Сменить ветку'))}</span></span>${icon('chevron', 'sm row-action')}</button></div>
        <div class="row"><button class="row-button" data-newbranch ${canNetwork() ? '' : 'disabled'}>${icon('plus', 'sm')}<span class="row-main"><span class="row-title">${esc(t('Новая ветка'))}</span><span class="row-description">${esc(t('От текущей версии, изменения останутся с вами'))}</span></span></button></div>
        <div class="row"><button class="row-button" data-pr ${canNetwork() ? '' : 'disabled'}>${icon('share', 'sm')}<span class="row-main"><span class="row-title">${esc(t('Pull Request'))}</span><span class="row-description">${esc(t('Предложить изменения ветки {branch} в основную', { branch: l.branch }))}</span></span>${icon('chevron', 'sm row-action')}</button></div>
        <div class="row"><button class="row-button" data-web2>${icon('external', 'sm')}<span class="row-main"><span class="row-title">${esc(t('Открыть на github.com'))}</span></span></button></div>
        <div class="row"><button class="row-button c-danger" data-unlink>${icon('close', 'sm')}<span class="row-main"><span class="row-title">${esc(t('Отвязать репозиторий'))}</span></span></button></div>
      </div>
    </div>`;

    const countsEl = body.querySelector<HTMLElement>('[data-counts]')!;
    const drawCounts = () => {
      const ahead = model?.total ?? 0;
      const behind = remote && remote.base === l.baseCommit ? String(remote.behind) : '?';
      countsEl.innerHTML = `<span class="gh-count" aria-label="${esc(t('Не отправлено: {count}', { count: ahead }))}">↑ ${ahead}</span>
        <span class="gh-count" aria-label="${esc(t('Новое на GitHub: {count}', { count: behind }))}">↓ ${behind}</span>
        <span class="subtxt">${synced ? esc(t('Синхронизировано {time}', { time: fmtShortDate(synced) })) : esc(t('Ещё не синхронизировано на этом устройстве'))}</span>`;
    };
    drawCounts();

    const web = () => ctx.openExternal(repoWebUrl(l));
    body.querySelector('[data-web]')!.addEventListener('click', web);
    body.querySelector('[data-web2]')!.addEventListener('click', web);
    body.querySelector('[data-site]')?.addEventListener('click', () => ctx.openExternal(l.pagesUrl!));
    body.querySelector('[data-signin]')?.addEventListener('click', () => nav.push(accountScreen()));
    body.querySelector('[data-pull]')!.addEventListener('click', () => nav.push(pullScreen('pull')));
    body.querySelector('[data-pages]')?.addEventListener('click', () => nav.push(pagesScreen()));
    body.querySelector('[data-branch]')!.addEventListener('click', () => nav.push(branchScreen()));
    body.querySelector('[data-newbranch]')!.addEventListener('click', () => void newBranch());
    body.querySelector('[data-pr]')!.addEventListener('click', () => nav.push(pullRequestScreen()));
    body.querySelector('[data-unlink]')!.addEventListener('click', () => void unlink());

    if (lastPush && lastPush.owner === l.owner && lastPush.repo === l.repo) {
      const host = body.querySelector<HTMLElement>('[data-lastpush]')!;
      const lp = lastPush;
      host.innerHTML = callout(
        esc(t('Отправлено на GitHub · {sha}', { sha: lp.sha.slice(0, 7) })),
        'success',
        `<div class="btn-row gh-callout-actions"><button class="btn secondary tiny" data-commit-open>${esc(t('Открыть коммит'))}</button></div>`,
      );
      host.querySelector('[data-commit-open]')!.addEventListener('click', () => ctx.openExternal(commitWebUrl(lp, lp.sha)));
    }

    const changesEl = body.querySelector<HTMLElement>('[data-changes]')!;
    const commitEl = body.querySelector<HTMLElement>('[data-commit]')!;
    const titleEl = body.querySelector<HTMLElement>('[data-changes-title]')!;
    const allBtn = body.querySelector<HTMLButtonElement>('[data-all]')!;
    let generation = 0;
    let signature = '';

    const compute = async () => {
      const cur = project();
      if (!cur?.github) return;
      const g = ++generation;
      seen = { files: cur.files, updatedAt: cur.updatedAt, base: cur.github.baseCommit };
      try {
        const plan = await planPush(cur.files, cur.github, { cache: shaCache });
        if (g !== generation || life.dead) return;
        const sig = `${plan.changes.map((c) => `${c.status}:${c.path}:${c.sha ?? ''}`).join('|')}#${plan.ignored.join('|')}`;
        if (model && sig === signature) return;
        signature = sig;
        model = new ChangesModel(plan, model);
        if (!subjectEdited) subject = defaultCommitMessage(model.selectedChanges());
        void quickStatus(cur);
        drawChanges();
        drawCommit();
        drawCounts();
      } catch (e) {
        if (g === generation && !life.dead) renderError(changesEl, e, { retry: () => void compute() });
      }
    };
    refreshChanges = () => void compute();

    const row = (i: ChangeItem) => `<div class="row gh-change">
        <label class="gh-check"><input type="checkbox" data-sel="${esc(i.path)}" ${i.selected ? 'checked' : ''} aria-label="${esc(t('Включить {name} в коммит', { name: i.path }))}"></label>
        <button class="row-button" data-open="${esc(i.path)}">${statusBadge(i.status)}
          <span class="row-main"><span class="row-title">${esc(basename(i.path))}</span>
          <span class="row-description">${i.secret ? `<span class="c-warning">${icon('shield', 'xs')} ${esc(secretText(i.secret))}</span>` : esc(dirname(i.path) || ' ')}</span></span>
          ${icon('chevron', 'sm row-action')}
        </button></div>`;

    const drawChanges = () => {
      if (!model) return;
      titleEl.textContent = model.total ? `${t('Изменения')} · ${model.total}` : t('Изменения');
      allBtn.hidden = model.total < 2;
      allBtn.textContent = model.allSelected ? t('Снять все') : t('Выбрать все');
      if (!model.total) {
        changesEl.innerHTML = `<div class="empty-state">${icon('check', 'xl')}<span>${esc(t('Нет локальных изменений'))}</span></div>${
          model.ignored.length ? ignoredNote(model.ignored) : ''
        }`;
        return;
      }
      const g = model.groups();
      const group = (title: string, items: ChangeItem[]) =>
        items.length ? `<div class="gh-group">${esc(title)}</div><div class="list">${items.map(row).join('')}</div>` : '';
      changesEl.innerHTML = `${group(t('Изменённые'), g.modified)}${group(t('Новые'), g.added)}${group(t('Удалённые'), g.deleted)}${
        model.ignored.length ? ignoredNote(model.ignored) : ''
      }`;
    };

    const drawCommit = () => {
      if (!model || !model.total) {
        commitEl.innerHTML = '';
        return;
      }
      const secrets = model.selectedSecrets();
      const block = model.block();
      const reason = !online
        ? t('Нет подключения к интернету.')
        : !account
          ? t('Подключите GitHub, чтобы отправлять изменения.')
          : block === 'nothing_selected'
            ? t('Отметьте файлы для коммита.')
            : block === 'secrets_unconfirmed'
              ? t('Подтвердите отправку файлов с секретами или снимите с них отметку.')
              : '';
      const focused = document.activeElement as HTMLInputElement | null;
      const keepFocus = focused && commitEl.contains(focused) ? focused.dataset.field : null;
      const caret = keepFocus ? [focused!.selectionStart, focused!.selectionEnd] : null;
      commitEl.innerHTML = `<div class="gh-card gh-commit stack">
        <div class="field"><label class="field-label" for="gh-msg">${esc(t('Сообщение коммита'))}</label>
          <input id="gh-msg" class="text-input" data-field="subject" maxlength="200" value="${esc(subject)}" autocomplete="off"></div>
        <div class="field"><label class="field-label" for="gh-desc">${esc(t('Описание (необязательно)'))}</label>
          <textarea id="gh-desc" class="text-input textarea" data-field="desc" rows="2" maxlength="4000">${esc(description)}</textarea></div>
        ${
          secrets.length
            ? `<div class="gh-callout danger">${icon('shield', 'sm')}<div class="grow">
            <div>${esc(t('Эти файлы похожи на секреты. Любой с доступом к репозиторию сможет их прочитать:'))}</div>
            <ul class="gh-paths mono">${secrets.map((s) => `<li>${esc(s.path)} — ${esc(secretText(s.secret!))}</li>`).join('')}</ul>
            <label class="gh-confirm"><input type="checkbox" data-confirm ${model.secretsConfirmed ? 'checked' : ''}> <span>${esc(t('Я понимаю и всё равно хочу отправить эти файлы'))}</span></label>
          </div></div>`
            : ''
        }
        <button class="btn primary full" data-push ${reason ? 'disabled' : ''}>${icon('upload', 'sm')}<span>${esc(t('Закоммитить и отправить'))} · ${model.selectedCount}</span></button>
        ${reason ? `<p class="subtxt" role="note">${esc(reason)}</p>` : ''}
      </div>`;
      if (keepFocus) {
        const el = commitEl.querySelector<HTMLInputElement>(`[data-field="${keepFocus}"]`);
        el?.focus();
        if (el && caret && caret[0] !== null) el.setSelectionRange(caret[0], caret[1]);
      }
    };

    changesEl.addEventListener('change', (e) => {
      const input = e.target as HTMLInputElement;
      const path = input.dataset.sel;
      if (!model || path === undefined) return;
      model.toggle(path, input.checked);
      if (!subjectEdited) subject = defaultCommitMessage(model.selectedChanges());
      drawChanges();
      drawCommit();
    });
    changesEl.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-open]');
      const item = b && model?.item(b.dataset.open!);
      if (item) nav.push(diffScreen(item));
    });
    allBtn.addEventListener('click', () => {
      if (!model) return;
      model.selectAll(!model.allSelected);
      if (!subjectEdited) subject = defaultCommitMessage(model.selectedChanges());
      drawChanges();
      drawCommit();
    });
    commitEl.addEventListener('input', (e) => {
      const el = e.target as HTMLInputElement;
      if (el.dataset.field === 'subject') {
        subject = el.value;
        subjectEdited = el.value.trim() !== '';
      } else if (el.dataset.field === 'desc') description = el.value;
    });
    commitEl.addEventListener('change', (e) => {
      const el = e.target as HTMLInputElement;
      if (el.matches('[data-confirm]') && model) {
        model.confirmSecrets(el.checked);
        drawCommit();
      }
    });
    commitEl.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-push]')) nav.push(pushScreen());
    });

    void compute();
    void checkRemote(l, drawCounts);
    return () => {
      refreshChanges = null;
      generation++;
    };
  }

  const ignoredNote = (paths: string[]) =>
    `<details class="gh-details"><summary>${esc(t('Не отправляются из-за .gitignore'))} · ${paths.length}</summary><ul class="gh-paths mono">${paths
      .slice(0, 50)
      .map((p) => `<li>${esc(p)}</li>`)
      .join('')}</ul></details>`;

  /** Counts what is new on GitHub (background, quietly ignores failures). */
  async function checkRemote(l: GitHubLink, redraw: () => void): Promise<void> {
    if (!canNetwork()) return;
    if (remote && remote.base === l.baseCommit && Date.now() - remote.at < 60_000) return;
    const c = life.controller();
    try {
      const p = project();
      if (!p) return;
      const plan = await preparePull(api(), p.files, l, { signal: c.signal });
      remote = { base: l.baseCommit, behind: plan.apply.length + plan.deleteLocal.length + plan.conflicts.length, at: Date.now() };
      if (!life.dead && nav.depth === 1) redraw();
    } catch {
      /* the count stays unknown */
    } finally {
      life.release(c);
    }
  }

  async function unlink(): Promise<void> {
    const l = link();
    if (!l) return;
    const ok = await ctx.confirm({
      title: t('Отвязать репозиторий?'),
      message: t('Проект и его файлы останутся на устройстве, а репозиторий {repo} — на GitHub. Связь между ними будет удалена.', { repo: `${l.owner}/${l.repo}` }),
      ok: t('Отвязать'),
      destructive: true,
    });
    if (!ok) return;
    try {
      await ctx.updateMeta({ github: undefined });
      model = null;
      remote = null;
      lastPush = null;
      ctx.toast(t('Репозиторий отвязан'), 'success');
      nav.reset(main);
    } catch (e) {
      ctx.toast(errorText(e), 'error');
    }
  }

  // ------------------------------------------------------------------ diff of one change

  async function baseFile(l: GitHubLink, path: string, signal: AbortSignal): Promise<ProjectFile> {
    const sha = l.baseTree[path]!;
    const cached = baseFiles.get(sha);
    if (cached) return cached;
    const g = api();
    const file = await Promise.race([
      fetchRemoteFile(g, l, path, sha),
      new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })),
    ]);
    baseFiles.set(sha, file);
    return file;
  }

  function diffScreen(item: ChangeItem): Screen {
    return {
      title: item.path,
      render(body) {
        const c = life.controller();
        const l = link();
        const p = project();
        if (!l || !p) return;
        const local = p.files[item.path];
        body.innerHTML = `<div class="gh-section stack">
          <div class="gh-diff-head">${statusBadge(item.status)}<span class="mono truncate grow">${esc(item.path)}</span><span class="subtxt" data-stats></span></div>
          ${item.secret ? callout(esc(secretText(item.secret)), 'warning') : ''}
          <div data-diff>${spinnerLine(t('Загружаем версию с GitHub…'))}</div>
          <div class="btn-row">
            ${item.status !== 'deleted' ? `<button class="btn secondary tiny" data-edit>${icon('code', 'sm')}<span>${esc(t('Открыть в редакторе'))}</span></button>` : ''}
            <button class="btn danger tiny" data-discard>${icon('refresh', 'sm')}<span>${esc(t('Отменить изменения'))}</span></button>
          </div>
        </div>`;
        const diffEl = body.querySelector<HTMLElement>('[data-diff]')!;
        body.querySelector('[data-edit]')?.addEventListener('click', () => ctx.openFile(item.path));
        body.querySelector('[data-discard]')!.addEventListener('click', () => void discard(item, c.signal));

        const show = (base: ProjectFile | undefined) => {
          const oldText = item.status === 'added' ? '' : textOf(base);
          const newText = item.status === 'deleted' ? '' : textOf(local);
          if (oldText === null || newText === null) {
            diffEl.innerHTML = `<div class="empty-state">${esc(t('Двоичный файл — построчное сравнение недоступно.'))}</div>`;
            return;
          }
          const stats = mountDiff(diffEl, oldText, newText, { oldLabel: t('На GitHub'), newLabel: t('Здесь') });
          body.querySelector('[data-stats]')!.textContent = `+${stats.added} −${stats.removed}`;
        };
        if (item.status === 'added') show(undefined);
        else if (!canNetwork()) {
          diffEl.innerHTML = callout(esc(t('Чтобы увидеть, что изменилось, нужна сеть и подключённый GitHub.')), 'warning');
        } else {
          baseFile(l, item.path, c.signal).then(
            (f) => !life.dead && show(f),
            (e) => !life.dead && !isAbortError(e) && renderError(diffEl, e, { retry: () => nav.refresh(), signIn: reconnect }),
          );
        }
        return () => {
          c.abort();
          life.release(c);
        };
      },
    };
  }

  async function discard(item: ChangeItem, signal: AbortSignal): Promise<void> {
    const l = link();
    if (!l) return;
    const ok = await ctx.confirm({
      title: t('Отменить изменения?'),
      message:
        item.status === 'added'
          ? t('Новый файл {name} будет удалён. Его можно вернуть из «Истории версий».', { name: item.path })
          : t('Файл {name} вернётся к версии с GitHub. Текущую версию можно вернуть из «Истории версий».', { name: item.path }),
      ok: t('Отменить изменения'),
      destructive: true,
    });
    if (!ok) return;
    const label = t('Перед отменой изменений в {name}', { name: basename(item.path) });
    try {
      if (item.status === 'added') {
        await ctx.writeFiles({}, { remove: [item.path], snapshotLabel: label });
      } else {
        if (!canNetwork()) throw new GitHubError('network');
        const base = await baseFile(l, item.path, signal);
        await ctx.writeFiles({ [item.path]: base }, { snapshotLabel: label });
      }
      ctx.haptic('success');
      ctx.toast(t('Изменения в {name} отменены', { name: basename(item.path) }), 'success');
      if (!life.dead) nav.home();
    } catch (e) {
      if (!isAbortError(e)) ctx.toast(errorText(e), 'error');
    }
  }

  // ------------------------------------------------------------------ push

  function pushScreen(): Screen {
    return opScreen(t('Отправка на GitHub'), async (task, body) => {
      const p = project();
      let l = p?.github;
      if (!p || !l || !model) {
        body.innerHTML = `<div class="empty-state">${esc(t('Нет изменений для отправки.'))}</div>`;
        return;
      }
      const message = commitMessage(subject.trim() || defaultCommitMessage(model.selectedChanges()), description);
      try {
        task.step(stageText('reading'));
        const check = await checkBeforePush(api(), p.files, l, { signal: task.signal });
        if (check.kind === 'behind') {
          task.done();
          const s = pullSummary(check.plan);
          body.innerHTML = `<div class="gh-section stack">
            ${callout(esc(t('На GitHub есть новые изменения. Сначала получите их, затем отправляйте.')), 'warning')}
            ${summaryList(s)}
            <button class="btn primary full" data-pullpush>${esc(t('Получить и отправить'))}</button>
            <button class="btn secondary full" data-back>${esc(t('Отмена'))}</button>
          </div>`;
          body.querySelector('[data-pullpush]')!.addEventListener('click', () => nav.replace(pullScreen('pull', check.plan, true)));
          body.querySelector('[data-back]')!.addEventListener('click', () => nav.pop());
          return;
        }
        if (check.kind === 'fast_forward') {
          await applyPull(api(), ctx, check.plan, {}, { signal: task.signal, label: t('Перед обновлением с GitHub') });
          l = link()!;
        }
        // Rebuild the selection against the files as they are now.
        const fresh = new ChangesModel(await planPush(project()!.files, l, { cache: shaCache }), model);
        if (fresh.block()) {
          model = fresh;
          throw new GitHubError('validation', { key: 'nothing_to_push' });
        }
        const next = await pushChanges(api(), ctx, l, fresh.selectedChanges(), message, {
          signal: task.signal,
          onProgress: (s, done, total) => {
            task.step(stageText(s), done, total);
            if (s === 'updating') task.lockCancel();
          },
        });
        markSynced(p.id);
        lastPush = { sha: next.baseCommit, owner: next.owner, repo: next.repo };
        subject = '';
        subjectEdited = false;
        description = '';
        remote = remote && { ...remote, base: next.baseCommit };
        ctx.haptic('success');
        ctx.toast(t('Отправлено на GitHub · {sha}', { sha: next.baseCommit.slice(0, 7) }), 'success');
        if (!life.dead) nav.home();
      } catch (e) {
        if (life.dead) return;
        if (isAbortError(e)) {
          nav.pop();
          return;
        }
        ctx.haptic('error');
        if (e instanceof GitHubError && e.code === 'conflict') {
          body.innerHTML = `<div class="gh-section stack">
            ${callout(esc(errorText(e)), 'warning')}
            <button class="btn primary full" data-pullpush>${esc(t('Получить и отправить'))}</button>
            <button class="btn secondary full" data-back>${esc(t('Отмена'))}</button>
          </div>`;
          body.querySelector('[data-pullpush]')!.addEventListener('click', () => nav.replace(pullScreen('pull', undefined, true)));
          body.querySelector('[data-back]')!.addEventListener('click', () => nav.pop());
          return;
        }
        renderError(body, e, { retry: () => nav.replace(pushScreen()), signIn: reconnect });
      }
    });
  }

  function summaryList(s: ReturnType<typeof pullSummary>): string {
    const item = (n: number, text: string, cls = '') => (n ? `<li class="${cls}">${esc(text)}</li>` : '');
    return `<ul class="gh-summary">
      ${item(s.updated, plural(s.updated, 'Обновится файлов: {count}'))}
      ${item(s.deleted, plural(s.deleted, 'Удалится файлов: {count}'))}
      ${item(s.conflicts, plural(s.conflicts, 'Конфликтов: {count}'), 'c-warning')}
      ${item(s.keptLocal, plural(s.keptLocal, 'Ваших изменений останется: {count}'))}
    </ul>`;
  }

  // ------------------------------------------------------------------ pull / link / branch switch

  function pullLabel(mode: PullMode): string {
    return mode === 'link' ? t('Перед связыванием с GitHub') : mode === 'branch' ? t('Перед сменой ветки') : t('Перед обновлением с GitHub');
  }

  /**
   * Pull-like screen: compute the plan (unless given), show the summary and the conflicts, then apply.
   * `thenPush` continues with Commit & Push afterwards; `prepare` computes the plan for link / branch modes.
   */
  function pullScreen(mode: PullMode, given?: PullPlan, thenPush = false, prepare?: (signal: AbortSignal) => Promise<PullPlan>): Screen {
    const title = mode === 'link' ? t('Связать репозиторий') : mode === 'branch' ? t('Сменить ветку') : t('Получить изменения');
    // Kept across re-renders (e.g. coming back from a comparison) so choices survive.
    let plan = given;
    let state: ConflictState | null = null;
    return {
      title,
      render(body) {
        const sub = life.child();

        const load = async () => {
          const task = new Task(body, sub, { title });
          busy = true;
          try {
            task.step(stageText('reading'));
            const p = project();
            if (!p?.github && mode !== 'link') return;
            plan = prepare ? await prepare(task.signal) : await preparePull(api(), p!.files, p!.github!, { signal: task.signal });
            showPlan();
          } catch (e) {
            if (sub.dead || isAbortError(e)) return;
            renderError(body, e, { retry: () => void load(), signIn: reconnect });
          } finally {
            busy = false;
            task.done();
          }
        };

        const showPlan = () => {
          if (!plan) return;
          const pl = plan;
          const s = pullSummary(pl);
          if (!state || state.conflicts !== pl.conflicts) state = new ConflictState(pl.conflicts);
          const st0 = state;
          const nothing = !s.updated && !s.deleted && !s.conflicts;
          const actionText =
            mode === 'link' ? t('Связать') : mode === 'branch' ? t('Переключиться на {branch}', { branch: pl.link.branch }) : t('Получить');
          const draw = () => {
            const counts = st0.counts();
            body.innerHTML = `<div class="gh-section stack">
              ${
                nothing && mode === 'pull' && pl.upToDate
                  ? callout(esc(t('Всё актуально: на GitHub нет новых изменений.')), 'success')
                  : nothing
                    ? callout(esc(t('Файлы проекта не изменятся.')), 'info')
                    : summaryList(s)
              }
              ${
                pl.conflicts.length
                  ? `<h3 class="section-heading">${esc(t('Конфликты'))}</h3>
                <p class="subtxt">${esc(t('Эти файлы изменены и здесь, и на GitHub. Выберите, какую версию оставить. По умолчанию остаётся ваша.'))}</p>
                <div class="btn-row"><button class="btn ghost tiny" data-allmine>${esc(t('Везде мой'))}</button><button class="btn ghost tiny" data-alltheirs>${esc(t('Везде с GitHub'))}</button></div>
                <div class="list">${pl.conflicts
                  .map(
                    (c) => `<div class="gh-conflict">
                    <div class="gh-conflict-head"><span class="mono truncate grow">${esc(c.path)}</span><button class="btn ghost tiny" data-view="${esc(c.path)}">${esc(t('Сравнить'))}</button></div>
                    <div class="subtxt">${esc(conflictKindText(c))}</div>
                    <div class="segmented" role="radiogroup" aria-label="${esc(t('Версия для {name}', { name: c.path }))}">
                      <button role="radio" aria-checked="${st0.get(c.path) === 'local'}" class="${st0.get(c.path) === 'local' ? 'active' : ''}" data-choose="local" data-path="${esc(c.path)}">${esc(t('Оставить мой'))}</button>
                      <button role="radio" aria-checked="${st0.get(c.path) === 'remote'}" class="${st0.get(c.path) === 'remote' ? 'active' : ''}" data-choose="remote" data-path="${esc(c.path)}">${esc(c.remoteSha ? t('Взять с GitHub') : t('Удалить, как на GitHub'))}</button>
                    </div></div>`,
                  )
                  .join('')}</div>
                <p class="subtxt">${esc(t('Ваших версий: {mine}, с GitHub: {theirs}', { mine: counts.local, theirs: counts.remote }))}</p>`
                  : ''
              }
              ${mode === 'pull' && pl.upToDate && !thenPush ? '' : `<button class="btn primary full" data-apply>${esc(thenPush ? t('Получить и отправить') : actionText)}</button>`}
              <p class="gh-note">${esc(t('Перед изменением файлов создаётся версия в «Истории» — всё можно вернуть.'))}</p>
            </div>`;
          };
          draw();
          body.onclick = (e) => {
            const el = e.target as HTMLElement;
            const choose = el.closest<HTMLElement>('[data-choose]');
            if (choose) {
              st0.set(choose.dataset.path!, choose.dataset.choose === 'remote' ? 'remote' : 'local');
              draw();
            } else if (el.closest('[data-allmine]')) {
              st0.setAll('local');
              draw();
            } else if (el.closest('[data-alltheirs]')) {
              st0.setAll('remote');
              draw();
            } else if (el.closest<HTMLElement>('[data-view]')) {
              const path = el.closest<HTMLElement>('[data-view]')!.dataset.view!;
              const c = pl.conflicts.find((x) => x.path === path);
              if (c) nav.push(conflictScreen(pl, c, st0));
            } else if (el.closest('[data-apply]')) {
              body.onclick = null;
              void apply(pl, st0);
            }
          };
        };

        const apply = async (pl: PullPlan, state: ConflictState) => {
          const task = new Task(body, sub, { title });
          busy = true;
          try {
            const result = await applyPull(api(), ctx, pl, state.resolutions(), {
              signal: task.signal,
              label: pullLabel(mode),
              onProgress: (st, done, total) => {
                task.step(stageText(st, 'pull'), done, total);
                if (st === 'saving') task.lockCancel();
              },
            });
            const p = project();
            if (p) markSynced(p.id);
            remote = { base: result.link.baseCommit, behind: 0, at: Date.now() };
            ctx.haptic('success');
            const changed = result.written.length + result.deleted.length;
            ctx.toast(
              mode === 'link'
                ? t('Проект связан с {repo}', { repo: `${result.link.owner}/${result.link.repo}` })
                : mode === 'branch'
                  ? t('Ветка: {branch}', { branch: result.link.branch })
                  : changed
                    ? plural(changed, 'Получено изменений: {count}')
                    : t('Всё актуально'),
              'success',
            );
            if (sub.dead) return;
            nav.reset(main);
            if (thenPush) nav.push(pushScreen());
          } catch (e) {
            if (sub.dead) return;
            if (isAbortError(e)) {
              showPlan();
              return;
            }
            ctx.haptic('error');
            if (e instanceof StaleProjectError) {
              plan = undefined;
              renderError(body, e, { retry: () => void load() });
              return;
            }
            renderError(body, e, { retry: () => showPlan(), signIn: reconnect });
          } finally {
            busy = false;
            task.done();
          }
        };

        if (plan) showPlan();
        else void load();
        return () => {
          sub.dispose();
          body.onclick = null;
        };
      },
    };
  }

  function conflictScreen(plan: PullPlan, c: PullConflict, state: ConflictState): Screen {
    return {
      title: c.path,
      render(body) {
        const ctl = life.controller();
        body.innerHTML = `<div class="gh-section stack">
          <div class="subtxt">${esc(conflictKindText(c))}</div>
          <div data-diff>${spinnerLine(t('Загружаем версию с GitHub…'))}</div>
          <div class="segmented" role="radiogroup" aria-label="${esc(t('Версия для {name}', { name: c.path }))}">
            <button role="radio" data-choose="local">${esc(t('Оставить мой'))}</button>
            <button role="radio" data-choose="remote">${esc(c.remoteSha ? t('Взять с GitHub') : t('Удалить, как на GitHub'))}</button>
          </div>
        </div>`;
        const mark = () => {
          for (const b of body.querySelectorAll<HTMLElement>('[data-choose]')) {
            const on = b.dataset.choose === state.get(c.path);
            b.classList.toggle('active', on);
            b.setAttribute('aria-checked', String(on));
          }
        };
        mark();
        body.querySelectorAll<HTMLElement>('[data-choose]').forEach((b) =>
          b.addEventListener('click', () => {
            state.set(c.path, b.dataset.choose === 'remote' ? 'remote' : 'local');
            mark();
            nav.pop();
          }),
        );
        const diffEl = body.querySelector<HTMLElement>('[data-diff]')!;
        const localText = textOf(plan.files[c.path]);
        const remoteLoad = c.remoteSha ? fetchRemoteFile(api(), plan.link, c.path, c.remoteSha) : Promise.resolve(undefined);
        remoteLoad.then(
          (rf) => {
            if (ctl.signal.aborted || life.dead) return;
            const remoteText = rf === undefined ? '' : textOf(rf);
            if (remoteText === null || localText === null) {
              diffEl.innerHTML = `<div class="empty-state">${esc(t('Двоичный файл — построчное сравнение недоступно.'))}</div>`;
              return;
            }
            mountDiff(diffEl, remoteText, localText, { oldLabel: t('На GitHub'), newLabel: t('Мой') });
          },
          (e) => !ctl.signal.aborted && !life.dead && renderError(diffEl, e, { retry: () => nav.refresh() }),
        );
        return () => {
          ctl.abort();
          life.release(ctl);
        };
      },
    };
  }

  // ------------------------------------------------------------------ create / link repository

  function createRepoScreen(): Screen {
    return {
      title: t('Новый репозиторий'),
      render(body) {
        const p = project();
        if (!p) return;
        let first: ChangesModel | null = null;
        let name = suggestRepoName(p.name);
        let desc = '';
        let isPrivate = true;
        body.innerHTML = spinnerLine(t('Готовим список файлов…'));

        const draw = () => {
          if (!first) return;
          const secrets = first.secrets();
          body.innerHTML = `<form class="gh-section stack" novalidate data-form>
            <div class="field"><label class="field-label" for="gh-name">${esc(t('Имя репозитория'))}</label>
              <input id="gh-name" class="text-input mono" value="${esc(name)}" maxlength="100" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" aria-describedby="gh-name-error">
              <div id="gh-name-error" class="field-error" role="alert"></div></div>
            <div class="field"><label class="field-label" for="gh-rdesc">${esc(t('Описание (необязательно)'))}</label>
              <input id="gh-rdesc" class="text-input" value="${esc(desc)}" maxlength="350" autocomplete="off"></div>
            <label class="setting-row switch-row"><span class="grow"><span class="row-title">${esc(t('Приватный'))}</span>
              <span class="row-description">${esc(t('Видите только вы и те, кого вы пригласите.'))}</span></span>
              <input type="checkbox" class="switch" data-private ${isPrivate ? 'checked' : ''}></label>
            <p class="subtxt">${esc(plural(first.selectedCount, 'Будет отправлено файлов: {count}'))}</p>
            ${
              secrets.length
                ? `<div class="gh-callout danger">${icon('shield', 'sm')}<div class="grow">
                <div>${esc(t('Эти файлы похожи на секреты и не будут отправлены, если не отметить их:'))}</div>
                ${secrets
                  .map(
                    (s) => `<label class="gh-confirm"><input type="checkbox" data-sel="${esc(s.path)}" ${s.selected ? 'checked' : ''}> <span class="mono">${esc(s.path)}</span> <span class="subtxt">${esc(secretText(s.secret!))}</span></label>`,
                  )
                  .join('')}
                ${first.selectedSecrets().length ? `<label class="gh-confirm"><input type="checkbox" data-confirm ${first.secretsConfirmed ? 'checked' : ''}> <span>${esc(t('Я понимаю и всё равно хочу отправить эти файлы'))}</span></label>` : ''}
              </div></div>`
                : ''
            }
            ${first.ignored.length ? ignoredNote(first.ignored) : ''}
            <button class="btn primary full" type="submit" data-submit>${esc(t('Создать и отправить'))}</button>
            <p class="subtxt" data-reason></p>
          </form>`;
          const form = body.querySelector<HTMLFormElement>('[data-form]')!;
          const nameEl = body.querySelector<HTMLInputElement>('#gh-name')!;
          const err = body.querySelector<HTMLElement>('#gh-name-error')!;
          const reasonEl = body.querySelector<HTMLElement>('[data-reason]')!;
          const submit = body.querySelector<HTMLButtonElement>('[data-submit]')!;
          const update = () => {
            const block = first!.block();
            const problem = validateRepoName(name);
            submit.disabled = !!block || !!problem;
            reasonEl.textContent =
              block === 'secrets_unconfirmed'
                ? t('Подтвердите отправку файлов с секретами или снимите с них отметку.')
                : block === 'nothing_selected'
                  ? t('В проекте нет файлов для отправки.')
                  : '';
          };
          nameEl.addEventListener('input', () => {
            name = nameEl.value.trim();
            const problem = validateRepoName(name);
            err.textContent = problem && name ? repoNameText(problem) : '';
            nameEl.toggleAttribute('aria-invalid', !!problem && !!name);
            update();
          });
          body.querySelector<HTMLInputElement>('#gh-rdesc')!.addEventListener('input', (e) => (desc = (e.target as HTMLInputElement).value));
          body.querySelector<HTMLInputElement>('[data-private]')!.addEventListener('change', (e) => (isPrivate = (e.target as HTMLInputElement).checked));
          form.addEventListener('change', (e) => {
            const el = e.target as HTMLInputElement;
            if (el.dataset.sel !== undefined) {
              first!.toggle(el.dataset.sel, el.checked);
              draw();
            } else if (el.matches('[data-confirm]')) {
              first!.confirmSecrets(el.checked);
              update();
            }
          });
          form.addEventListener('submit', (e) => {
            e.preventDefault();
            const problem = validateRepoName(name);
            if (problem) {
              err.textContent = repoNameText(problem);
              nameEl.setAttribute('aria-invalid', 'true');
              nameEl.focus();
              return;
            }
            if (first!.block()) return;
            void create();
          });
          update();
        };

        const create = async () => {
          const model0 = first!;
          const task = new Task(body, life, { title: t('Новый репозиторий') });
          busy = true;
          try {
            const res = await createRepositoryAndPush(api(), ctx, {
              name,
              description: desc.trim(),
              private: isPrivate,
              message: 'Initial commit',
              pick: (plan) => new ChangesModel(plan, model0).selectedChanges(),
              signal: task.signal,
              onProgress: (s, done, total) => {
                task.step(stageText(s, 'repo'), done, total);
                if (s === 'updating') task.lockCancel();
              },
            });
            clearRepoCache();
            const cur = project();
            if (cur) markSynced(cur.id);
            if (res.pushed) lastPush = { sha: res.link.baseCommit, owner: res.link.owner, repo: res.link.repo };
            ctx.haptic('success');
            ctx.toast(t('Репозиторий {repo} создан', { repo: `${res.link.owner}/${res.link.repo}` }), 'success');
            if (!life.dead) nav.reset(main);
          } catch (e) {
            if (life.dead) return;
            ctx.haptic('error');
            if (link()) {
              // Created and linked; only the push failed. Commit & Push can be tried again.
              ctx.toast(errorText(e), 'error');
              nav.reset(main);
              return;
            }
            if (isAbortError(e)) {
              draw();
              return;
            }
            const exists = e instanceof GitHubError && e.code === 'validation' && /already exists/i.test(e.detail ?? '');
            renderError(body, e, {
              retry: () => draw(),
              signIn: reconnect,
              extra: exists ? esc(t('Репозиторий с таким именем уже есть в вашем аккаунте. Выберите другое имя.')) : '',
            });
          } finally {
            busy = false;
            task.done();
          }
        };

        void planFirstPush(p.files).then(
          (plan) => {
            if (life.dead) return;
            first = new ChangesModel(plan);
            draw();
          },
          (e) => !life.dead && renderError(body, e),
        );
      },
    };
  }

  function linkPickScreen(): Screen {
    return {
      title: t('Выберите репозиторий'),
      render(body) {
        const sub = life.child();
        body.innerHTML = `<div class="gh-section"><div data-picker></div></div>`;
        mountRepoPicker(body.querySelector('[data-picker]')!, api(), sub, {
          onPick: (r) => nav.push(linkOptionsScreen(r.owner.login, r.name, r.default_branch)),
          signIn: reconnect,
          manageAccess: account?.kind === 'device' && githubAppInstallUrl() ? () => ctx.openExternal(githubAppInstallUrl()) : undefined,
        });
        return () => sub.dispose();
      },
    };
  }

  function linkOptionsScreen(owner: string, repo: string, defaultBranch: string): Screen {
    return {
      title: `${owner}/${repo}`,
      render(body) {
        const sub = life.child();
        body.innerHTML = spinnerLine(t('Загружаем ветки…'));
        const load = async () => {
          const c = sub.controller();
          try {
            const names = orderBranches(await api().listBranches(owner, repo), defaultBranch);
            if (c.signal.aborted) return;
            body.innerHTML = `<form class="gh-section stack" novalidate>
              <div class="field"><label class="field-label" for="gh-lbranch">${esc(t('Ветка'))}</label>
                <select id="gh-lbranch" class="select">${branchOptions(names, names[0] ?? defaultBranch)}</select></div>
              <div class="field"><label class="field-label" for="gh-lsub">${esc(t('Подпапка (необязательно)'))}</label>
                <input id="gh-lsub" class="text-input mono" placeholder="${esc(t('например, site'))}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">
                <div class="form-help">${esc(t('Если проект — это одна папка репозитория.'))}</div></div>
              <p class="subtxt">${esc(t('Сначала сравним файлы: что есть только на GitHub — скачается, что только здесь — останется для отправки.'))}</p>
              <button class="btn primary full" type="submit">${esc(t('Продолжить'))}</button>
            </form>`;
            body.querySelector('form')!.addEventListener('submit', (e) => {
              e.preventDefault();
              const branch = body.querySelector<HTMLSelectElement>('#gh-lbranch')!.value;
              const subdir = body.querySelector<HTMLInputElement>('#gh-lsub')!.value.trim() || undefined;
              nav.push(
                pullScreen('link', undefined, false, (signal) => prepareLink(api(), project()!.files, { owner, repo, branch, subdir }, { signal })),
              );
            });
          } catch (e) {
            if (!sub.dead && !isAbortError(e)) renderError(body, e, { retry: () => void load(), signIn: reconnect });
          } finally {
            sub.release(c);
          }
        };
        void load();
        return () => sub.dispose();
      },
    };
  }

  /** Creates a branch at the commit the project is based on and moves the project onto it. Local
   *  changes stay as they are and go to the new branch with the next push. */
  async function newBranch(): Promise<void> {
    const l = link();
    if (!l) return;
    const name = await ctx.prompt({ title: t('Новая ветка'), label: t('Имя ветки'), value: suggestBranchName(), ok: t('Создать') });
    if (name === null) return;
    const problem = branchNameProblem(name);
    if (problem) {
      ctx.toast(problem === 'empty' ? t('Введите имя ветки') : t('Недопустимое имя ветки: уберите пробелы и символы ~ ^ : ? * ['), 'error');
      return;
    }
    try {
      await api().createBranch(l.owner, l.repo, name.trim(), l.baseCommit);
      await ctx.updateMeta({ github: { ...l, branch: name.trim() } });
      ctx.haptic('success');
      ctx.toast(t('Ветка {branch} создана — следующий пуш пойдёт в неё', { branch: name.trim() }), 'success');
      nav.refresh();
    } catch (e) {
      ctx.toast(isGitHubError(e) && e.status === 422 ? t('Ветка {branch} уже существует', { branch: name.trim() }) : errorText(e), 'error');
    }
  }

  function suggestBranchName(): string {
    const d = new Date();
    return `feature/${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  }

  /** Pull request from the project's branch into the default branch (or opens the existing one). */
  function pullRequestScreen(): Screen {
    return {
      title: t('Pull Request'),
      render(body) {
        const sub = life.child();
        const l = link();
        if (!l) return;
        body.innerHTML = spinnerLine(t('Загружаем…'));
        const load = async () => {
          const c = sub.controller();
          try {
            const g = api();
            const info = await g.getRepo(l.owner, l.repo);
            const base = info.default_branch;
            if (c.signal.aborted) return;
            if (l.branch === base) {
              body.innerHTML = `<div class="gh-section"><p class="subtxt">${esc(t('Проект работает с основной веткой {branch}. Создайте новую ветку, отправьте в неё изменения — и предложите их через Pull Request.', { branch: base }))}</p>
                <button class="btn primary" data-nb>${icon('plus', 'sm')} ${esc(t('Новая ветка'))}</button></div>`;
              body.querySelector('[data-nb]')!.addEventListener('click', () => void newBranch().then(() => nav.pop()));
              return;
            }
            const existing = await g.findPullRequest(l.owner, l.repo, l.branch, base);
            if (c.signal.aborted) return;
            if (existing) {
              body.innerHTML = `<div class="gh-section"><p>${esc(t('Pull Request #{number} уже открыт: {title}', { number: existing.number, title: existing.title }))}</p>
                <p class="subtxt">${esc(t('Новые коммиты в ветку {branch} автоматически попадут в него.', { branch: l.branch }))}</p>
                <button class="btn primary" data-open>${icon('external', 'sm')} ${esc(t('Открыть на github.com'))}</button></div>`;
              body.querySelector('[data-open]')!.addEventListener('click', () => ctx.openExternal(existing.html_url));
              return;
            }
            body.innerHTML = `<form class="gh-section stack" data-form>
              <p class="subtxt mono">${esc(l.branch)} → ${esc(base)}</p>
              <label class="field-label" for="pr-title">${esc(t('Заголовок'))}</label>
              <input id="pr-title" class="text-input" maxlength="200" value="${esc(l.branch.replace(/^[a-z]+\//, '').replace(/[-_]/g, ' '))}">
              <label class="field-label" for="pr-body">${esc(t('Описание'))}</label>
              <textarea id="pr-body" class="text-input textarea" rows="5" placeholder="${esc(t('Что изменилось и зачем'))}"></textarea>
              <label class="switch-row"><input type="checkbox" id="pr-draft"> ${esc(t('Черновик'))}</label>
              <button class="btn primary" type="submit">${icon('share', 'sm')} ${esc(t('Создать Pull Request'))}</button>
              <p class="subtxt">${esc(t('Неотправленные изменения сначала отправьте в ветку — Pull Request показывает то, что уже на GitHub.'))}</p>
            </form>`;
            body.querySelector('[data-form]')!.addEventListener('submit', async (e) => {
              e.preventDefault();
              const title = (body.querySelector('#pr-title') as HTMLInputElement).value.trim();
              if (!title) return ctx.toast(t('Введите заголовок'), 'error');
              const btn = body.querySelector<HTMLButtonElement>('button[type=submit]')!;
              btn.disabled = true;
              try {
                const pr = await g.createPullRequest(l.owner, l.repo, {
                  title,
                  head: l.branch,
                  base,
                  body: (body.querySelector('#pr-body') as HTMLTextAreaElement).value,
                  draft: (body.querySelector('#pr-draft') as HTMLInputElement).checked,
                });
                ctx.haptic('success');
                ctx.toast(t('Pull Request #{number} создан', { number: pr.number }), 'success');
                body.innerHTML = `<div class="gh-section"><p>${esc(t('Pull Request #{number} создан', { number: pr.number }))}</p>
                  <button class="btn primary" data-open>${icon('external', 'sm')} ${esc(t('Открыть на github.com'))}</button></div>`;
                body.querySelector('[data-open]')!.addEventListener('click', () => ctx.openExternal(pr.html_url));
              } catch (err) {
                btn.disabled = false;
                ctx.toast(
                  isGitHubError(err) && err.status === 422 ? t('GitHub не создал Pull Request: в ветке нет новых коммитов относительно {branch}', { branch: base }) : errorText(err),
                  'error',
                );
              }
            });
          } catch (e) {
            if (!sub.dead && !isAbortError(e)) renderError(body, e, { retry: () => void load(), signIn: reconnect });
          } finally {
            sub.release(c);
          }
        };
        void load();
        return () => sub.dispose();
      },
    };
  }

  function branchScreen(): Screen {
    return {
      title: t('Сменить ветку'),
      render(body) {
        const sub = life.child();
        const l = link();
        if (!l) return;
        body.innerHTML = spinnerLine(t('Загружаем ветки…'));
        const load = async () => {
          const c = sub.controller();
          try {
            const g = api();
            const info = await g.getRepo(l.owner, l.repo);
            const names = orderBranches(await g.listBranches(l.owner, l.repo), info.default_branch);
            if (c.signal.aborted) return;
            body.innerHTML = `<div class="gh-section">
              <p class="subtxt">${esc(t('Ваши несохранённые на GitHub изменения перенесутся на новую ветку. Если файл изменён и там, и здесь, вы выберете версию.'))}</p>
              <div class="list">${names
                .map(
                  (n) => `<div class="row"><button class="row-button" data-b="${esc(n)}" ${n === l.branch ? 'aria-current="true"' : ''}>${icon(n === l.branch ? 'check' : 'branch', 'sm')}
                  <span class="row-main"><span class="row-title mono">${esc(n)}</span>${n === info.default_branch ? `<span class="row-description">${esc(t('по умолчанию'))}</span>` : ''}</span></button></div>`,
                )
                .join('')}</div></div>`;
            body.querySelector('.list')!.addEventListener('click', (e) => {
              const b = (e.target as HTMLElement).closest<HTMLElement>('[data-b]');
              const branch = b?.dataset.b;
              if (!branch || branch === l.branch) return;
              nav.push(pullScreen('branch', undefined, false, (signal) => prepareBranchSwitch(api(), project()!.files, link()!, branch, { signal })));
            });
          } catch (e) {
            if (!sub.dead && !isAbortError(e)) renderError(body, e, { retry: () => void load(), signIn: reconnect });
          } finally {
            sub.release(c);
          }
        };
        void load();
        return () => sub.dispose();
      },
    };
  }

  // ------------------------------------------------------------------ Pages

  function pagesScreen(): Screen {
    return {
      title: t('Опубликовать сайт'),
      render(body) {
        const sub = life.child();
        const p = project();
        const l = p?.github;
        if (!p || !l) return;

        const start = async () => {
          const task = new Task(body, sub, { title: t('Публикация на GitHub Pages') });
          busy = true;
          try {
            const res = await publishPages(api(), l, { signal: task.signal, onProgress: (s) => task.step(stageText(s, 'pages')) });
            const cur = link();
            if (cur && cur.pagesUrl !== res.url) await ctx.updateMeta({ github: { ...cur, pagesUrl: res.url } });
            ctx.haptic('success');
            if (sub.dead) return;
            body.innerHTML = `<div class="gh-section stack">
              ${callout(esc(res.built ? t('Сайт опубликован!') : t('GitHub ещё собирает сайт. Он появится по этой ссылке через минуту-другую.')), res.built ? 'success' : 'info')}
              <div class="gh-url-box mono" aria-label="${esc(t('Адрес сайта'))}">${esc(res.url)}</div>
              <div class="btn-row">
                <button class="btn primary" data-open>${icon('external', 'sm')}<span>${esc(t('Открыть'))}</span></button>
                <button class="btn secondary" data-copy>${icon('copy', 'sm')}<span>${esc(t('Копировать'))}</span></button>
                <button class="btn secondary" data-share>${icon('share', 'sm')}<span>${esc(t('Поделиться'))}</span></button>
              </div>
              <p class="gh-note">${esc(t('Сайт публикуется из ветки {branch}. После каждой отправки он обновляется сам.', { branch: l.branch }))}</p>
            </div>`;
            body.querySelector('[data-open]')!.addEventListener('click', () => ctx.openExternal(res.url));
            body.querySelector('[data-copy]')!.addEventListener('click', async () => {
              if (await copyText(res.url)) ctx.toast(t('Ссылка скопирована'), 'success');
            });
            body.querySelector('[data-share]')!.addEventListener('click', () => void shareUrl(res.url, ctx));
          } catch (e) {
            if (sub.dead) return;
            if (isAbortError(e)) {
              nav.pop();
              return;
            }
            ctx.haptic('error');
            const extra =
              e instanceof PagesBuildError
                ? e.detail
                  ? esc(e.detail)
                  : ''
                : e instanceof GitHubError && e.code === 'validation'
                  ? esc(t('Возможно, GitHub Pages недоступен для этого репозитория: на бесплатном тарифе сайт можно публиковать только из публичного репозитория.'))
                  : '';
            renderError(body, e, { retry: () => void start(), signIn: reconnect, extra });
          } finally {
            busy = false;
            task.done();
          }
        };

        body.innerHTML = spinnerLine(t('Проверяем изменения…'));
        void quickStatus(p).then((st) => {
          if (sub.dead) return;
          if (!st?.total) return void start();
          body.innerHTML = `<div class="gh-section stack">
            ${callout(esc(plural(st.total, 'Не отправлено изменений: {count}. На сайте будет версия с GitHub, без них.')), 'warning')}
            <button class="btn primary full" data-push>${esc(t('Сначала отправить изменения'))}</button>
            <button class="btn secondary full" data-anyway>${esc(t('Опубликовать как есть'))}</button>
          </div>`;
          body.querySelector('[data-push]')!.addEventListener('click', () => nav.home());
          body.querySelector('[data-anyway]')!.addEventListener('click', () => void start());
        });
        return () => sub.dispose();
      },
    };
  }

  // ------------------------------------------------------------------ start

  root.innerHTML = spinnerLine(t('Загрузка…'));
  void currentAccount().then((a) => {
    if (life.dead) return;
    account = a;
    nav.reset(main);
  });
  return () => life.dispose();
}
