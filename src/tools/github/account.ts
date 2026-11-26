/**
 * Account panel: sign in with the GitHub device flow (or a personal access token), see who is
 * signed in, sign out. Also mounted inline by the Clone and Source control panels when needed.
 */
import { t } from '../../i18n';
import {
  completeDeviceSignIn,
  GITHUB_AUTHORIZATIONS_URL,
  githubAppInstallUrl,
  isDeviceFlowAvailable,
  pollForToken,
  signInWithToken,
  startDeviceFlow,
  type DeviceFlowStart,
} from '../../github/auth';
import { copyText } from '../../platform/native';
import type { ToolContext } from '../types';
import { errorText, isAbortError } from './messages';
import { currentAccount, notifyAccount, onAccountChange, signOutAndNotify, toAccount, type AccountInfo } from './session';
import { avatar, callout, esc, icon, Life, spinnerLine, wireAvatars } from './ui';

const TOKEN_SETTINGS_URL = 'https://github.com/settings/personal-access-tokens/new';
const DEVICE_URL = 'https://github.com/login/device';

export interface AccountOptions {
  /** Smaller layout for inline use inside another panel. */
  compact?: boolean;
  onSignedIn?: (account: AccountInfo) => void;
}

/** Where to send the user: GitHub's own page only. */
function safeVerificationUri(uri: string): string {
  try {
    const u = new URL(uri);
    if (u.protocol === 'https:' && u.hostname === 'github.com') return u.toString();
  } catch {
    /* fall through */
  }
  return DEVICE_URL;
}

const fmtCountdown = (ms: number): string => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export const keychainNote = (): string =>
  `<p class="gh-note">${icon('lock', 'xs')}<span>${esc(t('Токен хранится только в Связке ключей этого устройства и никуда не отправляется, кроме GitHub.'))}</span></p>`;

/** Mounts the account UI into `host`. Re-renders when the account changes anywhere. */
export function mountAccount(host: HTMLElement, ctx: ToolContext, life: Life, opts: AccountOptions = {}): void {
  let flow: AbortController | null = null;
  let revokeHint = false;

  const stopFlow = () => {
    flow?.abort();
    if (flow) life.release(flow);
    flow = null;
  };
  life.onDispose(stopFlow);
  life.onDispose(
    onAccountChange((a) => {
      if (a) {
        stopFlow();
        renderSignedIn(a);
        opts.onSignedIn?.(a);
      } else if (!flow) renderSignedOut();
    }),
  );

  const signedIn = (session: Parameters<typeof toAccount>[0]) => {
    ctx.haptic('success');
    const a = toAccount(session)!;
    ctx.toast(t('GitHub подключён: {login}', { login: a.login }), 'success');
    notifyAccount(a);
  };

  function renderSignedOut(): void {
    if (life.dead) return;
    const device = isDeviceFlowAvailable();
    host.innerHTML = `<div class="gh-account ${opts.compact ? 'compact' : ''}">
      ${revokeHint ? callout(esc(t('GitHub отключён на этом устройстве. Чтобы полностью отозвать доступ приложения, откройте настройки GitHub.')), 'success', `<div class="btn-row gh-callout-actions"><button class="btn secondary tiny" data-revoke>${esc(t('Открыть настройки GitHub'))}</button></div>`) : ''}
      <div class="gh-hero">
        <h3 class="gh-h3">${esc(t('Подключите GitHub'))}</h3>
        <p class="subtxt">${esc(t('Клонируйте репозитории, отправляйте изменения и публикуйте сайты прямо с телефона.'))}</p>
      </div>
      <div class="stack">
        ${device ? `<button class="btn primary full" data-device>${esc(t('Войти через GitHub'))}</button>` : ''}
        <button class="btn ${device ? 'secondary' : 'primary'} full" data-pat>${esc(t('Использовать персональный токен'))}</button>
      </div>
      ${keychainNote()}
    </div>`;
    host.querySelector('[data-device]')?.addEventListener('click', () => void runDeviceFlow());
    host.querySelector('[data-pat]')!.addEventListener('click', renderTokenForm);
    host.querySelector('[data-revoke]')?.addEventListener('click', () => ctx.openExternal(GITHUB_AUTHORIZATIONS_URL));
  }

  function renderBusy(text: string): void {
    host.innerHTML = `<div class="gh-account">${spinnerLine(text)}<button class="btn secondary full" data-cancel>${esc(t('Отмена'))}</button></div>`;
    host.querySelector('[data-cancel]')!.addEventListener('click', () => {
      stopFlow();
      renderSignedOut();
    });
  }

  function renderCode(start: DeviceFlowStart): void {
    const uri = safeVerificationUri(start.verificationUri);
    host.innerHTML = `<div class="gh-account gh-device">
      <p class="subtxt">${esc(t('Введите этот код на GitHub, чтобы разрешить доступ:'))}</p>
      <div class="gh-code mono" aria-label="${esc(t('Код подтверждения'))}">${esc(start.userCode)}</div>
      <button class="btn primary full" data-open>${icon('copy', 'sm')}<span>${esc(t('Скопировать код и открыть GitHub'))}</span></button>
      <div class="gh-loading" role="status" aria-live="polite"><span class="spinner" aria-hidden="true"></span>
        <span>${esc(t('Ждём подтверждения на GitHub…'))} <span class="subtxt" data-left></span></span></div>
      <button class="btn secondary full" data-cancel>${esc(t('Отмена'))}</button>
      <p class="gh-note">${esc(t('Пароль вы вводите только на сайте GitHub — приложение его не видит.'))}</p>
    </div>`;
    host.querySelector('[data-open]')!.addEventListener('click', async () => {
      const ok = await copyText(start.userCode);
      if (ok) ctx.toast(t('Код скопирован'), 'success');
      ctx.openExternal(uri);
    });
    host.querySelector('[data-cancel]')!.addEventListener('click', () => {
      stopFlow();
      renderSignedOut();
    });
    const left = host.querySelector<HTMLElement>('[data-left]')!;
    const tick = () => {
      const ms = start.expiresAt - Date.now();
      left.textContent = ms > 0 ? t('Код действует ещё {time}', { time: fmtCountdown(ms) }) : t('Срок действия кода истёк');
    };
    tick();
    const timer = setInterval(() => (host.contains(left) ? tick() : clearInterval(timer)), 1000);
    life.onDispose(() => clearInterval(timer));
  }

  function renderDeviceError(e: unknown): void {
    host.innerHTML = `<div class="gh-account">
      <div class="gh-callout danger" role="alert">${icon('info', 'sm')}<div class="grow">${esc(errorText(e))}</div></div>
      <div class="stack">
        <button class="btn primary full" data-again>${esc(t('Попробовать снова'))}</button>
        <button class="btn secondary full" data-pat>${esc(t('Использовать персональный токен'))}</button>
        <button class="btn ghost full" data-back>${esc(t('Назад'))}</button>
      </div></div>`;
    host.querySelector('[data-again]')!.addEventListener('click', () => void runDeviceFlow());
    host.querySelector('[data-pat]')!.addEventListener('click', renderTokenForm);
    host.querySelector('[data-back]')!.addEventListener('click', renderSignedOut);
  }

  async function runDeviceFlow(): Promise<void> {
    stopFlow();
    const c = (flow = life.controller());
    revokeHint = false;
    renderBusy(t('Получаем код…'));
    try {
      const start = await startDeviceFlow(c.signal);
      if (c.signal.aborted) return;
      renderCode(start);
      const tokens = await pollForToken(start.deviceCode, start.interval, c.signal, start.expiresAt);
      if (c.signal.aborted) return;
      renderBusy(t('Завершаем вход…'));
      const session = await completeDeviceSignIn(tokens);
      flow = null;
      life.release(c);
      signedIn(session);
    } catch (e) {
      if (flow !== c) return;
      flow = null;
      life.release(c);
      if (life.dead || isAbortError(e)) return;
      ctx.haptic('error');
      renderDeviceError(e);
    }
  }

  function renderTokenForm(): void {
    stopFlow();
    revokeHint = false;
    host.innerHTML = `<form class="gh-account stack" data-form novalidate>
      <h3 class="gh-h3">${esc(t('Персональный токен доступа'))}</h3>
      <ol class="gh-steps">
        <li>${esc(t('Создайте на GitHub токен типа «Fine-grained».'))}</li>
        <li>${esc(t('В «Repository access» выберите репозитории, с которыми будете работать.'))}</li>
        <li>${esc(t('В «Permissions» включите: Contents — Read and write, Metadata — Read, Pages — Read and write (для публикации сайтов).'))}</li>
        <li>${esc(t('Скопируйте токен и вставьте его ниже.'))}</li>
      </ol>
      <button type="button" class="btn secondary full" data-open>${esc(t('Открыть настройки токенов на GitHub'))}</button>
      <label class="field-label" for="gh-pat">${esc(t('Токен'))}</label>
      <input id="gh-pat" class="text-input mono" type="password" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="github_pat_…" aria-describedby="gh-pat-error">
      <div id="gh-pat-error" class="field-error" role="alert"></div>
      <button class="btn primary full" type="submit" data-submit>${esc(t('Подключить'))}</button>
      <button type="button" class="btn ghost full" data-back>${esc(t('Назад'))}</button>
      ${keychainNote()}
    </form>`;
    const form = host.querySelector<HTMLFormElement>('[data-form]')!;
    const input = host.querySelector<HTMLInputElement>('#gh-pat')!;
    const err = host.querySelector<HTMLElement>('#gh-pat-error')!;
    const submit = host.querySelector<HTMLButtonElement>('[data-submit]')!;
    host.querySelector('[data-open]')!.addEventListener('click', () => ctx.openExternal(TOKEN_SETTINGS_URL));
    host.querySelector('[data-back]')!.addEventListener('click', () => {
      input.value = '';
      renderSignedOut();
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const value = input.value;
      if (!value.trim()) {
        err.textContent = t('Вставьте токен.');
        input.setAttribute('aria-invalid', 'true');
        return;
      }
      submit.disabled = true;
      err.textContent = '';
      submit.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>${esc(t('Проверяем…'))}</span>`;
      try {
        const session = await signInWithToken(value);
        input.value = '';
        signedIn(session);
      } catch (ex) {
        if (life.dead) return;
        err.textContent = errorText(ex);
        input.setAttribute('aria-invalid', 'true');
        submit.disabled = false;
        submit.textContent = t('Подключить');
        ctx.haptic('error');
      }
    });
  }

  function renderSignedIn(a: AccountInfo): void {
    if (life.dead) return;
    host.innerHTML = `<div class="gh-account ${opts.compact ? 'compact' : ''}">
      <div class="gh-profile">
        ${avatar(a.avatarUrl, a.name, a.login, opts.compact ? 44 : 64)}
        <div class="grow">
          <div class="gh-name truncate">${esc(a.name || a.login)}</div>
          <div class="subtxt truncate">@${esc(a.login)} · ${esc(a.kind === 'pat' ? t('персональный токен') : t('вход через GitHub'))}</div>
        </div>
      </div>
      ${
        opts.compact
          ? ''
          : `${a.kind === 'device' && githubAppInstallUrl() ? repoAccessNote() : ''}<div class="stack">
        <button class="btn secondary full" data-profile>${esc(t('Открыть профиль на GitHub'))}</button>
        <button class="btn danger full" data-signout>${esc(t('Отключить GitHub'))}</button>
      </div>
      ${keychainNote()}`
      }
    </div>`;
    wireAvatars(host);
    host.querySelector('[data-repo-access]')?.addEventListener('click', () => ctx.openExternal(githubAppInstallUrl()));
    host.querySelector('[data-profile]')?.addEventListener('click', () => ctx.openExternal(a.htmlUrl || `https://github.com/${encodeURIComponent(a.login)}`));
    host.querySelector('[data-signout]')?.addEventListener('click', async () => {
      const ok = await ctx.confirm({
        title: t('Отключить GitHub?'),
        message: t('Токен будет удалён с этого устройства. Полностью отозвать доступ приложения можно в настройках GitHub.'),
        ok: t('Отключить'),
        destructive: true,
      });
      if (!ok) return;
      try {
        await signOutAndNotify();
        revokeHint = true;
        renderSignedOut();
      } catch (ex) {
        ctx.toast(errorText(ex), 'error');
      }
    });
  }

  host.innerHTML = spinnerLine(t('Загрузка…'));
  void currentAccount().then((a) => {
    if (life.dead) return;
    if (a) renderSignedIn(a);
    else renderSignedOut();
  });
}

/** The Account tool. */
export function mountAccountTool(root: HTMLElement, ctx: ToolContext): () => void {
  const life = new Life();
  root.classList.add('gh');
  root.innerHTML = '<div class="gh-body"></div>';
  mountAccount(root.querySelector<HTMLElement>('.gh-body')!, ctx, life);
  return () => life.dispose();
}

/** Signed in through the GitHub App: it sees only the repositories it is installed on. */
export function repoAccessNote(): string {
  return `<div class="gh-callout" role="note">${icon('lock', 'sm')}<div class="grow">${esc(
    t('Codevia видит только те репозитории, к которым вы дали доступ. Выберите нужные репозитории или все сразу — это можно изменить в любой момент.'),
  )}<div class="btn-row gh-callout-actions"><button class="btn primary tiny" data-repo-access>${esc(t('Выбрать репозитории'))}</button></div></div></div>`;
}
