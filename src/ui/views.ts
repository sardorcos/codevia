import { formatBytes } from '../core/bytes';
import { basename, dirname, extOf, fileKind, isTextPath } from '../core/paths';
import { searchProject } from '../core/search';
import type { Language, Project, ProjectMeta } from '../core/types';
import type { AppState, ConsoleLine } from '../state';
import { fmtNumber, LANG_NAMES, plural, preferredLang, SUPPORTED_LANGS, t, tc, type RuForms } from '../i18n';
import { esc, fmtDate, fmtDateTime, icon } from './dom';
import { errorLog } from './errors';

export const APP_VERSION = __APP_VERSION__;

const FILES: RuForms = { one: '{count} файл', few: '{count} файла', many: '{count} файлов' };
const PROJECTS: RuForms = { one: '{count} проект', few: '{count} проекта', many: '{count} проектов' };
const ENTRIES: RuForms = { one: '{count} запись', few: '{count} записи', many: '{count} записей' };

export const langLabel = (l: Language): string => (l === 'python' ? 'Python' : l === 'php' ? 'PHP' : l === 'javascript' ? 'JavaScript · TypeScript' : 'HTML · CSS · JS');
const langBadge = (l: Language) =>
  l === 'python'
    ? '<span class="file-ext py">PY</span>'
    : l === 'php'
      ? '<span class="file-ext php">PHP</span>'
      : l === 'javascript'
        ? '<span class="file-ext js">JS</span>'
        : `<span class="file-ext html">${esc('</>')}</span>`;

const KIND_LABEL: Record<string, string> = { html: 'H', css: '#', js: 'JS', php: 'PHP', py: 'PY', json: '{}', md: 'TXT' };
const fileBadge = (path: string): string => {
  const k = fileKind(path);
  if (k === 'image') return `<span class="file-ext image">${icon('image', 'sm')}</span>`;
  if (k === 'font') return '<span class="file-ext other">Aa</span>';
  if (k === 'other') return `<span class="file-ext other">${icon('file', 'sm')}</span>`;
  return `<span class="file-ext ${k}">${esc(KIND_LABEL[k] ?? '')}</span>`;
};

// ---------------- chrome ----------------

export function topbar(s: AppState): string {
  const p = s.project;
  if (s.route === 'workspace' && p) {
    return `<header class="topbar">
      <button class="icon-btn" data-action="go-home" aria-label="${t('К проектам')}">${icon('back')}</button>
      <button class="project-title" data-action="rename-project" aria-label="${t('Переименовать проект {name}', { name: esc(p.name) })}"><span class="truncate">${esc(p.name)}</span></button>
      <div class="top-actions">
        <button class="icon-btn" data-action="tools" aria-label="${t('Инструменты')}">${icon('sliders')}</button>
        <button class="icon-btn" data-action="history" aria-label="${t('История версий')}">${icon('clock')}</button>
        <button class="icon-btn" data-action="project-menu" aria-label="${t('Действия с проектом')}">${icon('more')}</button>
      </div></header>`;
  }
  if (s.route === 'home') {
    return `<header class="topbar"><div class="brand" aria-label="Codevia Pocket">codevia<span>.</span></div>
      <div class="top-actions"><button class="icon-btn" data-action="tools" aria-label="${t('Инструменты')}">${icon('sliders')}</button>
      <button class="icon-btn" data-action="settings" aria-label="${t('Настройки')}">${icon('settings')}</button></div></header>`;
  }
  const titles: Record<string, string> = {
    history: t('История версий'),
    diagnostics: t('Проверка'),
    settings: t('Настройки'),
    privacy: t('Конфиденциальность'),
    licenses: t('Лицензии'),
  };
  return `<header class="topbar"><button class="icon-btn" data-action="back" aria-label="${t('Назад')}">${icon('back')}</button>
    <h1 class="topbar-title">${esc(titles[s.route] ?? '')}</h1><div class="top-actions"></div></header>`;
}

export function bottomnav(s: AppState): string {
  if (s.route !== 'workspace') return '';
  const items: Array<[string, string, string]> = [
    ['files', t('Файлы'), 'folder'],
    ['code', t('Код'), 'code'],
    ['preview', t('Просмотр'), 'eye'],
    ['run', t('Запуск'), 'terminal'],
  ];
  return `<nav class="bottomnav" aria-label="${t('Разделы проекта')}">${items
    .map(
      ([v, label, ic]) =>
        `<button class="nav-item ${s.view === v ? 'active' : ''}" data-action="view" data-view="${v}" ${s.view === v ? 'aria-current="page"' : ''}>${icon(ic)}<span>${label}</span></button>`,
    )
    .join('')}</nav>`;
}

export function storageBanner(s: AppState): string {
  if (s.volatile) {
    return `<div class="banner danger" role="alert">${icon('info', 'sm')}<div><strong>${t('Изменения не сохраняются.')}</strong> ${t('Хранилище устройства недоступно{detail}. Экспортируйте проекты в ZIP, чтобы не потерять работу.', { detail: s.storageError ? ` (${esc(s.storageError)})` : '' })}</div></div>`;
  }
  if (s.save === 'error') {
    return `<div class="banner danger" role="alert">${icon('info', 'sm')}<div><strong>${t('Не удалось сохранить.')}</strong> ${esc(s.saveError)}</div><button class="btn secondary tiny" data-action="retry-save">${t('Повторить')}</button></div>`;
  }
  return '';
}

// ---------------- welcome ----------------

export function welcome(): string {
  return `<main class="content welcome" id="main">
    <div class="welcome-mark" aria-hidden="true">codevia<span>.</span></div>
    <h1 class="screen-title">${t('Код в кармане')}</h1>
    <p class="screen-sub">${t('Редактор для сайтов, Python и PHP. Всё работает прямо на iPhone — без интернета и без отправки кода на сервер.')}</p>
    <ul class="feature-list">
      <li>${icon('code')}<div><strong>${t('Редактор с подсветкой')}</strong><span>${t('Автодополнение, поиск, отмена, удобная панель символов.')}</span></div></li>
      <li>${icon('eye')}<div><strong>${t('Живой предпросмотр')}</strong><span>${t('HTML, CSS и JavaScript со стилями, картинками и консолью.')}</span></div></li>
      <li>${icon('terminal')}<div><strong>${t('Python и PHP офлайн')}</strong><span>${t('Python 3 и PHP 8.3 выполняются на устройстве.')}</span></div></li>
      <li>${icon('folder')}<div><strong>${t('Ваши файлы — ваши')}</strong><span>${t('Проекты видны в приложении «Файлы», импорт и экспорт ZIP.')}</span></div></li>
    </ul>
    <div class="stack">
      <button class="btn primary full" data-action="welcome-samples">${t('Начать с примеров')}</button>
      <button class="btn secondary full" data-action="welcome-empty">${t('Начать с чистого листа')}</button>
    </div></main>`;
}

// ---------------- home ----------------

export function home(s: AppState): string {
  const last = s.projects[0];
  const q = s.projectQuery.trim().toLowerCase();
  const list = s.projects.filter((p) => !q || p.name.toLowerCase().includes(q));
  return `<main class="content" id="main">${storageBanner(s)}
    <section class="section">
      <h1 class="screen-title">${t('Проекты')}</h1>
      <div class="home-actions">
        <button class="btn primary" data-action="new-project">${icon('plus', 'sm')} ${t('Новый')}</button>
        <button class="btn secondary" data-action="import-project">${icon('upload', 'sm')} ${t('Импорт')}</button>
      </div>
      ${
        last
          ? `<h2 class="section-heading">${t('Продолжить')}</h2>
      <button class="continue-card" data-action="open-project" data-id="${esc(last.id)}">
        ${langBadge(last.language)}
        <span class="row-main"><span class="row-title">${esc(last.name)}</span>
        <span class="row-description">${langLabel(last.language)} · ${t('изменён {date}', { date: esc(fmtDate(last.updatedAt)) })}</span></span>
        <span class="continue-go">${t('Открыть')} ${icon('chevron', 'sm')}</span>
      </button>`
          : ''
      }
      <h2 class="section-heading">${t('Все проекты')} <span class="muted">${s.projects.length}</span></h2>
      ${
        s.projects.length > 4
          ? `<div class="search-wrap">${icon('search')}<input class="text-input search-input" id="project-search" type="search" value="${esc(s.projectQuery)}" placeholder="${t('Поиск проектов')}" aria-label="${t('Поиск проектов')}" autocomplete="off"></div>`
          : ''
      }
      <div class="list" role="list">
        ${
          list.length
            ? list.map((p) => projectRow(p)).join('')
            : s.projects.length
              ? `<div class="empty-state">${t('Ничего не найдено')}</div>`
              : `<div class="empty-state">${icon('folder', 'xl')}<p>${t('Здесь будут ваши проекты.')}</p>
                <div class="btn-row center"><button class="btn secondary" data-action="welcome-samples">${t('Добавить примеры')}</button></div></div>`
        }
      </div>
      <p class="form-help">${s.volatile ? '' : t('Проекты хранятся на этом устройстве и видны в приложении «Файлы» → «На iPhone» → Codevia Pocket.')}</p>
    </section></main>`;
}

function projectRow(p: ProjectMeta): string {
  return `<div class="row" role="listitem">
    <button class="row-button" data-action="open-project" data-id="${esc(p.id)}">
      ${langBadge(p.language)}
      <span class="row-main"><span class="row-title">${esc(p.name)}</span>
      <span class="row-description">${langLabel(p.language)} · ${plural(p.fileCount, FILES)} · ${formatBytes(p.size)}</span></span>
      <span class="row-meta">${esc(fmtDate(p.updatedAt))}</span>
    </button>
    <button class="icon-btn row-action" data-action="project-row-menu" data-id="${esc(p.id)}" aria-label="${t('Действия с проектом {name}', { name: esc(p.name) })}">${icon('more', 'sm')}</button>
  </div>`;
}

// ---------------- workspace: files ----------------

export function filesView(s: AppState, p: Project): string {
  const q = s.fileQuery.trim().toLowerCase();
  const paths = Object.keys(p.files)
    .filter((path) => s.fileFilter === 'all' || (s.fileFilter === 'code' ? isTextPath(path) : !isTextPath(path)))
    .filter((path) => !q || path.toLowerCase().includes(q))
    .sort((a, b) => {
      const da = dirname(a);
      const db = dirname(b);
      return da === db ? a.localeCompare(b) : da.localeCompare(db);
    });
  const chips = (
    [
      ['all', t('Все')],
      ['code', t('Код')],
      ['assets', t('Ресурсы')],
    ] as const
  )
    .map(([id, label]) => `<button class="chip ${s.fileFilter === id ? 'active' : ''}" data-action="filter" data-value="${id}" aria-pressed="${s.fileFilter === id}">${label}</button>`)
    .join('');
  let lastDir: string | null = null;
  const rows = paths
    .map((path) => {
      const dir = dirname(path);
      const header = dir !== lastDir ? `<div class="dir-header" role="presentation">${icon('folder', 'sm')} ${esc(dir ? dir + '/' : t('Корень проекта'))}</div>` : '';
      lastDir = dir;
      const f = p.files[path]!;
      const size = f.text ? new TextEncoder().encode(f.content).length : f.data.byteLength;
      const isEntry = p.entry === path;
      return `${header}<div class="row" role="listitem">
        <button class="row-button" data-action="open-file" data-path="${esc(path)}">
          ${fileBadge(path)}
          <span class="row-main"><span class="row-title mono">${esc(basename(path))}${isEntry ? ` <span class="pill cyan">${t('запуск')}</span>` : ''}</span>
          <span class="row-description">${formatBytes(size)}</span></span>
        </button>
        <button class="icon-btn row-action" data-action="file-menu" data-path="${esc(path)}" aria-label="${t('Действия с файлом {name}', { name: esc(path) })}">${icon('more', 'sm')}</button>
      </div>`;
    })
    .join('');
  return `<div class="pane files-pane">${storageBanner(s)}
    <div class="toolbar">
      <div class="search-wrap grow">${icon('search')}<input id="file-search" class="text-input search-input" type="search" value="${esc(s.fileQuery)}" placeholder="${t('Поиск по именам и коду')}" aria-label="${t('Поиск по именам файлов и коду')}" autocomplete="off"></div>
      <button class="icon-btn" data-action="new-file" aria-label="${t('Создать файл')}">${icon('plus')}</button>
      <button class="icon-btn" data-action="add-files" aria-label="${t('Добавить файлы с устройства')}">${icon('upload')}</button>
    </div>
    <div class="toolbar">
      <div class="chips" role="group" aria-label="${t('Фильтр файлов')}">${chips}</div>
      <button class="btn ghost tiny" data-action="diagnostics">${icon('shield', 'sm')} ${t('Проверка')}</button>
    </div>
    <div class="list scroll" role="list" id="file-list">${rows || (q.length >= 2 ? '' : `<div class="empty-state">${q ? t('Ничего не найдено') : t('В проекте нет файлов')}</div>`)}${contentHits(p, s.fileQuery.trim())}</div>
    <div class="pane-foot"><span>${plural(Object.keys(p.files).length, FILES)} · ${formatBytes(p.size)}</span></div>
  </div>`;
}

function contentHits(p: Project, query: string): string {
  if (query.length < 2) return '';
  const { hits, truncated } = searchProject(p.files, query);
  if (!hits.length) return `<div class="dir-header" role="presentation">${t('Совпадений в коде нет')}</div>`;
  const mark = (h: { snippet: string; at: number }) =>
    `${esc(h.snippet.slice(0, h.at))}<mark>${esc(h.snippet.slice(h.at, h.at + query.length))}</mark>${esc(h.snippet.slice(h.at + query.length))}`;
  return `<div class="dir-header" role="presentation">${icon('search', 'sm')} ${plural(hits.length, 'Найдено в коде: {count}{more}', { more: truncated ? '+' : '' })}</div>${hits
    .map(
      (h) => `<div class="row" role="listitem"><button class="row-button" data-action="open-issue" data-path="${esc(h.path)}" data-line="${h.line}">
        ${fileBadge(h.path)}<span class="row-main"><span class="row-description mono">${esc(h.path)}:${h.line}</span>
        <span class="row-title mono hit">${mark(h)}</span></span></button></div>`,
    )
    .join('')}`;
}

// ---------------- workspace: code ----------------

const KEYS: Record<string, string[]> = {
  html: ['<>', '/', '=', '""', '{}', '()', ';', ':', '#', '.'],
  css: ['{}', ':', ';', '#', '.', '()', '-', '%', '""', '!'],
  js: ['{}', '()', '[]', ';', '=', '=>', '""', "''", '.', '!', '&', '|', '`'],
  py: ['()', ':', '[]', '{}', '=', '""', "''", '#', '_', '.', ','],
  php: ['<?php', '$', '->', '()', '{}', ';', '=', "''", '[]', '.', '=>'],
  json: ['{}', '[]', '""', ':', ','],
};

export function codeView(s: AppState, p: Project): string {
  const path = s.currentPath;
  const f = p.files[path];
  if (!f || !f.text) {
    return `<div class="pane"><div class="empty-state">${icon('code', 'xl')}<p>${t('Выберите текстовый файл во вкладке «Файлы».')}</p>
      <button class="btn secondary" data-action="view" data-view="files">${t('Открыть файлы')}</button></div></div>`;
  }
  const kind = fileKind(path);
  const keys = KEYS[kind] ?? KEYS.js!;
  const tabs = s.tabs
    .filter((tab) => p.files[tab]?.text)
    .map(
      (tab) => `<div class="file-tab ${tab === path ? 'active' : ''}">
        <button class="file-tab-name" data-action="select-tab" data-path="${esc(tab)}" ${tab === path ? 'aria-current="true"' : ''}>${esc(basename(tab))}</button>
        <button class="file-tab-close" data-action="close-tab" data-path="${esc(tab)}" aria-label="${t('Закрыть вкладку {name}', { name: esc(basename(tab)) })}">${icon('close', 'xs')}</button>
      </div>`,
    )
    .join('');
  const saveLabel = s.save === 'saving' ? t('Сохранение…') : s.save === 'error' ? t('Ошибка сохранения') : t('Сохранено');
  return `<div class="pane editor-pane">
    <div class="file-tabs" role="group" aria-label="${t('Открытые файлы')}">${tabs}</div>
    <div class="editor-topline">
      <span class="subtxt mono truncate">${esc(path)}</span>
      <div class="btn-row nowrap">
        <button class="icon-btn" data-action="editor-search" aria-label="${t('Найти и заменить')}">${icon('search', 'sm')}</button>
        <button class="icon-btn ${s.settings.wrapLines ? 'on' : ''}" data-action="toggle-wrap" aria-pressed="${s.settings.wrapLines}" aria-label="${t('Перенос строк')}">${icon('wrap', 'sm')}</button>
        <button class="icon-btn" data-action="copy-code" aria-label="${t('Скопировать код')}">${icon('copy', 'sm')}</button>
      </div>
    </div>
    <div class="editor-host" id="editor-host"></div>
    <div class="editor-status"><span>${esc(extOf(path).toUpperCase() || 'TXT')} · UTF-8</span>
      <span class="save-state ${s.save}" id="save-state">${s.save === 'saved' ? icon('check', 'xs') : ''} ${saveLabel}</span></div>
    <div class="keybar" role="toolbar" aria-label="${t('Символы')}">
      <button class="key-btn" data-action="undo" aria-label="${t('Отменить')}">↶</button>
      <button class="key-btn" data-action="redo" aria-label="${tc('redo', 'Повторить')}">↷</button>
      <button class="key-btn" data-action="key" data-value="\t" aria-label="${t('Отступ')}">⇥</button>
      ${keys.map((k) => `<button class="key-btn" data-action="key" data-value="${esc(k)}" aria-label="${t('Вставить {text}', { text: esc(k) })}">${esc(k.length === 2 && '{}[]()<>""\'\''.includes(k) ? k[0] + ' ' + k[1] : k)}</button>`).join('')}
    </div>
  </div>`;
}

// ---------------- workspace: preview ----------------

export function previewView(s: AppState, p: Project): string {
  const pages = Object.keys(p.files).filter((x) => /\.html?$/i.test(x) || (p.language === 'php' && /\.php$/i.test(x)));
  const errors = s.previewConsole.filter((l) => l.level === 'error').length;
  if (!s.previewPage) {
    const runs = p.language === 'python' || p.language === 'javascript';
    const msg =
      p.language === 'python'
        ? t('У Python-проекта результат появляется во вкладке «Запуск». Для предпросмотра добавьте HTML-файл.')
        : p.language === 'javascript'
          ? t('У JavaScript-проекта результат появляется во вкладке «Запуск». Для предпросмотра добавьте HTML-файл.')
          : t('Для предпросмотра нужен HTML-файл.');
    return `<div class="pane"><div class="empty-state">${icon('eye', 'xl')}<p>${msg}</p>
      ${runs ? `<button class="btn primary" data-action="view" data-view="run">${t('Открыть запуск')}</button>` : `<button class="btn secondary" data-action="new-file">${t('Создать файл')}</button>`}</div></div>`;
  }
  return `<div class="pane preview-pane ${s.fullscreen ? 'fullscreen' : ''}" id="preview-pane">
    <div class="preview-toolbar">
      ${
        pages.length > 1
          ? `<label class="visually-hidden" for="preview-page">${t('Страница')}</label><select id="preview-page" class="select">${pages
              .map((x) => `<option value="${esc(x)}" ${x === s.previewPage ? 'selected' : ''}>${esc(x)}</option>`)
              .join('')}</select>`
          : `<span class="filename truncate mono">${esc(s.previewPage)}${s.previewQuery ? '?' + esc(s.previewQuery) : ''}</span>`
      }
      <button class="icon-btn ${s.consoleOpen ? 'on' : ''}" data-action="toggle-console" aria-pressed="${s.consoleOpen}" aria-label="${t('Консоль')}${errors ? plural(errors, ', ошибок: {count}') : ''}">${icon('console')}${errors ? `<span class="badge">${errors}</span>` : ''}</button>
      <button class="icon-btn" data-action="refresh-preview" aria-label="${t('Обновить предпросмотр')}">${icon('refresh')}</button>
      <button class="icon-btn" data-action="toggle-fullscreen" aria-label="${s.fullscreen ? t('Выйти из полноэкранного режима') : t('Во весь экран')}">${icon(s.fullscreen ? 'close' : 'expand')}</button>
    </div>
    <div class="browser-pane"><iframe id="live-preview" title="${t('Предпросмотр {name}', { name: esc(s.previewPage) })}" sandbox="allow-scripts" referrerpolicy="no-referrer" src="./preview-host.html"></iframe></div>
    ${consolePanel(s.previewConsole, 'preview-console', !s.consoleOpen)}
    ${!s.settings.previewNetwork ? `<div class="mini-info"><span class="grow">${t('Офлайн: внешние CDN и шрифты отключены')}</span><button class="link-btn" data-action="settings">${t('Изменить')}</button></div>` : ''}
  </div>`;
}

export function consolePanel(lines: ConsoleLine[], id: string, hidden = false): string {
  return `<div class="console" id="${id}" role="log" aria-label="${t('Консоль')}" tabindex="0" ${hidden ? 'hidden' : ''}>${
    lines.length
      ? lines
          .map((l) =>
            l.image
              ? `<span class="console-line ${l.level}"><img class="console-image" alt="${esc(t('Изображение из программы'))}" src="data:${esc(l.image.mime)};base64,${esc(l.image.data)}"></span>`
              : `<span class="console-line ${l.level}">${esc(l.text)}</span>`,
          )
          .join('')
      : `<span class="console-line system empty">${t('Консоль пуста')}</span>`
  }<button class="btn ghost tiny console-clear" data-action="clear-console" data-target="${id}">${t('Очистить')}</button></div>`;
}

// ---------------- workspace: run ----------------

export function runView(s: AppState, p: Project): string {
  const r = s.run;
  if (p.language === 'web') {
    return `<div class="pane run-pane">
      <div class="run-top"><div><h2 class="detail-header">${t('Консоль страницы')}</h2><div class="subtxt">${t('Сообщения console.log и ошибки JavaScript из предпросмотра')}</div></div>
      <button class="btn primary" data-action="view" data-view="preview">${icon('play', 'sm')} ${t('Открыть')}</button></div>
      ${consolePanel(s.previewConsole, 'preview-console')}
    </div>`;
  }
  const ext = p.language === 'python' ? '.py' : p.language === 'javascript' ? '.js / .ts' : '.php';
  const isEntry = (x: string) =>
    p.language === 'python' ? x.endsWith('.py') : p.language === 'javascript' ? /\.(m?[jt]s|cjs|[jt]sx)$/.test(x) && !x.startsWith('node_modules/') : x.endsWith('.php');
  const entries = Object.keys(p.files).filter(isEntry);
  const seconds = (ms: number) => t('{seconds} с', { seconds: fmtNumber(ms / 1000, { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false }) });
  const status = r.running
    ? `<span class="spinner" aria-hidden="true"></span> ${esc(r.status || t('Выполняется…'))}`
    : r.exitCode === null
      ? t('Готово к запуску')
      : r.exitCode === 130
        ? t('Остановлено')
        : `${t('Завершено с кодом {code}', { code: r.exitCode })}${r.ms !== null ? ` · ${seconds(r.ms)}` : ''}`;
  return `<div class="pane run-pane">
    <div class="run-top">
      <div class="grow">
        <label class="field-label" for="run-entry">${t('Файл запуска')} · ${p.language === 'python' ? 'Python 3' : p.language === 'javascript' ? 'JavaScript · TypeScript' : 'PHP 8.3'}</label>
        ${entries.length ? `<select id="run-entry" class="select">${entries.map((x) => `<option value="${esc(x)}" ${x === p.entry ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>` : `<div class="subtxt">${t('Нет файлов {ext}', { ext })}</div>`}
      </div>
      ${
        r.running
          ? `<button class="btn danger" data-action="stop">${icon('stop', 'sm')} ${t('Стоп')}</button>`
          : `<button class="btn primary" data-action="run" ${entries.length ? '' : 'disabled'}>${icon('play', 'sm')} ${t('Запустить')}</button>`
      }
    </div>
    ${
      p.language === 'python' || p.language === 'javascript'
        ? `<details class="stdin-box" ${r.stdin ? 'open' : ''}><summary>${p.language === 'python' ? t('Ввод для input()') : t('Ввод для prompt()')} <span class="muted">${t('— по строке на вызов')}</span></summary>
          <textarea id="run-stdin" class="text-input textarea mono" rows="3" placeholder="${t('Например: Анна')}" autocapitalize="off" autocorrect="off" spellcheck="false">${esc(r.stdin)}</textarea></details>`
        : `<div class="field-row"><label class="field-label" for="run-query">${t('Параметры запроса ($_GET)')}</label>
          <input id="run-query" class="text-input mono" value="${esc(s.previewQuery)}" placeholder="${t('name=Анна&page=2')}" autocapitalize="off" autocorrect="off" spellcheck="false"></div>`
    }
    <div class="run-status" aria-live="polite">${status}</div>
    ${consolePanel(r.output, 'run-console')}
    ${p.language === 'php' ? '<button class="btn secondary full" data-action="view" data-view="preview">' + icon('eye', 'sm') + ` ${t('Показать как страницу')}</button>` : ''}
  </div>`;
}

// ---------------- history ----------------

export function historyView(s: AppState): string {
  const p = s.project;
  if (!p) return `<main class="content"><div class="empty-state">${t('Нет открытого проекта')}</div></main>`;
  const list = [...s.snapshots].reverse();
  return `<main class="content" id="main"><section class="section narrow">
    <p class="screen-sub">${esc(p.name)} · ${t('до 30 ручных и 10 автоматических версий')}</p>
    <button class="btn primary full" data-action="checkpoint">${icon('save', 'sm')} ${t('Сохранить версию')}</button>
    <h2 class="section-heading">${t('Версии')} <span class="muted">${list.length}</span></h2>
    <div class="list" role="list">${
      list.length
        ? list
            .map(
              (v) => `<div class="row" role="listitem">
          <div class="row-static"><span class="file-ext other">${icon(v.kind === 'manual' ? 'flag' : 'clock', 'sm')}</span>
          <span class="row-main"><span class="row-title">${esc(v.label)}</span>
          <span class="row-description">${esc(fmtDateTime(v.at))} · ${plural(v.fileCount, FILES)} · ${v.kind === 'manual' ? t('вручную') : t('авто')}</span></span></div>
          <button class="btn secondary tiny" data-action="restore-version" data-id="${esc(v.id)}">${t('Вернуть')}</button>
          <button class="icon-btn row-action" data-action="delete-version" data-id="${esc(v.id)}" aria-label="${t('Удалить версию {name}', { name: esc(v.label) })}">${icon('trash', 'sm')}</button>
        </div>`,
            )
            .join('')
        : `<div class="empty-state">${t('Версий пока нет. Сохраните первую, прежде чем делать большие изменения.')}</div>`
    }</div>
    <p class="form-help">${t('Перед восстановлением и удалением файлов текущее состояние сохраняется автоматически. Одинаковые файлы в разных версиях хранятся один раз.')}</p>
  </section></main>`;
}

// ---------------- diagnostics ----------------

export function diagnosticsView(s: AppState): string {
  const p = s.project;
  if (!p) return `<main class="content"><div class="empty-state">${t('Нет открытого проекта')}</div></main>`;
  const counts = { error: 0, warning: 0, info: 0 };
  s.issues.forEach((i) => counts[i.severity]++);
  return `<main class="content" id="main"><section class="section narrow">
    <div class="compact-stats">
      <div><strong>${Object.keys(p.files).length}</strong> ${plural(Object.keys(p.files).length, 'файлов')}</div>
      <div><strong class="${counts.error ? 'c-danger' : 'c-success'}">${counts.error}</strong> ${plural(counts.error, 'ошибок')}</div>
      <div><strong class="${counts.warning ? 'c-warning' : ''}">${counts.warning + counts.info}</strong> ${plural(counts.warning + counts.info, 'замечаний')}</div>
    </div>
    <div class="list" role="list">${
      s.issues.length
        ? s.issues
            .map(
              (x) => `<div class="row" role="listitem"><button class="row-button issue ${x.severity}" ${x.path ? `data-action="open-issue" data-path="${esc(x.path)}" data-line="${x.line ?? ''}"` : 'disabled'}>
          <span class="issue-dot" aria-hidden="true"></span>
          <span class="row-main"><span class="row-title">${esc(x.title)}</span>
          <span class="row-description mono">${esc(x.path)}${x.line ? ':' + x.line : ''} ${esc(x.details)}</span></span></button></div>`,
            )
            .join('')
        : `<div class="empty-state">${icon('check', 'xl')}<p>${t('Проблем не найдено.')}</p><p class="form-help">${t('Проверены ссылки на файлы в HTML, CSS и JS-импортах, а также синтаксис JSON.')}</p></div>`
    }</div>
    <div class="btn-row"><button class="btn secondary" data-action="refresh-diagnostics">${icon('refresh', 'sm')} ${t('Проверить снова')}</button>
    <button class="btn ghost" data-action="export-report">${icon('share', 'sm')} ${t('Отчёт')}</button></div>
  </section></main>`;
}

// ---------------- settings ----------------

export function settingsView(s: AppState, storageKind: string, totalSize: number): string {
  const st = s.settings;
  return `<main class="content" id="main"><section class="section narrow">
    <h2 class="section-heading">${t('Интерфейс')}</h2>
    <div class="segmented" role="group" aria-label="${t('Плотность интерфейса')}">
      <button class="${st.density === 'compact' ? 'active' : ''}" data-action="density" data-value="compact" aria-pressed="${st.density === 'compact'}">${t('Компактный')}</button>
      <button class="${st.density === 'comfortable' ? 'active' : ''}" data-action="density" data-value="comfortable" aria-pressed="${st.density === 'comfortable'}">${t('Просторный')}</button>
    </div>
    <label class="setting-row"><span class="row-main"><span class="row-title">${t('Язык интерфейса')}</span></span>
      <select id="ui-language" class="select">
        <option value="system" ${preferredLang() ? '' : 'selected'}>${t('Как в системе')}</option>
        ${SUPPORTED_LANGS.map((l) => `<option value="${l}" ${preferredLang() === l ? 'selected' : ''}>${esc(LANG_NAMES[l])}</option>`).join('')}
      </select></label>
    <h2 class="section-heading">${t('Редактор')}</h2>
    <div class="setting-row"><span class="row-main"><span class="row-title" id="font-label">${t('Размер шрифта кода')}</span><span class="row-description">${st.editorFont} pt</span></span>
      <div class="stepper"><button class="icon-btn" data-action="font" data-delta="-1" aria-label="${t('Уменьшить шрифт')}" ${st.editorFont <= 11 ? 'disabled' : ''}>A−</button>
      <button class="icon-btn" data-action="font" data-delta="1" aria-label="${t('Увеличить шрифт')}" ${st.editorFont >= 24 ? 'disabled' : ''}>A+</button></div></div>
    <label class="setting-row switch-row"><span class="row-main"><span class="row-title">${t('Перенос длинных строк')}</span><span class="row-description">${t('Удобно на узком экране')}</span></span>
      <input type="checkbox" class="switch" data-setting="wrapLines" ${st.wrapLines ? 'checked' : ''}></label>
    <h2 class="section-heading">${t('Предпросмотр')}</h2>
    <label class="setting-row switch-row"><span class="row-main"><span class="row-title">${t('Разрешить интернет в предпросмотре')}</span>
      <span class="row-description">${t('Нужно для CDN (Bootstrap, Google Fonts). Страница сможет обращаться к внешним сайтам по HTTPS.')}</span></span>
      <input type="checkbox" class="switch" data-setting="previewNetwork" ${st.previewNetwork ? 'checked' : ''}></label>
    <h2 class="section-heading">${t('Python')}</h2>
    <label class="setting-row switch-row"><span class="row-main"><span class="row-title">${t('Загружать пакеты Python')}</span>
      <span class="row-description">${t('Пакеты, которых нет в приложении, скачиваются при первом import с CDN Pyodide или PyPI и дальше работают офлайн.')}</span></span>
      <input type="checkbox" class="switch" data-setting="pythonDownloads" ${st.pythonDownloads !== false ? 'checked' : ''}></label>
    <div class="setting-row"><span class="row-main"><span class="row-title">${t('Встроены (работают без интернета)')}</span>
      <span class="row-description">numpy, pandas, matplotlib, scipy, scikit-learn, sympy, pillow, beautifulsoup4, regex, pyyaml, networkx ${t('и их зависимости')}</span></span></div>
    <h2 class="section-heading">${t('Хранение')}</h2>
    <div class="setting-row"><span class="row-main"><span class="row-title">${t('Проекты на устройстве')}</span>
      <span class="row-description">${plural(s.projects.length, PROJECTS)} · ${formatBytes(totalSize)} · ${storageKind === 'fs' ? t('папка «Файлы» → Codevia Pocket') : s.volatile ? t('временно, не сохраняется') : t('память браузера')}</span></span></div>
    <button class="setting-row link-row" data-action="backup-all" ${s.projects.length ? '' : 'disabled'}><span class="row-main"><span class="row-title">${t('Резервная копия всех проектов')}</span>
      <span class="row-description">${t('Один ZIP. Импортируйте его, чтобы восстановить все проекты')}</span></span>${icon('share', 'sm')}</button>
    <h2 class="section-heading">${t('О приложении')}</h2>
    ${errorLog().length ? `<button class="setting-row link-row" data-action="error-log"><span class="row-main"><span class="row-title">${t('Журнал ошибок')}</span><span class="row-description">${plural(errorLog().length, ENTRIES)} · ${t('только на устройстве')}</span></span>${icon('chevron', 'sm')}</button>` : ''}
    <button class="setting-row link-row" data-action="route" data-route="privacy"><span class="row-main"><span class="row-title">${t('Конфиденциальность')}</span><span class="row-description">${t('Приложение не собирает данные')}</span></span>${icon('chevron', 'sm')}</button>
    <button class="setting-row link-row" data-action="route" data-route="licenses"><span class="row-main"><span class="row-title">${t('Лицензии открытого ПО')}</span></span>${icon('chevron', 'sm')}</button>
    <button class="setting-row link-row" data-action="show-onboarding"><span class="row-main"><span class="row-title">${t('Показать приветствие')}</span></span>${icon('chevron', 'sm')}</button>
    <p class="form-help">Codevia Pocket ${esc(APP_VERSION)}</p>
  </section></main>`;
}

export function privacyView(): string {
  return `<main class="content" id="main"><section class="section narrow prose">
    <h2>${t('Коротко')}</h2>
    <p>${t('Codevia Pocket не собирает, не передаёт и не продаёт ваши данные. В приложении нет аналитики, рекламы и учётных записей.')}</p>
    <h2>${t('Где хранятся файлы')}</h2>
    <p>${t('Проекты, версии и настройки хранятся только на вашем устройстве (папка приложения, видна в «Файлах»). Они попадают в резервную копию iCloud или компьютера, если она включена у вас в настройках iOS.')}</p>
    <h2>${t('Выполнение кода')}</h2>
    <p>${t('Python и PHP выполняются локально внутри приложения. Код не отправляется на серверы.')}</p>
    <h2>${t('Сеть')}</h2>
    <p>${t('Приложение работает без интернета. Если вы включите «Разрешить интернет в предпросмотре», страницы ваших проектов смогут загружать внешние ресурсы (например, шрифты с CDN) — эти запросы делает ваш код, а не приложение.')}</p>
    <p>${t('Сеть используется только по вашему действию: загрузка пакетов Python, которых нет в приложении (CDN Pyodide, PyPI), запросы HTTP-клиента и работа с GitHub. У разработчика нет серверов — данные идут напрямую в эти сервисы.')}</p>
    <h2>GitHub</h2>
    <p>${t('Если вы подключите GitHub, токен доступа хранится в Связке ключей iOS только на этом устройстве и отправляется только на github.com. Код проекта отправляется в ваш репозиторий только когда вы нажимаете «Отправить». Отключить доступ можно в настройках приложения и на github.com.')}</p>
    <h2>${t('Экспорт')}</h2>
    <p>${t('Файлы покидают устройство только когда вы сами экспортируете или отправляете их через системное меню «Поделиться».')}</p>
    <h2>${t('Контакты')}</h2>
    <p>${t('Вопросы о конфиденциальности: через страницу поддержки в App Store.')}</p>
  </section></main>`;
}

export function licensesView(): string {
  const items: Array<[string, string, string]> = [
    ['Pyodide / CPython', 'MPL-2.0 / PSF License', t('Python в WebAssembly')],
    ['PHP (php-wasm)', 'Apache-2.0 / PHP License 3.01', t('PHP 8.3 в WebAssembly')],
    ['sucrase', 'MIT', t('TypeScript и JSX')],
    ['NumPy, pandas, Matplotlib, SciPy, scikit-learn, SymPy, Pillow…', 'BSD / MIT / PSF / HPND', t('Встроенные пакеты Python (полные тексты лицензий — ниже)')],
    ['CodeMirror 6', 'MIT', t('Редактор кода')],
    ['Lezer', 'MIT', t('Парсеры для подсветки')],
    ['Capacitor', 'MIT', t('Нативная оболочка iOS')],
  ];
  return `<main class="content" id="main"><section class="section narrow">
    <div class="list" role="list">${items
      .map(([n, l, d]) => `<div class="row" role="listitem"><div class="row-static"><span class="row-main"><span class="row-title">${esc(n)}</span><span class="row-description">${esc(l)} · ${esc(d)}</span></span></div></div>`)
      .join('')}</div>
    <p class="form-help">${t('Полные тексты лицензий входят в состав приложения (файл THIRD_PARTY_LICENSES.txt) и доступны в исходных пакетах.')}</p>
  </section></main>`;
}
