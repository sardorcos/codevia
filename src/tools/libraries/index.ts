import { esc, icon } from '../../ui/dom';
import { t } from '../../i18n';
import { formatBytes } from '../../core/bytes';
import { textFile, type Files, type Project } from '../../core/types';
import type { Tool, ToolContext } from '../types';
import { copyText, fileText, pickProjectFile } from '../shared';
import { LIBRARIES, bundledPath, libraryById, projectPath, type Library } from './catalog';
import { addLibraryToHtml, detectLibrary, insertSnippet, removeLibraryFromHtml, rootPrefix, type LibraryState } from './html';
import '../tools.css';

interface BundleIndex {
  libraries: Array<{ id: string; version: string; files: Array<{ name: string; size: number }> }>;
  total: number;
}

const isHtml = (p: string) => /\.html?$/i.test(p);

/** The page libraries are added to: the project's entry if it is HTML, else index.html, else the first HTML file. */
export function entryHtml(project: Project | null): string | null {
  if (!project) return null;
  const paths = Object.keys(project.files);
  if (project.entry && isHtml(project.entry) && project.files[project.entry]) return project.entry;
  return paths.find((p) => p.toLowerCase() === 'index.html') ?? paths.filter(isHtml).sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))[0] ?? null;
}

/** Fetches a file bundled with the app (relative URL, so it works offline inside the iOS app). */
async function fetchBundled(path: string): Promise<string> {
  const res = await fetch(new URL(path, document.baseURI).toString(), { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.text();
}

function mount(root: HTMLElement, ctx: ToolContext): () => void {
  let page: string | null = entryHtml(ctx.project());
  let sizes: BundleIndex | null = null;
  let busy = false;

  root.classList.add('tool-root', 'tool-libs');

  const sizeOf = (lib: Library): number | null => {
    const entry = sizes?.libraries.find((l) => l.id === lib.id);
    return entry ? entry.files.reduce((s, f) => s + f.size, 0) : null;
  };

  function stateOf(lib: Library): LibraryState {
    const project = ctx.project();
    const f = page ? project?.files[page] : undefined;
    return f ? detectLibrary(fileText(f), lib) : 'none';
  }

  function render() {
    const project = ctx.project();
    const total = sizes ? formatBytes(sizes.total) : '';
    root.innerHTML = `
      <div class="tool-bar">
        <span class="tool-muted">${esc(t('Страница:'))}</span>
        <span class="tool-file mono truncate">${esc(page ?? t('нет HTML-файла'))}</span>
        <button type="button" class="btn tiny secondary" data-act="page" ${project ? '' : 'disabled'}>${esc(t('Изменить'))}</button>
      </div>
      <p class="tool-note">${icon('download', 'xs')} ${esc(t('Файлы встроены в приложение и копируются в папку libs/ проекта — интернет не нужен.'))}${total ? ` ${esc(t('Всего: {size}.', { size: total }))}` : ''}</p>
      <div class="tool-lib-grid">${LIBRARIES.map((lib) => card(lib)).join('')}</div>`;
  }

  function card(lib: Library): string {
    const state = stateOf(lib);
    const size = sizeOf(lib);
    const disabled = !page || busy ? 'disabled' : '';
    return `<article class="tool-lib-card" data-lib="${lib.id}" aria-labelledby="lib-${lib.id}-name">
      <header class="tool-lib-head">
        <h3 id="lib-${lib.id}-name">${esc(lib.name)}</h3>
        <span class="pill">${esc(lib.version)}</span>
        ${state === 'added' ? `<span class="pill cyan">${icon('check', 'xs')}${esc(t('Подключена'))}</span>` : ''}
        ${state === 'other' ? `<span class="pill tool-pill-warn">${esc(t('Подключена иначе (CDN?)'))}</span>` : ''}
      </header>
      <p class="tool-lib-desc">${esc(t(lib.description))}</p>
      <div class="tool-lib-meta">
        ${lib.tags.map((tag) => `<span class="tool-tag">${esc(tag)}</span>`).join('')}
        <span class="tool-muted">${esc(lib.license)}${size != null ? ` · ${esc(formatBytes(size))}` : ''}</span>
      </div>
      <div class="btn-row">
        ${
          state === 'added'
            ? `<button type="button" class="btn tiny danger" data-act="remove" ${disabled}>${icon('trash', 'sm')}<span>${esc(t('Удалить из проекта'))}</span></button>`
            : `<button type="button" class="btn tiny primary" data-act="add" ${disabled}>${icon('plus', 'sm')}<span>${esc(t('Добавить в проект'))}</span></button>`
        }
        <button type="button" class="btn tiny secondary" data-act="example" ${disabled}>${esc(t('Вставить пример'))}</button>
      </div>
      <details class="tool-lib-example">
        <summary>${esc(t(lib.example.label))}</summary>
        <pre class="tool-pre mono">${esc(lib.example.html)}</pre>
        <button type="button" class="btn tiny ghost" data-act="copy-example">${icon('copy', 'sm')}<span>${esc(t('Копировать'))}</span></button>
      </details>
    </article>`;
  }

  async function add(lib: Library) {
    const project = ctx.project();
    if (!project || !page) return;
    const html = fileText(project.files[page]);
    if (detectLibrary(html, lib) === 'other' && !(await ctx.confirm({ title: t('Библиотека уже подключена'), message: t('{name} уже подключена на странице другим способом (например, с CDN). Добавить локальную копию?', { name: lib.name }), ok: t('Добавить') }))) return;
    const files: Files = {};
    for (const f of lib.files) {
      try {
        files[projectPath(lib, f)] = textFile(await fetchBundled(bundledPath(lib, f)));
      } catch {
        ctx.toast(t('Файл {name} не найден в приложении. Пересоберите приложение (npm run build).', { name: f.name }), 'error');
        return;
      }
    }
    const r = addLibraryToHtml(html, lib, rootPrefix(page));
    if (r.changed) files[page] = textFile(r.html);
    await ctx.writeFiles(files, { snapshotLabel: t('Перед добавлением {name}', { name: lib.name }) });
    ctx.haptic('success');
    ctx.toast(t('{name} добавлена в проект', { name: lib.name }), 'success');
  }

  async function remove(lib: Library) {
    const project = ctx.project();
    if (!project || !page) return;
    if (!(await ctx.confirm({ title: t('Удалить {name}?', { name: lib.name }), message: t('Теги будут убраны со страницы, а файлы из папки libs/{id}/ удалены.', { id: lib.id }), ok: t('Удалить'), destructive: true }))) return;
    const r = removeLibraryFromHtml(fileText(project.files[page]), lib);
    const remove = Object.keys(project.files).filter((p) => p.startsWith(`libs/${lib.id}/`));
    await ctx.writeFiles(r.changed ? { [page]: textFile(r.html) } : {}, { remove, snapshotLabel: t('Перед удалением {name}', { name: lib.name }) });
    ctx.toast(t('{name} удалена из проекта', { name: lib.name }), 'success');
  }

  async function example(lib: Library) {
    const project = ctx.project();
    if (!project || !page) return;
    let html = fileText(project.files[page]);
    const files: Files = {};
    if (detectLibrary(html, lib) === 'none') {
      // The example needs the library: add it first.
      for (const f of lib.files) files[projectPath(lib, f)] = textFile(await fetchBundled(bundledPath(lib, f)));
      html = addLibraryToHtml(html, lib, rootPrefix(page)).html;
    }
    const r = insertSnippet(html, lib.example.html);
    if (!r.changed && !Object.keys(files).length) {
      ctx.toast(t('Пример уже есть на странице'), 'info');
      return;
    }
    files[page] = textFile(r.html);
    await ctx.writeFiles(files, { snapshotLabel: t('Перед добавлением {name}', { name: lib.name }) });
    ctx.toast(t('Пример вставлен в {path}', { path: page }), 'success');
  }

  const onClick = async (e: MouseEvent) => {
    const el = e.target as HTMLElement;
    const act = el.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'page') {
      const p = await pickProjectFile(ctx, { title: t('HTML-страница'), filter: isHtml, empty: t('В проекте нет HTML-файлов') });
      if (p) {
        page = p;
        render();
      }
      return;
    }
    const lib = libraryById(el.closest<HTMLElement>('[data-lib]')?.dataset.lib ?? '');
    if (!lib) return;
    if (act === 'copy-example') return void copyText(lib.example.html, ctx);
    if (busy) return;
    busy = true;
    try {
      if (act === 'add') await add(lib);
      else if (act === 'remove') await remove(lib);
      else if (act === 'example') await example(lib);
    } catch (err) {
      ctx.toast(String((err as Error)?.message ?? err), 'error');
    } finally {
      busy = false;
      render();
    }
  };

  root.addEventListener('click', onClick);
  render();
  let alive = true;
  void fetchBundled('libs/index.json')
    .then((text) => {
      sizes = JSON.parse(text) as BundleIndex;
      if (alive && !busy) render();
    })
    .catch(() => undefined);

  return () => {
    alive = false;
    root.removeEventListener('click', onClick);
    root.innerHTML = '';
    root.classList.remove('tool-root', 'tool-libs');
  };
}

export const librariesTool: Tool = {
  id: 'libraries',
  title: 'Библиотеки',
  icon: 'package',
  needsProject: true,
  mount,
};
