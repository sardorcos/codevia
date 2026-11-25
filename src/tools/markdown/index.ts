import { esc, icon } from '../../ui/dom';
import { t } from '../../i18n';
import { bytesToBase64 } from '../../core/bytes';
import { isExternalRef, mimeOf, resolveRelative } from '../../core/paths';
import type { Files } from '../../core/types';
import type { Tool, ToolContext } from '../types';
import { fileBytes, fileText, loadStored, pickProjectFile, saveStored, segmented, setSegmented } from '../shared';
import { headingsOf, renderMarkdown } from './render';
import '../tools.css';

export { renderMarkdown } from './render';

const isMd = (p: string) => /\.(md|markdown|mdown|mkd)$/i.test(p);

/** data: URL of a project image referenced from `from` (null when missing or not an image). */
export function projectImageUrl(files: Files, from: string, src: string): string | null {
  const path = resolveRelative(from, src);
  const f = path ? files[path] : undefined;
  if (!path || !f) return null;
  const mime = mimeOf(path);
  if (!mime.startsWith('image/')) return null;
  return `data:${mime};base64,${bytesToBase64(fileBytes(f))}`;
}

function mount(root: HTMLElement, ctx: ToolContext): () => void {
  let file: string | null = null;
  let lastText: string | null = null;
  let theme = loadStored<'dark' | 'light'>('md.theme', 'dark') === 'light' ? 'light' : 'dark';

  root.classList.add('tool-root', 'tool-md');
  root.innerHTML = `
    <div class="tool-bar">
      <button type="button" class="btn tiny secondary" data-act="pick">${icon('file', 'sm')}<span>${esc(t('Выбрать файл'))}</span></button>
      <span class="tool-file mono truncate" data-file></span>
      <span class="grow"></span>
      ${segmented('theme', [['dark', t('Тёмная')], ['light', t('Светлая')]], theme, t('Тема чтения'))}
      <button type="button" class="icon-btn" data-act="outline" aria-label="${esc(t('Оглавление'))}" aria-expanded="false">${icon('sliders', 'sm')}</button>
      <button type="button" class="icon-btn" data-act="edit" aria-label="${esc(t('Открыть в редакторе'))}">${icon('edit', 'sm')}</button>
    </div>
    <div class="tool-md-layout">
      <nav class="tool-md-outline" aria-label="${esc(t('Оглавление'))}" data-outline hidden></nav>
      <div class="tool-md-scroll" data-scroll>
        <article class="tool-md-article" data-article data-theme="${theme}"></article>
      </div>
    </div>`;

  const q = <T extends HTMLElement = HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const article = q('[data-article]');
  const outline = q('[data-outline]');
  const scroll = q('[data-scroll]');

  function render(keepScroll = false) {
    const project = ctx.project();
    const f = file ? project?.files[file] : undefined;
    q('[data-file]').textContent = file ?? '';
    if (!project || !file || !f) {
      lastText = null;
      article.innerHTML = `<div class="tool-empty">${icon('file', 'xl')}<p>${esc(project ? t('Выберите Markdown-файл проекта') : t('Откройте проект с файлами .md'))}</p></div>`;
      outline.innerHTML = '';
      return;
    }
    const text = fileText(f);
    lastText = text;
    const top = scroll.scrollTop;
    const from = file;
    article.innerHTML = renderMarkdown(text, { resolveImage: (src) => projectImageUrl(project.files, from, src) }) || `<p class="tool-muted">${esc(t('Файл пуст'))}</p>`;
    const heads = headingsOf(article);
    outline.innerHTML = heads.length
      ? `<ul>${heads.map((h) => `<li class="lvl-${h.level}"><a href="#${esc(h.id)}" data-jump="${esc(h.id)}">${esc(h.text)}</a></li>`).join('')}</ul>`
      : `<p class="tool-muted">${esc(t('Заголовков нет'))}</p>`;
    scroll.scrollTop = keepScroll ? top : 0;
  }

  function open(path: string) {
    file = path;
    render();
  }

  const jump = (id: string) => {
    const target = article.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`);
    if (!target) return;
    target.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
  };

  const onClick = async (e: MouseEvent) => {
    const el = e.target as HTMLElement;
    const th = el.closest<HTMLElement>('[data-theme]:not(article)');
    if (th?.dataset.theme) {
      theme = th.dataset.theme === 'light' ? 'light' : 'dark';
      article.dataset.theme = theme;
      setSegmented(root, 'theme', theme);
      saveStored('md.theme', theme);
      return;
    }
    const j = el.closest<HTMLElement>('[data-jump]');
    if (j) {
      e.preventDefault();
      jump(j.dataset.jump!);
      if (root.clientWidth < 760) toggleOutline(false);
      return;
    }
    const a = el.closest<HTMLAnchorElement>('a[href]');
    if (a && article.contains(a)) {
      e.preventDefault();
      const href = a.getAttribute('href') ?? '';
      if (href.startsWith('#')) jump(`md-${decodeURIComponent(href.slice(1))}`);
      else if (isExternalRef(href)) {
        if (/^(https?|mailto|tel):/i.test(href)) ctx.openExternal(href);
      } else if (file) {
        const path = resolveRelative(file, href);
        const project = ctx.project();
        if (path && project?.files[path]) {
          if (isMd(path)) open(path);
          else ctx.openFile(path);
        } else ctx.toast(t('Файл не найден: {path}', { path: path ?? href }), 'error');
      }
      return;
    }
    switch (el.closest<HTMLElement>('[data-act]')?.dataset.act) {
      case 'pick': {
        const path = await pickProjectFile(ctx, { title: t('Markdown-файл'), filter: isMd, empty: t('В проекте нет файлов .md') });
        if (path) open(path);
        break;
      }
      case 'outline':
        toggleOutline();
        break;
      case 'edit':
        if (file) ctx.openFile(file);
        break;
    }
  };

  function toggleOutline(force?: boolean) {
    const show = force ?? outline.hidden;
    outline.hidden = !show;
    q('[data-act="outline"]').setAttribute('aria-expanded', String(show));
    q('[data-act="outline"]').classList.toggle('on', show);
  }

  // Live preview: re-render when the file changes in the editor (e.g. side pane on iPad).
  const timer = setInterval(() => {
    if (!file) return;
    const f = ctx.project()?.files[file];
    const text = f ? fileText(f) : null;
    if (text !== lastText) render(true);
  }, 1000);

  root.addEventListener('click', onClick);
  const active = ctx.activeFile();
  const project = ctx.project();
  if (active && isMd(active) && project?.files[active]) open(active);
  else {
    const readme = project && Object.keys(project.files).find((p) => /^readme\.(md|markdown)$/i.test(p));
    if (readme) open(readme);
    else render();
  }
  if (root.clientWidth >= 760) toggleOutline(true);

  return () => {
    clearInterval(timer);
    root.removeEventListener('click', onClick);
    root.innerHTML = '';
    root.classList.remove('tool-root', 'tool-md');
  };
}

export const markdownTool: Tool = {
  id: 'markdown',
  title: 'Markdown',
  icon: 'markdown',
  mount,
};
