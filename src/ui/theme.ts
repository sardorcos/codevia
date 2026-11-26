import { isNative } from '../platform/native';

export type ThemePref = 'system' | 'dark' | 'light';

const media = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
let pref: ThemePref = 'system';
let listening = false;

const resolve = (): 'dark' | 'light' => (pref === 'system' ? (media?.matches ? 'light' : 'dark') : pref);

/** Applies the interface theme: `data-appearance` on <html>, the browser chrome colour and the iOS status bar. */
export function applyTheme(next: ThemePref = pref): void {
  pref = next;
  const mode = resolve();
  const root = document.documentElement;
  if (root.dataset.appearance === mode) return;
  root.dataset.appearance = mode;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', mode === 'light' ? '#f5f6f8' : '#0c0e12');
  if (isNative()) {
    void import('@capacitor/status-bar')
      .then(({ StatusBar, Style }) => StatusBar.setStyle({ style: mode === 'light' ? Style.Light : Style.Dark }))
      .catch(() => undefined);
  }
  if (!listening && media) {
    listening = true;
    media.addEventListener('change', () => applyTheme());
  }
}

export const currentAppearance = (): 'dark' | 'light' => resolve();
