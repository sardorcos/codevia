import { $, $$, esc, icon } from './dom';
import { t } from '../i18n';

/**
 * Bottom sheets (dialogs). Accessible: focus moves into the sheet, Tab is trapped, Escape and the
 * backdrop close it, and focus returns to the element that opened it.
 */
interface OpenSheet {
  close: (value?: unknown) => void;
}
let current: OpenSheet | null = null;

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

export function closeSheet(value?: unknown): void {
  current?.close(value);
}

export const sheetOpen = (): boolean => current !== null;

export interface SheetOptions {
  title: string;
  body: string;
  /** Called after the sheet DOM is in place. Return value is ignored. */
  onMount?: (root: HTMLElement, close: (v?: unknown) => void) => void;
  wide?: boolean;
  initialFocus?: string;
}

export function openSheet<T = unknown>(opts: SheetOptions): Promise<T | undefined> {
  current?.close(undefined);
  const root = $('#sheet-root')!;
  const opener = document.activeElement as HTMLElement | null;
  root.innerHTML = `<div class="sheet-layer" data-sheet-backdrop>
    <div class="sheet ${opts.wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
      <div class="sheet-grabber" aria-hidden="true"></div>
      <div class="sheet-head"><h2 class="sheet-title" id="sheet-title">${esc(opts.title)}</h2>
        <button class="icon-btn" data-sheet-close aria-label="${esc(t('Закрыть'))}">${icon('close')}</button></div>
      <div class="sheet-content">${opts.body}</div>
    </div></div>`;
  document.body.classList.add('sheet-active');
  $('#app')?.setAttribute('aria-hidden', 'true');
  $('#app')?.setAttribute('inert', '');
  const layer = $('.sheet-layer', root)!;
  const sheet = $('.sheet', root)!;

  return new Promise<T | undefined>((resolve) => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(undefined);
      } else if (e.key === 'Tab') {
        const items = $$<HTMLElement>(FOCUSABLE, sheet).filter((x) => x.offsetParent !== null);
        if (!items.length) return;
        const first = items[0]!;
        const last = items[items.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('[data-sheet-close]') || t === layer) close(undefined);
    };
    function close(value?: unknown) {
      if (current !== handle) return;
      current = null;
      document.removeEventListener('keydown', onKey, true);
      layer.removeEventListener('click', onClick);
      layer.classList.add('closing');
      document.body.classList.remove('sheet-active');
      $('#app')?.removeAttribute('aria-hidden');
      $('#app')?.removeAttribute('inert');
      setTimeout(() => {
        if (!current) root.innerHTML = '';
      }, 160);
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
      resolve(value as T | undefined);
    }
    const handle: OpenSheet = { close };
    current = handle;
    document.addEventListener('keydown', onKey, true);
    layer.addEventListener('click', onClick);
    opts.onMount?.(sheet, close);
    const target = (opts.initialFocus && $<HTMLElement>(opts.initialFocus, sheet)) || $<HTMLElement>(FOCUSABLE, $('.sheet-content', sheet)!) || sheet;
    requestAnimationFrame(() => target.focus({ preventScroll: true }));
  });
}

export async function confirmSheet(opts: {
  title: string;
  message: string;
  confirm: string;
  danger?: boolean;
  cancel?: string;
}): Promise<boolean> {
  const r = await openSheet<boolean>({
    title: opts.title,
    body: `<p class="sheet-text">${opts.message}</p>
      <div class="sheet-actions">
        <button class="btn ${opts.danger ? 'danger' : 'primary'} full" data-ok>${esc(opts.confirm)}</button>
        <button class="btn secondary full" data-sheet-close>${esc(opts.cancel ?? t('Отмена'))}</button>
      </div>`,
    onMount: (root, close) => $('[data-ok]', root)!.addEventListener('click', () => close(true)),
    initialFocus: opts.danger ? '[data-sheet-close]' : '[data-ok]',
  });
  return r === true;
}

export async function promptSheet(opts: {
  title: string;
  label: string;
  value?: string;
  placeholder?: string;
  confirm: string;
  help?: string;
  mono?: boolean;
  validate?: (v: string) => string | null;
}): Promise<string | null> {
  const r = await openSheet<string>({
    title: opts.title,
    body: `<form class="stack" data-prompt novalidate>
      <label class="field-label" for="prompt-input">${esc(opts.label)}</label>
      <input id="prompt-input" class="text-input ${opts.mono ? 'mono' : ''}" value="${esc(opts.value ?? '')}" placeholder="${esc(opts.placeholder ?? '')}"
        autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="400" aria-describedby="prompt-help prompt-error">
      <div id="prompt-error" class="field-error" role="alert"></div>
      ${opts.help ? `<div id="prompt-help" class="form-help">${opts.help}</div>` : ''}
      <button class="btn primary full" type="submit">${esc(opts.confirm)}</button>
    </form>`,
    initialFocus: '#prompt-input',
    onMount: (root, close) => {
      const form = $<HTMLFormElement>('[data-prompt]', root)!;
      const input = $<HTMLInputElement>('#prompt-input', root)!;
      const err = $('#prompt-error', root)!;
      requestAnimationFrame(() => {
        const dot = input.value.lastIndexOf('.');
        input.setSelectionRange(0, dot > 0 && opts.mono ? dot : input.value.length);
      });
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const v = input.value.trim();
        const problem = opts.validate?.(v) ?? (v ? null : t('Поле не может быть пустым'));
        if (problem) {
          err.textContent = problem;
          input.setAttribute('aria-invalid', 'true');
          input.focus();
          return;
        }
        close(v);
      });
    },
  });
  return r ?? null;
}

export interface MenuItem {
  id: string;
  label: string;
  icon: string;
  danger?: boolean;
}

export async function menuSheet(title: string, items: MenuItem[], subtitle?: string): Promise<string | undefined> {
  return openSheet<string>({
    title,
    body: `${subtitle ? `<div class="subtxt mono sheet-sub">${esc(subtitle)}</div>` : ''}<div class="menu-list" role="group" aria-label="${esc(title)}">
      ${items.map((i) => `<button class="menu-item ${i.danger ? 'danger' : ''}" data-id="${esc(i.id)}">${icon(i.icon)}<span>${esc(i.label)}</span></button>`).join('')}
    </div>`,
    onMount: (root, close) =>
      root.addEventListener('click', (e) => {
        const b = (e.target as HTMLElement).closest<HTMLElement>('.menu-item');
        if (b) close(b.dataset.id);
      }),
  });
}
