import { decodeUtf8, formatBytes, makeId } from './core/bytes';
import { reportText, scanProject } from './core/diagnostics';
import { basename, extOf, fileKind, isJunkPath, isTextPath, normalizePath, uniquePath } from './core/paths';
import { buildPreview } from './core/preview';
import { defaultEntry, detectLanguage, templateFiles, templateLanguage, type TemplateId } from './core/templates';
import { binaryFile, LIMITS, textFile, type Files, type Project, type ProjectFile, type ProjectMeta } from './core/types';
import { stripCommonRoot, unzip, zipFiles } from './core/zip';
import { createEditor, type EditorHost } from './editor/editor';
import { copyText, haptic, initNativeChrome, isNative, pickFiles, shareFile } from './platform/native';
import { Runner, type RuntimeKind } from './runtime/runner';
import { initialState, type AppState, type ConsoleLine, type Route, type View } from './state';
import { filesSize } from './storage/repository';
import { migrateLegacy, openStorage } from './storage';
import type { Repository } from './storage/repository';
import { $, esc, icon, toast } from './ui/dom';
import { closeSheet, confirmSheet, menuSheet, openSheet, promptSheet, sheetOpen } from './ui/sheet';
import * as V from './ui/views';

const SAVE_DELAY = 700;
const MAX_OUTPUT_CHARS = 400_000;
const AUTO_SNAPSHOT_AFTER_MS = 12 * 60 * 60 * 1000;

const NEW_FILE_CONTENT: Record<string, (name: string) => string> = {
  html: (n) => `<!doctype html>\n<html lang="ru">\n<head>\n  <meta charset="utf-8" />\n  <meta name="viewport" content="width=device-width, initial-scale=1" />\n  <title>${n}</title>\n</head>\n<body>\n\n</body>\n</html>\n`,
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
      if (migrated) toast(`Перенесено проектов из прошлой версии: ${migrated}`, 'success');
    }
    this.s.settings = await this.repo.loadSettings();
    this.editor.setWrap(this.s.settings.wrapLines);
    this.s.projects = await this.repo.listProjects();
    this.s.route = !this.s.settings.onboardingDone && !this.s.projects.length ? 'welcome' : 'home';

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

  private async guard(fn: () => unknown): Promise<void> {
    try {
      await fn();
    } catch (e) {
      console.error(e);
      this.setBusy('');
      haptic('error');
      toast((e as Error)?.message || 'Что-то пошло не так', 'error');
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
    el.innerHTML = this.s.save === 'saving' ? 'Сохранение…' : this.s.save === 'error' ? 'Ошибка сохранения' : `${icon('check', 'xs')} Сохранено`;
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

  async flushSaves(): Promise<void> {
    clearTimeout(this.saveTimer);
    this.saving = this.saving.then(async () => {
      const p = this.s.project;
      if (!p || !this.pending.size) return;
      const paths = [...this.pending];
      this.pending.clear();
      try {
        for (const path of paths) await this.repo.saveFile(p, path);
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
    return this.saving;
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
    await this.flushSaves();
    if (this.runner.running) this.runner.stop();
    this.s.route = 'home';
    this.s.project = null;
    this.s.projects = await this.repo.listProjects();
    this.render();
  }

  // ------------------------------------------------------------------ projects

  private async openProject(id: string): Promise<void> {
    await this.flushSaves();
    const meta = this.s.projects.find((m) => m.id === id) ?? (await this.repo.listProjects()).find((m) => m.id === id);
    if (!meta) throw new Error('Проект не найден');
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
      await this.repo.createSnapshot(project, 'Автоверсия при открытии', 'auto');
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
      title: 'Новый проект',
      body: `<form class="stack" id="new-project-form" novalidate>
        <div class="field"><label class="field-label" for="np-name">Название</label>
        <input class="text-input" id="np-name" maxlength="80" placeholder="Мой сайт" autocomplete="off"></div>
        <div class="field"><span class="field-label" id="np-tpl-label">Шаблон</span>
        <div class="template-grid" role="radiogroup" aria-labelledby="np-tpl-label">
          ${(
            [
              ['web', 'Сайт', 'HTML, CSS, JS', 'code'],
              ['python', 'Python', 'Скрипт и данные', 'terminal'],
              ['php', 'PHP', 'Страница на PHP 8.3', 'server'],
              ['empty', 'Пустой', 'Один index.html', 'file'],
            ] as const
          )
            .map(
              ([id, t, d, ic], i) =>
                `<button type="button" class="template ${i === 0 ? 'active' : ''}" role="radio" aria-checked="${i === 0}" data-tpl="${id}">${icon(ic)}<strong>${t}</strong><span>${d}</span></button>`,
            )
            .join('')}
        </div></div>
        <button class="btn primary full" type="submit">Создать проект</button></form>`,
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
          const fallback = { web: 'Мой сайт', python: 'Python-проект', php: 'PHP-проект', empty: 'Новый проект' }[template];
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
    this.setBusy('Создаю примеры…');
    for (const [t, name] of [
      ['web', 'Сайт-портфолио'],
      ['python', 'Python · расчёты'],
      ['php', 'PHP · приветствие'],
    ] as const) {
      await this.repo.createProject(name, templateLanguage(t), templateFiles(t, name));
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
      if (zip.size > LIMITS.maxZipBytes) throw new Error(`ZIP больше ${formatBytes(LIMITS.maxZipBytes)}`);
      const result = await unzip(new Uint8Array(await zip.arrayBuffer()));
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
      if (f.size > LIMITS.maxFileBytes) throw new Error(`Файл ${f.name} больше ${formatBytes(LIMITS.maxFileBytes)}`);
      total += f.size;
      if (total > LIMITS.maxProjectBytes) throw new Error('Слишком большой объём файлов');
      const safe = normalizePath(f.name);
      const path = uniquePath(safe, Object.keys(out));
      if (path !== safe) renamed++;
      const bytes = new Uint8Array(await f.arrayBuffer());
      out[path] = isTextPath(path) ? textFile(decodeUtf8(bytes)) : binaryFile(bytes);
    }
    return { files: out, name: files.length === 1 ? files[0]!.name.replace(/\.[^.]+$/, '') : 'Импорт', skipped, renamed };
  }

  private async importProject(): Promise<void> {
    const picked = await pickFiles('.zip,application/zip,.html,.htm,.css,.js,.mjs,.json,.php,.py,.md,.txt,.svg,.png,.jpg,.jpeg,.gif,.webp,.woff,.woff2,.ttf,.csv,.xml', true);
    if (!picked.length) return;
    this.setBusy('Импорт…');
    try {
      const { files, name, skipped, renamed } = await this.readPicked(picked);
      if (!Object.keys(files).length) throw new Error('В архиве нет файлов');
      const project = await this.repo.createProject(name, detectLanguage(Object.keys(files)), files);
      this.setBusy('');
      haptic('success');
      const notes = [skipped && `пропущено служебных: ${skipped}`, renamed && `переименовано дубликатов: ${renamed}`].filter(Boolean).join(', ');
      toast(`Импортировано файлов: ${Object.keys(files).length}${notes ? ` (${notes})` : ''}`, 'success');
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
    this.setBusy('Добавляю файлы…');
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
        title: 'Файлы уже существуют',
        message: `${conflicts.length} из добавляемых файлов уже есть в проекте (${esc(conflicts.slice(0, 3).join(', '))}${conflicts.length > 3 ? '…' : ''}). Заменить их? Иначе будут сохранены обе версии.`,
        confirm: 'Заменить',
        cancel: 'Сохранить обе',
      });
      if (replace) await this.repo.createSnapshot(p, 'Перед заменой файлов', 'auto');
    }
    const merged: Files = { ...p.files };
    for (const [path, f] of Object.entries(incoming)) merged[replace ? path : uniquePath(path, Object.keys(merged))] = f;
    if (Object.keys(merged).length > LIMITS.maxFilesPerProject) throw new Error('Слишком много файлов в проекте');
    if (filesSize(merged) > LIMITS.maxProjectBytes) throw new Error('Проект станет слишком большим');
    this.setBusy('Сохраняю…');
    try {
      await this.repo.replaceFiles(p, merged);
    } finally {
      this.setBusy('');
    }
    conflicts.forEach((c) => replace && this.editor.forget(c));
    this.previewDirty = true;
    toast(`Добавлено файлов: ${Object.keys(incoming).length}`, 'success');
    this.render();
  }

  private async exportProject(meta?: ProjectMeta): Promise<void> {
    await this.flushSaves();
    const project = meta && meta.id !== this.s.project?.id ? await this.repo.openProject(meta) : this.s.project;
    if (!project) return;
    this.setBusy('Упаковываю ZIP…');
    try {
      const blob = await zipFiles(project.files);
      const r = await shareFile(blob, `${project.folder}.zip`, 'application/zip');
      if (r === 'downloaded') toast('ZIP сохранён в загрузки', 'success');
    } finally {
      this.setBusy('');
    }
  }

  private async renameProject(meta?: ProjectMeta): Promise<void> {
    const target = meta && meta.id !== this.s.project?.id ? await this.repo.openProject(meta) : this.s.project;
    if (!target) return;
    const name = await promptSheet({ title: 'Название проекта', label: 'Название', value: target.name, confirm: 'Сохранить' });
    if (!name || name === target.name) return;
    await this.repo.renameProject(target, name);
    this.s.projects = await this.repo.listProjects();
    this.render();
  }

  private async deleteProject(meta: ProjectMeta): Promise<void> {
    const ok = await confirmSheet({
      title: 'Удалить проект?',
      message: `Проект <strong>${esc(meta.name)}</strong> и все его версии будут удалены с устройства. Это нельзя отменить. Если нужна копия — сначала экспортируйте ZIP.`,
      confirm: 'Удалить проект',
      danger: true,
    });
    if (!ok) return;
    if (this.s.project?.id === meta.id) {
      this.pending.clear();
      this.s.project = null;
      this.s.route = 'home';
    }
    await this.repo.deleteProject(meta);
    haptic('warning');
    this.s.projects = await this.repo.listProjects();
    toast('Проект удалён');
    this.render();
  }

  private async projectMenu(meta: ProjectMeta, inWorkspace: boolean): Promise<void> {
    const choice = await menuSheet(meta.name, [
      { id: 'rename', label: 'Переименовать', icon: 'edit' },
      { id: 'duplicate', label: 'Дублировать', icon: 'duplicate' },
      { id: 'export', label: 'Экспорт ZIP', icon: 'share' },
      ...(inWorkspace ? [{ id: 'check', label: 'Проверка файлов', icon: 'shield' }] : []),
      { id: 'delete', label: 'Удалить проект', icon: 'trash', danger: true },
    ]);
    if (choice === 'rename') await this.renameProject(meta);
    else if (choice === 'duplicate') {
      await this.flushSaves();
      const src = meta.id === this.s.project?.id ? this.s.project : await this.repo.openProject(meta);
      const copy = await this.repo.duplicateProject(src!);
      this.s.projects = await this.repo.listProjects();
      toast(`Создана копия «${copy.name}»`, 'success');
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
      body: `${isImage ? `<div class="image-preview"><img src="${url}" alt="${esc(path)}"></div>` : `<p class="sheet-text">Этот файл нельзя редактировать в приложении, но он входит в проект и в экспорт.</p>`}
        <div class="subtxt mono">${esc(path)} · ${formatBytes(f.data.byteLength)}</div>
        <div class="sheet-actions"><button class="btn secondary full" data-sheet-close>Готово</button></div>`,
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
        { id: 'open', label: p.files[path]!.text ? 'Открыть в редакторе' : 'Просмотреть', icon: p.files[path]!.text ? 'code' : 'eye' },
        { id: 'rename', label: 'Переименовать или переместить', icon: 'edit' },
        ...(runnable ? [{ id: 'entry', label: 'Сделать файлом запуска', icon: 'flag' }] : []),
        { id: 'share', label: 'Поделиться файлом', icon: 'share' },
        { id: 'delete', label: 'Удалить файл', icon: 'trash', danger: true },
      ],
      path,
    );
    if (choice === 'open') this.openFile(path);
    else if (choice === 'rename') await this.renameFile(path);
    else if (choice === 'entry') {
      await this.repo.setEntry(p, path);
      this.s.previewPage = /\.(html?|php)$/i.test(path) ? path : this.s.previewPage;
      this.previewDirty = true;
      toast(`Файл запуска: ${basename(path)}`);
      this.render();
    } else if (choice === 'share') {
      const f = p.files[path]!;
      await shareFile(f.text ? f.content : f.data, basename(path), f.text ? 'text/plain;charset=utf-8' : 'application/octet-stream');
    } else if (choice === 'delete') await this.deleteFile(path);
  }

  private validateNewPath(v: string, except?: string): string | null {
    try {
      const path = normalizePath(v);
      const p = this.s.project!;
      const clash = Object.keys(p.files).find((x) => x.toLowerCase() === path.toLowerCase() && x !== except);
      if (clash) return 'Файл с таким именем уже существует';
      if (Object.keys(p.files).some((x) => x.startsWith(path + '/'))) return 'Это имя занято папкой';
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
      title: 'Новый файл',
      label: 'Имя файла (можно с папкой)',
      value: suggestion,
      placeholder: 'css/theme.css',
      confirm: 'Создать',
      mono: true,
      help: 'Папки создаются автоматически: например, <span class="mono">js/main.js</span>.',
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
      title: 'Переименовать',
      label: 'Новый путь',
      value: from,
      confirm: 'Сохранить',
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
      title: 'Удалить файл?',
      message: `<span class="mono">${esc(path)}</span> будет удалён. Перед удалением автоматически сохранится версия проекта — файл можно будет вернуть из истории.`,
      confirm: 'Удалить',
      danger: true,
    });
    if (!ok) return;
    await this.flushSaves();
    await this.repo.createSnapshot(p, `Перед удалением ${basename(path)}`, 'auto');
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
    toast('Файл удалён. Вернуть можно в истории версий.');
    this.render();
  }

  // ------------------------------------------------------------------ preview

  private async ensurePreview(): Promise<void> {
    if (this.previewDirty || this.previewHtml === null) {
      if (!this.previewBuilding) {
        this.previewBuilding = this.buildPreviewHtml().finally(() => (this.previewBuilding = null));
      }
      await this.previewBuilding;
    }
    this.postPreview();
  }

  private async buildPreviewHtml(): Promise<void> {
    const p = this.s.project;
    const page = this.s.previewPage;
    if (!p || !page) return;
    this.previewDirty = false;
    this.previewToken = makeId();
    this.s.previewConsole = [];
    this.refreshConsole('preview-console', this.s.previewConsole);
    let source: string;
    if (/\.php$/i.test(page)) {
      let html = '';
      let errors = '';
      let text = '';
      try {
        await this.runner.run('php', p.files, page, { onStdout: (t) => (text += t), onStderr: (t) => (errors += t), onHtml: (h) => (html = h) }, { query: this.s.previewQuery });
      } catch (e) {
        errors += (e as Error).message;
      }
      if (errors) this.pushPreviewConsole({ level: 'error', text: `PHP: ${errors.trim()}\n` });
      source = html || `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><pre style="white-space:pre-wrap;font:14px ui-monospace,monospace;padding:16px">${esc(text || errors || '(нет вывода)')}</pre></body></html>`;
    } else {
      const f = p.files[page];
      source = f?.text ? f.content : '';
    }
    const result = buildPreview(p.files, page, source, { allowNetwork: this.s.settings.previewNetwork, token: this.previewToken });
    for (const m of result.missing.slice(0, 20)) this.pushPreviewConsole({ level: 'warn', text: `Не найден файл: ${m}\n` });
    this.previewHtml = result.html;
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
    if (!frame || e.source !== frame.contentWindow) return;
    const d = e.data as { type?: string; token?: string; [k: string]: unknown };
    if (d?.type === 'codevia:host-ready') {
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
        toast(`Страница не найдена: ${path || '—'}`, 'error');
        return;
      }
      this.s.previewPage = target;
      this.s.previewQuery = typeof d.query === 'string' ? d.query : '';
      this.previewDirty = true;
      this.render();
    } else if (d.type === 'external') {
      const href = String(d.href).slice(0, 2000);
      void copyText(href).then((ok) => toast(ok ? `Внешняя ссылка скопирована: ${href}` : `Внешняя ссылка: ${href}`));
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

  private appendConsoleLine(id: string, line: ConsoleLine): void {
    const panel = document.getElementById(id);
    if (!panel) return;
    panel.querySelector('.console-line.system.empty')?.remove();
    const span = document.createElement('span');
    span.className = `console-line ${line.level}`;
    span.textContent = line.text;
    panel.insertBefore(span, panel.querySelector('.console-clear'));
    panel.scrollTop = panel.scrollHeight;
  }

  private refreshConsole(id: string, lines: ConsoleLine[]): void {
    const panel = document.getElementById(id);
    if (!panel) return;
    panel.querySelectorAll('.console-line').forEach((x) => x.remove());
    if (!lines.length) panel.insertAdjacentHTML('afterbegin', '<span class="console-line system empty">Консоль пуста</span>');
    lines.forEach((l) => this.appendConsoleLine(id, l));
  }

  // ------------------------------------------------------------------ run

  private async run(): Promise<void> {
    const p = this.s.project;
    if (!p || p.language === 'web' || this.runner.running) return;
    const entry = p.entry && p.files[p.entry] ? p.entry : defaultEntry(Object.keys(p.files), p.language);
    if (!entry) throw new Error('Нет файла для запуска');
    await this.flushSaves();
    const stdin = ($<HTMLTextAreaElement>('#run-stdin', this.root)?.value ?? this.s.run.stdin) || '';
    this.s.run = { running: true, status: 'Подготовка…', output: [], exitCode: null, ms: null, stdin };
    this.outputChars = 0;
    this.render();
    const push = (level: ConsoleLine['level'], text: string) => {
      if (!text) return;
      this.outputChars += text.length;
      if (this.outputChars > MAX_OUTPUT_CHARS) {
        if (this.runner.running) {
          this.runner.stop();
          const l: ConsoleLine = { level: 'system', text: '\nВывод слишком большой — выполнение остановлено.\n' };
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
      setStatus('Выполняется…');
      const kind = p.language as RuntimeKind;
      const r = await this.runner.run(
        kind,
        p.files,
        entry,
        { onStatus: setStatus, onStdout: (t) => push('stdout', t), onStderr: (t) => push('stderr', t), onHtml: () => undefined },
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
      title: 'Сохранить версию',
      label: 'Описание',
      value: `Версия от ${new Date().toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`,
      confirm: 'Сохранить',
    });
    if (!label) return;
    await this.flushSaves();
    await this.repo.createSnapshot(p, label.slice(0, 120), 'manual');
    haptic('success');
    this.s.snapshots = await this.repo.listSnapshots(p.id);
    toast('Версия сохранена', 'success');
    this.render();
  }

  private async restore(id: string): Promise<void> {
    const p = this.s.project;
    const snap = this.s.snapshots.find((x) => x.id === id);
    if (!p || !snap) return;
    const ok = await confirmSheet({
      title: 'Вернуть версию?',
      message: `Файлы проекта будут заменены версией «${esc(snap.label)}». Текущее состояние сначала сохранится как отдельная версия.`,
      confirm: 'Вернуть',
    });
    if (!ok) return;
    await this.flushSaves();
    this.setBusy('Восстанавливаю…');
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
    toast('Версия восстановлена', 'success');
    this.render();
  }

  private async deleteVersion(id: string): Promise<void> {
    const p = this.s.project;
    const snap = this.s.snapshots.find((x) => x.id === id);
    if (!p || !snap) return;
    const ok = await confirmSheet({ title: 'Удалить версию?', message: `Версия «${esc(snap.label)}» будет удалена.`, confirm: 'Удалить', danger: true });
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
        toast(ok ? 'Код скопирован' : 'Не удалось скопировать', ok ? 'success' : 'error');
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
        return this.flushSaves();
    }
  }

  private toggleFullscreen(force?: boolean): void {
    this.s.fullscreen = force ?? !this.s.fullscreen;
    const pane = $('#preview-pane', this.root);
    pane?.classList.toggle('fullscreen', this.s.fullscreen);
    const btn = $('[data-action="toggle-fullscreen"]', this.root);
    if (btn) {
      btn.innerHTML = icon(this.s.fullscreen ? 'close' : 'expand');
      btn.setAttribute('aria-label', this.s.fullscreen ? 'Выйти из полноэкранного режима' : 'Во весь экран');
      btn.focus({ preventScroll: true });
    }
  }

  private onInput(e: Event): void {
    const t = e.target as HTMLInputElement;
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
    const setting = (t as HTMLElement).dataset.setting;
    if (setting === 'wrapLines' || setting === 'previewNetwork') {
      this.s.settings[setting] = (t as HTMLInputElement).checked;
      if (setting === 'wrapLines') this.editor.setWrap(this.s.settings.wrapLines);
      if (setting === 'previewNetwork') this.previewDirty = true;
      await this.saveSettings();
    }
  }

  private onKey(e: KeyboardEvent): void {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void this.flushSaves().then(() => toast(this.s.save === 'error' ? 'Ошибка сохранения' : 'Сохранено'));
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
