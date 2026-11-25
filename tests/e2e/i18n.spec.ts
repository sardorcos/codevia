import { expect, test } from '@playwright/test';

const CYRILLIC = /[А-Яа-яЁё]/;

test('the configured Russian system language reaches the page', async ({ page }) => {
  await page.goto('/');
  expect(await page.evaluate(() => navigator.language)).toBe('ru-RU');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  await expect(page.getByRole('heading', { name: 'Код в кармане' })).toBeVisible();
});

test.describe('English', () => {
  // The other specs run with a Russian system language (playwright.config.ts); these check English.
  test.use({ locale: 'en-US' });

  test('home is in English, a new project can be created and opened', async ({ page }) => {
    page.on('pageerror', (e) => {
      throw e;
    });
    await page.goto('/');
    expect(await page.evaluate(() => navigator.language)).toBe('en-US');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('heading', { name: 'Code in your pocket' })).toBeVisible();
    await page.getByRole('button', { name: 'Start from scratch' }).click();

    await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Import', exact: true })).toBeVisible();
    expect(await page.locator('#app').innerText()).not.toMatch(CYRILLIC);

    await page.getByRole('button', { name: 'New', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'New project' })).toBeVisible();
    await page.getByLabel('Name').fill('Hello site');
    await page.getByRole('button', { name: 'Create project' }).click();

    // The website template opens in Preview, with its sample page in English.
    await expect(page.locator('.project-title')).toContainText('Hello site');
    await expect(page.locator('.nav-item[aria-current="page"]')).toHaveText('Preview');
    await expect(page.frameLocator('#live-preview').getByRole('heading', { name: 'Ideas become products.' })).toBeVisible();

    await page.locator('.nav-item', { hasText: 'Files' }).click();
    await expect(page.locator('.pane-foot')).toContainText('7 files');
    expect(await page.locator('#app').innerText()).not.toMatch(CYRILLIC);

    await page.getByRole('button', { name: 'Back to projects' }).click();
    await expect(page.getByRole('heading', { name: 'Continue' })).toBeVisible();
    await page.locator('.row-button', { hasText: 'Hello site' }).click();
    await expect(page.locator('.project-title')).toContainText('Hello site');
    await page.locator('.row-button', { hasText: 'index.html' }).click();
    await expect(page.locator('#save-state')).toHaveText(/Saved/);
  });

  test('?lang=ru overrides an English system language', async ({ page }) => {
    await page.goto('/?e2e=1&lang=ru');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
    await expect(page.getByRole('heading', { name: 'Код в кармане' })).toBeVisible();
  });
});
