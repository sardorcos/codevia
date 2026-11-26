import { expect, test, type Page } from '@playwright/test';

/** Editor features in the real app: Emmet, snippets, lint, formatting (worker + lazy Prettier), swatches. */
const mod = (page: Page) => (page.context().browser()?.browserType().name() === 'webkit' ? 'Meta' : 'Control');

type Outcome = { changed: boolean; error?: string };
interface Hooks {
  __codevia: { editor: { format(): Promise<Outcome>; current(): string; diagnostics(): { errors: number } } };
}

async function openFile(page: Page, project: string, file: string) {
  await page.goto('/?e2e=1');
  await page.getByRole('button', { name: 'Начать с примеров' }).click();
  await page.locator('.row-button', { hasText: project }).click();
  await expect(page.locator('.project-title')).toContainText(project);
  await page.locator('.row-button', { hasText: file }).first().click();
  await expect(page.locator('.cm-content')).toBeVisible();
}

async function replaceAll(page: Page, text: string) {
  await page.locator('.cm-content').click();
  await page.keyboard.press(`${mod(page)}+a`);
  await page.keyboard.press('Backspace');
  await page.keyboard.type(text);
}

const format = (page: Page) => page.evaluate(() => (globalThis as unknown as Hooks).__codevia.editor.format());
const code = (page: Page) => page.evaluate(() => (globalThis as unknown as Hooks).__codevia.editor.current());

test.describe('editor', () => {
  test.beforeEach(async ({ page }) => {
    page.on('pageerror', (e) => {
      throw e;
    });
  });

  test('Emmet abbreviation shows a preview and expands with Tab', async ({ page }) => {
    await openFile(page, 'Сайт-портфолио', 'index.html');
    // Emmet is a lazy chunk, loaded when the first HTML file opens.
    await page.waitForFunction(() => performance.getEntriesByType('resource').some((e) => /\/emmet-[\w-]+\.js$/.test(e.name)));
    await page.waitForTimeout(200);
    await replaceAll(page, 'div.card>h2+p');
    await expect(page.locator('.emmet-tracker')).toHaveText('div.card>h2+p');
    // The suggestion: an autocomplete entry whose info shows the expanded markup.
    await expect(page.locator('.cm-tooltip-autocomplete')).toContainText('Emmet abbreviation');
    await expect(page.locator('.cm-completionInfo .emmet-preview')).toContainText('<h2></h2>');
    await page.keyboard.press('Tab');
    await expect.poll(() => code(page)).toBe('<div class="card">\n  <h2></h2>\n  <p></p>\n</div>');
    // Enter on the suggestion expands too.
    await page.keyboard.press(`${mod(page)}+a`);
    await page.keyboard.press('Backspace');
    await page.keyboard.type('ul>li*3');
    await expect(page.locator('.cm-tooltip-autocomplete')).toContainText('Emmet abbreviation');
    await page.waitForTimeout(200); // CodeMirror ignores Enter for 75 ms after the list changes
    await page.keyboard.press('Enter');
    await expect.poll(() => code(page)).toBe('<ul>\n  <li></li>\n  <li></li>\n  <li></li>\n</ul>');
  });

  test('snippets complete with fields', async ({ page }) => {
    await openFile(page, 'Сайт-портфолио', 'app.js');
    await replaceAll(page, 'forEa');
    await expect(page.locator('.cm-tooltip-autocomplete')).toContainText('forEach');
    await page.waitForTimeout(200); // CodeMirror ignores Enter for 75 ms after the list changes
    await page.keyboard.press('Enter');
    await expect.poll(() => code(page)).toBe('array.forEach((item) => {\n  \n});');
    await page.keyboard.type('list');
    await expect.poll(() => code(page)).toBe('list.forEach((item) => {\n  \n});');
  });

  test('syntax errors get a squiggle, a counter and a tap-to-read message', async ({ page }) => {
    await openFile(page, 'Сайт-портфолио', 'app.js');
    await replaceAll(page, 'const ok = 1;\nconst broken = ;\n');
    const squiggle = page.locator('.cm-lintRange-error');
    await expect(squiggle).toHaveCount(1, { timeout: 5000 });
    await expect(page.locator('.cm-lint-marker-error')).toHaveCount(1);
    expect(await page.evaluate(() => (globalThis as unknown as Hooks).__codevia.editor.diagnostics().errors)).toBe(1);
    await squiggle.click();
    await expect(page.locator('.cm-touch-lint')).toContainText('Синтаксическая ошибка');
  });

  test('format document runs Prettier in a worker (JS and PHP) and is undoable', async ({ page }) => {
    await openFile(page, 'Сайт-портфолио', 'app.js');
    await replaceAll(page, 'const a = {b:1,c:[1,2]}');
    expect(await format(page)).toEqual({ changed: true });
    expect(await code(page)).toBe('const a = { b: 1, c: [1, 2] };\n');
    await page.keyboard.press(`${mod(page)}+z`);
    await expect.poll(() => code(page)).toBe('const a = {b:1,c:[1,2]}');

    await page.goto('/?e2e=1');
    await page.locator('.row-button', { hasText: 'PHP' }).click();
    await page.locator('.row-button', { hasText: 'view.php' }).click();
    const res = await format(page);
    expect(res.error).toBeUndefined();
    expect(await code(page)).toContain('function greeting(string $name): string\n{');
  });

  test('colour swatches appear before CSS colours', async ({ page }) => {
    await openFile(page, 'Сайт-портфолио', 'styles.css');
    await expect(page.locator('.cm-color-swatch').first()).toBeVisible();
    const input = page.locator('.cm-color-swatch input[type=color]').first();
    await expect(input).toHaveValue('#40c8f6');
    await input.evaluate((el: HTMLInputElement) => {
      el.value = '#ff0000';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect.poll(() => code(page)).toContain('--accent: #ff0000;');
  });
});
