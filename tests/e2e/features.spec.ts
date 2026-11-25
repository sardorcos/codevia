import { existsSync, readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/** Editor shortcuts: CodeMirror treats iPhone (WebKit) like a Mac, where Mod = ⌘ and Ctrl-A means "line start". */
const mod = (page: Page) => (page.context().browser()?.browserType().name() === 'webkit' ? 'Meta' : 'Control');

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
  await page.keyboard.press(`${mod(page)}+End`);
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
  await expect(page.locator('.list .row-button')).toHaveCount(8);
  await page.locator('.row-button', { hasText: 'Python' }).first().click();
  await page.locator('.nav-item', { hasText: 'Запуск' }).click();
  await expect(page.locator('#run-entry')).toHaveValue('main.py');
});

test('unknown Python modules get a helpful hint', async ({ page }) => {
  await start(page);
  await openProject(page, 'Python');
  await page.locator('.row-button', { hasText: 'main.py' }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.press(`${mod(page)}+a`);
  await page.keyboard.type('import codevia_no_such_module\n');
  await page.locator('.nav-item', { hasText: 'Запуск' }).click();
  await page.getByRole('button', { name: 'Запустить' }).click();
  await expect(page.locator('#run-console')).toContainText('ModuleNotFoundError', { timeout: 60_000 });
  await expect(page.locator('#run-console')).toContainText(/Подсказка|Tip:/);
});

test('bundled numpy and pandas run offline', async ({ page }) => {
  const bundled = existsSync('public/pyodide/bundled.json') ? JSON.parse(readFileSync('public/pyodide/bundled.json', 'utf8')).packages : [];
  test.skip(!bundled.includes('numpy') || !bundled.includes('pandas'), 'Python packages were not bundled in this build (CDN unreachable)');
  await page.route(/cdn\.jsdelivr\.net|pypi\.org|pythonhosted\.org/, (r) => r.abort());
  await start(page);
  await openProject(page, 'Python');
  await page.locator('.row-button', { hasText: 'main.py' }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.press(`${mod(page)}+a`);
  await page.keyboard.type('import numpy as np\nimport pandas as pd\nprint("sum", np.arange(5).sum())\nprint("rows", len(pd.DataFrame({"a": [1, 2, 3]})))\n');
  await page.locator('.nav-item', { hasText: 'Запуск' }).click();
  await page.getByRole('button', { name: 'Запустить' }).click();
  await expect(page.locator('#run-console')).toContainText('sum 10', { timeout: 120_000 });
  await expect(page.locator('#run-console')).toContainText('rows 3');
});

test('a failed save blocks leaving the project until the user decides', async ({ page }) => {
  await start(page, '?e2e=1');
  await openProject(page, 'Сайт-портфолио');
  // Simulate a full disk.
  await page.evaluate(() => {
    const app = (globalThis as unknown as { __codevia: { repo: { saveFiles: unknown; __orig?: unknown } } }).__codevia;
    app.repo.__orig = app.repo.saveFiles;
    app.repo.saveFiles = () => Promise.reject(new Error('Недостаточно места'));
  });
  await page.locator('.row-button', { hasText: 'app.js' }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.type('// unsaved');
  await page.getByRole('button', { name: 'К проектам' }).click();
  await expect(page.getByRole('dialog', { name: 'Изменения не сохранены' })).toBeVisible();
  await page.getByRole('button', { name: 'Остаться' }).click();
  await expect(page.locator('.project-title')).toContainText('Сайт-портфолио');
  // Space freed: the next attempt saves the kept edits and navigation continues without a prompt.
  await page.evaluate(() => {
    const app = (globalThis as unknown as { __codevia: { repo: { saveFiles: unknown; __orig?: unknown } } }).__codevia;
    app.repo.saveFiles = app.repo.__orig;
  });
  await page.getByRole('button', { name: 'К проектам' }).click();
  await expect(page.getByRole('heading', { name: 'Проекты', exact: true })).toBeVisible();
  await openProject(page, 'Сайт-портфолио');
  await page.locator('.row-button', { hasText: 'app.js' }).click();
  await expect(page.locator('.cm-content')).toContainText('// unsaved');
});

test('importing a Windows-1251 file keeps its bytes and offers conversion', async ({ page }) => {
  await start(page);
  await openProject(page, 'PHP');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Добавить файлы с устройства' }).click();
  await (await chooser).setFiles({ name: 'old.php', mimeType: 'text/plain', buffer: Buffer.from([0x3c, 0x3f, 0x3d, 0x27, 0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x27, 0x3b]) });
  await page.getByRole('button', { name: 'Действия с файлом old.php' }).click();
  await page.getByRole('button', { name: /Преобразовать в UTF-8/ }).click();
  await page.getByRole('button', { name: 'Преобразовать', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText("<?='Привет';");
});

test('JavaScript/TypeScript project runs with imports, JSON, timers and prompt()', async ({ page }) => {
  await start(page);
  await openProject(page, 'JavaScript');
  await page.locator('.nav-item', { hasText: 'Запуск' }).click();
  await expect(page.locator('#run-entry')).toHaveValue('main.ts');
  await page.locator('summary', { hasText: 'prompt()' }).click();
  await page.locator('#run-stdin').fill('Анна');
  await page.getByRole('button', { name: 'Запустить' }).click();
  const out = page.locator('#run-console');
  await expect(out).toContainText('Сумма заказов:', { timeout: 30_000 });
  await expect(out).toContainText('(index)');
  await expect(out).toContainText('Привет, Анна!');
  await expect(page.locator('.run-status')).toContainText('кодом 0');
});
