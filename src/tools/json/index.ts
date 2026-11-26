import { esc, icon } from '../../ui/dom';
import { menuSheet } from '../../ui/sheet';
import { t } from '../../i18n';
import { textFile } from '../../core/types';
import { formatBytes } from '../../core/bytes';
import type { Tool, ToolContext } from '../types';
import { copyText, debounce, fileText, pickProjectFile, segmented, setSegmented, uid } from '../shared';
import { formatJson, minifyJson, parseJson, sortKeysDeep, type Indent, type JsonValue } from './format';
import { renderJsonTree, type JsonTreeHandle } from './tree';
import '../tools.css';

export { renderJsonTree } from './tree';

const isJsonPath = (p: string) => /\.(json|webmanifest|map|geojson)$/i.test(p) || /(^|\/)\.?(babelrc|eslintrc|prettierrc)$/i.test(p);

function mount(root: HTMLElement, ctx: ToolContext): () => void {
  const id = uid('json');
  root.classList.add('tool-root', 'tool-json');
  root.innerHTML = `
    <div class="tool-bar" role="toolbar" aria-label="${esc(t('Действия с JSON'))}">
      <button type="button" class="btn tiny secondary" data-act="open">${icon('folder', 'sm')}<span>${esc(t('Открыть файл'))}</span></button>
      <button type="button" class="btn tiny secondary" data-act="paste">${icon('copy', 'sm')}<span>${esc(t('Вставить'))}</span></button>
      <button type="button" class="btn tiny primary" data-act="save" hidden>${icon('save', 'sm')}<span>${esc(t('Сохранить'))}</span></button>
      <span class="tool-file mono truncate grow" data-file></span>
      <button type="button" class="icon-btn" data-act="more" aria-label="${esc(t('Ещё действия'))}">${icon('more')}</button>
    </div>
    <div class="tool-bar">
      ${segmented('indent', [['2', '2'], ['4', '4'], ['tab', 'Tab']], '2', t('Отступ'))}
      <button type="button" class="btn tiny primary" data-act="pretty">${esc(t('Форматировать'))}</button>
    </div>
    <div class="tool-json-tabs">${segmented('view', [['text', t('Текст')], ['tree', t('Дерево')]], 'text', t('Вид'))}</div>
    <div class="tool-status" data-status role="status" aria-live="polite"></div>
    <div class="tool-json-body" data-view="text">
      <section class="tool-json-text">
        <label class="visually-hidden" for="${id}-src">${esc(t('JSON-текст'))}</label>
        <textarea id="${id}-src" class="text-input textarea tool-code" spellcheck="false" autocapitalize="off" autocorrect="off" autocomplete="off"
          placeholder="${esc(t('Вставьте или введите JSON'))}"></textarea>
      </section>
      <section class="tool-json-tree">
        <div class="tool-bar tool-search">
          <input type="search" class="text-input" data-q placeholder="${esc(t('Поиск по ключам и значениям'))}" aria-label="${esc(t('Поиск по ключам и значениям'))}" autocapitalize="off" autocorrect="off" spellcheck="false">
          <span class="tool-muted tool-count" data-count aria-live="polite"></span>
          <button type="button" class="icon-btn" data-act="prev" aria-label="${esc(t('Предыдущее совпадение'))}">${icon('back', 'sm')}</button>
          <button type="button" class="icon-btn" data-act="next" aria-label="${esc(t('Следующее совпадение'))}">${icon('chevron', 'sm')}</button>
        </div>
        <div class="tool-bar">
          <button type="button" class="btn tiny ghost" data-act="expand">${esc(t('Развернуть всё'))}</button>
          <button type="button" class="btn tiny ghost" data-act="collapse">${esc(t('Свернуть всё'))}</button>
        </div>
        <div class="tool-json-treehost" data-tree></div>
      </section>
    </div>`;

  const q = <T extends HTMLElement = HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const area = q<HTMLTextAreaElement>('textarea');
  const status = q('[data-status]');
  const body = q('.tool-json-body');
  const saveBtn = q<HTMLButtonElement>('[data-act="save"]');
  const fileLabel = q('[data-file]');
  let indent: Indent = 2;
  let file: string | null = null;
  let savedText = '';
  let parsed: { ok: true; value: JsonValue } | { ok: false } = { ok: false };
  let tree: JsonTreeHandle | null = null;
  let treeStale = true;
  let errorOffset = -1;

  const treeVisible = () => body.dataset.view === 'tree' || root.clientWidth >= 760;

  const updateFile = () => {
    saveBtn.hidden = !file;
    const dirty = !!file && area.value !== savedText;
    fileLabel.textContent = file ? `${file}${dirty ? ' •' : ''}` : '';
    saveBtn.disabled = !dirty;
  };

  function validate() {
    const text = area.value;
    errorOffset = -1;
    if (!text.trim()) {
      parsed = { ok: false };
      status.className = 'tool-status';
      status.textContent = '';
      area.removeAttribute('aria-invalid');
    } else {
      const r = parseJson(text);
      if (r.ok) {
        parsed = r;
        status.className = 'tool-status ok';
        status.innerHTML = `${icon('check', 'sm')}<span>${esc(t('Корректный JSON'))} · ${esc(formatBytes(new Blob([text]).size))}</span>`;
        area.removeAttribute('aria-invalid');
      } else {
        parsed = { ok: false };
        errorOffset = r.error.offset;
        status.className = 'tool-status error';
        status.innerHTML = `<span>${esc(t('Строка {line}, столбец {column}: {message}', { line: r.error.line, column: r.error.column, message: r.error.message }))}</span>
          <button type="button" class="link-btn" data-act="goto">${esc(t('Перейти'))}</button>`;
        area.setAttribute('aria-invalid', 'true');
      }
    }
    treeStale = true;
    if (treeVisible()) refreshTree();
    updateFile();
  }

  function refreshTree() {
    if (!treeStale) return;
    treeStale = false;
    const host = q('[data-tree]');
    if (!parsed.ok) {
      tree?.destroy();
      tree = null;
      host.innerHTML = `<p class="tool-empty">${esc(area.value.trim() ? t('Исправьте ошибку, чтобы увидеть дерево') : t('Здесь появится дерево JSON'))}</p>`;
      return;
    }
    if (tree) tree.setValue(parsed.value);
    else {
      host.innerHTML = '';
      tree = renderJsonTree(host, parsed.value, {
        copy: (text, what) => void copyText(text, ctx, what === 'path' ? t('Путь скопирован') : t('Скопировано')),
      });
    }
    const qv = q<HTMLInputElement>('[data-q]').value;
    if (qv) runSearch(qv);
  }

  const scheduleValidate = debounce(validate, 250);
  const onInput = () => {
    // Bigger texts are re-parsed less often while typing.
    if (area.value.length > 2_000_000) {
      scheduleValidate.cancel();
      setTimeout(validate, 900);
    } else scheduleValidate();
    updateFile();
  };

  function setText(text: string) {
    area.value = text;
    validate();
  }

  function transform(fn: (v: JsonValue) => string) {
    if (!parsed.ok) {
      ctx.toast(t('Сначала исправьте ошибку в JSON'), 'error');
      return;
    }
    setText(fn(parsed.value));
  }

  function runSearch(text: string) {
    const count = q('[data-count]');
    if (!tree) {
      count.textContent = '';
      return;
    }
    const n = tree.search(text);
    count.textContent = text.trim() ? (n ? `1/${n}` : t('Нет совпадений')) : '';
    count.dataset.total = String(n);
  }
  const step = (dir: 1 | -1) => {
    if (!tree) return;
    const total = Number(q('[data-count]').dataset.total ?? 0);
    if (!total) return;
    const i = dir > 0 ? tree.next() : tree.prev();
    q('[data-count]').textContent = `${i}/${total}`;
  };

  async function openFile(path: string) {
    const project = ctx.project();
    const f = project?.files[path];
    if (!f) return;
    file = path;
    savedText = fileText(f);
    setText(savedText);
  }

  const onClick = async (e: MouseEvent) => {
    const el = e.target as HTMLElement;
    const seg = el.closest<HTMLElement>('[data-indent],[data-view]');
    if (seg?.dataset.indent) {
      indent = seg.dataset.indent === 'tab' ? '\t' : (Number(seg.dataset.indent) as 2 | 4);
      setSegmented(root, 'indent', seg.dataset.indent);
      if (parsed.ok) setText(formatJson(parsed.value, indent));
      return;
    }
    if (seg?.dataset.view) {
      body.dataset.view = seg.dataset.view;
      setSegmented(root, 'view', seg.dataset.view);
      if (seg.dataset.view === 'tree') refreshTree();
      return;
    }
    const act = el.closest<HTMLElement>('[data-act]')?.dataset.act;
    switch (act) {
      case 'open': {
        const path = await pickProjectFile(ctx, { title: t('Открыть JSON-файл'), filter: isJsonPath, empty: t('В проекте нет JSON-файлов') });
        if (path) await openFile(path);
        break;
      }
      case 'paste':
        try {
          setText(await navigator.clipboard.readText());
        } catch {
          area.focus();
          ctx.toast(t('Вставьте текст в поле (удерживайте → Вставить)'), 'info');
        }
        break;
      case 'save':
        if (!file) break;
        try {
          await ctx.writeFiles({ [file]: textFile(area.value) });
          savedText = area.value;
          updateFile();
          ctx.haptic('success');
          ctx.toast(t('Сохранено'), 'success');
        } catch (err) {
          ctx.toast(String((err as Error).message ?? err), 'error');
        }
        break;
      case 'pretty':
        transform((v) => formatJson(v, indent));
        break;
      case 'more': {
        const pick = await menuSheet('JSON', [
          { id: 'copy', label: t('Копировать'), icon: 'copy' },
          { id: 'minify', label: t('Сжать'), icon: 'minus' },
          { id: 'sort', label: t('Сортировать ключи'), icon: 'list' },
        ]);
        if (pick === 'copy') {
          if (area.value) void copyText(area.value, ctx);
        } else if (pick === 'minify') transform(minifyJson);
        else if (pick === 'sort') transform((v) => formatJson(sortKeysDeep(v), indent));
        break;
      }
      case 'copy':
        if (area.value) void copyText(area.value, ctx);
        break;
      case 'goto':
        if (errorOffset >= 0) {
          body.dataset.view = 'text';
          setSegmented(root, 'view', 'text');
          area.focus();
          area.setSelectionRange(errorOffset, Math.min(area.value.length, errorOffset + 1));
        }
        break;
      case 'expand':
        tree?.expandAll();
        break;
      case 'collapse':
        tree?.collapseAll();
        break;
      case 'next':
        step(1);
        break;
      case 'prev':
        step(-1);
        break;
    }
  };

  const search = debounce((v: string) => runSearch(v), 200);
  const onSearchInput = (e: Event) => search((e.target as HTMLInputElement).value);
  const onSearchKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    }
  };
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => treeVisible() && refreshTree()) : null;
  ro?.observe(root);

  root.addEventListener('click', onClick);
  area.addEventListener('input', onInput);
  q('[data-q]').addEventListener('input', onSearchInput);
  q('[data-q]').addEventListener('keydown', onSearchKey);

  const active = ctx.activeFile();
  if (active && isJsonPath(active) && ctx.project()?.files[active]) void openFile(active);
  else validate();

  return () => {
    scheduleValidate.cancel();
    search.cancel();
    ro?.disconnect();
    tree?.destroy();
    root.removeEventListener('click', onClick);
    root.innerHTML = '';
    root.classList.remove('tool-root', 'tool-json');
  };
}

export const jsonTool: Tool = {
  id: 'json',
  group: 'Данные и API',
  description: 'Форматирование, дерево и проверка JSON',
  title: 'JSON',
  icon: 'braces',
  mount,
};
