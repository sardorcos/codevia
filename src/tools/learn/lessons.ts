import { textFile, type Files, type Language } from '../../core/types';

/**
 * Mini-courses: short lessons with a task and an automatic check. Texts are Russian keys translated
 * with t() (English in src/i18n/en/learn.ts). Every lesson carries a reference solution, and the unit
 * tests prove each check fails on the starter files and passes on the solution.
 */
export type Check =
  /** Program output must contain every string (Python / JavaScript); `stdin` feeds input()/prompt(). */
  | { kind: 'output'; contains: string[]; stdin?: string }
  /** Files must match every pattern (web lessons). `message` is shown when a rule fails. */
  | { kind: 'files'; rules: Array<{ file: string; pattern: RegExp; message: string }> };

export interface Lesson {
  id: string;
  title: string;
  /** Short explanation of the idea. */
  explain: string;
  /** What to do. */
  task: string;
  hint: string;
  /** Files written when the lesson starts (others in the project are kept). */
  starter: Files;
  solution: Files;
  check: Check;
}

export interface Course {
  id: string;
  title: string;
  description: string;
  language: Language;
  icon: string;
  lessons: Lesson[];
}

const html = (body: string, extraHead = '') => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="stylesheet" href="style.css" />${extraHead}
</head>
<body>
${body}
</body>
</html>
`;

const webBase = (body: string, css = 'body { font-family: system-ui, sans-serif; padding: 20px; }\n'): Files => ({
  'index.html': textFile(html(body)),
  'style.css': textFile(css),
});

export const COURSES: readonly Course[] = [
  {
    id: 'web',
    title: 'Основы HTML и CSS',
    description: 'Страница с нуля: заголовки, ссылки, списки, цвета и раскладка',
    language: 'web',
    icon: 'code',
    lessons: [
      {
        id: 'web-1',
        title: 'Заголовок и абзац',
        explain: 'HTML описывает структуру страницы тегами. <h1> — главный заголовок, <p> — абзац текста.',
        task: 'Добавьте в index.html заголовок <h1> с вашим именем и абзац <p> о себе.',
        hint: 'Например: <h1>Анна</h1> и <p>Я учусь программировать.</p>',
        starter: webBase('  <!-- Your code here -->'),
        solution: webBase('  <h1>Anna</h1>\n  <p>I am learning to code.</p>'),
        check: {
          kind: 'files',
          rules: [
            { file: 'index.html', pattern: /<h1[^>]*>\s*\S[\s\S]*?<\/h1>/i, message: 'Нужен заголовок <h1> с текстом' },
            { file: 'index.html', pattern: /<p[^>]*>\s*\S[\s\S]*?<\/p>/i, message: 'Нужен абзац <p> с текстом' },
          ],
        },
      },
      {
        id: 'web-2',
        title: 'Ссылка и картинка',
        explain: '<a href="…"> делает ссылку, <img src="…" alt="…"> показывает картинку. Атрибут alt описывает картинку для тех, кто её не видит.',
        task: 'Добавьте ссылку <a> с атрибутом href и картинку <img> с атрибутами src и alt.',
        hint: 'Картинку можно взять из интернета или добавить файл в проект: <img src="photo.jpg" alt="Моё фото">',
        starter: webBase('  <h1>My page</h1>\n  <!-- Add a link and an image -->'),
        solution: webBase('  <h1>My page</h1>\n  <a href="https://github.com">GitHub</a>\n  <img src="photo.jpg" alt="My photo" />'),
        check: {
          kind: 'files',
          rules: [
            { file: 'index.html', pattern: /<a\s[^>]*href\s*=\s*["'][^"']+["'][^>]*>/i, message: 'Нужна ссылка <a> с атрибутом href' },
            { file: 'index.html', pattern: /<img\s(?=[^>]*\bsrc\s*=\s*["'][^"']+["'])(?=[^>]*\balt\s*=\s*["'][^"']*["'])[^>]*>/i, message: 'Нужна картинка <img> с атрибутами src и alt' },
          ],
        },
      },
      {
        id: 'web-3',
        title: 'Список',
        explain: '<ul> — маркированный список, каждый пункт — <li>. Для нумерованного списка есть <ol>.',
        task: 'Сделайте список <ul> минимум из трёх пунктов <li>: например, ваши любимые фильмы.',
        hint: '<ul>\n  <li>Один</li>\n  <li>Два</li>\n  <li>Три</li>\n</ul>',
        starter: webBase('  <h1>Favourites</h1>\n  <!-- Your list here -->'),
        solution: webBase('  <h1>Favourites</h1>\n  <ul>\n    <li>One</li>\n    <li>Two</li>\n    <li>Three</li>\n  </ul>'),
        check: {
          kind: 'files',
          rules: [{ file: 'index.html', pattern: /<ul[^>]*>(?:[\s\S]*?<li[^>]*>[\s\S]*?<\/li>){3}[\s\S]*?<\/ul>/i, message: 'Нужен список <ul> минимум с тремя <li>' }],
        },
      },
      {
        id: 'web-4',
        title: 'Цвета в CSS',
        explain: 'CSS задаёт внешний вид: селектор выбирает элементы, а свойства внутри { } меняют их стиль.',
        task: 'В style.css задайте фон страницы (background для body) и цвет заголовка (color для h1).',
        hint: 'body { background: #f4f9ff; }\nh1 { color: #1677a6; }',
        starter: webBase('  <h1>Colours</h1>\n  <p>Make me beautiful.</p>'),
        solution: webBase('  <h1>Colours</h1>\n  <p>Make me beautiful.</p>', 'body { background: #f4f9ff; }\nh1 { color: #1677a6; }\n'),
        check: {
          kind: 'files',
          rules: [
            { file: 'style.css', pattern: /(^|[\s,}])body\s*\{[^}]*\bbackground(-color)?\s*:/i, message: 'Задайте background для body в style.css' },
            { file: 'style.css', pattern: /(^|[\s,}])h1\s*\{[^}]*(^|[;\s{])color\s*:/i, message: 'Задайте color для h1 в style.css' },
          ],
        },
      },
      {
        id: 'web-5',
        title: 'Раскладка Flexbox',
        explain: 'display: flex выстраивает дочерние элементы в ряд, а gap задаёт расстояние между ними.',
        task: 'Сделайте блок .cards гибким контейнером: display: flex и gap в style.css.',
        hint: '.cards { display: flex; gap: 12px; }',
        starter: webBase('  <div class="cards">\n    <div class="card">A</div>\n    <div class="card">B</div>\n    <div class="card">C</div>\n  </div>', '.card { padding: 20px; background: #e7f6fd; border-radius: 12px; }\n'),
        solution: webBase(
          '  <div class="cards">\n    <div class="card">A</div>\n    <div class="card">B</div>\n    <div class="card">C</div>\n  </div>',
          '.card { padding: 20px; background: #e7f6fd; border-radius: 12px; }\n.cards { display: flex; gap: 12px; }\n',
        ),
        check: {
          kind: 'files',
          rules: [
            { file: 'style.css', pattern: /\.cards\s*\{[^}]*display\s*:\s*(inline-)?flex/i, message: 'Нужно display: flex для .cards' },
            { file: 'style.css', pattern: /\.cards\s*\{[^}]*\bgap\s*:/i, message: 'Нужно свойство gap для .cards' },
          ],
        },
      },
    ],
  },
  {
    id: 'js',
    title: 'Основы JavaScript',
    description: 'Вывод, переменные, функции, массивы и ввод',
    language: 'javascript',
    icon: 'code',
    lessons: [
      {
        id: 'js-1',
        title: 'Первая программа',
        explain: 'console.log печатает значение в консоль. Строки пишутся в кавычках.',
        task: 'Напечатайте текст Hello, Codevia!',
        hint: "console.log('Hello, Codevia!');",
        starter: { 'main.js': textFile('// Print a greeting\n') },
        solution: { 'main.js': textFile("console.log('Hello, Codevia!');\n") },
        check: { kind: 'output', contains: ['Hello, Codevia!'] },
      },
      {
        id: 'js-2',
        title: 'Переменные и шаблонные строки',
        explain: 'const сохраняет значение под именем. В строке в обратных кавычках `…` можно подставить ${переменную}.',
        task: 'Создайте переменную name со значением "Codevia" и напечатайте Hi, Codevia! с помощью шаблонной строки.',
        hint: "const name = 'Codevia';\nconsole.log(`Hi, ${name}!`);",
        starter: { 'main.js': textFile('// const name = ...\n') },
        solution: { 'main.js': textFile("const name = 'Codevia';\nconsole.log(`Hi, ${name}!`);\n") },
        check: { kind: 'output', contains: ['Hi, Codevia!'] },
      },
      {
        id: 'js-3',
        title: 'Функции',
        explain: 'Функция — именованный кусок кода: принимает параметры и возвращает результат через return.',
        task: 'Напишите функцию sum(a, b), которая возвращает сумму, и напечатайте sum(2, 3).',
        hint: 'function sum(a, b) {\n  return a + b;\n}\nconsole.log(sum(2, 3));',
        starter: { 'main.js': textFile('// function sum(a, b) { ... }\n') },
        solution: { 'main.js': textFile('function sum(a, b) {\n  return a + b;\n}\nconsole.log(sum(2, 3));\n') },
        check: { kind: 'output', contains: ['5'] },
      },
      {
        id: 'js-4',
        title: 'Массивы',
        explain: 'Массив хранит список значений. Метод reduce сворачивает массив в одно значение, например в сумму.',
        task: 'Напечатайте сумму чисел массива numbers.',
        hint: 'console.log(numbers.reduce((total, n) => total + n, 0));',
        starter: { 'main.js': textFile('const numbers = [4, 8, 15, 16, 23, 42];\n// Print the sum\n') },
        solution: { 'main.js': textFile('const numbers = [4, 8, 15, 16, 23, 42];\nconsole.log(numbers.reduce((total, n) => total + n, 0));\n') },
        check: { kind: 'output', contains: ['108'] },
      },
      {
        id: 'js-5',
        title: 'Ввод данных',
        explain: 'prompt() спрашивает пользователя и возвращает введённую строку.',
        task: 'Спросите имя через prompt() и напечатайте Hello, <имя>!',
        hint: "const name = prompt('Your name: ');\nconsole.log(`Hello, ${name}!`);",
        starter: { 'main.js': textFile('// Ask for a name and greet\n') },
        solution: { 'main.js': textFile("const name = prompt('Your name: ');\nconsole.log(`Hello, ${name}!`);\n") },
        check: { kind: 'output', contains: ['Hello, Codevia!'], stdin: 'Codevia' },
      },
    ],
  },
  {
    id: 'python',
    title: 'Основы Python',
    description: 'print, переменные, условия, циклы и функции',
    language: 'python',
    icon: 'terminal',
    lessons: [
      {
        id: 'py-1',
        title: 'Первая программа',
        explain: 'print() печатает значение. Строки пишутся в кавычках.',
        task: 'Напечатайте текст Hello, Codevia!',
        hint: 'print("Hello, Codevia!")',
        starter: { 'main.py': textFile('# Print a greeting\n') },
        solution: { 'main.py': textFile('print("Hello, Codevia!")\n') },
        check: { kind: 'output', contains: ['Hello, Codevia!'] },
      },
      {
        id: 'py-2',
        title: 'Переменные и арифметика',
        explain: 'Переменная хранит значение: a = 7. Python считает как калькулятор: + - * /.',
        task: 'Напечатайте произведение переменных a и b.',
        hint: 'print(a * b)',
        starter: { 'main.py': textFile('a = 7\nb = 5\n# Print a times b\n') },
        solution: { 'main.py': textFile('a = 7\nb = 5\nprint(a * b)\n') },
        check: { kind: 'output', contains: ['35'] },
      },
      {
        id: 'py-3',
        title: 'Условия',
        explain: 'if выполняет блок, только если условие истинно; else — иначе. Остаток от деления: n % 2.',
        task: 'Напечатайте odd, если n нечётное, и even, если чётное.',
        hint: 'if n % 2 == 0:\n    print("even")\nelse:\n    print("odd")',
        starter: { 'main.py': textFile('n = 7\n# odd or even?\n') },
        solution: { 'main.py': textFile('n = 7\nif n % 2 == 0:\n    print("even")\nelse:\n    print("odd")\n') },
        check: { kind: 'output', contains: ['odd'] },
      },
      {
        id: 'py-4',
        title: 'Циклы',
        explain: 'for повторяет блок для каждого значения. range(1, 6) — числа от 1 до 5.',
        task: 'Напечатайте квадраты чисел от 1 до 5, каждый на новой строке.',
        hint: 'for i in range(1, 6):\n    print(i * i)',
        starter: { 'main.py': textFile('# Squares of 1..5\n') },
        solution: { 'main.py': textFile('for i in range(1, 6):\n    print(i * i)\n') },
        check: { kind: 'output', contains: ['1\n4\n9\n16\n25'] },
      },
      {
        id: 'py-5',
        title: 'Функции',
        explain: 'def создаёт функцию, return возвращает результат. f-строки подставляют значения: f"Hi, {name}!".',
        task: 'Напишите функцию greet(name), которая возвращает Hi, <name>!, и напечатайте greet("Codevia").',
        hint: 'def greet(name):\n    return f"Hi, {name}!"\n\nprint(greet("Codevia"))',
        starter: { 'main.py': textFile('# def greet(name): ...\n') },
        solution: { 'main.py': textFile('def greet(name):\n    return f"Hi, {name}!"\n\n\nprint(greet("Codevia"))\n') },
        check: { kind: 'output', contains: ['Hi, Codevia!'] },
      },
    ],
  },
];

export const courseById = (id: string) => COURSES.find((c) => c.id === id);

/** Result of checking a lesson against the project's files or the program's output. */
export interface CheckResult {
  ok: boolean;
  /** Russian keys of failed rules (files) or a summary of the expected output. */
  problems: string[];
}

export function checkFiles(check: Extract<Check, { kind: 'files' }>, files: Files): CheckResult {
  const problems = check.rules
    .filter((r) => {
      const f = files[r.file];
      return !f || !f.text || !r.pattern.test(f.content.replace(/<!--[\s\S]*?-->/g, ''));
    })
    .map((r) => r.message);
  return { ok: problems.length === 0, problems };
}

export function checkOutput(check: Extract<Check, { kind: 'output' }>, stdout: string): CheckResult {
  const out = stdout.replace(/\r\n/g, '\n');
  const missing = check.contains.filter((c) => !out.includes(c));
  return { ok: missing.length === 0, problems: missing };
}
