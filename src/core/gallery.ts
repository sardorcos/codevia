import { bundledPath, libraryById, projectPath } from '../tools/libraries/catalog';
import { binaryFile, textFile, type Files, type Language } from './types';

/**
 * Ready-made starter projects for the "New project" sheet. Templates that use front-end libraries get
 * the library files copied from the app bundle (public/libs, the same files as the Libraries tool),
 * so every template works offline. Titles and descriptions are Russian keys translated with t().
 */
export interface GalleryTemplate {
  id: string;
  title: string;
  description: string;
  language: Language;
  icon: string;
  /** Ids of bundled libraries (src/tools/libraries/catalog.ts); their files are copied into libs/<id>/. */
  libs: string[];
  files: () => Files;
  /** First screen after creation. */
  view: 'preview' | 'code';
}

const page = (title: string, head: string, body: string) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
${head}
</head>
<body>
${body}
</body>
</html>
`;

export const GALLERY: readonly GalleryTemplate[] = [
  {
    id: 'tailwind-landing',
    title: 'Лендинг на Tailwind',
    description: 'Адаптивная страница продукта: шапка, преимущества, тарифы',
    language: 'web',
    icon: 'grid',
    view: 'preview',
    libs: ['tailwindcss'],
    files: () => ({
      'index.html': textFile(
        page(
          'Launch',
          '  <script src="libs/tailwindcss/tailwindcss.js"></script>',
          `  <header class="px-6 py-5 flex items-center justify-between max-w-5xl mx-auto">
    <strong class="text-xl tracking-tight">launch<span class="text-sky-500">.</span></strong>
    <a href="#pricing" class="text-sm font-semibold text-sky-600">Pricing</a>
  </header>
  <main class="max-w-5xl mx-auto px-6">
    <section class="py-16 text-center">
      <p class="text-sm font-semibold tracking-widest text-sky-600 uppercase">New</p>
      <h1 class="mt-3 text-4xl sm:text-6xl font-extrabold tracking-tight text-slate-900">Ship your idea this week</h1>
      <p class="mt-5 text-lg text-slate-600 max-w-xl mx-auto">A clean starter built with Tailwind utility classes. Edit the text and watch the preview update.</p>
      <a href="#pricing" class="inline-block mt-8 px-6 py-3 rounded-xl bg-sky-500 text-white font-semibold shadow-lg shadow-sky-500/30">Get started</a>
    </section>
    <section class="grid sm:grid-cols-3 gap-4 pb-16">
      <div class="p-6 rounded-2xl bg-white shadow"><h3 class="font-bold">Fast</h3><p class="text-slate-600 mt-2">No build step, works offline.</p></div>
      <div class="p-6 rounded-2xl bg-white shadow"><h3 class="font-bold">Responsive</h3><p class="text-slate-600 mt-2">Looks right on every screen.</p></div>
      <div class="p-6 rounded-2xl bg-white shadow"><h3 class="font-bold">Yours</h3><p class="text-slate-600 mt-2">Plain HTML you can publish anywhere.</p></div>
    </section>
    <section id="pricing" class="pb-20 grid sm:grid-cols-2 gap-4">
      <div class="p-8 rounded-2xl border border-slate-200 bg-white"><h3 class="font-bold text-lg">Free</h3><p class="text-4xl font-extrabold mt-2">$0</p></div>
      <div class="p-8 rounded-2xl bg-slate-900 text-white"><h3 class="font-bold text-lg">Pro</h3><p class="text-4xl font-extrabold mt-2">$9</p></div>
    </section>
  </main>`,
        ).replace('<body>', '<body class="bg-slate-50 text-slate-800">'),
      ),
    }),
  },
  {
    id: 'vue-todo',
    title: 'Список дел на Vue',
    description: 'Vue 3: добавление, фильтры, сохранение в localStorage',
    language: 'web',
    icon: 'check',
    view: 'preview',
    libs: ['vue'],
    files: () => ({
      'index.html': textFile(
        page(
          'Todo',
          '  <link rel="stylesheet" href="style.css" />',
          `  <div id="app" class="card">
    <h1>Todo</h1>
    <form @submit.prevent="add"><input v-model="text" placeholder="What needs doing?" /><button>Add</button></form>
    <ul>
      <li v-for="t in visible" :key="t.id" :class="{ done: t.done }">
        <label><input type="checkbox" v-model="t.done" /> {{ t.text }}</label>
        <button class="x" @click="remove(t)" aria-label="Delete">×</button>
      </li>
    </ul>
    <nav><button v-for="f in ['all', 'active', 'done']" :key="f" :class="{ on: filter === f }" @click="filter = f">{{ f }}</button></nav>
    <p class="muted">{{ left }} left</p>
  </div>
  <script src="libs/vue/vue.global.prod.js"></script>
  <script src="app.js"></script>`,
        ),
      ),
      'app.js': textFile(`const { createApp } = Vue;

createApp({
  data: () => ({
    text: '',
    filter: 'all',
    todos: JSON.parse(localStorage.getItem('todos') || '[]'),
  }),
  computed: {
    visible() {
      if (this.filter === 'active') return this.todos.filter((t) => !t.done);
      if (this.filter === 'done') return this.todos.filter((t) => t.done);
      return this.todos;
    },
    left() {
      return this.todos.filter((t) => !t.done).length;
    },
  },
  watch: {
    todos: { deep: true, handler: (v) => localStorage.setItem('todos', JSON.stringify(v)) },
  },
  methods: {
    add() {
      if (!this.text.trim()) return;
      this.todos.push({ id: Date.now(), text: this.text.trim(), done: false });
      this.text = '';
    },
    remove(t) {
      this.todos = this.todos.filter((x) => x !== t);
    },
  },
}).mount('#app');
`),
      'style.css': textFile(`body { font-family: system-ui, sans-serif; background: #eef4fb; margin: 0; padding: 24px; }
.card { max-width: 420px; margin: auto; background: #fff; border-radius: 16px; padding: 20px; box-shadow: 0 10px 30px #0001; }
form { display: flex; gap: 8px; }
input:not([type]) { flex: 1; padding: 10px; border: 1px solid #ccd; border-radius: 10px; font-size: 16px; }
button { padding: 10px 14px; border: 0; border-radius: 10px; background: #40c8f6; font-weight: 600; }
ul { list-style: none; padding: 0; }
li { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #eee; }
li.done label { text-decoration: line-through; color: #889; }
.x { background: none; font-size: 20px; }
nav { display: flex; gap: 6px; } nav button { background: #eef; } nav .on { background: #40c8f6; }
.muted { color: #889; }
`),
    }),
  },
  {
    id: 'alpine-widgets',
    title: 'Виджеты на Alpine.js',
    description: 'Счётчик, вкладки и аккордеон в несколько строк разметки',
    language: 'web',
    icon: 'sliders',
    view: 'preview',
    libs: ['alpinejs'],
    files: () => ({
      'index.html': textFile(
        page(
          'Alpine widgets',
          '  <link rel="stylesheet" href="style.css" />\n  <script defer src="libs/alpinejs/alpine.min.js"></script>',
          `  <section x-data="{ count: 0 }" class="box">
    <h2>Counter</h2>
    <button @click="count--">−</button> <strong x-text="count"></strong> <button @click="count++">+</button>
  </section>
  <section x-data="{ tab: 'html' }" class="box">
    <h2>Tabs</h2>
    <nav><button @click="tab = 'html'" :class="tab === 'html' && 'on'">HTML</button><button @click="tab = 'css'" :class="tab === 'css' && 'on'">CSS</button></nav>
    <p x-show="tab === 'html'">Structure of the page.</p>
    <p x-show="tab === 'css'">How it looks.</p>
  </section>
  <section x-data="{ open: false }" class="box">
    <h2>Accordion</h2>
    <button @click="open = !open" x-text="open ? 'Hide details' : 'Show details'"></button>
    <p x-show="open" x-transition>Alpine adds behaviour right in the HTML.</p>
  </section>`,
        ),
      ),
      'style.css': textFile(`body { font-family: system-ui, sans-serif; background: #f6f3ff; padding: 20px; }
.box { background: #fff; border-radius: 16px; padding: 16px 20px; margin: 0 auto 14px; max-width: 420px; box-shadow: 0 8px 24px #0001; }
button { padding: 8px 14px; border: 0; border-radius: 10px; background: #e7e0ff; font-weight: 600; margin-right: 6px; }
button.on { background: #8b5cf6; color: #fff; }
strong { font-size: 24px; padding: 0 10px; }
`),
    }),
  },
  {
    id: 'chart-dashboard',
    title: 'Дашборд с Chart.js',
    description: 'Графики продаж и долей из JSON-файла проекта',
    language: 'web',
    icon: 'grid',
    view: 'preview',
    libs: ['chartjs'],
    files: () => ({
      'index.html': textFile(
        page(
          'Dashboard',
          '  <link rel="stylesheet" href="style.css" />',
          `  <h1>Sales dashboard</h1>
  <div class="grid">
    <div class="card"><canvas id="sales"></canvas></div>
    <div class="card"><canvas id="share"></canvas></div>
  </div>
  <script src="libs/chartjs/chart.umd.min.js"></script>
  <script src="app.js"></script>`,
        ),
      ),
      'app.js': textFile(`const data = await (await fetch('data/sales.json')).json();

new Chart(document.getElementById('sales'), {
  type: 'line',
  data: { labels: data.months, datasets: [{ label: 'Sales', data: data.sales, borderColor: '#40c8f6', tension: 0.35, fill: false }] },
});

new Chart(document.getElementById('share'), {
  type: 'doughnut',
  data: { labels: Object.keys(data.channels), datasets: [{ data: Object.values(data.channels), backgroundColor: ['#40c8f6', '#8b5cf6', '#60d7af'] }] },
});
`),
      'data/sales.json': textFile(
        JSON.stringify({ months: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'], sales: [12, 19, 15, 25, 31, 38], channels: { Web: 55, App: 30, Retail: 15 } }, null, 2) + '\n',
      ),
      'style.css': textFile(`body { font-family: system-ui, sans-serif; background: #0f1520; color: #e8eef6; padding: 20px; }
.grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
.card { background: #182233; border-radius: 16px; padding: 14px; }
`),
    }),
  },
  {
    id: 'bootstrap-page',
    title: 'Страница на Bootstrap',
    description: 'Навигация, карточки и форма с проверкой полей',
    language: 'web',
    icon: 'grid',
    view: 'preview',
    libs: ['bootstrap'],
    files: () => ({
      'index.html': textFile(
        page(
          'Bootstrap',
          '  <link rel="stylesheet" href="libs/bootstrap/bootstrap.min.css" />',
          `  <nav class="navbar navbar-dark bg-dark px-3"><span class="navbar-brand">Studio</span></nav>
  <main class="container py-4">
    <div class="row g-3">
      <div class="col-md-4"><div class="card"><div class="card-body"><h5 class="card-title">Design</h5><p class="card-text">Cards, grid and utilities.</p></div></div></div>
      <div class="col-md-4"><div class="card"><div class="card-body"><h5 class="card-title">Code</h5><p class="card-text">Components that just work.</p></div></div></div>
      <div class="col-md-4"><div class="card"><div class="card-body"><h5 class="card-title">Launch</h5><p class="card-text">Publish to GitHub Pages.</p></div></div></div>
    </div>
    <form class="mt-4 needs-validation" novalidate>
      <div class="mb-3"><label class="form-label" for="email">Email</label><input type="email" class="form-control" id="email" required><div class="invalid-feedback">Enter a valid email.</div></div>
      <button class="btn btn-primary">Subscribe</button>
    </form>
  </main>
  <script src="libs/bootstrap/bootstrap.bundle.min.js"></script>
  <script>
    document.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      e.target.classList.add('was-validated');
      if (e.target.checkValidity()) alert('Subscribed!');
    });
  </script>`,
        ),
      ),
    }),
  },
  {
    id: 'python-data',
    title: 'Анализ данных на Python',
    description: 'pandas и matplotlib: CSV, сводная таблица и график',
    language: 'python',
    icon: 'terminal',
    view: 'code',
    libs: [],
    files: () => ({
      'main.py': textFile(`import pandas as pd
import matplotlib.pyplot as plt

df = pd.read_csv("data/sales.csv")
print(df.head())

summary = df.groupby("region")["amount"].agg(["count", "sum", "mean"]).round(1)
print("\\nBy region:")
print(summary)

monthly = df.groupby("month")["amount"].sum()
monthly.plot(kind="bar", color="#40c8f6", title="Sales by month")
plt.ylabel("amount")
plt.tight_layout()
plt.show()
`),
      'data/sales.csv': textFile(
        'month,region,amount\n' +
          ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun']
            .flatMap((m, i) => ['North', 'South', 'West'].map((r, j) => `${m},${r},${100 + i * 15 + j * 22 + ((i * j) % 7) * 9}`))
            .join('\n') +
          '\n',
      ),
    }),
  },
  {
    id: 'php-form',
    title: 'Форма на PHP',
    description: 'Обработка $_POST, проверка полей и безопасный вывод',
    language: 'php',
    icon: 'server',
    view: 'preview',
    libs: [],
    files: () => ({
      'index.php': textFile(`<?php
$name = trim($_POST['name'] ?? '');
$message = trim($_POST['message'] ?? '');
$errors = [];
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    if ($name === '') $errors[] = 'Name is required';
    if (strlen($message) < 3) $errors[] = 'Message is too short';
}
?>
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Guestbook</title>
<style>body{font-family:system-ui,sans-serif;max-width:420px;margin:24px auto;padding:0 16px}input,textarea{width:100%;padding:10px;margin:6px 0 12px;border:1px solid #ccd;border-radius:10px;font-size:16px}button{padding:10px 16px;border:0;border-radius:10px;background:#8b5cf6;color:#fff;font-weight:600}.error{color:#c0392b}.ok{background:#eafaf1;padding:12px;border-radius:10px}</style></head>
<body>
<h1>Guestbook</h1>
<?php if ($_SERVER['REQUEST_METHOD'] === 'POST' && !$errors): ?>
  <p class="ok">Thanks, <strong><?= htmlspecialchars($name) ?></strong>! Your message: “<?= htmlspecialchars($message) ?>”</p>
<?php endif; ?>
<?php foreach ($errors as $e): ?><p class="error"><?= htmlspecialchars($e) ?></p><?php endforeach; ?>
<form method="post">
  <label>Name <input name="name" value="<?= htmlspecialchars($name) ?>"></label>
  <label>Message <textarea name="message" rows="3"><?= htmlspecialchars($message) ?></textarea></label>
  <button>Send</button>
</form>
</body>
</html>
`),
    }),
  },
  {
    id: 'js-guess',
    title: 'Игра «Угадай число» на JS',
    description: 'Диалог с prompt(), циклы и условия в TypeScript',
    language: 'javascript',
    icon: 'code',
    view: 'code',
    libs: [],
    files: () => ({
      'main.ts': textFile(`const secret = Math.floor(Math.random() * 100) + 1;
let tries = 0;

console.log('I picked a number from 1 to 100. Can you guess it?');

while (true) {
  const answer = prompt('Your guess: ');
  if (answer === null) break;
  const n = Number(answer);
  tries++;
  if (Number.isNaN(n)) console.log('That is not a number.');
  else if (n < secret) console.log('Higher ⬆');
  else if (n > secret) console.log('Lower ⬇');
  else {
    console.log(\`Correct! \${secret} in \${tries} tries.\`);
    break;
  }
}
`),
    }),
  },
];

export const galleryTemplate = (id: string) => GALLERY.find((g) => g.id === id);

/** Files of a template, with the bundled library files fetched from the app (offline). */
export async function galleryFiles(tpl: GalleryTemplate, fetchFile: (url: string) => Promise<Uint8Array> = defaultFetch): Promise<Files> {
  const files = tpl.files();
  for (const id of tpl.libs) {
    const lib = libraryById(id);
    if (!lib) throw new Error(`Unknown library ${id}`);
    for (const file of lib.files) {
      const bytes = await fetchFile(bundledPath(lib, file));
      files[projectPath(lib, file)] = /\.(css|js)$/.test(file.name) ? textFile(new TextDecoder().decode(bytes)) : binaryFile(bytes);
    }
  }
  return files;
}

async function defaultFetch(path: string): Promise<Uint8Array> {
  const res = await fetch(new URL(path, document.baseURI));
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
