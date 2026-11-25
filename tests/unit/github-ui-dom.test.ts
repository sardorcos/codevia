// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeUtf8 } from '../../src/core/bytes';
import { textFile, type Project } from '../../src/core/types';
import { createMemoryStore, setSecureStore } from '../../src/github/secure-store';
import { gitBlobSha1 } from '../../src/github/sync';
import { githubTools } from '../../src/tools/github';
import type { ToolContext } from '../../src/tools/types';
import { makeProject } from './helpers/fake-github';

const TOKEN = 'ghp_SECRETtokenVALUE0123456789abcdefghij';

function fakeCtx(project: Project | null) {
  let current = project;
  const ctx: ToolContext & { toasts: string[] } = {
    toasts: [],
    project: () => current,
    activeFile: () => null,
    writeFiles: vi.fn(async () => undefined),
    replaceAllFiles: vi.fn(async () => undefined),
    updateMeta: vi.fn(async (patch) => {
      current = { ...current!, ...patch } as Project;
    }),
    createProject: vi.fn(async () => undefined),
    openFile: vi.fn(),
    toast: vi.fn((m: string) => void ctx.toasts.push(m)),
    confirm: vi.fn(async () => true),
    prompt: vi.fn(async () => null),
    share: vi.fn(async () => undefined),
    openExternal: vi.fn(),
    haptic: vi.fn(),
    close: vi.fn(),
  };
  return ctx;
}

const tool = (id: string) => githubTools.find((t) => t.id === id)!;

async function signIn() {
  const store = createMemoryStore();
  setSecureStore(store);
  await store.set(
    'github.session',
    JSON.stringify({ kind: 'pat', accessToken: TOKEN, user: { id: 1, login: 'octo', name: 'Octo Cat', avatarUrl: '', htmlUrl: 'https://github.com/octo' } }),
  );
}

async function linkedProject() {
  const sha = await gitBlobSha1(encodeUtf8('<p>old</p>'));
  return makeProject('site', 'web', { 'index.html': textFile('<p>new</p>'), '.env': textFile('KEY=1') }, {
    github: { owner: 'octo', repo: 'site', branch: 'main', baseCommit: 'c1', baseTree: { 'index.html': sha } },
  });
}

let root: HTMLElement;
let cleanup: void | (() => void);

beforeEach(() => {
  root = document.createElement('div');
  document.body.append(root);
  // No real network: every request fails fast.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"message":"Not Found"}', { status: 404 })));
});

afterEach(() => {
  if (cleanup) cleanup();
  cleanup = undefined;
  root.remove();
  setSecureStore(null);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('GitHub tools in the DOM', () => {
  it('exports three tools with ids, icons and project needs', () => {
    expect(githubTools.map((t) => [t.id, t.icon, !!t.needsProject])).toEqual([
      ['github-account', 'user', false],
      ['github-clone', 'download', false],
      ['github-sync', 'branch', true],
    ]);
  });

  it('Account shows the signed-in user and the Keychain note, never the token', async () => {
    await signIn();
    const ctx = fakeCtx(null);
    cleanup = tool('github-account').mount(root, ctx);
    await vi.waitFor(() => expect(root.textContent).toContain('@octo'));
    expect(root.textContent).toContain('Octo Cat');
    expect(root.textContent).toContain('Связке ключей');
    expect(root.innerHTML).not.toContain(TOKEN);
  });

  it('Account runs the device flow: big code, copy + open GitHub, countdown, cancel', async () => {
    vi.stubEnv('VITE_GITHUB_CLIENT_ID', 'Iv1.test');
    setSecureStore(createMemoryStore());
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, onLine: true, clipboard: { writeText } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('/login/device/code')
          ? new Response(JSON.stringify({ device_code: 'dc', user_code: 'WDJB-MJHT', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }), {
              status: 200,
            })
          : new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 200 }),
      ),
    );
    const ctx = fakeCtx(null);
    cleanup = tool('github-account').mount(root, ctx);
    await vi.waitFor(() => expect(root.querySelector('[data-device]')).not.toBeNull());
    root.querySelector<HTMLButtonElement>('[data-device]')!.click();
    await vi.waitFor(() => expect(root.querySelector('.gh-code')?.textContent).toBe('WDJB-MJHT'));
    expect(root.querySelector('[data-left]')!.textContent).toMatch(/1[45]:\d\d/);
    root.querySelector<HTMLButtonElement>('[data-open]')!.click();
    await vi.waitFor(() => expect(ctx.openExternal).toHaveBeenCalledWith('https://github.com/login/device'));
    expect(writeText).toHaveBeenCalledWith('WDJB-MJHT');
    root.querySelector<HTMLButtonElement>('[data-cancel]')!.click();
    expect(root.querySelector('[data-device]')).not.toBeNull();
  });

  it('Account offers the token path when signed out (no client id in this build)', async () => {
    vi.stubEnv('VITE_GITHUB_CLIENT_ID', '');
    setSecureStore(createMemoryStore());
    const ctx = fakeCtx(null);
    cleanup = tool('github-account').mount(root, ctx);
    await vi.waitFor(() => expect(root.querySelector('[data-pat]')).not.toBeNull());
    expect(root.querySelector('[data-device]')).toBeNull();
    (root.querySelector('[data-pat]') as HTMLButtonElement).click();
    const input = root.querySelector<HTMLInputElement>('#gh-pat')!;
    expect(input.type).toBe('password');
    expect(root.textContent).toContain('Contents — Read and write');
  });

  it('Source control lists local changes with badges, keeps secrets unchecked and never renders the token', async () => {
    await signIn();
    const ctx = fakeCtx(await linkedProject());
    cleanup = tool('github-sync').mount(root, ctx);
    await vi.waitFor(() => expect(root.querySelector('[data-open="index.html"]')).not.toBeNull());
    expect(root.querySelector('.gh-repo')!.textContent).toBe('octo/site');
    expect(root.querySelector('[data-open="index.html"] .gh-st')!.textContent).toBe('M');
    expect(root.querySelector('[data-open=".env"] .gh-st')!.textContent).toBe('A');
    expect(root.querySelector<HTMLInputElement>('[data-sel=".env"]')!.checked).toBe(false);
    expect(root.querySelector<HTMLInputElement>('#gh-msg')!.value).toBe('Update index.html');
    expect(root.querySelector<HTMLButtonElement>('[data-push]')!.disabled).toBe(false);

    // Checking the secret blocks Commit & Push until confirmed.
    const env = root.querySelector<HTMLInputElement>('[data-sel=".env"]')!;
    env.checked = true;
    env.dispatchEvent(new Event('change', { bubbles: true }));
    expect(root.querySelector<HTMLButtonElement>('[data-push]')!.disabled).toBe(true);
    const confirm = root.querySelector<HTMLInputElement>('[data-confirm]')!;
    confirm.checked = true;
    confirm.dispatchEvent(new Event('change', { bubbles: true }));
    expect(root.querySelector<HTMLButtonElement>('[data-push]')!.disabled).toBe(false);
    expect(root.innerHTML).not.toContain(TOKEN);
  });

  it('New branch from the base commit, then a pull request into the default branch', async () => {
    await signIn();
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ method, path: url.pathname, body });
        const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
        if (url.pathname === '/repos/octo/site') return json({ name: 'site', full_name: 'octo/site', default_branch: 'main', private: true, owner: { login: 'octo' } });
        if (url.pathname === '/repos/octo/site/git/refs' && method === 'POST') return json({ ref: body.ref }, 201);
        if (url.pathname === '/repos/octo/site/pulls' && method === 'GET') return json([]);
        if (url.pathname === '/repos/octo/site/pulls' && method === 'POST') return json({ number: 3, html_url: 'https://github.com/octo/site/pull/3', title: body.title, state: 'open' }, 201);
        return json({ message: 'Not Found' }, 404);
      }),
    );
    const ctx = fakeCtx(await linkedProject());
    (ctx.prompt as ReturnType<typeof vi.fn>).mockResolvedValue('feature/hero');
    cleanup = tool('github-sync').mount(root, ctx);
    await vi.waitFor(() => expect(root.querySelector('[data-newbranch]')).not.toBeNull());
    root.querySelector<HTMLButtonElement>('[data-newbranch]')!.click();
    await vi.waitFor(() => expect(ctx.project()!.github!.branch).toBe('feature/hero'));
    expect(calls.find((c) => c.path.endsWith('/git/refs'))!.body).toEqual({ ref: 'refs/heads/feature/hero', sha: 'c1' });

    await vi.waitFor(() => expect(root.querySelector('[data-pr]')).not.toBeNull());
    root.querySelector<HTMLButtonElement>('[data-pr]')!.click();
    await vi.waitFor(() => expect(root.querySelector('#pr-title')).not.toBeNull());
    expect(root.textContent).toContain('feature/hero → main');
    root.querySelector<HTMLInputElement>('#pr-title')!.value = 'New hero';
    root.querySelector<HTMLFormElement>('[data-form]')!.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await vi.waitFor(() => expect(root.querySelector('[data-open]')).not.toBeNull());
    expect(calls.find((c) => c.method === 'POST' && c.path.endsWith('/pulls'))!.body).toMatchObject({ title: 'New hero', head: 'feature/hero', base: 'main' });
    root.querySelector<HTMLButtonElement>('[data-open]')!.click();
    expect(ctx.openExternal).toHaveBeenCalledWith('https://github.com/octo/site/pull/3');
  });

  it('Source control offline: shows changes, disables network actions and explains', async () => {
    await signIn();
    vi.stubGlobal('navigator', { ...navigator, onLine: false });
    const ctx = fakeCtx(await linkedProject());
    cleanup = tool('github-sync').mount(root, ctx);
    await vi.waitFor(() => expect(root.querySelector('[data-open="index.html"]')).not.toBeNull());
    expect(root.querySelector<HTMLButtonElement>('[data-pull]')!.disabled).toBe(true);
    expect(root.querySelector<HTMLButtonElement>('[data-push]')!.disabled).toBe(true);
    expect(root.textContent).toContain('Нет подключения к интернету');
  });

  it('Source control for an unlinked project offers create / link, disabled when signed out', async () => {
    setSecureStore(createMemoryStore());
    const ctx = fakeCtx(makeProject('Мой сайт', 'web', { 'index.html': textFile('x') }));
    cleanup = tool('github-sync').mount(root, ctx);
    await vi.waitFor(() => expect(root.querySelector('[data-create]')).not.toBeNull());
    expect(root.querySelector<HTMLButtonElement>('[data-create]')!.disabled).toBe(true);
    expect(root.querySelector('[data-signin]')).not.toBeNull();
  });

  it('Create repository prefills a valid name and validates it', async () => {
    await signIn();
    const ctx = fakeCtx(makeProject('Мой сайт', 'web', { 'index.html': textFile('x') }));
    cleanup = tool('github-sync').mount(root, ctx);
    await vi.waitFor(() => expect(root.querySelector<HTMLButtonElement>('[data-create]')?.disabled).toBe(false));
    root.querySelector<HTMLButtonElement>('[data-create]')!.click();
    await vi.waitFor(() => expect(root.querySelector('#gh-name')).not.toBeNull());
    const name = root.querySelector<HTMLInputElement>('#gh-name')!;
    expect(name.value).toBe('moy-sayt');
    expect(root.querySelector<HTMLInputElement>('[data-private]')!.checked).toBe(true);
    name.value = 'bad name';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    expect(root.querySelector('#gh-name-error')!.textContent).toContain('латинские');
    expect(root.querySelector<HTMLButtonElement>('[data-submit]')!.disabled).toBe(true);
  });

  it('Clone works signed out: link field plus the account inline; bad links are explained', async () => {
    setSecureStore(createMemoryStore());
    const ctx = fakeCtx(null);
    cleanup = tool('github-clone').mount(root, ctx);
    await vi.waitFor(() => expect(root.querySelector('#gh-url')).not.toBeNull());
    expect(root.querySelector('[data-pat]')).not.toBeNull();
    root.querySelector<HTMLInputElement>('#gh-url')!.value = 'https://gitlab.com/a/b';
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(root.querySelector('#gh-url-error')!.textContent).not.toBe('');
  });
});
