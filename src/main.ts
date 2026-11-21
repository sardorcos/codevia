import { App } from './app';
import './styles/app.css';

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
