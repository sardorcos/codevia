import { expect, test, type Page } from '@playwright/test';

/**
 * The inspector agent inside the real preview iframe (sandboxed, opaque origin), driven from the app page
 * through postMessage exactly like the app's bridge will (token from the frame, answers via parent.postMessage).
 */

type Msg = { type: string; [k: string]: unknown };

async function openPortfolioPreview(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Начать с примеров' }).click();
  await page.locator('.row-button', { hasText: 'Сайт-портфолио' }).click();
  await page.locator('.nav-item', { hasText: 'Просмотр' }).click();
  const frame = page.frameLocator('#live-preview');
  await expect(frame.getByRole('heading', { name: 'Идеи становятся продуктами.' })).toBeVisible();
  // The token is in the shim script of the previewed document.
  const token = await frame.locator('head script').first().evaluate((s) => /var T="([^"]+)"/.exec(s.textContent ?? '')?.[1] ?? '');
  expect(token).not.toBe('');
  await page.evaluate((tok) => {
    const w = window as unknown as { __insp: Msg[]; __send(m: Record<string, unknown>): void };
    w.__insp = [];
    addEventListener('message', (e) => {
      const d = e.data as Msg | null;
      if (d && typeof d.type === 'string' && d.type.startsWith('inspect:')) w.__insp.push(d);
    });
    w.__send = (m) => document.querySelector<HTMLIFrameElement>('#live-preview')!.contentWindow!.postMessage({ ...m, token: tok }, '*');
  }, token);
  return frame;
}

const send = (page: Page, m: Record<string, unknown>) => page.evaluate((msg) => (window as unknown as { __send(m: unknown): void }).__send(msg), m);
const waitFor = async (page: Page, type: string, pred: (m: Msg) => boolean = () => true): Promise<Msg> => {
  let hit: Msg | undefined;
  await expect
    .poll(async () => {
      const all = await page.evaluate(() => (window as unknown as { __insp: Msg[] }).__insp);
      hit = all.filter((m) => m.type === type).reverse().find(pred);
      return !!hit;
    })
    .toBe(true);
  return hit!;
};

test('inspector agent: tree, styles with source file, overlay, network log and pick by tap', async ({ page }) => {
  page.on('pageerror', (e) => {
    throw e;
  });
  const frame = await openPortfolioPreview(page);
  await send(page, { type: 'inspect:enable' });
  await waitFor(page, 'inspect:enabled');

  await send(page, { type: 'inspect:query', rid: 1, selector: 'h1' });
  const q = await waitFor(page, 'inspect:query', (m) => m.rid === 1);
  const h1 = (q.results as { id: number; label: string }[])[0]!;
  expect(h1.label).toBe('h1');

  await send(page, { type: 'inspect:tree', rid: 2, reveal: h1.id });
  const tree = await waitFor(page, 'inspect:tree', (m) => m.rid === 2);
  expect((tree.path as { label: string }[]).map((c) => c.label).slice(0, 2)).toEqual(['html', 'body']);

  await send(page, { type: 'inspect:select', id: h1.id });
  const sel = await waitFor(page, 'inspect:selected', (m) => m.id === h1.id);
  expect((sel.box as { width: number }).width).toBeGreaterThan(0);
  // The overlay sits in the page, above everything, and never takes taps.
  const overlay = frame.locator('[data-codevia-inspector]');
  await expect(overlay).toHaveCount(1);
  expect(await overlay.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');

  await send(page, { type: 'inspect:styles', rid: 3, id: h1.id });
  const styles = await waitFor(page, 'inspect:styles', (m) => m.rid === 3);
  const rules = styles.rules as { selector: string; src: string; decls: { name: string; value: string }[] }[];
  const h1Rule = rules.find((r) => r.selector === 'h1')!;
  expect(h1Rule.src).toBe('css/styles.css');
  expect(h1Rule.decls.map((d) => d.name)).toContain('letter-spacing');
  expect((styles.computed as [string, string][]).find(([k]) => k === 'letter-spacing')?.[1]).toBe('-2px');

  // Live edit (not saved).
  await send(page, { type: 'inspect:edit-style', rid: 4, id: h1.id, prop: 'color', value: 'rgb(255, 0, 0)' });
  await waitFor(page, 'inspect:edited', (m) => m.rid === 4 && m.ok === true);
  expect(await frame.locator('h1').evaluate((el) => getComputedStyle(el).color)).toBe('rgb(255, 0, 0)');

  // Pick mode: tapping the button highlights it and does not run the page handler.
  await send(page, { type: 'inspect:pick', on: true });
  await waitFor(page, 'inspect:pick', (m) => m.on === true);
  await frame.locator('#contact').click();
  const picked = await waitFor(page, 'inspect:picked');
  expect((picked.path as { label: string }[]).at(-1)!.label).toBe('button#contact.action');
  await waitFor(page, 'inspect:pick', (m) => m.on === false);
  await expect(frame.locator('#tagline')).toHaveText('Создаём сайты и приложения.');

  // Outside pick mode the page works as before, and its fetch() of a project file is logged.
  await page.waitForTimeout(600);
  await frame.locator('#contact').click();
  await expect(frame.locator('#tagline')).toHaveText('Мы скоро свяжемся с вами.');
  const done = await waitFor(page, 'inspect:network', (m) => (m.entry as { pending: boolean; url: string }).url === 'data/project.json' && !(m.entry as { pending: boolean }).pending);
  expect(done.entry).toMatchObject({ kind: 'fetch', source: 'project', path: 'data/project.json', status: 200, type: 'json' });
  await send(page, { type: 'inspect:network-all', rid: 5 });
  const all = await waitFor(page, 'inspect:network-all', (m) => m.rid === 5);
  expect((all.entries as { url: string }[]).some((e) => e.url === 'data/project.json')).toBe(true);

  // DOM changes are reported while enabled.
  await waitFor(page, 'inspect:dom-changed');

  await send(page, { type: 'inspect:disable' });
  await expect(overlay).toHaveCount(0);
});
