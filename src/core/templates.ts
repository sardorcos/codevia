import { getLang, t } from '../i18n';
import { textFile, type Files, type Language } from './types';

// Sample projects follow the interface language; code identifiers stay the same in both.

const web = (name: string): Files => ({
  'index.html': textFile(`<!doctype html>
<html lang="${getLang()}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${name}</title>
  <link rel="stylesheet" href="css/styles.css" />
</head>
<body>
  <header class="site-header">
    <strong>studio.</strong>
    <nav><a href="index.html">${t('Главная')}</a> <a href="about.html">${t('О нас')}</a></nav>
  </header>
  <main class="hero">
    <span class="eyebrow">${t('ДИЗАЙН И РАЗРАБОТКА')}</span>
    <h1>${t('Идеи становятся продуктами.')}</h1>
    <p id="tagline">${t('Создаём сайты и приложения.')}</p>
    <button class="action" id="contact">${t('Обсудить проект ↗')}</button>
    <img class="logo" src="img/logo.svg" alt="${t('Логотип')}" width="56" height="56" />
  </main>
  <script src="js/app.js"></script>
</body>
</html>
`),
  'about.html': textFile(`<!doctype html>
<html lang="${getLang()}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${t('О нас')}</title>
  <link rel="stylesheet" href="css/styles.css" />
</head>
<body>
  <header class="site-header">
    <strong>studio.</strong>
    <nav><a href="index.html">${t('Главная')}</a> <a href="about.html">${t('О нас')}</a></nav>
  </header>
  <main class="hero">
    <h1>${t('О студии')}</h1>
    <p>${t('Эта страница открылась по ссылке — предпросмотр поддерживает несколько страниц.')}</p>
  </main>
</body>
</html>
`),
  'css/styles.css': textFile(`:root { --accent: #40c8f6; }
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, sans-serif; background: #f4f9ff; color: #152033; }
a { color: #1677a6; margin-left: 12px; }
.site-header { display: flex; align-items: center; justify-content: space-between; padding: 22px; }
.site-header strong { font-size: 21px; letter-spacing: -1px; }
.hero { padding: 48px 24px 96px; }
.eyebrow { font-size: 12px; color: #60758e; font-weight: bold; letter-spacing: 2px; }
h1 { font-size: clamp(36px, 10vw, 64px); letter-spacing: -2px; line-height: 1.06; }
p { color: #4f5d75; margin-bottom: 25px; }
.action { border: 0; background: var(--accent); color: #10202a; border-radius: 12px; font-weight: 700; padding: 15px 20px; font-size: 16px; }
.logo { display: block; margin-top: 32px; }
`),
  'js/app.js': textFile(`const button = document.querySelector('#contact');
button.addEventListener('click', async () => {
  const response = await fetch('data/project.json');
  const data = await response.json();
  button.textContent = '${t('Спасибо! ✓')}';
  document.querySelector('#tagline').textContent = data.tagline;
  console.log('${t('Данные проекта:')}', data);
});
`),
  'data/project.json': textFile(JSON.stringify({ name, version: '1.0', tagline: t('Мы скоро свяжемся с вами.') }, null, 2) + '\n'),
  'img/logo.svg': textFile(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 56 56"><rect width="56" height="56" rx="14" fill="#0c0e12"/><circle cx="40" cy="38" r="5" fill="#40c8f6"/><path d="M30 18a12 12 0 1 0 0 20" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round"/></svg>
`),
  'README.md': textFile(`# ${name}\n\n${t('Сайт на HTML, CSS и JavaScript.')}\n`),
});

const python = (name: string): Files => ({
  'main.py': textFile(`import json
from calculations import total

with open('data/orders.json', encoding='utf-8') as f:
    orders = json.load(f)

print('${name}')
print('${t('Заказов:')}', len(orders))
print('${t('Сумма заказов:')}', total(orders))

name = input('${t('Как вас зовут? ')}')
print(f'${t('Привет, {name}!')}')
`),
  'calculations.py': textFile(`def total(orders):
    """${t('Возвращает сумму поля amount.')}"""
    return sum(item['amount'] for item in orders)
`),
  'data/orders.json': textFile(JSON.stringify([{ amount: 2700000 }, { amount: 1650000 }], null, 2) + '\n'),
  'README.md': textFile(`# ${name}\n\n${t('Python-проект. Откройте «Запуск» и нажмите «Запустить». Строка ввода передаётся в input().')}\n`),
});

const php = (name: string): Files => ({
  'index.php': textFile(`<?php
require_once __DIR__ . '/lib/view.php';
$name = $_GET['name'] ?? '${t('гость')}';
?>
<!doctype html>
<html lang="${getLang()}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="styles.css">
  <title>${name}</title>
</head>
<body>
  <?= greeting($name) ?>
  <p>PHP <?= PHP_VERSION ?> · <?= date('${getLang() === 'en' ? 'M j, Y' : 'd.m.Y'}') ?></p>
  <p><a href="index.php?name=Codevia">${t('Передать имя через ?name=')}</a></p>
</body>
</html>
`),
  'lib/view.php': textFile(`<?php
function greeting(string $name): string {
  return '<h1>${t('Привет, ')}' . htmlspecialchars($name) . '!</h1>';
}
`),
  'styles.css': textFile(`body { font-family: system-ui, sans-serif; padding: 36px; background: #f8fafc; color: #142b3c; }
a { color: #1677a6; }
`),
  'README.md': textFile(`# ${name}\n\n${t('PHP-проект. «Запуск» выполняет index.php и показывает результат.')}\n`),
});

export type TemplateId = Language | 'empty';

export function templateFiles(template: TemplateId, name: string): Files {
  if (template === 'python') return python(name);
  if (template === 'php') return php(name);
  if (template === 'empty') return { 'index.html': textFile(`<!doctype html>\n<html lang="${getLang()}">\n<head>\n  <meta charset="utf-8" />\n  <meta name="viewport" content="width=device-width, initial-scale=1" />\n  <title>${name}</title>\n</head>\n<body>\n\n</body>\n</html>\n`) };
  return web(name);
}

export const templateLanguage = (t: TemplateId): Language => (t === 'python' || t === 'php' ? t : 'web');

export function detectLanguage(paths: string[]): Language {
  const py = paths.filter((p) => p.endsWith('.py')).length;
  const php = paths.filter((p) => /\.(php|phtml)$/.test(p)).length;
  const html = paths.filter((p) => /\.html?$/.test(p)).length;
  if (php && php >= py) return 'php';
  if (py && py > html) return 'python';
  return 'web';
}

/** Picks the file that "Run"/"Preview" should start from. */
export function defaultEntry(paths: string[], language: Language): string | undefined {
  const by = (names: string[]) =>
    names.map((n) => paths.find((p) => p === n)).find(Boolean) ??
    names.map((n) => paths.filter((p) => p.endsWith('/' + n)).sort((a, b) => a.length - b.length)[0]).find(Boolean);
  if (language === 'python') return by(['main.py', 'app.py', '__main__.py']) ?? paths.find((p) => p.endsWith('.py'));
  if (language === 'php') return by(['index.php']) ?? paths.find((p) => p.endsWith('.php'));
  return by(['index.html', 'index.htm']) ?? paths.find((p) => /\.html?$/.test(p));
}
