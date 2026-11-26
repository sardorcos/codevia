/**
 * Small DOM helpers shared by the GitHub panels: a lifetime that cancels everything on unmount,
 * an in-panel navigation stack, a progress card with Cancel, and error cards.
 */
import { locale, t } from '../../i18n';
import { esc, icon } from '../../ui/dom';
import { errorText, isAbortError, needsSignIn } from './messages';
import type { ChangeStatus } from './model';

export { esc, icon };

/** Owns the async work of a mounted panel: aborted, timers cleared and listeners removed on unmount. */
export class Life {
  private readonly controllers = new Set<AbortController>();
  private readonly cleanups: Array<() => void> = [];
  dead = false;

  controller(): AbortController {
    const c = new AbortController();
    if (this.dead) c.abort();
    this.controllers.add(c);
    return c;
  }

  /** A lifetime that ends with this one, or earlier when disposed itself (e.g. one screen). */
  child(): Life {
    const c = new Life();
    const end = () => c.dispose();
    this.onDispose(end);
    c.onDispose(() => {
      const i = this.cleanups.indexOf(end);
      if (i >= 0) this.cleanups.splice(i, 1);
    });
    return c;
  }

  release(c: AbortController): void {
    this.controllers.delete(c);
  }

  onDispose(fn: () => void): void {
    if (this.dead) fn();
    else this.cleanups.push(fn);
  }

  interval(fn: () => void, ms: number): void {
    const id = setInterval(fn, ms);
    this.onDispose(() => clearInterval(id));
  }

  listen(target: EventTarget, type: string, fn: EventListener): void {
    target.addEventListener(type, fn);
    this.onDispose(() => target.removeEventListener(type, fn));
  }

  dispose(): void {
    if (this.dead) return;
    this.dead = true;
    for (const c of this.controllers) c.abort();
    this.controllers.clear();
    for (const fn of this.cleanups.splice(0)) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
  }
}

export interface Screen {
  /** Shown in the sub-header with a Back button (screens below the first). */
  title: string;
  render(body: HTMLElement): void | (() => void);
}

/** A stack of screens inside the tool panel. */
export class Nav {
  private stack: Screen[] = [];
  private cleanup: (() => void) | void = undefined;

  constructor(
    private readonly root: HTMLElement,
    private readonly life: Life,
  ) {
    root.classList.add('gh');
    life.onDispose(() => this.unmountCurrent());
  }

  get depth(): number {
    return this.stack.length;
  }

  push(screen: Screen): void {
    this.stack.push(screen);
    this.show();
  }

  replace(screen: Screen): void {
    this.stack.pop();
    this.push(screen);
  }

  reset(screen: Screen): void {
    this.stack = [];
    this.push(screen);
  }

  pop(): void {
    if (this.stack.length > 1) this.stack.pop();
    this.show();
  }

  /** Back to the first screen. */
  home(): void {
    this.stack.splice(1);
    this.show();
  }

  /** Renders the current screen again. */
  refresh(): void {
    this.show();
  }

  private unmountCurrent(): void {
    const fn = this.cleanup;
    this.cleanup = undefined;
    if (fn) fn();
  }

  private show(): void {
    if (this.life.dead) return;
    this.unmountCurrent();
    const screen = this.stack[this.stack.length - 1];
    if (!screen) return;
    const sub =
      this.stack.length > 1
        ? `<div class="gh-subhead"><button class="icon-btn" data-gh-back aria-label="${esc(t('Назад'))}">${icon('back')}</button><h2 class="gh-subtitle truncate">${esc(screen.title)}</h2></div>`
        : '';
    this.root.innerHTML = `${sub}<div class="gh-body"></div>`;
    this.root.querySelector('[data-gh-back]')?.addEventListener('click', () => this.pop());
    const body = this.root.querySelector<HTMLElement>('.gh-body')!;
    this.cleanup = screen.render(body);
    this.root.scrollTop = 0;
  }
}

/** Progress card of a running action. */
export class Task {
  readonly controller: AbortController;
  private readonly el: HTMLElement;

  constructor(
    host: HTMLElement,
    private readonly life: Life,
    opts: { title: string; cancellable?: boolean },
  ) {
    this.controller = life.controller();
    host.innerHTML = `<div class="gh-task" role="status" aria-live="polite">
      <div class="gh-task-head"><span class="spinner" aria-hidden="true"></span><strong>${esc(opts.title)}</strong></div>
      <div class="gh-task-step subtxt" data-step></div>
      <div class="gh-bar" hidden><div class="gh-bar-fill"></div></div>
      ${opts.cancellable === false ? '' : `<button class="btn secondary full" data-cancel>${esc(t('Отмена'))}</button>`}
    </div>`;
    this.el = host.querySelector('.gh-task')!;
    this.el.querySelector('[data-cancel]')?.addEventListener('click', () => this.controller.abort());
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  step(text: string, done?: number, total?: number): void {
    const step = this.el.querySelector<HTMLElement>('[data-step]');
    if (step) step.textContent = total ? `${text} (${done ?? 0}/${total})` : text;
    const bar = this.el.querySelector<HTMLElement>('.gh-bar');
    if (bar) {
      bar.hidden = !total;
      if (total) bar.querySelector<HTMLElement>('.gh-bar-fill')!.style.width = `${Math.round(((done ?? 0) / total) * 100)}%`;
    }
  }

  /** From here on the action finishes on its own (e.g. the branch update of a push). */
  lockCancel(): void {
    this.el.querySelector('[data-cancel]')?.remove();
  }

  done(): void {
    this.life.release(this.controller);
  }
}

/** Renders an error card; returns the element. Actions get a Retry / Connect again button. */
export function renderError(host: HTMLElement, e: unknown, actions: { retry?: () => void; signIn?: () => void; extra?: string } = {}): void {
  const abort = isAbortError(e);
  host.innerHTML = `<div class="gh-callout ${abort ? '' : 'danger'}" role="alert">
    ${icon(abort ? 'info' : 'info', 'sm')}<div class="grow"><div>${esc(errorText(e))}</div>${actions.extra ? `<div class="subtxt">${actions.extra}</div>` : ''}
    <div class="btn-row gh-callout-actions">
      ${actions.signIn && needsSignIn(e) ? `<button class="btn primary tiny" data-signin>${esc(t('Подключить снова'))}</button>` : ''}
      ${actions.retry ? `<button class="btn secondary tiny" data-retry>${esc(t('Повторить'))}</button>` : ''}
    </div></div></div>`;
  host.querySelector('[data-retry]')?.addEventListener('click', () => actions.retry?.());
  host.querySelector('[data-signin]')?.addEventListener('click', () => actions.signIn?.());
}

export function callout(text: string, kind: 'info' | 'warning' | 'danger' | 'success' = 'info', extra = ''): string {
  const ic = kind === 'success' ? 'check' : kind === 'warning' ? 'shield' : 'info';
  return `<div class="gh-callout ${kind}">${icon(ic, 'sm')}<div class="grow">${text}${extra}</div></div>`;
}

const LETTER: Record<ChangeStatus, string> = { modified: 'M', added: 'A', deleted: 'D' };

export function statusBadge(status: ChangeStatus): string {
  const label = status === 'modified' ? t('Изменён') : status === 'added' ? t('Новый') : t('Удалён');
  return `<span class="gh-st gh-st-${status}" title="${esc(label)}" aria-label="${esc(label)}">${LETTER[status]}</span>`;
}

/** "3 Oct" / "3 Oct 2023" (or the time today). */
export function fmtShortDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

/** Two letters for the avatar placeholder. */
export function initials(name: string | null, login: string): string {
  const src = (name || login).trim();
  const words = src.split(/[\s._-]+/).filter(Boolean);
  const s = words.length >= 2 ? words[0]![0]! + words[1]![0]! : src.slice(0, 2);
  return s.toUpperCase();
}

/** Avatar image over initials; the initials stay when the image cannot load (offline, CSP). */
export function avatar(url: string, name: string | null, login: string, size = 56): string {
  return `<span class="gh-avatar" style="width:${size}px;height:${size}px" aria-hidden="true"><span>${esc(initials(name, login))}</span>${
    url ? `<img alt="" src="${esc(url)}" referrerpolicy="no-referrer">` : ''
  }</span>`;
}

/** Removes avatar images that fail to load (inline handlers are not allowed by the CSP). */
export function wireAvatars(root: ParentNode): void {
  for (const img of root.querySelectorAll<HTMLImageElement>('.gh-avatar img')) {
    const drop = () => img.remove();
    if (img.complete && img.naturalWidth === 0 && img.src) drop();
    else img.addEventListener('error', drop, { once: true });
  }
}

export function spinnerLine(text: string): string {
  return `<div class="gh-loading" role="status"><span class="spinner" aria-hidden="true"></span><span>${esc(text)}</span></div>`;
}
