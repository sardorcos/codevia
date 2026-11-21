import { expect, test, type Page } from '@playwright/test';

const previewFrame = (page: Page) => page.frameLocator('#live-preview');

async function startWithSamples(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Начать с примеров' }).click();
  await expect(page.getByRole('heading', { name: 'Проекты', exact: true })).toBeVisible();
}

async function openProject(page: Page, name: string) {
  await page.locator('.row-button', { hasText: name }).click();
  await expect(page.locator('.project-title')).toContainText(name);
}

test.describe('Codevia Pocket', () => {
  test.beforeEach(async ({ page }) => {
    page.on('pageerror', (e) => {
      throw e;
    });
  });

  test('onboarding → home has no horizontal scroll and accessible names', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Код в кармане' })).toBeVisible();
    await page.getByRole('button', { name: 'Начать с примеров' }).click();
    await expect(page.locator('.row-button')).toHaveCount(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // Every web project row shows its badge (regression: "</>" used to vanish).
    await expect(page.locator('.file-ext.html').first()).toHaveText('</>');
  });

  test('tap targets are at least 44×44 in the default density', async ({ page }) => {
    await startWithSamples(page);
    await openProject(page, 'Сайт-портфолио');
    for (const view of ['Файлы', 'Код', 'Просмотр', 'Запуск']) {
      await page.locator('.nav-item', { hasText: view }).click();
      const small = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('button, select, input:not([type=checkbox])')]
          .filter((el) => el.offsetParent !== null && !el.closest('.cm-editor'))
          .map((el) => ({ el: el.getAttribute('aria-label') || el.textContent?.trim() || el.id, r: el.getBoundingClientRect() }))
          .filter(({ r }) => r.height < 43.5 && !(r.height >= 36)) // chips are 36px with an extended ::before hit area
          .map(({ el, r }) => `${el}: ${Math.round(r.width)}×${Math.round(r.height)}`),
      );
      expect(small, view).toEqual([]);
    }
  });

  test('inputs use 16px text so iOS does not zoom', async ({ page }) => {
    await startWithSamples(page);
    await page.getByRole('button', { name: 'Новый' }).click();
    expect(await page.locator('#np-name').evaluate((el) => getComputedStyle(el).fontSize)).toBe('16px');
  });

  test('edit → autosave survives reload (real IndexedDB)', async ({ page }) => {
    await startWithSamples(page);
    await openProject(page, 'Сайт-портфолио');
    await page.locator('.row-button', { hasText: 'styles.css' }).click();
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('\n/* PERSISTED */');
    await expect(page.locator('#save-state')).toHaveText(/Сохранено/, { timeout: 5000 });
    await page.reload();
    await openProject(page, 'Сайт-портфолио');
    await page.locator('.row-button', { hasText: 'styles.css' }).click();
    await expect(page.locator('.cm-content')).toContainText('PERSISTED');
  });

  test('keybar inserts pairs with the caret inside, undo reverts it', async ({ page }) => {
    await startWithSamples(page);
    await openProject(page, 'Сайт-портфолио');
    await page.locator('.row-button', { hasText: 'app.js' }).click();
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+Home');
    await page.locator('.key-btn[data-value="()"]').click();
    await page.keyboard.type('x');
    await expect(page.locator('.cm-line').first()).toHaveText(/^\(x\)/);
    await page.getByRole('button', { name: 'Отменить' }).click();
    await page.getByRole('button', { name: 'Отменить' }).click();
    await expect(page.locator('.cm-line').first()).not.toHaveText(/^\(/);
  });

  test('preview: CSS, images, fetch(), console, multi-page links, fullscreen exit', async ({ page }) => {
    await startWithSamples(page);
    await openProject(page, 'Сайт-портфолио');
    await page.locator('.nav-item', { hasText: 'Просмотр' }).click();
    const frame = previewFrame(page);
    await expect(frame.getByRole('heading', { name: 'Идеи становятся продуктами.' })).toBeVisible();
    expect(await frame.locator('img.logo').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    await frame.getByRole('button', { name: /Обсудить проект/ }).click();
    await expect(frame.locator('#tagline')).toHaveText('Мы скоро свяжемся с вами.');
    await page.getByRole('button', { name: /Консоль/ }).click();
    await expect(page.locator('#preview-console')).toContainText('Данные проекта');
    await frame.getByRole('link', { name: 'О нас' }).click();
    await expect(previewFrame(page).getByRole('heading', { name: 'О студии' })).toBeVisible();
    await page.getByRole('button', { name: 'Во весь экран' }).click();
    await expect(page.locator('.preview-pane.fullscreen')).toBeVisible();
    // The exit button stays reachable above the page (regression: users were trapped).
    await page.getByRole('button', { name: 'Выйти из полноэкранного режима' }).click();
    await expect(page.locator('.preview-pane.fullscreen')).toHaveCount(0);
  });

  test('preview handles "</script>" inside a JS string', async ({ page }) => {
    await startWithSamples(page);
    await openProject(page, 'Сайт-портфолио');
    await page.locator('.row-button', { hasText: 'app.js' }).click();
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('document.title = "</script>" + "ok"; document.body.dataset.ran = "yes";');
    await page.locator('.nav-item', { hasText: 'Просмотр' }).click();
    await expect(previewFrame(page).locator('body[data-ran="yes"]')).toHaveCount(1);
    await expect(previewFrame(page).locator('body')).not.toContainText('document.title');
  });

  test('Python runs on device with stdin and can be stopped', async ({ page }) => {
    await startWithSamples(page);
    await openProject(page, 'Python');
    await page.locator('.nav-item', { hasText: 'Запуск' }).click();
    await page.locator('summary').click();
    await page.locator('#run-stdin').fill('Анна');
    await page.getByRole('button', { name: 'Запустить' }).click();
    await expect(page.locator('#run-console')).toContainText('Привет, Анна!', { timeout: 60_000 });
    await expect(page.locator('#run-console')).toContainText('Сумма заказов: 4350000');
    await expect(page.locator('.run-status')).toContainText('кодом 0');

    // Infinite loop → Stop terminates the worker; the next run works again.
    await page.locator('.nav-item', { hasText: 'Файлы' }).click();
    await page.locator('.row-button', { hasText: 'main.py' }).click();
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('while True:\n    pass\n');
    await page.locator('.nav-item', { hasText: 'Запуск' }).click();
    await page.getByRole('button', { name: 'Запустить' }).click();
    await page.getByRole('button', { name: 'Стоп' }).click();
    await expect(page.locator('.run-status')).toContainText('Остановлено');
  });

  test('Python errors show a clean traceback', async ({ page }) => {
    await startWithSamples(page);
    await openProject(page, 'Python');
    await page.locator('.row-button', { hasText: 'main.py' }).click();
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('print(1/0)\n');
    await page.locator('.nav-item', { hasText: 'Запуск' }).click();
    await page.getByRole('button', { name: 'Запустить' }).click();
    await expect(page.locator('#run-console')).toContainText('ZeroDivisionError', { timeout: 60_000 });
    await expect(page.locator('#run-console')).not.toContainText('/home/pyodide');
    await expect(page.locator('.run-status')).toContainText('кодом 1');
  });

  test('PHP renders as a page with $_GET', async ({ page }) => {
    await startWithSamples(page);
    await openProject(page, 'PHP');
    await page.locator('.nav-item', { hasText: 'Просмотр' }).click();
    await expect(previewFrame(page).getByRole('heading', { name: 'Привет, гость!' })).toBeVisible({ timeout: 60_000 });
    await previewFrame(page).getByRole('link', { name: /Передать имя/ }).click();
    await expect(previewFrame(page).getByRole('heading', { name: 'Привет, Codevia!' })).toBeVisible({ timeout: 30_000 });
  });

  test('files: create, rename, delete with automatic version, restore from history', async ({ page }) => {
    await startWithSamples(page);
    await openProject(page, 'Сайт-портфолио');
    await page.getByRole('button', { name: 'Создать файл' }).click();
    await page.locator('#prompt-input').fill('js/extra.js');
    await page.getByRole('button', { name: 'Создать' }).click();
    await expect(page.locator('.file-tab.active')).toContainText('extra.js');
    await page.locator('.nav-item', { hasText: 'Файлы' }).click();
    await page.getByRole('button', { name: 'Действия с файлом js/extra.js' }).click();
    await page.getByRole('button', { name: 'Переименовать или переместить' }).click();
    await page.locator('#prompt-input').fill('../escape.js');
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await expect(page.locator('#prompt-error')).toContainText('Недопустимый');
    await page.locator('#prompt-input').fill('js/renamed.js');
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await expect(page.locator('.row-button', { hasText: 'renamed.js' })).toBeVisible();

    await page.getByRole('button', { name: 'Действия с файлом README.md' }).click();
    await page.getByRole('button', { name: 'Удалить файл' }).click();
    await page.getByRole('button', { name: 'Удалить', exact: true }).click();
    await expect(page.locator('.row-button', { hasText: 'README.md' })).toHaveCount(0);

    await page.getByRole('button', { name: 'История версий' }).click();
    await expect(page.locator('.row', { hasText: 'Перед удалением README.md' })).toBeVisible();
    await page.locator('.row', { hasText: 'Перед удалением README.md' }).getByRole('button', { name: 'Вернуть' }).click();
    await page.getByRole('button', { name: 'Вернуть', exact: true }).last().click();
    await page.getByRole('button', { name: 'Назад' }).click();
    await page.locator('.nav-item', { hasText: 'Файлы' }).click();
    await expect(page.locator('.row-button', { hasText: 'README.md' })).toBeVisible();
  });

  test('ZIP export → import round trip keeps every file', async ({ page }) => {
    await startWithSamples(page);
    await openProject(page, 'Сайт-портфолио');
    await page.getByRole('button', { name: 'Действия с проектом', exact: true }).click();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Экспорт ZIP' }).click();
    const file = await (await download).path();
    await page.getByRole('button', { name: 'К проектам' }).click();
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Импорт' }).click();
    await (await chooser).setFiles(file!);
    await expect(page.locator('.project-title')).toBeVisible();
    for (const name of ['index.html', 'about.html', 'styles.css', 'app.js', 'project.json', 'logo.svg', 'README.md']) {
      await expect(page.locator('.row-button', { hasText: name })).toBeVisible();
    }
  });

  test('dialogs trap focus, close with Escape and restore focus', async ({ page }) => {
    await startWithSamples(page);
    const opener = page.getByRole('button', { name: 'Новый' });
    await opener.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.locator('#np-name')).toBeFocused();
    for (let i = 0; i < 12; i++) await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]'))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(opener).toBeFocused();
  });

  test('diagnostics finds a broken reference and jumps to the line', async ({ page }) => {
    await startWithSamples(page);
    await openProject(page, 'Сайт-портфолио');
    await page.locator('.row-button', { hasText: 'index.html' }).first().click();
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('\n<img src="missing.png">');
    await page.locator('.nav-item', { hasText: 'Файлы' }).click();
    await page.getByRole('button', { name: 'Проверка' }).click();
    await expect(page.locator('.issue.error')).toContainText('missing.png');
    await page.locator('.issue.error').first().click();
    await expect(page.locator('.cm-activeLine')).toContainText('missing.png');
  });
});
