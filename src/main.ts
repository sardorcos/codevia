import { App } from './app';
import './styles/app.css';

/**
 * iOS Dynamic Type: WKWebView resolves `font: -apple-system-body` to the user's text size (17px by default).
 * The UI is laid out in px, so scale it as a whole, capped so the phone layout still fits.
 */
function applyDynamicType(): void {
  const probe = document.createElement('span');
  probe.style.font = '-apple-system-body';
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  document.body.append(probe);
  const size = parseFloat(getComputedStyle(probe).fontSize);
  probe.remove();
  const supported = probe.style.font !== '';
  const scale = supported && size ? Math.min(1.3, Math.max(1, size / 17)) : 1;
  document.documentElement.style.setProperty('--ui-scale', String(scale));
  document.documentElement.classList.toggle('dynamic-type', scale > 1);
}
applyDynamicType();
window.addEventListener('resize', applyDynamicType);

const root = document.getElementById('app')!;
const app = new App(root);

app.start().catch((e) => {
  console.error(e);
  root.innerHTML = `<div class="fatal" role="alert"><h1>Не удалось запустить приложение</h1><p></p><button class="btn primary">Перезапустить</button></div>`;
  root.querySelector('.fatal p')!.textContent = String((e as Error)?.message ?? e);
  root.querySelector('.fatal button')!.addEventListener('click', () => location.reload());
});

if (import.meta.env.DEV || new URLSearchParams(location.search).has('e2e')) {
  (globalThis as unknown as { __codevia: App }).__codevia = app;
}
