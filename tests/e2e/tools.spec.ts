import { expect, test, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';

/**
 * Smoke tests of the tool panels, mounted standalone on the dev page tools.html with an in-memory
 * project (src/tools/dev/fake-context.ts). tools.html exists only in development, so these tests start
 * their own Vite dev server instead of using the preview of the production build.
 */

let server: ViteDevServer;
let base = '';

test.beforeAll(async () => {
  server = await createServer({ configFile: 'vite.config.ts', logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
  await server.listen();
  base = server.resolvedUrls!.local[0]!.replace(/\/$/, '');
});

test.afterAll(async () => {
  await server?.close();
});

test.use({ viewport: { width: 375, height: 760 } });

async function open(page: Page, query: string) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/tools.html?lang=en&${query}`);
  await expect(page.locator('[data-tool-host].tool-root')).toBeVisible();
  return errors;
}

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test('HTTP client sends a request and shows the JSON response', async ({ page }) => {
  await page.route('https://api.test/**', (route) =>
    route.fulfill({ status: 201, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ hello: 'world', list: [1, 2] }) }),
  );
  const errors = await open(page, 'tool=http');
  await page.getByLabel('Method').selectOption('POST');
  await page.getByLabel('URL').fill('https://api.test/items?a=1');
  await page.getByRole('tab', { name: /Body/ }).click();
  await page.getByRole('button', { name: 'JSON', exact: true }).click();
  await page.getByLabel('Request body').fill('{"name": "x"}');
  await expect(page.getByText('Valid JSON')).toBeVisible();
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('.tool-status-pill')).toHaveText(/^201/);
  await expect(page.locator('.tool-jt-tree')).toContainText('"world"');
  await page.getByRole('button', { name: /^Headers/ }).last().click();
  await expect(page.locator('.tool-headers')).toContainText('content-type');
  await noHorizontalScroll(page);
  expect(errors).toEqual([]);
});

test('JSON viewer validates, formats and shows a searchable tree', async ({ page }) => {
  const errors = await open(page, 'tool=json');
  const area = page.getByLabel('JSON text');
  await area.fill('{"a": 1,}');
  await expect(page.locator('[data-status]')).toContainText('Line 1, column 9');
  await area.fill('{"user": {"name": "Ann", "tags": ["x", "needle"]}}');
  await expect(page.locator('[data-status]')).toContainText('Valid JSON');
  await page.getByRole('button', { name: 'Format' }).click();
  await expect(area).toHaveValue(/\n {2}"user": \{/);
  await page.getByRole('button', { name: 'Tree' }).click();
  await page.getByLabel('Search keys and values').fill('needle');
  await expect(page.locator('.tool-jt-row.current mark')).toHaveText('needle');
  await page.locator('.tool-jt-row.current').click();
  await expect(page.locator('.tool-jt-path')).toHaveText('$.user.tags[1]');
  await noHorizontalScroll(page);
  expect(errors).toEqual([]);
});

test('Colour tool converts formats and picks a colour from a project image', async ({ page }) => {
  const errors = await open(page, 'tool=color');
  await page.getByLabel('HEX', { exact: true }).fill('#336699');
  await expect(page.getByLabel('RGB(A)', { exact: true })).toHaveValue('rgb(51, 102, 153)');
  await expect(page.getByLabel('HSL(A)', { exact: true })).toHaveValue('hsl(210, 50%, 40%)');
  await page.getByRole('button', { name: 'From project' }).click();
  await page.getByRole('button', { name: 'img/pixel.png' }).click();
  const canvas = page.locator('.tool-eye-canvas');
  await expect(canvas).toBeVisible();
  await canvas.scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  const box = (await canvas.boundingBox())!;
  // The 2×2 image is drawn at 8× in the middle: tap its top-left (red) pixel.
  await page.mouse.click(box.x + box.width / 2 - 4, box.y + box.height / 2 - 4);
  await expect(page.getByLabel('HEX', { exact: true })).toHaveValue('#ff0000');
  await page.getByRole('button', { name: 'Scan' }).click();
  await expect(page.locator('[data-usages] .tool-chip-swatch').first()).toBeVisible();
  await noHorizontalScroll(page);
  expect(errors).toEqual([]);
});

test('Markdown preview renders the README with an outline', async ({ page }) => {
  const errors = await open(page, 'tool=markdown');
  const article = page.locator('[data-article]');
  await expect(article.getByRole('heading', { level: 1 })).toHaveText('Sample project');
  await expect(article.locator('table td').first()).toHaveText('HTTP');
  await expect(article.locator('img')).toHaveAttribute('src', /^data:image\/png/);
  await page.getByRole('button', { name: 'Outline' }).click();
  await page.locator('[data-outline]').getByRole('link', { name: 'Table' }).click();
  await page.getByRole('button', { name: 'Light' }).click();
  await expect(article).toHaveAttribute('data-theme', 'light');
  await noHorizontalScroll(page);
  expect(errors).toEqual([]);
});

test('Libraries adds Bootstrap offline and removes it again', async ({ page }) => {
  const errors = await open(page, 'tool=libraries');
  const card = page.locator('[data-lib="bootstrap"]');
  await card.getByRole('button', { name: 'Add to project' }).click();
  await expect(card.getByText('Added')).toBeVisible();
  const writes = await page.evaluate(() => (window as unknown as { __toolLog: { writes: Array<{ files: string[]; snapshotLabel?: string }> } }).__toolLog.writes);
  expect(writes[0]!.snapshotLabel).toBe('Before adding Bootstrap');
  expect(writes[0]!.files).toEqual(expect.arrayContaining(['libs/bootstrap/bootstrap.min.css', 'index.html']));
  await card.getByRole('button', { name: 'Remove from project' }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Add to project' })).toBeVisible();
  await noHorizontalScroll(page);
  expect(errors).toEqual([]);
});
