// App Store screenshots for iPhone 6.9" (1320 x 2868) and iPad 13" (2048 x 2732), per language.
// Usage: npm run build && node scripts/store-screenshots.mjs [en-US,ru]
// Runs the production build in Chromium with the device's viewport, captures real screens, then frames
// them with a caption. Python charts need the bundled packages (CI build with CODEVIA_PY_STRICT=1).
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const PORT = 4599;
const BASE = `http://127.0.0.1:${PORT}/`;
const locales = (process.argv[2] ?? 'en-US,ru').split(',');
const OUT = 'appstore';

const CAPTIONS = {
  'en-US': {
    home: ['Code in your pocket', 'Websites, Python, JS and PHP on iPhone'],
    editor: ['A real code editor', 'Emmet, snippets, Prettier, errors as you type'],
    inspector: ['Live preview + inspector', 'DOM, styles and network of your page'],
    python: ['Python with numpy & pandas', 'Charts right in the console, offline'],
    js: ['JavaScript & TypeScript', 'Imports, console.table, timers, prompt()'],
    tools: ['Tools built in', 'JSON viewer, HTTP client, colours, GitHub'],
    ipadSplit: ['Made for iPad', 'Files, code and preview side by side'],
    ipadPython: ['Data science, offline', 'numpy, pandas, matplotlib built in'],
    ipadInspector: ['Inspect any element', 'Styles, box model and network'],
    ipadLibs: ['Tailwind, Bootstrap, Vue', 'Added in one tap, no internet needed'],
  },
  ru: {
    home: ['Код в кармане', 'Сайты, Python, JS и PHP на iPhone'],
    editor: ['Настоящий редактор', 'Emmet, сниппеты, Prettier, ошибки на лету'],
    inspector: ['Предпросмотр и инспектор', 'DOM, стили и сеть вашей страницы'],
    python: ['Python с numpy и pandas', 'Графики прямо в консоли, офлайн'],
    js: ['JavaScript и TypeScript', 'Импорты, console.table, таймеры, prompt()'],
    tools: ['Инструменты внутри', 'JSON, HTTP-клиент, цвета, GitHub'],
    ipadSplit: ['Создано для iPad', 'Файлы, код и предпросмотр рядом'],
    ipadPython: ['Анализ данных офлайн', 'numpy, pandas, matplotlib встроены'],
    ipadInspector: ['Инспектор элементов', 'Стили, блочная модель и сеть'],
    ipadLibs: ['Tailwind, Bootstrap, Vue', 'Одной кнопкой, без интернета'],
  },
};

const PY_CHART = `import numpy as np
import pandas as pd
import matplotlib.pyplot as plt

df = pd.DataFrame({"month": range(1, 13), "sales": np.random.default_rng(7).integers(40, 120, 12).cumsum()})
print(df.tail(3))
plt.figure(figsize=(6, 3.6))
plt.plot(df["month"], df["sales"], marker="o", color="#40c8f6")
plt.title("Sales 2026")
plt.grid(alpha=.3)
plt.show()
`;

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch();

async function session(locale, device) {
  const lang = locale.split('-')[0];
  const ctx = await browser.newContext({
    viewport: device === 'iphone' ? { width: 440, height: 956 } : { width: 1024, height: 1366 },
    deviceScaleFactor: device === 'iphone' ? 3 : 2,
    isMobile: device === 'iphone',
    hasTouch: true,
    locale,
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}?lang=${lang}`);
  await page.locator('[data-action="welcome-samples"]').click();
  await page.locator('.row-button').first().waitFor();
  return { ctx, page };
}

const open = async (page, sample) => {
  await page.locator('.row-button').nth(sample).click();
  await page.locator('.project-title').waitFor();
};
const home = async (page) => page.locator('[data-action="go-home"]').click();
const tools = async (page, id) => {
  await page.locator('[data-action="tools"]').click();
  await page.locator(`[data-tool="${id}"]`).click();
  await page.locator('.tool-layer').waitFor();
};
const typeFile = async (page, path, text) => {
  await page.evaluate(
    ([p, c]) => {
      const app = globalThis.__codevia;
      app.s.project.files[p] = { text: true, content: c };
      app.editor.forget?.(p);
    },
    [path, text],
  );
};
const run = async (page, waitText) => {
  await page.locator('[data-action="run"]').first().click();
  await page.locator('#run-console', { hasText: waitText }).waitFor({ timeout: 120_000 });
  // Wait until the run has finished (Run button back, status shows the exit code).
  await page.locator('[data-action="run"]').first().waitFor({ timeout: 120_000 });
  await page.waitForTimeout(800);
};

// Sample order on Home (newest first): JS, PHP, Python, Web — resolved by text to stay robust.
const sampleIndex = async (page, re) => {
  const titles = await page.locator('.row-button .row-title').allTextContents();
  return titles.findIndex((t) => re.test(t));
};

async function iphone(locale) {
  const shots = {};
  const { ctx, page } = await session(locale, 'iphone');
  await page.goto(`${BASE}?lang=${locale.split('-')[0]}&e2e=1`);
  await page.locator('.row-button').first().waitFor();
  shots.home = await page.screenshot();

  await open(page, await sampleIndex(page, /portfolio|портфолио/i));
  await page.locator('.row-button', { hasText: 'index.html' }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n  <section class="cards">\n    div.card>h2+p');
  await page.waitForTimeout(800);
  shots.editor = await page.screenshot();
  await page.keyboard.press('Control+z');

  await tools(page, 'inspector');
  await page.locator('.insp-row').nth(3).click().catch(() => undefined);
  await page.waitForTimeout(1200);
  shots.inspector = await page.screenshot();
  await page.locator('.tool-layer [data-tool-close]').click();
  await home(page);

  if (!process.env.SKIP_PY) {
    await open(page, await sampleIndex(page, /python/i));
    await typeFile(page, 'main.py', PY_CHART);
    await page.locator('.nav-item').nth(3).click();
    await run(page, 'month');
    await page.locator('#run-console').evaluate((el) => (el.scrollTop = el.scrollHeight));
    shots.python = await page.screenshot();
    await home(page);
  }

  await open(page, await sampleIndex(page, /javascript/i));
  await page.locator('.nav-item').nth(3).click();
  await page.locator('summary').first().click();
  await page.fill('#run-stdin', locale === 'ru' ? 'Анна' : 'Anna');
  await run(page, locale === 'ru' ? 'Анна' : 'Anna');
  shots.js = await page.screenshot();
  await home(page);

  await tools(page, 'json');
  const sample = JSON.stringify({ user: { id: 7, name: 'Anna', roles: ['admin', 'dev'] }, projects: [{ name: 'portfolio', stars: 42 }, { name: 'api', stars: 17 }], active: true });
  await page.locator('.tool-layer textarea').first().fill(sample);
  await page.locator('.tool-layer textarea').first().dispatchEvent('input');
  await page.waitForTimeout(400);
  // Show the collapsible tree (the most telling view of the JSON tool).
  await page.locator('.tool-layer button', { hasText: /^(Tree|Дерево)$/ }).first().click();
  await page.waitForTimeout(800);
  shots.tools = await page.screenshot();
  await ctx.close();
  return shots;
}

async function ipad(locale) {
  const shots = {};
  const { ctx, page } = await session(locale, 'ipad');
  await page.goto(`${BASE}?lang=${locale.split('-')[0]}&e2e=1`);
  await page.locator('.row-button').first().waitFor();
  // Python first, on a fresh project screen (Run is the default side pane for Python).
  if (!process.env.SKIP_PY) {
    await open(page, await sampleIndex(page, /python/i));
    await typeFile(page, 'main.py', PY_CHART);
    await page.evaluate(() => globalThis.__codevia.render());
    await run(page, 'month');
    shots.ipadPython = await page.screenshot();
    await home(page);
  }
  await open(page, await sampleIndex(page, /portfolio|портфолио/i));
  await page.locator('.split-files .row-button', { hasText: 'index.html' }).click();
  await page.waitForTimeout(1500);
  shots.ipadSplit = await page.screenshot();

  await tools(page, 'inspector');
  await page.locator('.insp-row').nth(3).click().catch(() => undefined);
  await page.waitForTimeout(1200);
  shots.ipadInspector = await page.screenshot();
  await page.locator('.tool-layer [data-tool-close]').click();

  await tools(page, 'libraries');
  await page.waitForTimeout(800);
  shots.ipadLibs = await page.screenshot();
  await ctx.close();
  // Store order: split view first.
  return { ipadSplit: shots.ipadSplit, ...(shots.ipadPython ? { ipadPython: shots.ipadPython } : {}), ipadInspector: shots.ipadInspector, ipadLibs: shots.ipadLibs };
}

async function frame(png, [title, sub], device) {
  const W = device === 'iphone' ? 1320 : 2048;
  const H = device === 'iphone' ? 2868 : 2732;
  const shotW = device === 'iphone' ? 1080 : 1640;
  const shotH = Math.round(shotW * (device === 'iphone' ? 956 / 440 : 1366 / 1024));
  const top = device === 'iphone' ? 470 : 520;
  const p = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await p.setContent(`<html><body style="margin:0;width:${W}px;height:${H}px;overflow:hidden;
    background:radial-gradient(1400px 1000px at 50% -10%, #1d3a4a 0%, #0c0e12 60%);font-family:-apple-system,'Segoe UI',Inter,Roboto,'Noto Sans','Noto Sans CJK SC',Arial,sans-serif">
    <div style="position:absolute;top:${device === 'iphone' ? 120 : 140}px;left:60px;right:60px;text-align:center;color:#f2f4f7">
      <div style="font-size:${device === 'iphone' ? 100 : 120}px;font-weight:800;letter-spacing:-2px;line-height:1.05">${title}</div>
      <div style="font-size:${device === 'iphone' ? 50 : 60}px;color:#9fd6f0;margin-top:28px;font-weight:500">${sub}</div>
    </div>
    <img src="data:image/png;base64,${png.toString('base64')}" style="position:absolute;top:${top}px;left:${(W - shotW) / 2}px;width:${shotW}px;height:${shotH}px;
      border-radius:${device === 'iphone' ? 72 : 48}px;box-shadow:0 40px 120px rgba(0,0,0,.55),0 0 0 6px #2a303a"/>
  </body></html>`);
  await p.waitForTimeout(200);
  const out = await p.screenshot();
  await p.close();
  return out;
}

try {
  for (const locale of locales) {
    const caps = CAPTIONS[locale] ?? CAPTIONS['en-US'];
    for (const [device, fn, dir] of [
      ['iphone', iphone, `${OUT}/screenshots/${locale}`],
      ['ipad', ipad, `${OUT}/screenshots-ipad/${locale}`],
    ]) {
      mkdirSync(dir, { recursive: true });
      const shots = await fn(locale);
      for (const f of readdirSync(dir)) if (f.endsWith('.png')) rmSync(`${dir}/${f}`);
      let i = 1;
      for (const [key, png] of Object.entries(shots)) {
        writeFileSync(`${dir}/${i++}-${key}.png`, await frame(png, caps[key], device));
      }
      console.log(`${locale} ${device}: ${Object.keys(shots).length} screenshots → ${dir}`);
    }
  }
} finally {
  await browser.close();
  server.kill();
}
