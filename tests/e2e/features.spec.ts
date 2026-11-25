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

test('file history shows a diff against the current text and restores one file', async ({ page }) => {
  await start(page);
  await openProject(page, 'Python');
  // Version 1 of main.py is captured by an automatic version before deleting another file.
  await page.locator('.nav-item', { hasText: 'Файлы' }).click();
  await page.getByRole('button', { name: 'Действия с файлом README.md' }).click();
  await page.getByRole('button', { name: 'Удалить файл' }).click();
  await page.getByRole('button', { name: 'Удалить', exact: true }).click();
  // Edit main.py.
  await page.locator('.row-button', { hasText: 'main.py' }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.press(`${mod(page)}+a`);
  await page.keyboard.type('print("changed")\n');
  await page.locator('.nav-item', { hasText: 'Файлы' }).click();
  await page.getByRole('button', { name: 'Действия с файлом main.py' }).click();
  await page.getByRole('button', { name: 'История файла' }).click();
  await page.locator('[data-version="0"]').click();
  await expect(page.locator('.diff-view .diff-add')).toContainText('print("changed")');
  await expect(page.locator('.diff-view .diff-del').first()).toBeVisible();
  await page.getByRole('button', { name: 'Восстановить эту версию' }).click();
  await expect(page.locator('#toast')).toContainText('Файл восстановлен');
  await page.locator('.row-button', { hasText: 'main.py' }).click();
  await expect(page.locator('.cm-content')).toContainText('from calculations import total');
});

test('multi-select moves files into a folder, then the folder is renamed and deleted with one undo version', async ({ page }) => {
  await start(page);
  await openProject(page, 'Python');
  await page.locator('.nav-item', { hasText: 'Файлы' }).click();
  await page.getByRole('button', { name: 'Выбрать', exact: true }).click();
  await page.locator('.row-button', { hasText: 'calculations.py' }).click();
  await page.locator('.row-button', { hasText: 'README.md' }).click();
  await expect(page.locator('.select-count')).toContainText('2');
  await page.getByRole('button', { name: 'Переместить' }).click();
  await page.locator('#prompt-input').fill('lib');
  await page.getByRole('button', { name: 'Переместить' }).last().click();
  await expect(page.locator('.dir-button', { hasText: 'lib/' })).toBeVisible();

  await page.locator('.dir-button', { hasText: 'lib/' }).click();
  await page.getByRole('button', { name: 'Переименовать или переместить папку' }).click();
  await page.locator('#prompt-input').fill('src/lib');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.locator('.dir-button', { hasText: 'src/lib/' })).toBeVisible();

  await page.locator('.dir-button', { hasText: 'src/lib/' }).click();
  await page.getByRole('button', { name: /Удалить папку/ }).click();
  await page.getByRole('button', { name: 'Удалить', exact: true }).click();
  await expect(page.locator('.dir-button', { hasText: 'src/lib/' })).toHaveCount(0);
  await page.getByRole('button', { name: 'История версий' }).click();
  await expect(page.locator('.row', { hasText: 'Перед удалением файлов: 2' })).toBeVisible();
});

test('inspector opens from Tools on the live preview and shows the DOM tree and styles', async ({ page }) => {
  await start(page);
  await openProject(page, 'Сайт-портфолио');
  await page.getByRole('button', { name: 'Инструменты' }).click();
  await page.locator('[data-tool="inspector"]').click();
  const panel = page.locator('.tool-layer');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.insp-tree')).toContainText('main', { timeout: 20_000 });
  await panel.locator('.insp-row', { hasText: 'class="hero"' }).first().click();
  await panel.getByRole('tab', { name: 'Стили' }).or(panel.getByRole('button', { name: 'Стили' })).first().click();
  await expect(panel).toContainText('css/styles.css');
  await panel.getByRole('button', { name: 'Закрыть' }).first().click();
  await expect(panel).toHaveCount(0);
});

test('libraries: Bootstrap is added offline in one tap (files copied, tags inserted, preview uses it)', async ({ page }) => {
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await start(page, '?e2e=1');
  await openProject(page, 'Сайт-портфолио');
  await page.getByRole('button', { name: 'Инструменты' }).click();
  await page.locator('[data-tool="libraries"]').click();
  await page.locator('.tool-lib-card[data-lib="bootstrap"] [data-act="add"]').click();
  await expect(page.locator('.tool-lib-card[data-lib="bootstrap"]')).toContainText(/Убрать|Удалить|Добавлено/, { timeout: 15_000 });
  await page.locator('.tool-layer').getByRole('button', { name: 'Закрыть' }).first().click();
  const files = await page.evaluate(() => Object.keys((globalThis as unknown as { __codevia: { s: { project: { files: Record<string, unknown> } } } }).__codevia.s.project.files));
  expect(files.some((f) => f.startsWith('libs/bootstrap/') && f.endsWith('.css'))).toBe(true);
  const html = await page.evaluate(() => ((globalThis as unknown as { __codevia: { s: { project: { files: Record<string, { content: string }> } } } }).__codevia.s.project.files['index.html']!.content));
  expect(html).toMatch(/<link[^>]+libs\/bootstrap\/[^"]+\.css/);
  expect(html).toMatch(/<script[^>]+libs\/bootstrap\/[^"]+\.js/);
});

test('go to definition jumps from a call in main.py to calculations.py; Emmet expands from the key bar', async ({ page }) => {
  await start(page);
  await openProject(page, 'Python');
  await page.locator('.row-button', { hasText: 'main.py' }).click();
  await page.locator('.cm-line', { hasText: 'total(orders)' }).click();
  await page.keyboard.press('End');
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowLeft'); // inside "total"
  await page.locator('.cm-line', { hasText: "print('" }).last().click();
  await page.locator('.cm-content').evaluate((el) => {
    // Put the caret inside the word "total" of the call on the sum line.
    const line = [...el.querySelectorAll('.cm-line')].find((l) => l.textContent?.includes('total(orders)'))!;
    const text = line.firstChild as Node;
    const range = document.createRange();
    const node = [...line.childNodes].map((n) => (n.nodeType === 3 ? n : n.firstChild)).find((n) => n?.textContent?.includes('total')) ?? text;
    range.setStart(node!, (node!.textContent ?? '').indexOf('total') + 2);
    range.collapse(true);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
  });
  await page.getByRole('button', { name: 'Перейти к определению' }).click();
  await expect(page.locator('.file-tab.active')).toContainText('calculations.py');

  await page.getByRole('button', { name: 'К проектам' }).click();
  await openProject(page, 'Сайт-портфолио');
  await page.locator('.nav-item', { hasText: 'Файлы' }).click();
  await page.locator('.row-button', { hasText: 'about.html' }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.press(`${mod(page)}+End`);
  await page.keyboard.type('\nul>li*3');
  await page.getByRole('button', { name: 'Развернуть Emmet' }).click();
  await expect(page.locator('.cm-content')).toContainText('<li></li>');
});

test('interactive input: the program asks, the answer is typed in the console, the run continues (Python and JS)', async ({ page }) => {
  await start(page);
  await openProject(page, 'Python');
  await page.locator('.nav-item', { hasText: 'Запуск' }).click();
  await page.getByRole('button', { name: 'Запустить' }).click();
  await expect(page.locator('.run-status')).toContainText('ждёт ввода', { timeout: 60_000 });
  await page.locator('#console-input').fill('Мария');
  await page.locator('#console-input').press('Enter');
  await expect(page.locator('#run-console')).toContainText('Привет, Мария!', { timeout: 60_000 });
  await expect(page.locator('.run-status')).toContainText('кодом 0');
  await expect(page.locator('#console-input')).toHaveCount(0);

  await page.getByRole('button', { name: 'К проектам' }).click();
  await openProject(page, 'JavaScript');
  await page.locator('.nav-item', { hasText: 'Запуск' }).click();
  await page.getByRole('button', { name: 'Запустить' }).click();
  await expect(page.locator('#console-input')).toBeVisible({ timeout: 30_000 });
  await page.locator('#console-input').fill('Пётр');
  await page.getByRole('button', { name: 'Отправить' }).click();
  await expect(page.locator('#run-console')).toContainText('Привет, Пётр!', { timeout: 30_000 });
});

test('gallery: a Vue todo project is created offline with its library and works in the preview', async ({ page }) => {
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await start(page);
  await page.getByRole('button', { name: 'Новый', exact: true }).click();
  await page.locator('[data-tpl="gallery:vue-todo"]').click();
  await page.getByRole('button', { name: 'Создать проект' }).click();
  await expect(page.locator('.project-title')).toContainText('Список дел на Vue');
  const frame = page.frameLocator('#live-preview');
  await frame.locator('input:not([type])').fill('Buy milk');
  await frame.locator('form button').click();
  await expect(frame.locator('li')).toContainText('Buy milk');
  await expect(frame.locator('.muted')).toContainText('1 left');
});

test('gallery: PHP form posts with method=post and shows $_POST safely', async ({ page }) => {
  await start(page);
  await page.getByRole('button', { name: 'Новый', exact: true }).click();
  await page.locator('[data-tpl="gallery:php-form"]').click();
  await page.getByRole('button', { name: 'Создать проект' }).click();
  const frame = page.frameLocator('#live-preview');
  await frame.locator('input[name="name"]').fill('<b>Ann</b>');
  await frame.locator('textarea[name="message"]').fill('Hello there');
  await frame.getByRole('button', { name: 'Send' }).click();
  await expect(frame.locator('.ok')).toContainText('Thanks, <b>Ann</b>!', { timeout: 30_000 });
  await expect(frame.locator('.ok strong b')).toHaveCount(0);
});

test('lessons: start the Python course, fail the check, write the answer, pass and move on', async ({ page }) => {
  await start(page);
  await page.getByRole('button', { name: 'Инструменты' }).click();
  await page.locator('[data-tool="learn"]').click();
  await page.locator('[data-course="python"]').click();
  await page.locator('[data-lesson="py-1"]').click();
  await page.getByRole('button', { name: 'Начать курс в новом проекте' }).click();
  await expect(page.locator('.project-title')).toContainText('Основы Python');

  await page.getByRole('button', { name: 'Инструменты' }).click();
  await page.locator('[data-tool="learn"]').click();
  await page.getByRole('button', { name: 'Проверить' }).click();
  await expect(page.locator('.learn-result.bad')).toBeVisible({ timeout: 60_000 });

  await page.locator('.tool-layer [data-tool-close]').click();
  await page.locator('.nav-item', { hasText: 'Файлы' }).click();
  await page.locator('.row-button', { hasText: 'main.py' }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.press(`${mod(page)}+a`);
  await page.keyboard.type('print("Hello, Codevia!")\n');
  await page.getByRole('button', { name: 'Инструменты' }).click();
  await page.locator('[data-tool="learn"]').click();
  await page.getByRole('button', { name: 'Проверить' }).click();
  await expect(page.locator('.learn-result.ok')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: /Следующий урок/ }).click();
  await expect(page.locator('.learn-h')).toContainText('Переменные и арифметика');
});
