import { formatBytes, guessLegacyEncoding, makeId } from './core/bytes';
import { toProjectFile } from './core/files';
import { reportText, scanProject } from './core/diagnostics';
import { basename, extOf, fileKind, isJunkPath, isTextPath, normalizePath, sanitizeImportName, uniquePath } from './core/paths';
import { buildPreview, needsTranspile } from './core/preview';
import { defaultEntry, detectLanguage, templateFiles, templateLanguage, type TemplateId } from './core/templates';
import { binaryFile, LIMITS, textFile, type Files, type Project, type ProjectFile, type ProjectMeta } from './core/types';
import { stripCommonRoot, unzip, zipFiles } from './core/zip';
import { createEditor, type EditorHost } from './editor/editor';
import { getLang, plural, setPreferredLang, t, type Lang } from './i18n';
import { copyText, haptic, initNativeChrome, isNative, pickFiles, shareFile } from './platform/native';
import { Runner, type RuntimeKind } from './runtime/runner';
import { initialState, type AppState, type ConsoleLine, type Route, type View } from './state';
import { filesSize } from './storage/repository';
import { migrateLegacy, openStorage } from './storage';
import type { Repository } from './storage/repository';
import { $, esc, fmtDateTime, icon, toast } from './ui/dom';
import { errorReport, installGlobalErrorHandlers, recordError } from './ui/errors';
import { closeSheet, confirmSheet, menuSheet, openSheet, promptSheet, sheetOpen } from './ui/sheet';
import * as V from './ui/views';

const SAVE_DELAY = 700;
const MAX_OUTPUT_CHARS = 400_000;
const AUTO_SNAPSHOT_AFTER_MS = 12 * 60 * 60 * 1000;
const BACKUP_LIMIT_BYTES = 150 * 1024 * 1024;
const PHP_PREVIEW_TIMEOUT_MS = 15_000;

const NEW_FILE_CONTENT: Record<string, (name: string) => string> = {
  html: (n) => `<!doctype html>\n<html lang="${getLang()}">\n<head>\n  <meta charset="utf-8" />\n  <meta name="viewport" content="width=device-width, initial-scale=1" />\n  <title>${n}</title>\n</head>\n<body>\n\n</body>\n</html>\n`,
  php: () => `<?php\n\n`,
  py: () => `def main():\n    pass\n\n\nif __name__ == '__main__':\n    main()\n`,
  json: () => '{\n}\n',
};

export class App {
  s: AppState = initialState();
  repo!: Repository;
  private editor: EditorHost;
  private runner: Runner;
  private pending = new Set<string>();
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<void> = Promise.resolve();
  private previewToken = '';
  private previewHtml: string | null = null;
  private previewDirty = true;
  private previewBuilding: Promise<void> | null = null;
  private editorPath = '';
  private returnRoute: Route = 'home';
  private outputChars = 0;
  /** Urlencoded body of a form posted in the preview, for the next PHP render. */
  private previewPost: string | null = null;
  private consoleQueue = new Map<string, ConsoleLine[]>();
  private consoleFrame = 0;
  private transpiler: Promise<(path: string, code: string) => string> | null = null;

  constructor(private root: HTMLElement) {
    this.editor = createEditor((path, text) => this.onEdit(path, text), false);
    this.runner = new Runner(new URL('pyodide/', document.baseURI).href);
  }

  // ------------------------------------------------------------------ lifecycle

  async start(): Promise<void> {
    const storage = await openStorage();
    this.repo = storage.repo;
    this.s.volatile = storage.volatile;
    this.s.storageError = storage.error ?? '';
    if (!storage.volatile) {
      const migrated = await migrateLegacy(this.repo).catch(() => 0);
      if (migrated) toast(plural(migrated, 'Перенесено проектов из прошлой версии: {count}'), 'success');
    }
    this.s.settings = await this.repo.loadSettings();
    this.applyRuntimeOptions();
    this.editor.setWrap(this.s.settings.wrapLines);
    const adopted = storage.volatile ? 0 : await this.repo.adoptOrphanFolders().catch(() => 0);
    if (adopted) toast(plural(adopted, 'Найдены папки из «Файлов»: добавлено проектов — {count}'), 'success');
    this.s.projects = await this.repo.listProjects();
    this.s.route = !this.s.settings.onboardingDone && !this.s.projects.length ? 'welcome' : 'home';

    installGlobalErrorHandlers((m) => toast(t('Ошибка: {message}', { message: m }), 'error'));
    this.root.addEventListener('click', (e) => void this.guard(() => this.onClick(e)));
    this.root.addEventListener('input', (e) => this.onInput(e));
    this.root.addEventListener('change', (e) => void this.guard(() => this.onChange(e)));
    // Keep the editor focused (and the keyboard up) when tapping the symbol bar.
    const keepFocus = (e: Event) => {
      if ((e.target as HTMLElement).closest('.key-btn')) e.preventDefault();
    };
    this.root.addEventListener('pointerdown', keepFocus);
    this.root.addEventListener('mousedown', keepFocus);
    document.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('message', (e) => this.onPreviewMessage(e));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void this.flushSaves();
    });
    window.addEventListener('pagehide', () => void this.flushSaves());
    await initNativeChrome((open) => {
      this.s.keyboardOpen = open;
      $('.main-column', this.root)?.classList.toggle('kb-open', open);
    });
    this.render();
  }

  /** Language and package downloads for the runtimes (messages they print themselves). */
  private applyRuntimeOptions(): void {
    this.runner.options = { lang: getLang() === 'ru' ? 'ru' : 'en', allowNetwork: this.s.settings.pythonDownloads !== false };
  }

  private async guard(fn: () => unknown): Promise<void> {
    try {
      await fn();
    } catch (e) {
      console.error(e);
      recordError(e, 'action');
      this.setBusy('');
      haptic('error');
      toast((e as Error)?.message || t('Что-то пошло не так'), 'error');
    }
  }

  private setBusy(text: string): void {
    this.s.busy = text;
    let node = $('#busy');
    if (!text) {
      node?.remove();
      return;
    }
    if (!node) {
      node = document.createElement('div');
      node.id = 'busy';
      node.className = 'busy';
      node.setAttribute('role', 'status');
      document.body.append(node);
    }
    node.innerHTML = `<div class="busy-card"><span class="spinner" aria-hidden="true"></span>${esc(text)}</div>`;
  }

  // ------------------------------------------------------------------ rendering

  render(): void {
    const s = this.s;
    document.documentElement.dataset.density = s.settings.density;
    document.documentElement.style.setProperty('--code-font', `${s.settings.editorFont}px`);
    const active = document.activeElement as HTMLInputElement | null;
    const focusId = active?.id && this.root.contains(active) ? active.id : '';
    const caret = focusId && 'selectionStart' in active! ? active!.selectionStart : null;
    // Buttons have no id: remember them by their action attributes so focus survives the re-render.
    const focusKey =
      !focusId && active && this.root.contains(active) && active.dataset?.action
        ? ['action', 'path', 'id', 'view', 'value']
            .filter((k) => active.dataset[k] !== undefined)
            .map((k) => `[data-${k}="${CSS.escape(active.dataset[k]!)}"]`)
            .join('')
        : '';
    const scroller = $('.content, .scroll', this.root);
    const scrollKey = `${s.route}:${s.view}`;
    const prevScroll = scroller ? { key: this.root.dataset.scrollKey, top: scroller.scrollTop } : null;
    const editorScroll = this.editor.view.scrollDOM.scrollTop;

    const p = s.project;
    let body = '';
    switch (s.route) {
      case 'welcome':
        body = V.welcome();
        break;
      case 'home':
        body = V.home(s);
        break;
      case 'workspace':
        if (!p) body = V.home(s);
        else if (s.view === 'files') body = V.filesView(s, p);
        else if (s.view === 'code') body = V.codeView(s, p);
        else if (s.view === 'preview') body = V.previewView(s, p);
        else body = V.runView(s, p);
        break;
      case 'history':
        body = V.historyView(s);
        break;
      case 'diagnostics':
        body = V.diagnosticsView(s);
        break;
      case 'settings':
        body = V.settingsView(s, this.repo.backend.kind, s.projects.reduce((a, m) => a + m.size, 0));
        break;
      case 'privacy':
        body = V.privacyView();
        break;
      case 'licenses':
        body = V.licensesView();
        break;
    }
    // The full render shows every line from state: drop lines still queued for the old DOM.
    this.consoleQueue.clear();
    const chrome = s.route === 'welcome' ? '' : V.topbar(s);
    this.root.innerHTML = `<div class="main-column ${s.keyboardOpen ? 'kb-open' : ''} route-${s.route} view-${s.view}">${chrome}${body}${V.bottomnav(s)}</div>`;
    this.root.dataset.scrollKey = scrollKey;

    if (s.route === 'workspace' && p && s.view === 'code') this.mountEditor(p, editorScroll);
    if (prevScroll && prevScroll.key === scrollKey) {
      const next = $('.content, .scroll', this.root);
      if (next) next.scrollTop = prevScroll.top;
    }
    if (focusId) {
      const el = document.getElementById(focusId) as HTMLInputElement | null;
      if (el && el.tagName === 'INPUT') {
        el.focus({ preventScroll: true });
        if (caret !== null) el.setSelectionRange(caret, caret);
      }
    } else if (focusKey && !sheetOpen()) {
      $<HTMLElement>(focusKey, this.root)?.focus({ preventScroll: true });
    }
    if (s.route === 'workspace' && s.view === 'preview' && s.previewPage) void this.ensurePreview();
  }

  private mountEditor(p: Project, scrollTop: number): void {
    const host = $('#editor-host', this.root);
    const f = p.files[this.s.currentPath];
    if (!host || !f?.text) return;
    host.append(this.editor.view.dom);
    if (this.editorPath !== this.s.currentPath || this.editor.current() !== f.content) {
      const sameFile = this.editorPath === this.s.currentPath;
      this.editor.open(this.s.currentPath, f.content);
      this.editorPath = this.s.currentPath;
      if (!sameFile) scrollTop = 0;
    }
    requestAnimationFrame(() => {
      this.editor.view.requestMeasure();
      this.editor.view.scrollDOM.scrollTop = scrollTop;
    });
  }

  private updateSaveIndicator(): void {
    const el = $('#save-state', this.root);
    if (!el) return;
    el.className = `save-state ${this.s.save}`;
    el.innerHTML = this.s.save === 'saving' ? t('Сохранение…') : this.s.save === 'error' ? t('Ошибка сохранения') : `${icon('check', 'xs')} ${t('Сохранено')}`;
  }

  // ------------------------------------------------------------------ saving

  private onEdit(path: string, text: string): void {
    const p = this.s.project;
    if (!p || !p.files[path]?.text) return;
    p.files[path] = textFile(text);
    this.previewDirty = true;
    this.pending.add(path);
    this.s.save = 'saving';
    this.updateSaveIndicator();
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flushSaves(), SAVE_DELAY);
  }

  /** Writes pending edits. Resolves true when nothing is left unsaved. */
  async flushSaves(): Promise<boolean> {
    clearTimeout(this.saveTimer);
    const run = this.saving.then(async () => {
      const p = this.s.project;
      if (!p || !this.pending.size) return;
      const paths = [...this.pending];
      this.pending.clear();
      try {
        await this.repo.saveFiles(p, paths);
        const wasError = this.s.save === 'error';
        this.s.save = this.pending.size ? 'saving' : 'saved';
        this.s.saveError = '';
        if (wasError) this.render();
        else this.updateSaveIndicator();
      } catch (e) {
        paths.forEach((x) => this.pending.add(x));
        this.s.save = 'error';
        this.s.saveError = (e as Error).message;
        haptic('error');
        this.updateSaveIndicator();
        toast((e as Error).message, 'error');
      }
    });
    this.saving = run;
    await run;
    return this.pending.size === 0;
  }

  /**
   * Called before leaving the current project. If edits could not be saved, the user decides:
   * retry, export what is in memory, or discard — edits are never dropped silently.
   */
  private async ensureSaved(): Promise<boolean> {
    for (;;) {
      if (await this.flushSaves()) return true;
      const choice = await openSheet<string>({
        title: t('Изменения не сохранены'),
        body: `<p class="sheet-text">${esc(this.s.saveError || t('Не удалось записать файлы.'))} ${t('Несохранённые файлы: {files}.', { files: esc([...this.pending].slice(0, 5).join(', ')) })}</p>
          <div class="sheet-actions">
            <button class="btn primary full" data-choice="retry">${t('Повторить сохранение')}</button>
            <button class="btn secondary full" data-choice="export">${t('Экспортировать проект в ZIP')}</button>
            <button class="btn danger full" data-choice="discard">${t('Выйти без сохранения')}</button>
            <button class="btn ghost full" data-sheet-close>${t('Остаться')}</button>
          </div>`,
        onMount: (root, close) =>
          root.addEventListener('click', (e) => {
            const c = (e.target as HTMLElement).closest<HTMLElement>('[data-choice]');
            if (c) close(c.dataset.choice);
          }),
      });
      if (choice === 'retry') continue;
      if (choice === 'export') {
        await this.exportInMemory();
        continue;
      }
      if (choice === 'discard') {
        this.pending.clear();
        this.s.save = 'saved';
        this.s.saveError = '';
        return true;
      }
      return false;
    }
  }

  private async exportInMemory(): Promise<void> {
    const p = this.s.project;
    if (!p) return;
    const blob = await zipFiles(p.files);
    await shareFile(blob, `${p.folder}.zip`, 'application/zip');
  }

  // ------------------------------------------------------------------ navigation

  private go(route: Route): void {
    if (route === 'settings' || route === 'privacy' || route === 'licenses') {
      if (this.s.route === 'home' || this.s.route === 'workspace') this.returnRoute = this.s.route;
    }
    this.s.route = route;
    this.render();
    $('.content', this.root)?.scrollTo(0, 0);
  }

  private async setView(view: View): Promise<void> {
    if (!this.s.project) return;
    if (this.s.view === 'code') await this.flushSaves();
    this.s.view = view;
    this.s.fullscreen = false;
    if (view === 'preview' && !this.s.previewPage) this.pickPreviewPage();
    if (view === 'run' && this.s.project.language !== 'web') this.runner.preload(this.s.project.language as RuntimeKind);
    this.render();
  }

  private async goHome(): Promise<void> {
    if (!(await this.ensureSaved())) return;
    this.runner.disposeAll();
    this.s.route = 'home';
    this.s.project = null;
    await this.repo.adoptOrphanFolders().catch(() => 0);
    this.s.projects = await this.repo.listProjects();
    this.render();
  }

  // ------------------------------------------------------------------ projects

  private async openProject(id: string): Promise<void> {
    if (!(await this.ensureSaved())) return;
    const meta = this.s.projects.find((m) => m.id === id) ?? (await this.repo.listProjects()).find((m) => m.id === id);
    if (!meta) throw new Error(t('Проект не найден'));
    if (this.s.project?.id !== id) {
      this.runner.disposeAll();
      this.editor.reset();
    }
    const project = await this.repo.openProject(meta);
    const paths = Object.keys(project.files);
    if (!project.entry || !project.files[project.entry]) {
      const entry = defaultEntry(paths, project.language);
      if (entry) await this.repo.setEntry(project, entry).catch(() => (project.entry = entry));
    }
    const firstText = project.entry && project.files[project.entry]?.text ? project.entry : paths.find((x) => project.files[x]!.text) ?? '';
    Object.assign(this.s, {
      project,
      route: 'workspace' as Route,
      view: 'files' as View,
      currentPath: firstText,
      tabs: firstText ? [firstText] : [],
      fileQuery: '',
      previewPage: '',
      previewQuery: '',
      previewConsole: [],
      fullscreen: false,
      run: { running: false, status: '', output: [], exitCode: null, ms: null, stdin: '' },
      save: 'saved',
      saveError: '',
    });
    this.previewDirty = true;
    this.previewHtml = null;
    this.editorPath = '';
    this.pickPreviewPage();
    this.render();
    void this.autoSnapshot(project);
  }

  /** A safety version when a project is opened after a while (cheap thanks to content deduplication). */
  private async autoSnapshot(project: Project): Promise<void> {
    if (this.s.volatile || !Object.keys(project.files).length) return;
    try {
      const snaps = await this.repo.listSnapshots(project.id);
      const last = snaps[snaps.length - 1];
      if (last && Date.now() - Date.parse(last.at) < AUTO_SNAPSHOT_AFTER_MS) return;
      if (last && Date.parse(project.updatedAt) <= Date.parse(last.at)) return;
      await this.repo.createSnapshot(project, t('Автоверсия при открытии'), 'auto');
    } catch {
      /* best effort */
    }
  }

  private pickPreviewPage(): void {
    const p = this.s.project;
    if (!p) return;
    const ext = p.language === 'php' ? /\.php$/i : /\.html?$/i;
    const pages = Object.keys(p.files).filter((x) => ext.test(x) || /\.html?$/i.test(x));
    this.s.previewPage =
      (p.entry && pages.includes(p.entry) ? p.entry : undefined) ?? defaultEntry(pages, p.language) ?? pages.find((x) => /\.html?$/i.test(x)) ?? '';
  }

  private async newProject(): Promise<void> {
    let template: TemplateId = 'web';
    const result = await openSheet<{ name: string; template: TemplateId }>({
      title: t('Новый проект'),
      body: `<form class="stack" id="new-project-form" novalidate>
        <div class="field"><label class="field-label" for="np-name">${t('Название')}</label>
        <input class="text-input" id="np-name" maxlength="80" placeholder="${t('Мой сайт')}" autocomplete="off"></div>
        <div class="field"><span class="field-label" id="np-tpl-label">${t('Шаблон')}</span>
        <div class="template-grid" role="radiogroup" aria-labelledby="np-tpl-label">
          ${(
            [
              ['web', t('Сайт'), 'HTML, CSS, JS', 'code'],
              ['python', 'Python', t('Скрипт и данные'), 'terminal'],
              ['php', 'PHP', t('Страница на PHP 8.3'), 'server'],
              ['javascript', 'JavaScript', t('Node-подобный запуск, TypeScript'), 'code'],
              ['empty', t('Пустой'), t('Один index.html'), 'file'],
            ] as const
          )
            .map(
              ([id, title, d, ic], i) =>
                `<button type="button" class="template ${i === 0 ? 'active' : ''}" role="radio" aria-checked="${i === 0}" data-tpl="${id}">${icon(ic)}<strong>${title}</strong><span>${d}</span></button>`,
            )
            .join('')}
        </div></div>
        <button class="btn primary full" type="submit">${t('Создать проект')}</button></form>`,
      initialFocus: '#np-name',
      onMount: (root, close) => {
        root.addEventListener('click', (e) => {
          const b = (e.target as HTMLElement).closest<HTMLElement>('[data-tpl]');
          if (!b) return;
          template = b.dataset.tpl as TemplateId;
          root.querySelectorAll('[data-tpl]').forEach((x) => {
            x.classList.toggle('active', x === b);
            x.setAttribute('aria-checked', String(x === b));
          });
        });
        root.querySelector('form')!.addEventListener('submit', (e) => {
          e.preventDefault();
          const name = (root.querySelector('#np-name') as HTMLInputElement).value.trim();
          const fallback = { web: t('Мой сайт'), python: t('Python-проект'), php: t('PHP-проект'), javascript: t('JS-проект'), empty: t('Новый проект') }[template];
          close({ name: name || fallback, template });
        });
      },
    });
    if (!result) return;
    const project = await this.repo.createProject(result.name, templateLanguage(result.template), templateFiles(result.template, result.name));
    haptic('success');
    this.s.projects = await this.repo.listProjects();
    await this.openProject(project.id);
    if (result.template !== 'empty') await this.setView(result.template === 'web' ? 'preview' : 'code');
    else await this.setView('code');
  }

  private async createSamples(): Promise<void> {
    this.setBusy(t('Создаю примеры…'));
    for (const [tpl, name] of [
      ['web', t('Сайт-портфолио')],
      ['python', t('Python · расчёты')],
      ['php', t('PHP · приветствие')],
      ['javascript', t('JavaScript · заказы')],
    ] as const) {
      await this.repo.createProject(name, templateLanguage(tpl), templateFiles(tpl, name));
    }
    this.setBusy('');
    this.s.projects = await this.repo.listProjects();
  }

  private async finishOnboarding(samples: boolean): Promise<void> {
    if (samples) await this.createSamples();
    this.s.settings.onboardingDone = true;
    await this.saveSettings();
    this.go('home');
  }

  private async readPicked(files: File[]): Promise<{ files: Files; name: string; skipped: number; renamed: number }> {
    const head = files.length === 1 ? new Uint8Array(await files[0]!.slice(0, 4).arrayBuffer()) : null;
    const isZip = !!head && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
    if (files.length === 1 && (isZip || /\.zip$/i.test(files[0]!.name))) {
      const zip = files[0]!;
      // Full backups may be up to BACKUP_LIMIT_BYTES (plus ZIP headers): never refuse our own backup (audit 3, R1).
      if (zip.size > BACKUP_LIMIT_BYTES * 1.1) throw new Error(t('ZIP больше {size}', { size: formatBytes(LIMITS.maxZipBytes) }));
      // Archive-level limits allow full backups; per-project limits are enforced when projects are created.
      const result = await unzip(new Uint8Array(await zip.arrayBuffer()), { maxEntries: 20_000, maxTotalBytes: BACKUP_LIMIT_BYTES * 1.4 });
      const stripped = stripCommonRoot(result.files);
      return {
        files: stripped.files,
        name: stripped.root ?? zip.name.replace(/\.zip$/i, ''),
        skipped: result.skipped.length,
        renamed: result.renamed.length,
      };
    }
    const out: Files = {};
    let total = 0;
    let skipped = 0;
    let renamed = 0;
    for (const f of files) {
      if (isJunkPath(f.name)) {
        skipped++;
        continue;
      }
      if (f.size > LIMITS.maxFileBytes) throw new Error(t('Файл {name} больше {size}', { name: f.name, size: formatBytes(LIMITS.maxFileBytes) }));
      total += f.size;
      if (total > LIMITS.maxProjectBytes) throw new Error(t('Слишком большой объём файлов'));
      const safe = normalizePath(sanitizeImportName(f.name));
      const path = uniquePath(safe, Object.keys(out));
      if (path !== safe) renamed++;
      const bytes = new Uint8Array(await f.arrayBuffer());
      out[path] = toProjectFile(path, bytes);
    }
    return { files: out, name: files.length === 1 ? files[0]!.name.replace(/\.[^.]+$/, '') : t('Импорт'), skipped, renamed };
  }

  private async importProject(): Promise<void> {
    const picked = await pickFiles('.zip,application/zip,.html,.htm,.css,.js,.mjs,.json,.php,.py,.md,.txt,.svg,.png,.jpg,.jpeg,.gif,.webp,.woff,.woff2,.ttf,.csv,.xml', true);
    if (!picked.length) return;
    this.setBusy(t('Импорт…'));
    try {
      const { files, name, skipped, renamed } = await this.readPicked(picked);
      if (!Object.keys(files).length) throw new Error(t('В архиве нет файлов'));
      this.setBusy('');
      if (await this.restoreBackup(files)) return;
      this.setBusy(t('Импорт…'));
      const project = await this.repo.createProject(name, detectLanguage(Object.keys(files)), files);
      this.setBusy('');
      haptic('success');
      const notes = [skipped && plural(skipped, 'пропущено служебных: {count}'), renamed && plural(renamed, 'переименовано дубликатов: {count}')].filter(Boolean).join(', ');
      toast(plural(Object.keys(files).length, 'Импортировано файлов: {count}{notes}', { notes: notes ? ` (${notes})` : '' }), 'success');
      this.s.projects = await this.repo.listProjects();
      await this.openProject(project.id);
    } finally {
      this.setBusy('');
    }
  }

  private async addFilesToProject(): Promise<void> {
    const p = this.s.project;
    if (!p) return;
    const picked = await pickFiles('*/*', true);
    if (!picked.length) return;
    this.setBusy(t('Добавляю файлы…'));
    let incoming: Files;
    try {
      incoming = (await this.readPicked(picked)).files;
    } finally {
      this.setBusy('');
    }
    const conflicts = Object.keys(incoming).filter((x) => p.files[x]);
    let replace = true;
    if (conflicts.length) {
      replace = await confirmSheet({
        title: t('Файлы уже существуют'),
        message: plural(conflicts.length, '{count} из добавляемых файлов уже есть в проекте ({files}). Заменить их? Иначе будут сохранены обе версии.', {
          files: `${esc(conflicts.slice(0, 3).join(', '))}${conflicts.length > 3 ? '…' : ''}`,
        }),
        confirm: t('Заменить'),
        cancel: t('Сохранить обе'),
      });
      if (replace) await this.repo.createSnapshot(p, t('Перед заменой файлов'), 'auto');
    }
    const merged: Files = { ...p.files };
    for (const [path, f] of Object.entries(incoming)) merged[replace ? path : uniquePath(path, Object.keys(merged))] = f;
    if (Object.keys(merged).length > LIMITS.maxFilesPerProject) throw new Error(t('Слишком много файлов в проекте'));
    if (filesSize(merged) > LIMITS.maxProjectBytes) throw new Error(t('Проект станет слишком большим'));
    this.setBusy(t('Сохраняю…'));
    try {
      await this.repo.replaceFiles(p, merged);
    } finally {
      this.setBusy('');
    }
    conflicts.forEach((c) => replace && this.editor.forget(c));
    this.previewDirty = true;
    toast(plural(Object.keys(incoming).length, 'Добавлено файлов: {count}'), 'success');
    this.render();
  }

  private async exportProject(meta?: ProjectMeta): Promise<void> {
    if (!(await this.ensureSaved())) return;
    const project = meta && meta.id !== this.s.project?.id ? await this.repo.openProject(meta) : this.s.project;
    if (!project) return;
    this.setBusy(t('Упаковываю ZIP…'));
    try {
      const blob = await zipFiles(project.files);
      const r = await shareFile(blob, `${project.folder}.zip`, 'application/zip');
      if (r === 'downloaded') toast(t('ZIP сохранён в загрузки'), 'success');
    } finally {
      this.setBusy('');
    }
  }

  /** One ZIP with every project in its own folder plus a manifest, so it can be restored in one step. */
  private async backupAll(): Promise<void> {
    if (!(await this.ensureSaved())) return;
    const metas = await this.repo.listProjects();
    if (!metas.length) throw new Error(t('Нет проектов для резервной копии'));
    const total = metas.reduce((a, m) => a + m.size, 0);
    if (total > BACKUP_LIMIT_BYTES) {
      throw new Error(
        t('Проекты занимают {size} — больше лимита полной копии ({limit}). Экспортируйте крупные проекты по отдельности.', {
          size: formatBytes(total),
          limit: formatBytes(BACKUP_LIMIT_BYTES),
        }),
      );
    }
    this.setBusy(t('Готовлю резервную копию…'));
    try {
      const all: Files = {};
      const manifest = { format: 'codevia-backup', version: 1, createdAt: new Date().toISOString(), projects: [] as Array<Record<string, string | undefined>> };
      for (const meta of metas) {
        const project = meta.id === this.s.project?.id ? this.s.project : await this.repo.openProject(meta);
        for (const [path, f] of Object.entries(project.files)) all[`${meta.folder}/${path}`] = f;
        manifest.projects.push({ folder: meta.folder, name: meta.name, language: meta.language, entry: project.entry });
      }
      all['codevia-backup.json'] = textFile(JSON.stringify(manifest, null, 2));
      const blob = await zipFiles(all);
      const stamp = new Date().toISOString().slice(0, 10);
      const r = await shareFile(blob, `codevia-backup-${stamp}.zip`, 'application/zip');
      if (r === 'downloaded') toast(t('Резервная копия сохранена'), 'success');
    } finally {
      this.setBusy('');
    }
  }

  /** Restores every project from a backup made by backupAll(). Returns false if `files` is not a backup. */
  private async restoreBackup(files: Files): Promise<boolean> {
    const raw = files['codevia-backup.json'];
    if (!raw?.text) return false;
    let manifest: { format?: string; projects?: Array<{ folder?: string; name?: string; language?: string; entry?: string }> };
    try {
      manifest = JSON.parse(raw.content);
    } catch {
      return false;
    }
    if (manifest.format !== 'codevia-backup' || !Array.isArray(manifest.projects)) return false;
    const free = LIMITS.maxProjects - this.s.projects.length;
    if (manifest.projects.length > free) {
      throw new Error(plural(manifest.projects.length, 'В копии {count} проектов, а места осталось на {free}. Удалите лишние проекты и повторите.', { free }));
    }
    const ok = await confirmSheet({
      title: t('Резервная копия Codevia'),
      message: plural(manifest.projects.length, 'В архиве {count} проектов. Восстановить их? Существующие проекты не изменятся — восстановленные появятся рядом.'),
      confirm: t('Восстановить'),
    });
    if (!ok) return true;
    this.setBusy(t('Восстанавливаю проекты…'));
    let restored = 0;
    try {
      for (const entry of manifest.projects) {
        if (!entry.folder) continue;
        const prefix = `${entry.folder}/`;
        const projectFiles: Files = {};
        for (const [path, f] of Object.entries(files)) if (path.startsWith(prefix)) projectFiles[path.slice(prefix.length)] = f;
        const lang = entry.language === 'python' || entry.language === 'php' ? entry.language : 'web';
        const project = await this.repo.createProject(entry.name || entry.folder, lang, projectFiles);
        if (entry.entry && projectFiles[entry.entry]) await this.repo.setEntry(project, entry.entry);
        restored++;
      }
    } finally {
      this.setBusy('');
    }
    this.s.projects = await this.repo.listProjects();
    toast(plural(restored, 'Восстановлено проектов: {count}'), 'success');
    this.go('home');
    return true;
  }

  private async showErrorLog(): Promise<void> {
    const report = errorReport(V.APP_VERSION);
    const choice = await openSheet<string>({
      title: t('Журнал ошибок'),
      body: `<p class="sheet-text">${t('Журнал хранится только на устройстве. Можно отправить его разработчику, чтобы помочь исправить проблему.')}</p>
        <pre class="console log-pre">${esc(report)}</pre>
        <div class="sheet-actions"><button class="btn primary full" data-share>${t('Поделиться журналом')}</button>
        <button class="btn secondary full" data-sheet-close>${t('Закрыть')}</button></div>`,
      onMount: (root, close) => root.querySelector('[data-share]')!.addEventListener('click', () => close('share')),
    });
    if (choice === 'share') await shareFile(report, 'codevia-error-log.txt', 'text/plain;charset=utf-8');
  }

  private async renameProject(meta?: ProjectMeta): Promise<void> {
    // Renaming needs metadata only: do not read the project's files from Home (audit 3, R15).
    const target = meta && meta.id !== this.s.project?.id ? { ...meta, files: {} } : this.s.project;
    if (!target) return;
    const name = await promptSheet({ title: t('Название проекта'), label: t('Название'), value: target.name, confirm: t('Сохранить') });
    if (!name || name === target.name) return;
    await this.repo.renameProject(target, name);
    this.s.projects = await this.repo.listProjects();
    this.render();
  }

  private async deleteProject(meta: ProjectMeta): Promise<void> {
    const ok = await confirmSheet({
      title: t('Удалить проект?'),
      message: t('Проект <strong>{name}</strong> и все его версии будут удалены с устройства. Это нельзя отменить. Если нужна копия — сначала экспортируйте ZIP.', { name: esc(meta.name) }),
      confirm: t('Удалить проект'),
      danger: true,
    });
    if (!ok) return;
    if (this.s.project?.id === meta.id) {
      this.pending.clear();
      clearTimeout(this.saveTimer);
      await this.saving; // an in-flight save must finish before the delete is queued behind it
      this.runner.disposeAll();
      this.s.project = null;
      this.s.route = 'home';
    }
    await this.repo.deleteProject(meta);
    haptic('warning');
    this.s.projects = await this.repo.listProjects();
    toast(t('Проект удалён'));
    this.render();
  }

  private async projectMenu(meta: ProjectMeta, inWorkspace: boolean): Promise<void> {
    const choice = await menuSheet(meta.name, [
      { id: 'rename', label: t('Переименовать'), icon: 'edit' },
      { id: 'duplicate', label: t('Дублировать'), icon: 'duplicate' },
      { id: 'export', label: t('Экспорт ZIP'), icon: 'share' },
      ...(inWorkspace ? [{ id: 'check', label: t('Проверка файлов'), icon: 'shield' }] : []),
      { id: 'delete', label: t('Удалить проект'), icon: 'trash', danger: true },
    ]);
    if (choice === 'rename') await this.renameProject(meta);
    else if (choice === 'duplicate') {
      if (!(await this.ensureSaved())) return;
      const src = meta.id === this.s.project?.id ? this.s.project : await this.repo.openProject(meta);
      const copy = await this.repo.duplicateProject(src!);
      this.s.projects = await this.repo.listProjects();
      toast(t('Создана копия «{name}»', { name: copy.name }), 'success');
      this.render();
    } else if (choice === 'export') await this.exportProject(meta);
    else if (choice === 'check') this.openDiagnostics();
    else if (choice === 'delete') await this.deleteProject(meta);
  }

  // ------------------------------------------------------------------ files

  private openFile(path: string): void {
    const p = this.s.project;
    const f = p?.files[path];
    if (!p || !f) return;
    if (f.text) {
      if (!this.s.tabs.includes(path)) this.s.tabs = [...this.s.tabs, path].slice(-8);
      this.s.currentPath = path;
      void this.setView('code');
      return;
    }
    void this.showBinary(path, f);
  }

  private async showBinary(path: string, f: ProjectFile): Promise<void> {
    if (f.text) return;
    const isImage = fileKind(path) === 'image';
    const url = isImage ? URL.createObjectURL(new Blob([f.data as BlobPart], { type: `image/${extOf(path) === 'svg' ? 'svg+xml' : extOf(path)}` })) : '';
    await openSheet({
      title: basename(path),
      body: `${isImage ? `<div class="image-preview"><img src="${url}" alt="${esc(path)}"></div>` : `<p class="sheet-text">${isTextPath(path) ? t('Файл не в кодировке UTF-8, поэтому открыт только для чтения. Его можно перекодировать через меню файла «⋯».') : t('Этот файл нельзя редактировать в приложении, но он входит в проект и в экспорт.')}</p>`}
        <div class="subtxt mono">${esc(path)} · ${formatBytes(f.data.byteLength)}</div>
        <div class="sheet-actions"><button class="btn secondary full" data-sheet-close>${t('Готово')}</button></div>`,
    });
    if (url) URL.revokeObjectURL(url);
  }

  private async fileMenu(path: string): Promise<void> {
    const p = this.s.project;
    if (!p?.files[path]) return;
    const runnable = /\.(py|php|html?)$/i.test(path) && p.entry !== path;
    const choice = await menuSheet(
      basename(path),
      [
        { id: 'open', label: p.files[path]!.text ? t('Открыть в редакторе') : t('Просмотреть'), icon: p.files[path]!.text ? 'code' : 'eye' },
        ...(!p.files[path]!.text && isTextPath(path) ? [{ id: 'convert', label: t('Преобразовать в UTF-8 для редактирования'), icon: 'edit' }] : []),
        { id: 'rename', label: t('Переименовать или переместить'), icon: 'edit' },
        ...(runnable ? [{ id: 'entry', label: t('Сделать файлом запуска'), icon: 'flag' }] : []),
        { id: 'share', label: t('Поделиться файлом'), icon: 'share' },
        { id: 'delete', label: t('Удалить файл'), icon: 'trash', danger: true },
      ],
      path,
    );
    if (choice === 'open') this.openFile(path);
    else if (choice === 'convert') await this.convertToUtf8(path);
    else if (choice === 'rename') await this.renameFile(path);
    else if (choice === 'entry') {
      await this.repo.setEntry(p, path);
      this.s.previewPage = /\.(html?|php)$/i.test(path) ? path : this.s.previewPage;
      this.previewDirty = true;
      toast(t('Файл запуска: {name}', { name: basename(path) }));
      this.render();
    } else if (choice === 'share') {
      const f = p.files[path]!;
      await shareFile(f.text ? f.content : f.data, basename(path), f.text ? 'text/plain;charset=utf-8' : 'application/octet-stream');
    } else if (choice === 'delete') await this.deleteFile(path);
  }

  private async convertToUtf8(path: string): Promise<void> {
    const p = this.s.project;
    const f = p?.files[path];
    if (!p || !f || f.text) return;
    const enc = guessLegacyEncoding(f.data);
    const label = enc === 'windows-1251' ? 'Windows-1251' : 'UTF-16';
    const ok = await confirmSheet({
      title: t('Преобразовать в UTF-8?'),
      message: t(
        'Файл сохранён не в UTF-8 (похоже на {encoding}). Чтобы его редактировать, Codevia перекодирует его в UTF-8. Если на странице указана кодировка (например, <span class="mono">charset=windows-1251</span>), замените её на utf-8. Текущая версия сохранится в истории.',
        { encoding: label },
      ),
      confirm: t('Преобразовать'),
    });
    if (!ok) return;
    await this.repo.createSnapshot(p, t('Перед перекодировкой {name}', { name: basename(path) }), 'auto');
    const text = new TextDecoder(enc).decode(f.data).replace(/^\uFEFF/, '');
    p.files[path] = textFile(text);
    await this.repo.saveFile(p, path);
    this.previewDirty = true;
    this.openFile(path);
  }

  private validateNewPath(v: string, except?: string): string | null {
    try {
      const path = normalizePath(v);
      const p = this.s.project!;
      const clash = Object.keys(p.files).find((x) => x.toLowerCase() === path.toLowerCase() && x !== except);
      if (clash) return t('Файл с таким именем уже существует');
      if (Object.keys(p.files).some((x) => x.startsWith(path + '/'))) return t('Это имя занято папкой');
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }

  private async newFile(): Promise<void> {
    const p = this.s.project;
    if (!p) return;
    const suggestion = p.language === 'python' ? 'utils.py' : p.language === 'php' ? 'page.php' : 'page.html';
    const value = await promptSheet({
      title: t('Новый файл'),
      label: t('Имя файла (можно с папкой)'),
      value: suggestion,
      placeholder: 'css/theme.css',
      confirm: t('Создать'),
      mono: true,
      help: t('Папки создаются автоматически: например, <span class="mono">js/main.js</span>.'),
      validate: (v) => this.validateNewPath(v),
    });
    if (!value) return;
    const path = normalizePath(value);
    const make = NEW_FILE_CONTENT[extOf(path) === 'htm' ? 'html' : extOf(path)];
    const file = isTextPath(path) ? textFile(make ? make(basename(path)) : '') : binaryFile(new Uint8Array());
    await this.repo.addFile(p, path, file);
    this.previewDirty = true;
    this.openFile(path);
  }

  private async renameFile(from: string): Promise<void> {
    const p = this.s.project;
    if (!p) return;
    const value = await promptSheet({
      title: t('Переименовать'),
      label: t('Новый путь'),
      value: from,
      confirm: t('Сохранить'),
      mono: true,
      validate: (v) => this.validateNewPath(v, from),
    });
    if (!value) return;
    const to = normalizePath(value);
    if (to === from) return;
    await this.flushSaves();
    await this.repo.renameFile(p, from, to);
    this.editor.forget(from);
    if (this.editorPath === from) this.editorPath = '';
    this.s.tabs = this.s.tabs.map((t) => (t === from ? to : t));
    if (this.s.currentPath === from) this.s.currentPath = to;
    if (p.entry === from) await this.repo.setEntry(p, to);
    if (this.s.previewPage === from) this.s.previewPage = to;
    this.previewDirty = true;
    this.render();
  }

  private async deleteFile(path: string): Promise<void> {
    const p = this.s.project;
    if (!p) return;
    const ok = await confirmSheet({
      title: t('Удалить файл?'),
      message: t('<span class="mono">{name}</span> будет удалён. Перед удалением автоматически сохранится версия проекта — файл можно будет вернуть из истории.', { name: esc(path) }),
      confirm: t('Удалить'),
      danger: true,
    });
    if (!ok) return;
    await this.flushSaves();
    await this.repo.createSnapshot(p, t('Перед удалением {name}', { name: basename(path) }), 'auto');
    await this.repo.deleteFile(p, path);
    this.editor.forget(path);
    this.s.tabs = this.s.tabs.filter((t) => t !== path);
    if (this.s.currentPath === path) this.s.currentPath = this.s.tabs[0] ?? '';
    if (this.editorPath === path) this.editorPath = '';
    if (p.entry === path) {
      const next = defaultEntry(Object.keys(p.files), p.language);
      if (next) await this.repo.setEntry(p, next);
    }
    if (this.s.previewPage === path) this.pickPreviewPage();
    this.previewDirty = true;
    haptic('warning');
    toast(t('Файл удалён. Вернуть можно в истории версий.'));
    this.render();
  }

  // ------------------------------------------------------------------ preview

  private async ensurePreview(): Promise<void> {
    // Rebuild while something changed during the previous build (edit, link click, project switch).
    for (let i = 0; i < 4 && (this.previewDirty || this.previewHtml === null); i++) {
      if (!this.previewBuilding) this.previewBuilding = this.buildPreviewHtml().finally(() => (this.previewBuilding = null));
      await this.previewBuilding;
    }
    this.postPreview();
  }

  private async buildPreviewHtml(): Promise<void> {
    const p = this.s.project;
    const page = this.s.previewPage;
    const query = this.s.previewQuery;
    if (!p || !page) {
      this.previewDirty = false;
      return;
    }
    this.previewDirty = false;
    const token = makeId();
    const notes: ConsoleLine[] = [];
    let source: string;
    if (/\.php$/i.test(page)) {
      let html = '';
      let errors = '';
      let text = '';
      const timer = setTimeout(() => {
        if (this.runner.running) {
          this.runner.stop();
          errors += `${t('PHP не ответил за {seconds} с — выполнение остановлено (возможен бесконечный цикл).', { seconds: PHP_PREVIEW_TIMEOUT_MS / 1000 })}\n`;
        }
      }, PHP_PREVIEW_TIMEOUT_MS);
      try {
        const post = this.previewPost;
        await this.runner.run('php', p.files, page, { onStdout: (t) => (text += t), onStderr: (t) => (errors += t), onHtml: (h) => (html = h) }, post !== null ? { query, post } : { query });
      } catch (e) {
        errors += (e as Error).message;
      } finally {
        clearTimeout(timer);
      }
      if (errors) notes.push({ level: 'error', text: `PHP: ${errors.trim()}\n` });
      source = html || `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><pre style="white-space:pre-wrap;font:14px ui-monospace,monospace;padding:16px">${esc(text || errors || t('(нет вывода)'))}</pre></body></html>`;
    } else {
      const f = p.files[page];
      source = f?.text ? f.content : '';
    }
    // Discard a result that no longer matches what is on screen.
    if (this.s.project !== p || this.s.previewPage !== page || this.s.previewQuery !== query) {
      this.previewDirty = true;
      return;
    }
    this.previewPost = null;
    const transpile = Object.keys(p.files).some(needsTranspile) ? await this.loadTranspiler() : undefined;
    const result = buildPreview(p.files, page, source, { allowNetwork: this.s.settings.previewNetwork, token, transpile });
    for (const m of result.missing.slice(0, 20)) notes.push({ level: 'warn', text: `${t('Не найден файл: {name}', { name: m })}\n` });
    this.previewToken = token;
    this.previewHtml = result.html;
    this.s.previewConsole = [];
    this.refreshConsole('preview-console', []);
    notes.forEach((n) => this.pushPreviewConsole(n));
    // A frame that already received the old document must reload to show the new one.
    const frame = $<HTMLIFrameElement>('#live-preview', this.root);
    if (frame?.dataset.sent === '1') this.reloadPreviewFrame();
  }

  /** sucrase is loaded only for projects with TypeScript/JSX scripts. */
  private loadTranspiler(): Promise<(path: string, code: string) => string> {
    this.transpiler ??= import('sucrase').then(({ transform }) => (path: string, code: string) =>
      transform(code, {
        transforms: /\.[jt]sx$/i.test(path) ? ['typescript', 'jsx'] : ['typescript'],
        filePath: path,
        jsxRuntime: 'classic',
        disableESTransforms: true,
        keepUnusedImports: true,
      }).code,
    );
    return this.transpiler;
  }

  private postPreview(): void {
    const frame = $<HTMLIFrameElement>('#live-preview', this.root);
    if (frame?.contentWindow && this.previewHtml !== null && frame.dataset.ready === '1' && frame.dataset.sent !== '1') {
      frame.dataset.sent = '1';
      frame.contentWindow.postMessage({ type: 'codevia:render', html: this.previewHtml }, '*');
    }
  }

  private reloadPreviewFrame(): void {
    const frame = $<HTMLIFrameElement>('#live-preview', this.root);
    if (!frame) return;
    frame.dataset.ready = '';
    frame.dataset.sent = '';
    frame.src = `./preview-host.html?r=${Date.now()}`;
  }

  private onPreviewMessage(e: MessageEvent): void {
    const frame = $<HTMLIFrameElement>('#live-preview', this.root);
    if (!frame || e.source !== frame.contentWindow || e.origin !== 'null') return;
    const d = e.data as { type?: string; token?: string; [k: string]: unknown };
    if (d?.type === 'codevia:host-ready') {
      if (frame.dataset.ready === '1') return; // once per frame load: a page cannot make us resend documents
      frame.dataset.ready = '1';
      frame.dataset.sent = '';
      void this.ensurePreview();
      return;
    }
    if (!d || d.token !== this.previewToken) return;
    if (d.type === 'console') {
      const args = Array.isArray(d.args) ? d.args.map(String) : [];
      const level = (['log', 'info', 'warn', 'error', 'debug'].includes(String(d.level)) ? d.level : 'log') as ConsoleLine['level'];
      this.pushPreviewConsole({ level, text: args.join(' ').slice(0, 4000) + '\n' });
    } else if (d.type === 'alert') {
      toast(`alert: ${String(d.message).slice(0, 300)}`);
    } else if (d.type === 'navigate') {
      const path = typeof d.path === 'string' ? d.path : '';
      const p = this.s.project;
      const target = p && (p.files[path] ? path : p.files[`${path}/index.html`] ? `${path}/index.html` : null);
      if (!target || !/\.(html?|php)$/i.test(target)) {
        toast(t('Страница не найдена: {name}', { name: path || '—' }), 'error');
        return;
      }
      this.s.previewPage = target;
      this.s.previewQuery = typeof d.query === 'string' ? d.query : '';
      // A form posted with method=post: its fields go to $_POST of the next PHP render (once).
      this.previewPost = typeof d.post === 'string' ? d.post.slice(0, 1_000_000) : null;
      this.previewDirty = true;
      this.render();
    } else if (d.type === 'external') {
      const href = String(d.href).slice(0, 2000);
      void copyText(href).then((ok) => toast(ok ? t('Внешняя ссылка скопирована: {url}', { url: href }) : t('Внешняя ссылка: {url}', { url: href })));
    }
  }

  private pushPreviewConsole(line: ConsoleLine): void {
    const list = this.s.previewConsole;
    list.push(line);
    if (list.length > 500) list.splice(0, list.length - 500);
    this.appendConsoleLine('preview-console', line);
    const badge = $('[data-action="toggle-console"]', this.root);
    if (badge && line.level === 'error') {
      const n = list.filter((l) => l.level === 'error').length;
      badge.querySelector('.badge')?.remove();
      badge.insertAdjacentHTML('beforeend', `<span class="badge">${n}</span>`);
    }
  }

  /** Queues a console line; lines are added to the DOM once per animation frame (fast output must
   *  not lay out the page per line, audit 3, R9). */
  private appendConsoleLine(id: string, line: ConsoleLine): void {
    const q = this.consoleQueue.get(id) ?? [];
    q.push(line);
    if (q.length > 600) q.splice(0, q.length - 600);
    this.consoleQueue.set(id, q);
    this.consoleFrame ||= requestAnimationFrame(() => this.flushConsole());
  }

  private flushConsole(): void {
    this.consoleFrame = 0;
    for (const [id, lines] of this.consoleQueue) {
      const panel = document.getElementById(id);
      if (!panel) continue;
      panel.querySelector('.console-line.system.empty')?.remove();
      const frag = document.createDocumentFragment();
      let last: HTMLElement | null = null;
      for (const line of lines) {
        // Consecutive text of the same level joins one node (fewer nodes for streaming output).
        if (!line.image && last && last.dataset.level === line.level && !last.querySelector('img') && (last.textContent?.length ?? 0) < 8000) {
          last.textContent += line.text;
          continue;
        }
        const span = document.createElement('span');
        span.className = `console-line ${line.level}`;
        span.dataset.level = line.level;
        if (line.image) {
          const img = document.createElement('img');
          img.className = 'console-image';
          img.alt = t('Изображение из программы');
          img.src = `data:${line.image.mime};base64,${line.image.data}`;
          span.append(img);
        } else span.textContent = line.text;
        frag.append(span);
        last = span;
      }
      panel.insertBefore(frag, panel.querySelector('.console-clear'));
      const all = panel.querySelectorAll('.console-line');
      for (let i = 0; i < all.length - 500; i++) all[i]!.remove();
      panel.scrollTop = panel.scrollHeight;
    }
    this.consoleQueue.clear();
  }

  private refreshConsole(id: string, lines: ConsoleLine[]): void {
    this.consoleQueue.delete(id);
    const panel = document.getElementById(id);
    if (!panel) return;
    panel.querySelectorAll('.console-line').forEach((x) => x.remove());
    if (!lines.length) panel.insertAdjacentHTML('afterbegin', `<span class="console-line system empty">${t('Консоль пуста')}</span>`);
    lines.forEach((l) => this.appendConsoleLine(id, l));
  }

  // ------------------------------------------------------------------ run

  private async run(): Promise<void> {
    const p = this.s.project;
    if (!p || p.language === 'web') return;
    if (this.runner.running) {
      toast(t('Программа уже выполняется — дождитесь окончания или нажмите «Стоп»'));
      return;
    }
    const entry = p.entry && p.files[p.entry] ? p.entry : defaultEntry(Object.keys(p.files), p.language);
    if (!entry) throw new Error(t('Нет файла для запуска'));
    await this.flushSaves();
    const stdin = ($<HTMLTextAreaElement>('#run-stdin', this.root)?.value ?? this.s.run.stdin) || '';
    this.s.run = { running: true, status: t('Подготовка…'), output: [], exitCode: null, ms: null, stdin };
    this.outputChars = 0;
    this.render();
    const push = (level: ConsoleLine['level'], text: string) => {
      if (!text) return;
      this.outputChars += text.length;
      if (this.outputChars > MAX_OUTPUT_CHARS) {
        if (this.runner.running) {
          this.runner.stop();
          const l: ConsoleLine = { level: 'system', text: `\n${t('Вывод слишком большой — выполнение остановлено.')}\n` };
          this.s.run.output.push(l);
          this.appendConsoleLine('run-console', l);
        }
        return;
      }
      const line = { level, text };
      this.s.run.output.push(line);
      this.appendConsoleLine('run-console', line);
    };
    const setStatus = (t: string) => {
      this.s.run.status = t;
      const el = $('.run-status', this.root);
      if (el) el.innerHTML = `<span class="spinner" aria-hidden="true"></span> ${esc(t)}`;
    };
    try {
      setStatus(t('Выполняется…'));
      const kind = p.language as RuntimeKind;
      const r = await this.runner.run(
        kind,
        p.files,
        entry,
        {
          onStatus: setStatus,
          onStdout: (t) => push('stdout', t),
          onStderr: (t) => push('stderr', t),
          onHtml: () => undefined,
          onImage: (mime, data) => {
            const line: ConsoleLine = { level: 'stdout', text: '', image: { mime, data } };
            this.s.run.output.push(line);
            this.appendConsoleLine('run-console', line);
          },
        },
        { stdin, query: this.s.previewQuery },
      );
      this.s.run.exitCode = r.exitCode;
      this.s.run.ms = r.stopped ? null : r.ms;
      haptic(r.exitCode === 0 ? 'success' : 'warning');
    } catch (e) {
      push('stderr', `${(e as Error).message}\n`);
      this.s.run.exitCode = 1;
      haptic('error');
    } finally {
      this.s.run.running = false;
      if (this.s.route === 'workspace' && this.s.view === 'run') this.render();
    }
  }

  // ------------------------------------------------------------------ history & diagnostics

  private async openHistory(): Promise<void> {
    if (!this.s.project) return;
    await this.flushSaves();
    this.s.snapshots = await this.repo.listSnapshots(this.s.project.id);
    this.go('history');
  }

  private openDiagnostics(): void {
    const p = this.s.project;
    if (!p) return;
    this.s.issues = scanProject(p.files, p.language, p.entry);
    this.go('diagnostics');
  }

  private async checkpoint(): Promise<void> {
    const p = this.s.project;
    if (!p) return;
    const label = await promptSheet({
      title: t('Сохранить версию'),
      label: t('Описание'),
      value: t('Версия от {date}', { date: fmtDateTime(new Date().toISOString()) }),
      confirm: t('Сохранить'),
    });
    if (!label) return;
    await this.flushSaves();
    await this.repo.createSnapshot(p, label.slice(0, 120), 'manual');
    haptic('success');
    this.s.snapshots = await this.repo.listSnapshots(p.id);
    toast(t('Версия сохранена'), 'success');
    this.render();
  }

  private async restore(id: string): Promise<void> {
    const p = this.s.project;
    const snap = this.s.snapshots.find((x) => x.id === id);
    if (!p || !snap) return;
    const ok = await confirmSheet({
      title: t('Вернуть версию?'),
      message: t('Файлы проекта будут заменены версией «{name}». Текущее состояние сначала сохранится как отдельная версия.', { name: esc(snap.label) }),
      confirm: t('Вернуть'),
    });
    if (!ok) return;
    await this.flushSaves();
    this.setBusy(t('Восстанавливаю…'));
    try {
      await this.repo.restoreSnapshot(p, id);
    } finally {
      this.setBusy('');
    }
    this.editorPath = '';
    Object.keys(p.files).forEach((x) => this.editor.forget(x));
    this.s.tabs = this.s.tabs.filter((t) => p.files[t]);
    if (!p.files[this.s.currentPath]) this.s.currentPath = this.s.tabs[0] ?? Object.keys(p.files).find((x) => p.files[x]!.text) ?? '';
    this.previewDirty = true;
    this.s.snapshots = await this.repo.listSnapshots(p.id);
    haptic('success');
    toast(t('Версия восстановлена'), 'success');
    this.render();
  }

  private async deleteVersion(id: string): Promise<void> {
    const p = this.s.project;
    const snap = this.s.snapshots.find((x) => x.id === id);
    if (!p || !snap) return;
    const ok = await confirmSheet({ title: t('Удалить версию?'), message: t('Версия «{name}» будет удалена.', { name: esc(snap.label) }), confirm: t('Удалить'), danger: true });
    if (!ok) return;
    await this.repo.deleteSnapshot(p.id, id);
    this.s.snapshots = await this.repo.listSnapshots(p.id);
    this.render();
  }

  // ------------------------------------------------------------------ settings

  private async saveSettings(): Promise<void> {
    try {
      await this.repo.saveSettings(this.s.settings);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }

  // ------------------------------------------------------------------ events

  private async onClick(e: MouseEvent): Promise<void> {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!el || (el as HTMLButtonElement).disabled) return;
    const a = el.dataset.action!;
    const p = this.s.project;
    switch (a) {
      case 'welcome-samples':
        return this.s.route === 'welcome' ? this.finishOnboarding(true) : (await this.createSamples(), this.render());
      case 'welcome-empty':
        return this.finishOnboarding(false);
      case 'show-onboarding':
        return this.go('welcome');
      case 'go-home':
        return this.goHome();
      case 'back':
        if (this.s.route === 'history' || this.s.route === 'diagnostics') this.go('workspace');
        else if (this.s.route === 'privacy' || this.s.route === 'licenses') this.go('settings');
        else if (this.s.route === 'settings' && this.returnRoute === 'workspace' && p) this.go('workspace');
        else await this.goHome();
        return;
      case 'settings':
        return this.go('settings');
      case 'route':
        return this.go(el.dataset.route as Route);
      case 'new-project':
        return this.newProject();
      case 'import-project':
        return this.importProject();
      case 'open-project':
        return this.openProject(el.dataset.id!);
      case 'project-row-menu': {
        const meta = this.s.projects.find((m) => m.id === el.dataset.id);
        if (meta) await this.projectMenu(meta, false);
        return;
      }
      case 'project-menu':
        if (p) await this.projectMenu(p, true);
        return;
      case 'rename-project':
        return this.renameProject();
      case 'view':
        return this.setView(el.dataset.view as View);
      case 'filter':
        this.s.fileFilter = el.dataset.value as AppState['fileFilter'];
        return this.render();
      case 'open-file':
        return this.openFile(el.dataset.path!);
      case 'file-menu':
        return this.fileMenu(el.dataset.path!);
      case 'new-file':
        return this.newFile();
      case 'add-files':
        return this.addFilesToProject();
      case 'select-tab':
        this.s.currentPath = el.dataset.path!;
        return this.render();
      case 'close-tab': {
        await this.flushSaves();
        const path = el.dataset.path!;
        const idx = this.s.tabs.indexOf(path);
        this.s.tabs = this.s.tabs.filter((t) => t !== path);
        if (this.s.currentPath === path) this.s.currentPath = this.s.tabs[Math.max(0, idx - 1)] ?? '';
        return this.render();
      }
      case 'key': {
        const v = el.dataset.value!;
        this.editor.insert(v === '\\t' || v === '\t' ? (extOf(this.s.currentPath) === 'py' ? '    ' : '  ') : v);
        haptic('light');
        return;
      }
      case 'undo':
        return this.editor.undo();
      case 'redo':
        return this.editor.redo();
      case 'editor-search':
        return this.editor.search();
      case 'toggle-wrap':
        this.s.settings.wrapLines = !this.s.settings.wrapLines;
        this.editor.setWrap(this.s.settings.wrapLines);
        el.classList.toggle('on', this.s.settings.wrapLines);
        el.setAttribute('aria-pressed', String(this.s.settings.wrapLines));
        return this.saveSettings();
      case 'copy-code': {
        const ok = await copyText(this.editor.current());
        toast(ok ? t('Код скопирован') : t('Не удалось скопировать'), ok ? 'success' : 'error');
        return;
      }
      case 'refresh-preview':
        this.previewDirty = true;
        this.reloadPreviewFrame();
        return;
      case 'toggle-console': {
        this.s.consoleOpen = !this.s.consoleOpen;
        const panel = document.getElementById('preview-console');
        if (panel) panel.hidden = !this.s.consoleOpen;
        el.classList.toggle('on', this.s.consoleOpen);
        el.setAttribute('aria-pressed', String(this.s.consoleOpen));
        return;
      }
      case 'toggle-fullscreen':
        return this.toggleFullscreen();
      case 'clear-console':
        if (el.dataset.target === 'run-console') this.s.run.output = [];
        else this.s.previewConsole = [];
        this.refreshConsole(el.dataset.target!, []);
        return;
      case 'run':
        return this.run();
      case 'stop':
        this.runner.stop();
        return;
      case 'history':
        return this.openHistory();
      case 'checkpoint':
        return this.checkpoint();
      case 'restore-version':
        return this.restore(el.dataset.id!);
      case 'delete-version':
        return this.deleteVersion(el.dataset.id!);
      case 'diagnostics':
        return this.openDiagnostics();
      case 'refresh-diagnostics':
        return this.openDiagnostics();
      case 'open-issue': {
        const path = el.dataset.path!;
        const line = Number(el.dataset.line) || 0;
        if (!p?.files[path]?.text) return;
        this.s.route = 'workspace';
        this.openFile(path);
        if (line) requestAnimationFrame(() => this.editor.goToLine(line));
        return;
      }
      case 'export-report':
        if (p) await shareFile(reportText(p.name, p.files, this.s.issues), `codevia-report-${p.folder}.txt`, 'text/plain;charset=utf-8');
        return;
      case 'density':
        this.s.settings.density = el.dataset.value as 'compact' | 'comfortable';
        this.render();
        return this.saveSettings();
      case 'font': {
        const next = Math.max(11, Math.min(24, this.s.settings.editorFont + Number(el.dataset.delta)));
        this.s.settings.editorFont = next;
        this.render();
        return this.saveSettings();
      }
      case 'retry-save':
        await this.flushSaves();
        return;
      case 'backup-all':
        return this.backupAll();
      case 'error-log':
        return this.showErrorLog();
    }
  }

  private toggleFullscreen(force?: boolean): void {
    this.s.fullscreen = force ?? !this.s.fullscreen;
    const pane = $('#preview-pane', this.root);
    pane?.classList.toggle('fullscreen', this.s.fullscreen);
    const btn = $('[data-action="toggle-fullscreen"]', this.root);
    if (btn) {
      btn.innerHTML = icon(this.s.fullscreen ? 'close' : 'expand');
      btn.setAttribute('aria-label', this.s.fullscreen ? t('Выйти из полноэкранного режима') : t('Во весь экран'));
      btn.focus({ preventScroll: true });
    }
  }

  private onInput(e: Event): void {
    const t = e.target as HTMLInputElement;
    // Do not rebuild the screen mid-composition (QuickType/IME); the final input event follows.
    if ((e as InputEvent).isComposing) return;
    switch (t.id) {
      case 'project-search':
        this.s.projectQuery = t.value;
        this.render();
        break;
      case 'file-search':
        this.s.fileQuery = t.value;
        this.render();
        break;
      case 'run-stdin':
        this.s.run.stdin = t.value;
        break;
      case 'run-query':
        this.s.previewQuery = t.value.replace(/^\?/, '');
        this.previewDirty = true;
        break;
    }
  }

  private async onChange(e: Event): Promise<void> {
    const t = e.target as HTMLInputElement | HTMLSelectElement;
    const p = this.s.project;
    if (t.id === 'run-entry' && p) {
      await this.repo.setEntry(p, t.value);
      return;
    }
    if (t.id === 'preview-page') {
      this.s.previewPage = t.value;
      this.s.previewQuery = '';
      this.previewDirty = true;
      this.render();
      return;
    }
    if (t.id === 'ui-language') {
      const value = t.value === 'system' ? null : (t.value as Lang);
      setPreferredLang(value);
      // Every screen is translated at render time; a reload switches everything, including the editor.
      await this.flushSaves();
      location.reload();
      return;
    }
    const setting = (t as HTMLElement).dataset.setting;
    if (setting === 'wrapLines' || setting === 'previewNetwork' || setting === 'pythonDownloads') {
      this.s.settings[setting] = (t as HTMLInputElement).checked;
      if (setting === 'wrapLines') this.editor.setWrap(this.s.settings.wrapLines);
      if (setting === 'previewNetwork') this.previewDirty = true;
      if (setting === 'pythonDownloads') this.applyRuntimeOptions();
      await this.saveSettings();
    }
  }

  private onKey(e: KeyboardEvent): void {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void this.flushSaves().then(() => toast(this.s.save === 'error' ? t('Ошибка сохранения') : t('Сохранено')));
    } else if (mod && e.key === 'Enter' && this.s.route === 'workspace') {
      e.preventDefault();
      if (this.s.project?.language === 'web' || this.s.view === 'preview') {
        if (this.s.view !== 'preview') void this.setView('preview');
        else {
          this.previewDirty = true;
          this.reloadPreviewFrame();
        }
      } else void this.guard(() => this.run());
    } else if (e.key === 'Escape' && !sheetOpen() && this.s.fullscreen) {
      e.preventDefault();
      this.toggleFullscreen(false);
    } else if (e.key === 'Escape' && sheetOpen()) {
      closeSheet();
    }
  }

  /** Test hook: exposes state for E2E assertions only. */
  debugState(): AppState {
    return this.s;
  }

  get native(): boolean {
    return isNative();
  }
}
