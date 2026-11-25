import { expect, test, type Page } from '@playwright/test';

const mod = (page: Page) => (page.context().browser()?.browserType().name() === 'webkit' ? 'Meta' : 'Control');

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (e) => {
    throw e;
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Начать с примеров' }).click();
  await expect(page.getByRole('heading', { name: 'Проекты', exact: true })).toBeVisible();
});

test('iPad: files, code and preview side by side; the preview follows typing', async ({ page }) => {
  await page.locator('.row-button', { hasText: 'Сайт-портфолио' }).click();
  await expect(page.locator('.split')).toBeVisible();
  await expect(page.locator('.bottomnav')).toHaveCount(0);
  await expect(page.locator('.split-files .row-button', { hasText: 'index.html' })).toBeVisible();
  await expect(page.locator('.split-code .cm-content')).toBeVisible();
  const frame = page.frameLocator('#live-preview');
  await expect(frame.locator('h1')).toContainText('Идеи');

  await page.locator('.split-files .row-button', { hasText: 'index.html' }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.press(`${mod(page)}+a`);
  await page.keyboard.type('<h1>Live on iPad</h1>');
  await expect(frame.locator('h1')).toContainText('Live on iPad', { timeout: 10_000 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('iPad: Python project runs in the side pane; ⌘1–⌘4 and the side switch work', async ({ page }) => {
  await page.locator('.row-button', { hasText: 'Python' }).click();
  await expect(page.locator('.split-side #run-entry')).toHaveValue('main.py');
  await page.locator('.split-side').getByRole('button', { name: 'Запустить' }).click();
  await expect(page.locator('#run-console')).toContainText('Сумма заказов', { timeout: 60_000 });
  await page.locator('.side-switch button', { hasText: 'Просмотр' }).click();
  await expect(page.locator('.split-side .empty-state')).toBeVisible();
  await page.keyboard.press(`${mod(page)}+4`);
  await expect(page.locator('.split-side #run-console')).toBeVisible();
});
