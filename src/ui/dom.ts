import { getLang, locale } from '../i18n';

export const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T | null => root.querySelector<T>(sel);
export const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T[] => [...root.querySelectorAll<T>(sel)];

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v: unknown = ''): string => String(v).replace(/[&<>"']/g, (c) => ESC[c]!);

export const icon = (name: string, cls = ''): string =>
  `<svg class="ico ${cls}" aria-hidden="true" focusable="false"><use href="#i-${name}"></use></svg>`;

// "14:05" in Russian, "2:05 PM" in English.
const hour = (): '2-digit' | 'numeric' => (getLang() === 'en' ? 'numeric' : '2-digit');

export const fmtDate = (iso: string): string => {
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString(locale(), { hour: hour(), minute: '2-digit' });
  return d.toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
};

export const fmtDateTime = (iso: string): string =>
  new Date(iso).toLocaleString(locale(), { day: 'numeric', month: 'short', hour: hour(), minute: '2-digit' });

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(message: string, kind: 'info' | 'error' | 'success' = 'info'): void {
  const node = $('#toast');
  if (!node) return;
  node.textContent = message;
  node.dataset.kind = kind;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), kind === 'error' ? 6000 : 3200);
}
