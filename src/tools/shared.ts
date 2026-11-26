import type { ProjectFile } from '../core/types';
import { decodeUtf8 } from '../core/bytes';
import { esc, icon } from '../ui/dom';
import { openSheet } from '../ui/sheet';
import { t } from '../i18n';
import type { ToolContext } from './types';

/** Helpers shared by the tool panels. Nothing here keeps state between mounts except localStorage. */

const PREFIX = 'codevia.tools.';

/** Reads a JSON value from localStorage; any error (private mode, quota, bad JSON) gives `fallback`. */
export function loadStored<T>(key: string, fallback: T): T {
  try {
    const raw = globalThis.localStorage?.getItem(PREFIX + key);
    if (raw == null) return fallback;
    const v = JSON.parse(raw) as unknown;
    return (v ?? fallback) as T;
  } catch {
    return fallback;
  }
}

/** Writes a JSON value to localStorage; returns false when storage is unavailable or full. */
export function saveStored(key: string, value: unknown): boolean {
  try {
    globalThis.localStorage?.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** Copies text to the clipboard (with a fallback for older WebKit) and confirms with a toast. */
export async function copyText(text: string, ctx: Pick<ToolContext, 'toast' | 'haptic'>, done = t('Скопировано')): Promise<boolean> {
  let ok: boolean;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
  }
  if (ok) {
    ctx.haptic('light');
    ctx.toast(done, 'success');
  } else ctx.toast(t('Не удалось скопировать'), 'error');
  return ok;
}

export const fileText = (f: ProjectFile | undefined): string => (!f ? '' : f.text ? f.content : decodeUtf8(f.data));

export const fileBytes = (f: ProjectFile): Uint8Array => (f.text ? new TextEncoder().encode(f.content) : f.data);

/**
 * Lets the user pick a file of the open project. Shows a filterable list in a bottom sheet.
 * Resolves with the path or null.
 */
export async function pickProjectFile(ctx: ToolContext, opts: { title: string; filter: (path: string) => boolean; empty?: string }): Promise<string | null> {
  const project = ctx.project();
  if (!project) {
    ctx.toast(t('Сначала откройте проект'), 'error');
    return null;
  }
  const paths = Object.keys(project.files).filter(opts.filter).sort((a, b) => a.localeCompare(b));
  const rows = (list: string[]) =>
    list.length
      ? list.map((p) => `<button class="menu-item" data-path="${esc(p)}">${icon('file')}<span class="truncate mono">${esc(p)}</span></button>`).join('')
      : `<p class="tool-muted">${esc(opts.empty ?? t('Подходящих файлов нет'))}</p>`;
  const r = await openSheet<string>({
    title: opts.title,
    body: `${paths.length > 8 ? `<input class="text-input" type="search" data-filter aria-label="${esc(t('Фильтр'))}" placeholder="${esc(t('Фильтр'))}" autocapitalize="off" autocorrect="off" spellcheck="false">` : ''}
      <div class="menu-list tool-pick-list" role="group" aria-label="${esc(opts.title)}">${rows(paths)}</div>`,
    onMount: (root, close) => {
      const list = root.querySelector<HTMLElement>('.tool-pick-list')!;
      root.querySelector<HTMLInputElement>('[data-filter]')?.addEventListener('input', (e) => {
        const q = (e.target as HTMLInputElement).value.trim().toLowerCase();
        list.innerHTML = rows(paths.filter((p) => p.toLowerCase().includes(q)));
      });
      list.addEventListener('click', (e) => {
        const b = (e.target as HTMLElement).closest<HTMLElement>('[data-path]');
        if (b) close(b.dataset.path);
      });
    },
  });
  return r ?? null;
}

/** Asks for a project path to save to; confirms overwriting. Returns the path or null. */
export async function askSavePath(ctx: ToolContext, suggested: string): Promise<string | null> {
  const project = ctx.project();
  if (!project) {
    ctx.toast(t('Сначала откройте проект'), 'error');
    return null;
  }
  const raw = await ctx.prompt({ title: t('Сохранить в проект'), label: t('Путь файла в проекте'), value: suggested, ok: t('Сохранить') });
  if (!raw) return null;
  const path = raw.trim().replace(/^\/+/, '');
  if (!path || path.split('/').some((s) => !s || s === '.' || s === '..')) {
    ctx.toast(t('Недопустимый путь файла'), 'error');
    return null;
  }
  if (project.files[path] && !(await ctx.confirm({ title: t('Заменить файл?'), message: path, ok: t('Заменить'), destructive: true }))) return null;
  return path;
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): ((...a: A) => void) & { cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = (...a: A) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...a), ms);
  };
  run.cancel = () => clearTimeout(timer);
  return run;
}

/** Segmented control markup; buttons carry `data-<name>="<value>"`. */
export function segmented(name: string, items: Array<[string, string]>, active: string, label: string): string {
  return `<div class="segmented tool-seg" role="group" aria-label="${esc(label)}">${items
    .map(([v, text]) => `<button type="button" data-${name}="${esc(v)}" class="${v === active ? 'active' : ''}" aria-pressed="${v === active}">${esc(text)}</button>`)
    .join('')}</div>`;
}

export function setSegmented(root: ParentNode, name: string, value: string): void {
  root.querySelectorAll<HTMLElement>(`[data-${name}]`).forEach((b) => {
    const on = b.getAttribute(`data-${name}`) === value;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
}

/** Unique-ish DOM id prefix so two mounted tools never share ids. */
let seq = 0;
export const uid = (p: string): string => `tool-${p}-${++seq}`;

/** Calls `onLong` after a press of 500 ms without moving (touch and mouse); returns a cleanup. */
export function onLongPress(root: HTMLElement, selector: string, onLong: (el: HTMLElement) => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let start: { x: number; y: number } | null = null;
  let fired = false;
  const down = (e: PointerEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>(selector);
    if (!el || !root.contains(el)) return;
    fired = false;
    start = { x: e.clientX, y: e.clientY };
    clearTimeout(timer);
    timer = setTimeout(() => {
      fired = true;
      onLong(el);
    }, 500);
  };
  const move = (e: PointerEvent) => {
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8) clearTimeout(timer);
  };
  const up = () => {
    clearTimeout(timer);
    start = null;
  };
  // A long press must not also count as a tap.
  const click = (e: MouseEvent) => {
    if (fired) {
      e.stopPropagation();
      e.preventDefault();
      fired = false;
    }
  };
  const menu = (e: Event) => {
    if ((e.target as HTMLElement).closest(selector)) e.preventDefault();
  };
  root.addEventListener('pointerdown', down);
  root.addEventListener('pointermove', move);
  root.addEventListener('pointerup', up);
  root.addEventListener('pointercancel', up);
  root.addEventListener('click', click, true);
  root.addEventListener('contextmenu', menu);
  return () => {
    clearTimeout(timer);
    root.removeEventListener('pointerdown', down);
    root.removeEventListener('pointermove', move);
    root.removeEventListener('pointerup', up);
    root.removeEventListener('pointercancel', up);
    root.removeEventListener('click', click, true);
    root.removeEventListener('contextmenu', menu);
  };
}
