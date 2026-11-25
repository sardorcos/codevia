import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatBytes } from '../../src/core/bytes';
import { templateFiles } from '../../src/core/templates';
import { localizeWorkerText } from '../../src/runtime/runner';
import { en } from '../../src/i18n/en';
import { detectLang, englishTexts, getLang, matchLang, pickPluralForm, plural, setLang, t, tc } from '../../src/i18n';

const FILES = { one: '{count} файл', few: '{count} файла', many: '{count} файлов' };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setLang('ru');
});

describe('detectLang', () => {
  const nav = (languages: string[]) => vi.stubGlobal('navigator', { languages, language: languages[0] });

  it('uses Russian for ru and be, and the own language for the other supported ones', () => {
    for (const l of ['ru', 'ru-RU', 'be']) {
      nav([l]);
      expect(detectLang(), l).toBe('ru');
    }
    for (const [l, want] of [['uk-UA', 'uk'], ['kk-KZ', 'kk'], ['uz', 'uz'], ['fr-FR', 'fr'], ['de', 'de'], ['ja-JP', 'ja']] as const) {
      nav([l]);
      expect(detectLang(), l).toBe(want);
    }
  });

  it('defaults to English', () => {
    for (const l of ['en-US', 'rue', 'ukr', 'xx-YY']) {
      nav([l]);
      expect(detectLang(), l).toBe('en');
    }
    nav([]);
    expect(detectLang()).toBe('en');
  });

  it('follows the first preferred language, and navigator.language when languages is missing', () => {
    nav(['en-GB', 'ru-RU']);
    expect(detectLang()).toBe('en');
    vi.stubGlobal('navigator', { language: 'ru-RU' });
    expect(detectLang()).toBe('ru');
  });

  it('honours ?lang= and localStorage overrides, ignoring storage errors', () => {
    nav(['ru-RU']);
    vi.stubGlobal('location', { search: '?e2e=1&lang=en' });
    expect(detectLang()).toBe('en');
    vi.stubGlobal('location', { search: '?lang=xx' });
    vi.stubGlobal('localStorage', { getItem: (k: string) => (k === 'codevia.lang' ? 'en' : null) });
    expect(detectLang()).toBe('en');
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
    });
    expect(detectLang()).toBe('ru');
  });

  it('setLang(null) detects again', () => {
    nav(['en-US']);
    setLang(null);
    expect(getLang()).toBe('en');
  });
});

describe('t()', () => {
  it('returns the Russian key unchanged in Russian', () => {
    setLang('ru');
    expect(t('Новый проект')).toBe('Новый проект');
    expect(t('Удалить версию {name}', { name: 'v1' })).toBe('Удалить версию v1');
  });

  it('translates into English and fills params', () => {
    setLang('en');
    expect(t('Новый проект')).toBe('New project');
    expect(t('Удалить версию {name}', { name: 'v1' })).toBe('Delete version v1');
    expect(t('Файл {name} больше {size}', { name: 'a.png', size: '5 MB' })).toBe('a.png is larger than 5 MB');
    expect(t('Завершено с кодом {code}', { code: 0 })).toBe('Finished with exit code 0');
  });

  it('keeps placeholders without a param', () => {
    setLang('en');
    expect(t('Привет, {name}!')).toBe('Hello, {name}!');
  });

  it('falls back to the key and warns once for a missing key', () => {
    setLang('en');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(t('Нет такой строки {x}', { x: 1 })).toBe('Нет такой строки 1');
    expect(t('Нет такой строки {x}', { x: 2 })).toBe('Нет такой строки 2');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('Нет такой строки');
  });

  it('tc() picks the English for a context', () => {
    setLang('en');
    expect(t('Повторить')).toBe('Retry');
    expect(tc('redo', 'Повторить')).toBe('Redo');
    setLang('ru');
    expect(tc('redo', 'Повторить')).toBe('Повторить');
  });
});

describe('plural()', () => {
  it('uses Russian one/few/many', () => {
    setLang('ru');
    const cases: Array<[number, string]> = [
      [0, '0 файлов'],
      [1, '1 файл'],
      [2, '2 файла'],
      [4, '4 файла'],
      [5, '5 файлов'],
      [11, '11 файлов'],
      [12, '12 файлов'],
      [14, '14 файлов'],
      [21, '21 файл'],
      [22, '22 файла'],
      [25, '25 файлов'],
      [101, '101 файл'],
      [111, '111 файлов'],
    ];
    for (const [n, s] of cases) expect(plural(n, FILES)).toBe(s);
  });

  it('uses English one/other from en.ts', () => {
    setLang('en');
    expect(plural(0, FILES)).toBe('0 files');
    expect(plural(1, FILES)).toBe('1 file');
    expect(plural(2, FILES)).toBe('2 files');
    expect(plural(21, FILES)).toBe('21 files');
  });

  it('supports a fixed Russian text with English plural forms and extra params', () => {
    setLang('ru');
    expect(plural(3, 'Добавлено файлов: {count}')).toBe('Добавлено файлов: 3');
    setLang('en');
    expect(plural(1, 'Добавлено файлов: {count}')).toBe('Added 1 file');
    expect(plural(3, 'Добавлено файлов: {count}')).toBe('Added 3 files');
    expect(plural(3, 'Найдено в коде: {count}{more}', { more: '+' })).toBe('3+ matches in code');
  });
});

describe('formatting follows the language', () => {
  it('formats sizes', () => {
    setLang('ru');
    expect(formatBytes(512)).toBe('512 Б');
    expect(formatBytes(1536)).toBe('1,5 КБ');
    expect(formatBytes(5 * 1048576)).toBe('5,0 МБ');
    setLang('en');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1048576)).toBe('5.0 MB');
  });

  it('localizes sample projects but keeps code identifiers', () => {
    setLang('en');
    const files = templateFiles('python', 'Demo');
    const main = (files['main.py'] as { content: string }).content;
    expect(main).toContain("print('Orders:', len(orders))");
    expect(main).toContain('from calculations import total');
    expect((files['calculations.py'] as { content: string }).content).toContain('def total(orders):');
    const web = (templateFiles('web', 'Demo')['index.html'] as { content: string }).content;
    expect(web).toContain('<html lang="en">');
    expect(web).not.toMatch(/[А-Яа-яЁё]/);
    setLang('ru');
    expect((templateFiles('python', 'Demo')['main.py'] as { content: string }).content).toContain("print('Заказов:', len(orders))");
  });
});

describe('worker messages', () => {
  it('are translated on the main thread, other output passes through', () => {
    setLang('en');
    expect(localizeWorkerText('Загрузка Python…')).toBe('Loading Python…');
    expect(localizeWorkerText('Не удалось загрузить PHP: boom')).toBe('Couldn’t load PHP: boom');
    expect(localizeWorkerText('input(): поле «Ввод» закончилось — добавьте строки перед запуском.\n')).toBe(
      'input(): no lines left in “Input for input()”. Add lines before running.\n',
    );
    expect(localizeWorkerText('Привет, мир\n')).toBe('Привет, мир\n');
    setLang('ru');
    expect(localizeWorkerText('Загрузка Python…')).toBe('Загрузка Python…');
  });
});

describe('en.ts', () => {
  const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  // Markup and quotes must match: texts are put into HTML attributes and into quoted strings of sample code.
  const special = (s: string) => [...s].filter((c) => `<>"&'`.includes(c)).join('');

  it('keeps placeholders and HTML of every key', () => {
    for (const [key, value] of Object.entries(en)) {
      for (const form of value.split('|')) {
        expect(placeholders(form), key).toEqual(placeholders(key));
        expect(special(form), key).toBe(special(key));
      }
      expect(value, key).not.toMatch(/[А-Яа-яЁё«»]/);
    }
  });
});

describe('every literal key used in src/ is translated', () => {
  const root = fileURLToPath(new URL('../../src', import.meta.url));
  // python.worker.ts is translated on the main thread (runtime/runner.ts).
  const skip = new Set(['runtime/python.worker.ts', 'i18n/en.ts']);
  const isDictionary = (rel: string) => rel.startsWith('i18n/en/') || rel.startsWith('i18n/locales/');
  const files = (readdirSync(root, { recursive: true }) as string[])
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(root, f))
    .filter((f) => !skip.has(relative(root, f).split('\\').join('/')) && !isDictionary(relative(root, f).split('\\').join('/')));

  const LIT = String.raw`'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|\`((?:\\.|[^\`\\$])*)\``;
  const patterns = [
    new RegExp(String.raw`\btr?\(\s*(?:${LIT})`, 'g'), // t('…'), and tr('…') where `t` is taken
    new RegExp(String.raw`\bplural\([^,;]+,\s*(?:${LIT})`, 'g'), // plural(n, '…')
    new RegExp(String.raw`\bmany:\s*(?:${LIT})`, 'g'), // RuForms passed to plural()
  ];
  const unescape = (s: string) => s.replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c));

  const used = new Map<string, string>();
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const re of patterns) {
      for (const m of text.matchAll(re)) used.set(unescape(m[1] ?? m[2] ?? m[3] ?? ''), relative(root, file));
    }
    for (const m of text.matchAll(/\btc\(\s*'([^']+)',\s*'((?:\\.|[^'\\])*)'/g)) used.set(`${unescape(m[2]!)} #${m[1]}`, relative(root, file));
  }

  it('finds the keys', () => {
    expect(used.size).toBeGreaterThan(350);
  });

  it('has an English text for each key', () => {
    const all = englishTexts();
    const missing = [...used].filter(([key]) => !Object.prototype.hasOwnProperty.call(all, key)).map(([key, file]) => `${file}: ${key}`);
    expect(missing).toEqual([]);
  });
});

describe('more languages', () => {
  it('matches system languages to supported ones', () => {
    expect(matchLang('pt-PT')).toBe('pt-BR');
    expect(matchLang('zh-CN')).toBe('zh-Hans');
    expect(matchLang('zh-TW')).toBeNull();
    expect(matchLang('uk-UA')).toBe('uk');
    expect(matchLang('be-BY')).toBe('ru');
    expect(matchLang('xx')).toBeNull();
  });

  it('picks plural forms by CLDR category order', () => {
    expect(pickPluralForm(1, 'a|b', 'en-US')).toBe('a');
    expect(pickPluralForm(5, 'a|b', 'en-US')).toBe('b');
    expect(pickPluralForm(3, '件', 'ja')).toBe('件');
    // Ukrainian: one|few|many|other
    expect(pickPluralForm(1, 'файл|файли|файлів|файлу', 'uk')).toBe('файл');
    expect(pickPluralForm(3, 'файл|файли|файлів|файлу', 'uk')).toBe('файли');
    expect(pickPluralForm(7, 'файл|файли|файлів|файлу', 'uk')).toBe('файлів');
  });
});
