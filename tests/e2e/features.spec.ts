import { expect, test, type Page } from '@playwright/test';

async function start(page: Page, query = '') {
  page.on('pageerror', (e) => {
    throw e;
  });
  await page.goto(`/${query}`);
  await page.getByRole('button', { name: 'Начать с примеров' }).click();
  await expect(page.getByRole('heading', { name: 'Проекты', exact: true })).toBeVisible();
}

async function openProject(page: Page, name: string) {
  await page.locator('.row-button', { hasText: name }).click();
  await expect(page.locator('.project-title')).toContainText(name);
}

test('filesystem backend (used on iOS) persists edits and history across reloads', async ({ page }) => {
  await start(page, '?store=fs');
  await openProject(page, 'Сайт-портфолио');
  await page.locator('.row-button', { hasText: 'app.js' }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('\n// FS-BACKEND');
  await expect(page.locator('#save-state')).toHaveText(/Сохранено/, { timeout: 5000 });
  await page.getByRole('button', { name: 'История версий' }).click();
  await page.getByRole('button', { name: 'Сохранить версию' }).click();
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.locator('.row', { hasText: 'Версия от' })).toBeVisible();
  await page.reload();
  await openProject(page, 'Сайт-портфолио');
  await page.locator('.row-button', { hasText: 'app.js' }).click();
  await expect(page.locator('.cm-content')).toContainText('FS-BACKEND');
  await page.getByRole('button', { name: 'История версий' }).click();
  await expect(page.locator('.row', { hasText: 'Версия от' })).toBeVisible();
});

test('search finds text inside files and jumps to the line', async ({ page }) => {
  await start(page);
  await openProject(page, 'Сайт-портфолио');
  await page.getByRole('searchbox', { name: /Поиск/ }).fill('tagline');
  await expect(page.locator('.row-title.hit').first()).toContainText('tagline');
  await page.locator('.row-button', { hasText: 'js/app.js:' }).first().click();
  await expect(page.locator('.cm-activeLine')).toContainText('tagline');
});

test('backup of all projects restores every project', async ({ page }) => {
  await start(page);
  await page.getByRole('button', { name: 'Настройки' }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: /Резервная копия всех проектов/ }).click();
  const file = await (await download).path();
  await page.getByRole('button', { name: 'Назад' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Импорт' }).click();
  await (await chooser).setFiles(file!);
  await page.getByRole('button', { name: 'Восстановить' }).click();
  await expect(page.locator('.list .row-button')).toHaveCount(6);
  await page.locator('.row-button', { hasText: 'Python' }).first().click();
  await page.locator('.nav-item', { hasText: 'Запуск' }).click();
  await expect(page.locator('#run-entry')).toHaveValue('main.py');
});

test('missing Python packages get a helpful hint', async ({ page }) => {
  await start(page);
  await openProject(page, 'Python');
  await page.locator('.row-button', { hasText: 'main.py' }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('import numpy\n');
  await page.locator('.nav-item', { hasText: 'Запуск' }).click();
  await page.getByRole('button', { name: 'Запустить' }).click();
  await expect(page.locator('#run-console')).toContainText('Сторонние пакеты', { timeout: 60_000 });
});
