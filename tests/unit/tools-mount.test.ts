// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOOLS } from '../../src/tools';
import { createFakeContext } from '../../src/tools/dev/fake-context';
import { LIBRARIES } from '../../src/tools/libraries/catalog';
import { textFile } from '../../src/core/types';

/** Mounts every tool with an in-memory ToolContext (DOM-level smoke tests; the Playwright suite covers real browsers). */

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div><div id="sheet-root"></div><div id="toast"></div>';
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mount(id: string, opts: Parameters<typeof createFakeContext>[0] = {}) {
  const tool = TOOLS.find((t) => t.id === id)!;
  const root = document.createElement('div');
  document.getElementById('app')!.append(root);
  const fake = createFakeContext(opts);
  const cleanup = tool.mount(root, fake.ctx);
  return { root, ...fake, cleanup: cleanup || (() => undefined) };
}

describe('every tool', () => {
  it('mounts with and without a project and cleans up', () => {
    for (const tool of TOOLS) {
      for (const project of [undefined, null]) {
        if (project === null && tool.needsProject) continue;
        const m = mount(tool.id, { project });
        expect(m.root.innerHTML.length, tool.id).toBeGreaterThan(100);
        expect(m.root.querySelectorAll('button').length, tool.id).toBeGreaterThan(0);
        // Every form control has an accessible name.
        for (const el of m.root.querySelectorAll<HTMLElement>(':not(.tool-md-article *):is(input:not([type="hidden"]), select, textarea)')) {
          const named = el.getAttribute('aria-label') || el.id && m.root.querySelector(`label[for="${el.id}"]`) || el.closest('label');
          expect(named, `${tool.id}: ${el.outerHTML.slice(0, 80)}`).toBeTruthy();
        }
        m.cleanup();
        expect(m.root.innerHTML, tool.id).toBe('');
      }
    }
  });
});

describe('JSON tool', () => {
  it('opens the active JSON file, validates, formats and saves', async () => {
    const m = mount('json', { activeFile: 'data.json' });
    await flush();
    const area = m.root.querySelector('textarea')!;
    expect(area.value).toContain('"Codevia"');
    expect(m.root.querySelector('[data-status]')!.className).toContain('ok');
    area.value = '{"b":1,"a":2}';
    area.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    // Sorting lives in the "more" menu (a sheet).
    if (!document.getElementById('sheet-root')) document.body.insertAdjacentHTML('beforeend', '<div id="sheet-root"></div>');
    (m.root.querySelector('[data-act="more"]') as HTMLElement).click();
    await flush();
    (document.querySelector('.menu-item[data-id="sort"]') as HTMLElement).click();
    await flush();
    expect(area.value).toBe('{\n  "a": 2,\n  "b": 1\n}');
    (m.root.querySelector('[data-act="save"]') as HTMLElement).click();
    await flush();
    expect(m.log.writes[0]!.files).toEqual(['data.json']);
    area.value = '{"a": }';
    area.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    expect(m.root.querySelector('[data-status]')!.textContent).toContain('Строка 1, столбец 7');
    m.cleanup();
  });
});

describe('Libraries tool', () => {
  it('adds and removes Bootstrap with snapshots', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (String(url).endsWith('index.json') ? new Response('{"libraries":[],"total":0}') : new Response(`/* ${url} */`))));
    const m = mount('libraries', { confirm: async () => true });
    const card = () => m.root.querySelector('[data-lib="bootstrap"]')!;
    (card().querySelector('[data-act="add"]') as HTMLElement).click();
    await vi.waitFor(() => expect(m.log.writes).toHaveLength(1));
    expect(m.log.writes[0]).toMatchObject({ snapshotLabel: 'Перед добавлением Bootstrap' });
    const files = m.project()!.files;
    expect(Object.keys(files)).toEqual(expect.arrayContaining(['libs/bootstrap/bootstrap.min.css', 'libs/bootstrap/bootstrap.bundle.min.js']));
    expect((files['index.html'] as { content: string }).content).toContain('<link rel="stylesheet" href="libs/bootstrap/bootstrap.min.css">');
    await vi.waitFor(() => expect(card().querySelector('[data-act="remove"]')).not.toBeNull());
    (card().querySelector('[data-act="remove"]') as HTMLElement).click();
    await vi.waitFor(() => expect(m.log.writes).toHaveLength(2));
    expect(m.log.writes[1]!.remove.sort()).toEqual(['libs/bootstrap/bootstrap.bundle.min.js', 'libs/bootstrap/bootstrap.min.css']);
    expect((m.project()!.files['index.html'] as { content: string }).content).not.toContain('bootstrap');
    expect(LIBRARIES.length).toBe(m.root.querySelectorAll('.tool-lib-card').length);
    m.cleanup();
  });
});

describe('Colour tool', () => {
  it('syncs formats, scans project colours and replaces one everywhere', async () => {
    const m = mount('color', { confirm: async () => true });
    const hex = m.root.querySelector<HTMLInputElement>('[data-field="hex"]')!;
    hex.value = '#ff0000';
    hex.dispatchEvent(new Event('input', { bubbles: true }));
    expect(m.root.querySelector<HTMLInputElement>('[data-field="rgb"]')!.value).toBe('rgb(255, 0, 0)');
    expect(m.root.querySelector<HTMLInputElement>('[data-field="hsl"]')!.value).toBe('hsl(0, 100%, 50%)');
    expect(m.root.querySelector<HTMLInputElement>('[data-field="name"]')!.value).toBe('red');
    (m.root.querySelector('[data-act="scan"]') as HTMLElement).click();
    const chips = [...m.root.querySelectorAll<HTMLElement>('[data-use-i]')];
    const brand = chips.find((c) => c.textContent!.includes('#40c8f6'))!;
    expect(brand.querySelector('.tool-count-badge')!.textContent).toBe('2');
    brand.click();
    hex.value = '#00ff00';
    hex.dispatchEvent(new Event('input', { bubbles: true }));
    (m.root.querySelector('[data-act="replace"]') as HTMLElement).click();
    await vi.waitFor(() => expect(m.log.writes).toHaveLength(1));
    expect(m.log.writes[0]!.snapshotLabel).toBe('Перед заменой цвета #40c8f6');
    expect((m.project()!.files['style.css'] as { content: string }).content).toContain('a { color: #00ff00; }');
    expect((m.project()!.files['index.html'] as { content: string }).content).toContain('color: #00ff00');
    m.cleanup();
  });
});

describe('Markdown tool', () => {
  it('renders README, opens relative Markdown links and external links outside', async () => {
    const m = mount('markdown');
    const article = m.root.querySelector('[data-article]')!;
    expect(article.querySelector('h1')!.textContent).toBe('Sample project');
    expect(article.querySelector('img')!.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    (article.querySelector('a[href="https://example.com"]') as HTMLElement).click();
    expect(m.log.external).toEqual(['https://example.com']);
    (article.querySelector('a[href="docs/guide.md"]') as HTMLElement).click();
    expect(article.querySelector('h1')!.textContent).toBe('Guide');
    // Edits in the editor show up live.
    await m.ctx.writeFiles({ 'docs/guide.md': textFile('# Changed') });
    await vi.waitFor(() => expect(article.querySelector('h1')!.textContent).toBe('Changed'), { timeout: 2500 });
    m.cleanup();
  });
});

describe('HTTP tool', () => {
  it('sends a request through fetch and shows the JSON response', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{"hello":"world"}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const m = mount('http');
    const url = m.root.querySelector<HTMLInputElement>('[data-url]')!;
    url.value = 'https://api.test/x?a=1';
    url.dispatchEvent(new Event('input', { bubbles: true }));
    m.root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(m.root.querySelector('.tool-status-pill')).not.toBeNull());
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.test/x?a=1');
    expect(m.root.querySelector('.tool-status-pill')!.className).toContain('ok');
    expect(m.root.querySelector('.tool-jt-tree')!.textContent).toContain('"world"');
    // The query moved into the params editor.
    expect(url.value).toBe('https://api.test/x');
    m.cleanup();
  });
});
