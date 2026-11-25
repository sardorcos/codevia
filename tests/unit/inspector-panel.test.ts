// @vitest-environment jsdom
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildPreview } from '../../src/core/preview';
import { textFile, type Files, type Project } from '../../src/core/types';
import { createInspectorTool } from '../../src/tools/inspector';
import { InspectorPanel } from '../../src/tools/inspector/panel';
import type { InspectorBridge, InspectorRequest, PreviewMessage } from '../../src/tools/inspector/protocol';
import type { ToolContext } from '../../src/tools/types';

const PAGE = `<!doctype html><html><head><title>Demo</title><link rel="stylesheet" href="css/styles.css"></head>
<body><main id="main"><h1 class="title">Hello <b>world</b></h1><div class="card">Card</div></main>
<script>console.log('page ready', 42)</script></body></html>`;
const CSS = `body { margin: 0 }

.card {
  color: red;
}
#main .card { padding: 4px }`;

const files = (): Files => ({ 'index.html': textFile(PAGE), 'css/styles.css': textFile(CSS), 'data.json': textFile('{"a":[1,2]}') });

/** A preview page in jsdom wired to a bridge exactly like the app will do it (token added on send, checked on receive). */
function setup(opts: { connected?: boolean } = {}) {
  const f = files();
  const { html } = buildPreview(f, 'index.html', (f['index.html'] as { content: string }).content, { allowNetwork: false, token: 'tok' });
  const handlers = new Set<(m: PreviewMessage) => void>();
  const sent: InspectorRequest[] = [];
  const picks: boolean[] = [];
  const deliver = (m: Record<string, unknown>) => {
    if (m.token !== 'tok') return;
    if (typeof m.type === 'string' && (m.type.startsWith('inspect:') || m.type === 'console')) for (const h of handlers) h(m as unknown as PreviewMessage);
  };
  let page: JSDOM | null = null;
  const bridge: InspectorBridge = {
    send(msg) {
      sent.push(msg);
      if (page && opts.connected !== false) page.window.dispatchEvent(new page.window.MessageEvent('message', { data: { ...msg, token: 'tok' } }));
    },
    onMessage(h) {
      handlers.add(h);
      return () => handlers.delete(h);
    },
    consoleHistory: () => [{ level: 'info', text: 'earlier line\n' }],
    onPickChange: (on) => picks.push(on),
  };
  page = new JSDOM(html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, ''), {
    runScripts: 'dangerously',
    url: 'https://host.test/preview-host.html',
    beforeParse(w) {
      Object.defineProperty(w, 'parent', { value: { postMessage: (m: Record<string, unknown>) => deliver(structuredClone(m)) } });
      const g = w as unknown as Record<string, unknown>;
      g.Response = Response;
      g.Headers = Headers;
      g.fetch = () => Promise.reject(new TypeError('offline'));
    },
  });
  const project = { files: f } as unknown as Project;
  const ctx = {
    project: () => project,
    activeFile: () => null,
    openFile: vi.fn(),
    toast: vi.fn(),
    haptic: vi.fn(),
    close: vi.fn(),
  } as unknown as ToolContext & { openFile: ReturnType<typeof vi.fn>; toast: ReturnType<typeof vi.fn> };
  const root = document.createElement('div');
  document.body.append(root);
  const tool = createInspectorTool(bridge);
  const cleanup = tool.mount(root, ctx) as () => void;
  const pw = page.window as unknown as Window & typeof globalThis;
  return { tool, root, ctx, sent, picks, cleanup, page, pw, handlers };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const $ = (root: HTMLElement, sel: string) => root.querySelector<HTMLElement>(sel);
const rowByText = (root: HTMLElement, text: string) =>
  [...root.querySelectorAll<HTMLElement>('.insp-node')].find((b) => b.textContent?.includes(text)) ?? null;

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('inspector tool', () => {
  it('is a project tool with the inspector id', () => {
    const tool = createInspectorTool({ send() {}, onMessage: () => () => undefined });
    expect(tool).toMatchObject({ id: 'inspector', needsProject: true, title: 'Инспектор' });
  });

  it('enables the agent, renders the DOM tree and disables on cleanup', async () => {
    const { root, sent, cleanup, handlers } = setup();
    await tick();
    expect(sent[0]).toEqual({ type: 'inspect:enable' });
    expect([...root.querySelectorAll('.insp-tab')].map((b) => b.textContent)).toEqual(['Элементы', 'Стили', 'Сеть', 'Консоль']);
    expect(rowByText(root, '<html')).not.toBeNull();
    expect(rowByText(root, '<body')).not.toBeNull();
    expect(rowByText(root, '<main id="main">')).not.toBeNull();
    // html and body are expanded; main is collapsed until tapped.
    expect(rowByText(root, '<h1')).toBeNull();
    cleanup();
    expect(sent.at(-1)).toEqual({ type: 'inspect:disable' });
    expect(handlers.size).toBe(0);
    expect(root.children).toHaveLength(0);
  });

  it('expands nodes lazily and selects with a tap: highlight, breadcrumb and styles with the source line', async () => {
    const { root, sent, ctx, page } = setup();
    await tick();
    const main = rowByText(root, '<main id="main">')!;
    (main.previousElementSibling as HTMLElement).click(); // twisty
    await tick();
    expect(rowByText(root, '<h1 class="title">')).not.toBeNull();
    rowByText(root, '<div class="card">')!.click();
    await tick();
    expect(sent.some((m) => m.type === 'inspect:select')).toBe(true);
    expect(page.window.document.querySelector('[data-codevia-inspector]')).not.toBeNull();
    // Narrow panel: the Styles tab opens.
    expect(root.querySelector('.insp')!.getAttribute('data-tab')).toBe('styles');
    expect([...root.querySelectorAll('[data-slot="crumbs-styles"] .insp-crumb')].map((c) => c.textContent)).toEqual(['html', 'body', 'main#main', 'div.card']);
    const selectors = [...root.querySelectorAll('.insp-selector')].map((s) => s.textContent);
    expect(selectors).toEqual(['element.style', '#main .card', '.card']);
    const src = [...root.querySelectorAll<HTMLElement>('.insp-src')].map((b) => b.textContent);
    expect(src).toEqual(['css/styles.css:6', 'css/styles.css:3']);
    root.querySelectorAll<HTMLElement>('.insp-src')[1]!.click();
    expect(ctx.openFile).toHaveBeenCalledWith('css/styles.css', 3);
    expect($(root, '.insp-box')).not.toBeNull();
    expect(root.querySelector('.insp-computed')!.textContent).toContain('display');
    expect(root.querySelector('[data-act="edit-attr"]')!.textContent).toBe('class="card"');
  });

  it('edits a declaration inline as a live experiment and copies the rule', async () => {
    const { root, page } = setup();
    await tick();
    const panel = root.querySelector('.insp')!;
    expect(panel).not.toBeNull();
    const q = root.querySelector<HTMLInputElement>('input[name="selector"]')!;
    q.value = '.card';
    q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick();
    expect(root.querySelector('.insp-query')!.textContent).toContain('Найдено: 1');
    root.querySelector<HTMLElement>('.insp-result')!.click();
    await tick();
    root.querySelector<HTMLElement>('[data-act="add-decl"][data-target="inline"]')!.click();
    const input = root.querySelector<HTMLInputElement>('.insp-edit')!;
    input.value = 'background: yellow';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick();
    const card = page.window.document.querySelector<HTMLElement>('.card')!;
    expect(card.style.background).toContain('yellow');
    expect(root.querySelector('.insp-decls')!.textContent).toContain('background: yellow');
    // Edit the value of a rule declaration.
    const decl = [...root.querySelectorAll<HTMLElement>('[data-act="edit-decl"]')].find((b) => b.dataset.target?.startsWith('rule:') && b.dataset.name === 'color')!;
    decl.click();
    const edit = root.querySelector<HTMLInputElement>('.insp-edit')!;
    expect(edit.value).toBe('color: red');
    edit.value = 'color: teal !important';
    edit.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick();
    const rule = [...page.window.document.styleSheets[0]!.cssRules].find((r) => (r as CSSStyleRule).selectorText === '.card') as CSSStyleRule;
    expect(rule.style.getPropertyValue('color')).toBe('teal');
    expect(rule.style.getPropertyPriority('color')).toBe('important');
  });

  it('copies CSS rules and parses inline edits', async () => {
    const { root, ctx } = setup();
    await tick();
    const q = root.querySelector<HTMLInputElement>('input[name="selector"]')!;
    q.value = '.card';
    q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick();
    root.querySelector<HTMLElement>('.insp-result')!.click();
    await tick();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    root.querySelectorAll<HTMLElement>('[data-act="copy-rule"]')[1]!.click();
    await tick();
    expect(writeText).toHaveBeenLastCalledWith('.card {\n  color: red;\n}');
    expect(ctx.toast).toHaveBeenLastCalledWith('Правило CSS скопировано', 'success');
    root.querySelector<HTMLElement>('[data-act="copy-inline"]')!.click();
    await tick();
    expect(writeText).toHaveBeenLastCalledWith('div.card {\n}');
    expect(InspectorPanel.parseDecl('Color : Red !important;')).toEqual({ name: 'color', value: 'Red', important: true });
    expect(InspectorPanel.parseDecl('--Brand: #fff')).toEqual({ name: '--Brand', value: '#fff', important: false });
    expect(InspectorPanel.parseAttr('data-x="a b"')).toEqual({ name: 'data-x', value: 'a b' });
    expect(InspectorPanel.parseAttr('hidden')).toEqual({ name: 'hidden', value: '' });
  });

  it('picks an element in the page and shows it', async () => {
    const { root, page, pw, picks } = setup();
    await tick();
    root.querySelector<HTMLElement>('[data-act="pick"]')!.click();
    await tick();
    expect(root.querySelector('[data-act="pick"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(picks).toEqual([true]);
    page.window.document.querySelector('b')!.dispatchEvent(new pw.MouseEvent('click', { bubbles: true, cancelable: true }));
    await tick();
    await tick();
    expect(root.querySelector('[data-act="pick"]')!.getAttribute('aria-pressed')).toBe('false');
    expect(picks).toEqual([true, false]);
    expect([...root.querySelectorAll('[data-slot="crumbs-elements"] .insp-crumb')].map((c) => c.textContent)).toEqual(['html', 'body', 'main#main', 'h1.title', 'b']);
    // The picked node is revealed and selected in the tree.
    expect(root.querySelector('.insp-row.selected .insp-node')!.textContent).toContain('<b>');
  });

  it('lists network requests with details and a JSON preview', async () => {
    const { root, pw } = setup();
    await tick();
    await pw.fetch('data.json');
    await tick();
    root.querySelector<HTMLElement>('[data-tab="network"]')!.click();
    await tick();
    const row = root.querySelector<HTMLElement>('.insp-net-row')!;
    expect(row.querySelector('.n-status')!.textContent).toBe('200');
    expect(row.querySelector('.n-status')!.className).toContain('ok');
    expect(row.querySelector('.n-file')!.textContent).toContain('GET');
    expect(row.querySelector('.n-file')!.textContent).toContain('data.json');
    expect(row.querySelector('.n-size')!.textContent).toBe('11 Б');
    root.querySelector<HTMLElement>('[data-filter="image"]')!.click();
    await tick();
    expect(root.querySelector('.insp-net-row')).toBeNull();
    root.querySelector<HTMLElement>('[data-filter="fetch"]')!.click();
    await tick();
    root.querySelector<HTMLElement>('.insp-net-row')!.click();
    await tick();
    const detail = root.querySelector('.insp-detail')!;
    expect(detail.textContent).toContain('content-type');
    expect(detail.querySelector('.insp-pre')!.textContent).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}');
    root.querySelector<HTMLElement>('[data-act="net-back"]')!.click();
    root.querySelector<HTMLElement>('[data-act="net-clear"]')!.click();
    await tick();
    expect(root.querySelector('.insp-net-row')).toBeNull();
  });

  it('shows console history and forwarded console messages', async () => {
    const { root, handlers } = setup();
    await tick();
    for (const h of handlers) h({ type: 'console', level: 'warn', args: ['careful', '1'] });
    root.querySelector<HTMLElement>('[data-tab="console"]')!.click();
    await tick();
    const lines = [...root.querySelectorAll('.insp-console .console-line')].map((l) => [l.className, l.textContent]);
    expect(lines).toEqual([
      ['console-line info', 'earlier line\n'],
      ['console-line warn', 'careful 1\n'],
    ]);
  });

  it('re-enables itself when a new preview document says hello', async () => {
    const { root, sent, handlers } = setup();
    await tick();
    const before = sent.filter((m) => m.type === 'inspect:enable').length;
    for (const h of handlers) h({ type: 'inspect:hello', page: 'index.html' });
    await tick();
    expect(sent.filter((m) => m.type === 'inspect:enable').length).toBe(before + 1);
    expect(rowByText(root, '<html')).not.toBeNull();
  });

  it('explains when there is no preview to inspect', async () => {
    vi.useFakeTimers();
    const { root } = setup({ connected: false });
    expect(root.querySelector('.insp-empty')!.textContent).toBe('Подключение к предпросмотру…');
    vi.advanceTimersByTime(2500);
    expect(root.querySelector('.insp-empty')!.textContent).toBe('Откройте «Просмотр», чтобы исследовать страницу.');
  });
});
