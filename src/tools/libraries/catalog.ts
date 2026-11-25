/**
 * Front-end libraries that ship inside the app (public/libs/<id>/<version>/<file>, copied at build time
 * by scripts/copy-libs.mjs from the exact npm packages listed in scripts/libs-manifest.mjs). Adding one
 * to a project needs no internet. Descriptions and example labels are Russian keys translated with t().
 */

export interface LibFile {
  /** File name, both in the app bundle and in the project (`libs/<id>/<name>`). */
  name: string;
  kind: 'css' | 'js';
  /** Where the tag goes: CSS always in <head>; scripts before </body> unless 'head'. */
  place?: 'head' | 'body';
  defer?: boolean;
}

export interface Library {
  id: string;
  name: string;
  /** npm package the files come from. */
  pkg: string;
  version: string;
  license: string;
  homepage: string;
  description: string;
  tags: string[];
  files: LibFile[];
  /** A small snippet that shows the library working (inserted before </body>). */
  example: { label: string; html: string };
  /** Recognises the library included some other way (e.g. from a CDN). */
  detect: RegExp;
}

export const LIBRARIES: readonly Library[] = [
  {
    id: 'tailwindcss',
    name: 'Tailwind CSS',
    pkg: '@tailwindcss/browser',
    version: '4.3.5',
    license: 'MIT',
    homepage: 'https://tailwindcss.com',
    description: 'Утилитарные CSS-классы прямо в разметке. Браузерная сборка генерирует стили на лету — без сборки и без интернета.',
    tags: ['CSS', 'utility'],
    files: [{ name: 'tailwindcss.js', kind: 'js', place: 'head' }],
    example: {
      label: 'Карточка на Tailwind',
      html: `<div class="max-w-sm mx-auto my-8 p-6 rounded-2xl bg-white shadow-lg text-slate-800">
  <h2 class="text-xl font-bold mb-2">Tailwind CSS</h2>
  <p class="text-slate-600 mb-4">Utility classes work without a build step.</p>
  <button class="px-4 py-2 rounded-lg bg-sky-500 text-white font-semibold hover:bg-sky-600">Button</button>
</div>`,
    },
    detect: /tailwindcss(\/browser)?[@/]|cdn\.tailwindcss\.com/i,
  },
  {
    id: 'bootstrap',
    name: 'Bootstrap',
    pkg: 'bootstrap',
    version: '5.3.9',
    license: 'MIT',
    homepage: 'https://getbootstrap.com',
    description: 'Готовые компоненты и сетка: кнопки, карточки, формы, модальные окна. CSS и JS-бандл с Popper.',
    tags: ['CSS', 'JS', 'UI'],
    files: [
      { name: 'bootstrap.min.css', kind: 'css' },
      { name: 'bootstrap.bundle.min.js', kind: 'js' },
    ],
    example: {
      label: 'Карточка Bootstrap',
      html: `<div class="container my-4">
  <div class="card" style="max-width: 22rem">
    <div class="card-body">
      <h5 class="card-title">Bootstrap</h5>
      <p class="card-text">A card with a button and a tooltip.</p>
      <button type="button" class="btn btn-primary" data-bs-toggle="tooltip" data-bs-title="Hello!">Button</button>
    </div>
  </div>
</div>
<script>
  document.querySelectorAll('[data-bs-toggle="tooltip"]').forEach((el) => new bootstrap.Tooltip(el));
</script>`,
    },
    detect: /bootstrap(\.bundle)?(\.min)?\.(css|js)/i,
  },
  {
    id: 'vue',
    name: 'Vue 3',
    pkg: 'vue',
    version: '3.5.46',
    license: 'MIT',
    homepage: 'https://vuejs.org',
    description: 'Реактивный фреймворк для интерфейсов. Глобальная сборка: объект Vue доступен сразу, шаблоны пишутся в HTML.',
    tags: ['JS', 'framework'],
    files: [{ name: 'vue.global.prod.js', kind: 'js' }],
    example: {
      label: 'Счётчик на Vue',
      html: `<div id="vue-counter">
  <button @click="count++">Clicked {{ count }} times</button>
</div>
<script>
  Vue.createApp({ data: () => ({ count: 0 }) }).mount('#vue-counter');
</script>`,
    },
    detect: /vue(\.global|\.runtime\.global|\.esm-browser)?(\.prod)?\.js|unpkg\.com\/vue|\/npm\/vue@/i,
  },
  {
    id: 'alpinejs',
    name: 'Alpine.js',
    pkg: 'alpinejs',
    version: '3.17.5',
    license: 'MIT',
    homepage: 'https://alpinejs.dev',
    description: 'Лёгкая интерактивность прямо в разметке: x-data, x-on, x-show. Подключается с атрибутом defer.',
    tags: ['JS', 'lightweight'],
    files: [{ name: 'alpine.min.js', kind: 'js', defer: true }],
    example: {
      label: 'Счётчик на Alpine',
      html: `<div x-data="{ count: 0 }">
  <button x-on:click="count++">+1</button>
  <span x-text="count"></span>
</div>`,
    },
    detect: /alpine(js)?(\.min)?\.js|\/npm\/alpinejs@|alpinejs@\d/i,
  },
  {
    id: 'htmx',
    name: 'htmx',
    pkg: 'htmx.org',
    version: '2.0.11',
    license: '0BSD',
    homepage: 'https://htmx.org',
    description: 'AJAX, переходы и обновление частей страницы через HTML-атрибуты hx-get, hx-post, hx-target. Запросам нужен сервер.',
    tags: ['JS', 'AJAX'],
    files: [{ name: 'htmx.min.js', kind: 'js' }],
    example: {
      label: 'Загрузка фрагмента с htmx',
      html: `<button hx-get="fragment.html" hx-target="#htmx-result" hx-swap="innerHTML">Load fragment</button>
<div id="htmx-result"></div>`,
    },
    detect: /htmx(\.org)?(\.min)?\.js|\/npm\/htmx\.org@/i,
  },
  {
    id: 'chartjs',
    name: 'Chart.js',
    pkg: 'chart.js',
    version: '4.6.2',
    license: 'MIT',
    homepage: 'https://www.chartjs.org',
    description: 'Графики на canvas: линии, столбцы, круговые диаграммы. UMD-сборка, объект Chart.',
    tags: ['JS', 'charts'],
    files: [{ name: 'chart.umd.min.js', kind: 'js' }],
    example: {
      label: 'Столбчатый график',
      html: `<div style="max-width: 480px"><canvas id="demo-chart"></canvas></div>
<script>
  new Chart(document.getElementById('demo-chart'), {
    type: 'bar',
    data: { labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], datasets: [{ label: 'Visits', data: [12, 19, 7, 15, 22] }] },
  });
</script>`,
    },
    detect: /chart(\.umd)?(\.min)?\.js|\/npm\/chart\.js@/i,
  },
  {
    id: 'lodash',
    name: 'Lodash',
    pkg: 'lodash',
    version: '4.18.1',
    license: 'MIT',
    homepage: 'https://lodash.com',
    description: 'Утилиты для массивов, объектов и строк: debounce, groupBy, cloneDeep и сотни других. Объект _.',
    tags: ['JS', 'utility'],
    files: [{ name: 'lodash.min.js', kind: 'js' }],
    example: {
      label: 'Группировка с lodash',
      html: `<pre id="lodash-demo"></pre>
<script>
  const people = [{ name: 'Ann', team: 'A' }, { name: 'Bob', team: 'B' }, { name: 'Eve', team: 'A' }];
  document.getElementById('lodash-demo').textContent = JSON.stringify(_.groupBy(people, 'team'), null, 2);
</script>`,
    },
    detect: /lodash(\.min)?\.js|\/npm\/lodash@/i,
  },
  {
    id: 'dayjs',
    name: 'Day.js',
    pkg: 'dayjs',
    version: '1.11.23',
    license: 'MIT',
    homepage: 'https://day.js.org',
    description: 'Крошечная библиотека для дат: разбор, форматирование и арифметика. Объект dayjs.',
    tags: ['JS', 'dates'],
    files: [{ name: 'dayjs.min.js', kind: 'js' }],
    example: {
      label: 'Форматирование дат',
      html: `<p id="dayjs-demo"></p>
<script>
  document.getElementById('dayjs-demo').textContent =
    'Today: ' + dayjs().format('YYYY-MM-DD') + ', in a week: ' + dayjs().add(7, 'day').format('dddd, D MMMM');
</script>`,
    },
    detect: /dayjs(\.min)?\.js|\/npm\/dayjs@/i,
  },
  {
    id: 'animatecss',
    name: 'Animate.css',
    pkg: 'animate.css',
    version: '4.1.1',
    license: 'MIT',
    homepage: 'https://animate.style',
    description: 'Готовые CSS-анимации: классы animate__animated и animate__bounce, fadeIn, pulse и другие.',
    tags: ['CSS', 'animation'],
    files: [{ name: 'animate.min.css', kind: 'css' }],
    example: {
      label: 'Анимированный заголовок',
      html: `<h1 class="animate__animated animate__bounce">Animate.css</h1>`,
    },
    detect: /animate(\.min)?\.css/i,
  },
];

export const libraryById = (id: string): Library | undefined => LIBRARIES.find((l) => l.id === id);

/** Path of a library file inside the app bundle (relative to the app's base URL). */
export const bundledPath = (lib: Library, file: LibFile): string => `libs/${lib.id}/${lib.version}/${file.name}`;

/** Path of a library file inside a project. */
export const projectPath = (lib: Library, file: LibFile): string => `libs/${lib.id}/${file.name}`;
