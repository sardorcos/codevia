import { formatBytes } from '../../core/bytes';
import { t } from '../../i18n';
import { copyText } from '../../platform/native';
import { esc, icon } from '../../ui/dom';
import type { ToolContext } from '../types';
import {
  cssRuleText,
  findRuleLine,
  networkFilterOf,
  selectorFromLabel,
  type BoxModel,
  type Crumb,
  type Decl,
  type InspectorBridge,
  type InspectorEvent,
  type InspectorRequest,
  type MatchedRule,
  type NetworkEntry,
  type NetworkFilter,
  type PreviewMessage,
  type TreeElement,
} from './protocol';

export type Tab = 'elements' | 'styles' | 'network' | 'console';
type StylesMsg = Extract<InspectorEvent, { type: 'inspect:styles' }>;
type ResponseMsg = Extract<InspectorEvent, { type: 'inspect:response' }>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const TABS: Tab[] = ['elements', 'styles', 'network', 'console'];
const tabTitle = (tab: Tab): string =>
  ({ elements: t('Элементы'), styles: t('Стили'), network: t('Сеть'), console: t('Консоль') })[tab];

const FILTERS: NetworkFilter[] = ['all', 'fetch', 'document', 'css', 'script', 'image', 'media', 'font', 'other'];
const filterTitle = (f: NetworkFilter): string =>
  ({
    all: t('Все'),
    fetch: 'Fetch/XHR',
    document: t('Документы'),
    css: 'CSS',
    script: 'JS',
    image: t('Изображения'),
    media: t('Медиа'),
    font: t('Шрифты'),
    other: t('Другое'),
  })[f];

/** Width of the panel from which the tree and the styles are shown side by side. */
export const WIDE_MIN = 900;
const MAX_ROWS = 3000;
const MAX_CONSOLE = 500;

const PICK_ICON =
  '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 4h6M4 4v6M20 4h-6M20 4v6M4 20h6M4 20v-6M20 20h-6M20 20v-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/></svg>';

const statusClass = (e: NetworkEntry): string =>
  e.pending ? 'pending' : e.error || e.status >= 400 ? 'bad' : e.status >= 300 ? 'redirect' : e.status >= 200 ? 'ok' : 'unknown';

const fileName = (url: string): string => {
  if (/^data:/i.test(url)) return url.slice(0, 40);
  const clean = url.split(/[?#]/)[0] ?? url;
  const name = clean.replace(/\/+$/, '').split('/').pop();
  return name || clean || url;
};

const fmtMs = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);

/** The inspector UI. One instance per mount; talks to the preview only through the bridge. */
export class InspectorPanel {
  tab: Tab = 'elements';
  private rid = 0;
  private status: 'waiting' | 'ready' | 'none' = 'waiting';
  private waitTimer: ReturnType<typeof setTimeout> | undefined;
  root: TreeElement | null = null;
  private nodes = new Map<number, TreeElement>();
  private parents = new Map<number, number>();
  expanded = new Set<number>();
  private loading = new Set<number>();
  selected: number | null = null;
  path: Crumb[] = [];
  styles: StylesMsg | null = null;
  private stylesRid = 0;
  private treeRid = 0;
  private allComputed = false;
  private computedFilter = '';
  private query: { rid: number; selector: string; results: Crumb[]; total: number; error?: string } | null = null;
  picking = false;
  network = new Map<number, NetworkEntry>();
  netFilter: NetworkFilter = 'all';
  netDetail: number | null = null;
  private netBody: ResponseMsg | null = null;
  private netRid = 0;
  consoleLines: { level: string; text: string }[] = [];
  private editing = false;
  private treeRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private lastTreeRefresh = 0;
  private renderQueued = new Set<'tree' | 'styles' | 'network' | 'console'>();
  private unsubscribe: () => void = () => undefined;
  private el: HTMLElement;

  constructor(
    private host: HTMLElement,
    private ctx: ToolContext,
    private bridge: InspectorBridge,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'insp';
    host.append(this.el);
  }

  mount(): () => void {
    this.el.innerHTML = this.shell();
    this.el.addEventListener('click', this.onClick);
    this.el.addEventListener('keydown', this.onKeydown);
    this.el.addEventListener('input', this.onInput);
    this.el.addEventListener('change', this.onChange);
    this.el.addEventListener('focusout', this.onFocusOut);
    for (const line of this.bridge.consoleHistory?.() ?? []) this.consoleLines.push({ level: line.level, text: line.text.replace(/\n$/, '') });
    this.unsubscribe = this.bridge.onMessage((m) => this.onMessage(m));
    this.setTab('elements');
    this.renderAll();
    this.start();
    return () => this.destroy();
  }

  destroy(): void {
    this.unsubscribe();
    clearTimeout(this.waitTimer);
    clearTimeout(this.treeRefreshTimer);
    if (this.picking) this.bridge.onPickChange?.(false);
    this.send({ type: 'inspect:disable' });
    this.el.remove();
  }

  // ---------------------------------------------------------------- messaging

  private send(msg: InspectorRequest): void {
    try {
      this.bridge.send(msg);
    } catch {
      /* no preview */
    }
  }

  /** Sends a request with a new `rid`; `assign` stores it before sending (answers may arrive synchronously). */
  private request<T extends InspectorRequest & { rid: number }>(msg: DistributiveOmit<T, 'rid'>, assign?: (rid: number) => void): number {
    const rid = ++this.rid;
    assign?.(rid);
    this.send({ ...msg, rid } as unknown as InspectorRequest);
    return rid;
  }

  private start(): void {
    this.status = 'waiting';
    this.send({ type: 'inspect:enable' });
    clearTimeout(this.waitTimer);
    this.waitTimer = setTimeout(() => {
      if (this.status === 'waiting') {
        this.status = 'none';
        this.renderAll();
      }
    }, 2000);
  }

  private resetDocument(): void {
    this.root = null;
    this.nodes.clear();
    this.parents.clear();
    this.expanded.clear();
    this.loading.clear();
    this.selected = null;
    this.path = [];
    this.styles = null;
    this.query = null;
    this.network.clear();
    this.netDetail = null;
    this.netBody = null;
    this.picking = false;
  }

  onMessage(m: PreviewMessage): void {
    if (!m || typeof m !== 'object') return;
    switch (m.type) {
      case 'inspect:hello':
        // A new preview document (edit, navigation, reload): its ids are new.
        this.resetDocument();
        this.start();
        this.renderAll();
        return;
      case 'inspect:enabled':
        this.status = 'ready';
        clearTimeout(this.waitTimer);
        this.refreshTree();
        this.request({ type: 'inspect:network-all' }, (rid) => (this.netRid = rid));
        this.renderAll();
        return;
      case 'inspect:tree':
        this.onTree(m);
        return;
      case 'inspect:selected':
        if (m.id !== null && m.id === this.selected) this.setPath(m.path);
        return;
      case 'inspect:styles':
        if (m.rid !== this.stylesRid) return;
        this.styles = m;
        if (m.found) this.setPath(m.path);
        this.queue('styles');
        return;
      case 'inspect:pick':
        if (this.picking !== m.on) this.bridge.onPickChange?.(m.on);
        this.picking = m.on;
        this.renderPickButton();
        return;
      case 'inspect:picked':
        this.ctx.haptic('light');
        this.select(m.id, { highlight: false, path: m.path });
        return;
      case 'inspect:edited':
        if (!m.ok) this.ctx.toast(t('Не удалось применить: {error}', { error: m.error ?? '' }), 'error');
        if (this.selected !== null) this.loadStyles();
        return;
      case 'inspect:query':
        if (!this.query || this.query.rid !== m.rid) return;
        this.query = { ...this.query, results: m.results ?? [], total: m.total ?? 0, error: m.error };
        this.queue('tree');
        return;
      case 'inspect:network':
        this.network.set(m.entry.nid, m.entry);
        this.queue('network');
        return;
      case 'inspect:network-all':
        if (m.rid !== this.netRid) return;
        this.network.clear();
        for (const e of m.entries ?? []) this.network.set(e.nid, e);
        this.queue('network');
        return;
      case 'inspect:response':
        if (m.nid === this.netDetail) {
          this.netBody = m;
          this.queue('network');
        }
        return;
      case 'inspect:dom-changed':
        this.scheduleTreeRefresh();
        return;
      case 'console': {
        const args = Array.isArray(m.args) ? m.args.map(String) : [];
        this.consoleLines.push({ level: String(m.level || 'log'), text: args.join(' ').slice(0, 4000) });
        if (this.consoleLines.length > MAX_CONSOLE) this.consoleLines.splice(0, this.consoleLines.length - MAX_CONSOLE);
        this.queue('console');
        return;
      }
    }
  }

  // ---------------------------------------------------------------- tree

  private refreshTree(): void {
    this.lastTreeRefresh = Date.now();
    this.request(
      {
        type: 'inspect:tree',
        expanded: [...this.expanded],
        ...(this.selected !== null ? { reveal: this.selected } : {}),
      },
      (rid) => (this.treeRid = rid),
    );
  }

  private scheduleTreeRefresh(): void {
    if (this.treeRefreshTimer) return;
    const wait = Math.max(0, 1000 - (Date.now() - this.lastTreeRefresh));
    this.treeRefreshTimer = setTimeout(() => {
      this.treeRefreshTimer = undefined;
      this.refreshTree();
    }, wait);
  }

  private index(node: TreeElement, parent?: number): void {
    this.nodes.set(node.id, node);
    if (parent !== undefined) this.parents.set(node.id, parent);
    for (const c of node.children ?? []) if (c.k === 'e') this.index(c, node.id);
  }

  private onTree(m: Extract<InspectorEvent, { type: 'inspect:tree' }>): void {
    const node = m.node;
    if (m.rid === this.treeRid) {
      this.root = node;
      this.nodes.clear();
      this.parents.clear();
      if (node) this.index(node);
      if (node && !this.expanded.size) {
        this.expanded.add(node.id);
        const body = node.children?.find((c): c is TreeElement => c.k === 'e' && c.tag === 'body');
        if (body) this.expanded.add(body.id);
      }
      for (const id of [...this.expanded]) if (!this.nodes.has(id)) this.expanded.delete(id);
      if (m.path) this.setPath(m.path);
      if (this.selected !== null && !this.nodes.has(this.selected) && !m.path) {
        this.selected = null;
        this.path = [];
        this.styles = null;
        this.queue('styles');
      }
    } else if (node) {
      // Lazily loaded children of one node.
      const old = this.nodes.get(node.id);
      this.loading.delete(node.id);
      if (old) {
        old.children = node.children;
        old.count = node.count;
        old.more = node.more;
        old.attrs = node.attrs;
        this.index(old, this.parents.get(old.id));
      }
    }
    this.queue('tree');
  }

  private setPath(path: Crumb[]): void {
    this.path = path;
    let missing = false;
    for (const c of path.slice(0, -1)) {
      this.expanded.add(c.id);
      const n = this.nodes.get(c.id);
      if (!n || !n.children) missing = true;
    }
    if (missing && this.root) this.refreshTree();
    this.queue('tree');
  }

  toggle(id: number): void {
    const node = this.nodes.get(id);
    if (!node) return;
    if (this.expanded.has(id)) this.expanded.delete(id);
    else {
      this.expanded.add(id);
      if (!node.children && node.count && !this.loading.has(id)) {
        this.loading.add(id);
        this.request({ type: 'inspect:tree', id, depth: 2 });
      }
    }
    this.queue('tree');
  }

  select(id: number, opts: { highlight?: boolean; path?: Crumb[]; showStyles?: boolean } = {}): void {
    this.selected = id;
    if (opts.highlight !== false) this.send({ type: 'inspect:select', id, scroll: true });
    if (opts.path) this.setPath(opts.path);
    else if (!this.nodes.has(id)) this.refreshTree();
    this.styles = this.styles && this.styles.id === id ? this.styles : null;
    this.loadStyles();
    if (opts.showStyles !== false && !this.isWide()) this.setTab('styles');
    this.queue('tree');
  }

  private loadStyles(): void {
    if (this.selected === null) return;
    this.request({ type: 'inspect:styles', id: this.selected, allComputed: this.allComputed }, (rid) => (this.stylesRid = rid));
  }

  private isWide(): boolean {
    return this.el.clientWidth >= WIDE_MIN;
  }

  // ---------------------------------------------------------------- rendering

  private shell(): string {
    return `
      <div class="insp-bar">
        <div class="insp-tabs" role="tablist" aria-label="${esc(t('Инспектор'))}">
          ${TABS.map((tab) => `<button type="button" role="tab" class="insp-tab" id="insp-tab-${tab}" data-act="tab" data-tab="${tab}" aria-controls="insp-pane-${tab}">${esc(tabTitle(tab))}</button>`).join('')}
        </div>
        <button type="button" class="insp-pick" data-act="pick" aria-pressed="false" aria-label="${esc(t('Выбрать элемент касанием'))}">${PICK_ICON}<span>${esc(t('Выбрать элемент'))}</span></button>
      </div>
      <div class="insp-hint" data-slot="pick-hint" role="status" hidden>
        <span>${esc(t('Коснитесь элемента в предпросмотре'))}</span>
        <button type="button" class="btn ghost tiny" data-act="pick">${esc(t('Отмена'))}</button>
      </div>
      <div class="insp-body">
        <section class="insp-pane" id="insp-pane-elements" role="tabpanel" aria-labelledby="insp-tab-elements" data-pane="elements">
          <div class="insp-search">
            <div class="search-wrap">${icon('search')}<input class="text-input search-input" type="search" name="selector" enterkeyhint="search" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="${esc(t('Поиск по селектору, например .card'))}" aria-label="${esc(t('Поиск по селектору'))}"></div>
          </div>
          <div class="insp-query" data-slot="query"></div>
          <nav class="insp-crumbs" data-slot="crumbs-elements" aria-label="${esc(t('Путь к элементу'))}"></nav>
          <div class="insp-tree" role="tree" aria-label="${esc(t('Дерево DOM'))}" data-slot="tree"></div>
        </section>
        <section class="insp-pane" id="insp-pane-styles" role="tabpanel" aria-labelledby="insp-tab-styles" data-pane="styles">
          <nav class="insp-crumbs" data-slot="crumbs-styles" aria-label="${esc(t('Путь к элементу'))}"></nav>
          <div class="insp-styles" data-slot="styles"></div>
        </section>
        <section class="insp-pane" id="insp-pane-network" role="tabpanel" aria-labelledby="insp-tab-network" data-pane="network">
          <div class="insp-net-bar">
            <div class="chips" role="group" aria-label="${esc(t('Тип запросов'))}" data-slot="net-filters"></div>
            <button type="button" class="btn secondary tiny" data-act="net-clear">${esc(t('Очистить'))}</button>
          </div>
          <div class="insp-net" data-slot="network"></div>
        </section>
        <section class="insp-pane" id="insp-pane-console" role="tabpanel" aria-labelledby="insp-tab-console" data-pane="console">
          <div class="insp-net-bar"><span class="insp-muted" data-slot="console-count"></span><button type="button" class="btn secondary tiny" data-act="console-clear">${esc(t('Очистить'))}</button></div>
          <div class="console insp-console" role="log" data-slot="console"></div>
        </section>
      </div>`;
  }

  private slot(name: string): HTMLElement | null {
    return this.el.querySelector<HTMLElement>(`[data-slot="${name}"]`);
  }

  setTab(tab: Tab): void {
    this.tab = tab;
    this.el.dataset.tab = tab;
    for (const b of this.el.querySelectorAll<HTMLElement>('.insp-tab')) {
      const on = b.dataset.tab === tab;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    if (tab === 'network' && this.status === 'ready') this.request({ type: 'inspect:network-all' }, (rid) => (this.netRid = rid));
    if (tab === 'styles' && this.selected !== null && !this.editing) this.loadStyles();
  }

  private queue(part: 'tree' | 'styles' | 'network' | 'console'): void {
    const first = !this.renderQueued.size;
    this.renderQueued.add(part);
    if (!first) return;
    queueMicrotask(() => {
      const parts = [...this.renderQueued];
      this.renderQueued.clear();
      for (const p of parts) this.render(p);
    });
  }

  private renderAll(): void {
    for (const p of ['tree', 'styles', 'network', 'console'] as const) this.render(p);
    this.renderPickButton();
  }

  private render(part: 'tree' | 'styles' | 'network' | 'console'): void {
    if (!this.el.isConnected && !this.host.isConnected) return;
    if (part === 'tree') this.renderTree();
    else if (part === 'styles') this.renderStyles();
    else if (part === 'network') this.renderNetwork();
    else this.renderConsole();
  }

  private renderPickButton(): void {
    const b = this.el.querySelector<HTMLElement>('.insp-pick');
    if (!b) return;
    b.setAttribute('aria-pressed', String(this.picking));
    b.classList.toggle('active', this.picking);
    this.el.classList.toggle('picking', this.picking);
    const hint = this.slot('pick-hint');
    if (hint) hint.hidden = !this.picking;
  }

  private emptyState(): string | null {
    if (this.status === 'ready') return null;
    return `<p class="insp-empty">${esc(this.status === 'waiting' ? t('Подключение к предпросмотру…') : t('Откройте «Просмотр», чтобы исследовать страницу.'))}</p>`;
  }

  private crumbsHtml(): string {
    if (!this.path.length) return '';
    return this.path
      .map((c) => `<button type="button" class="insp-crumb${c.id === this.selected ? ' current' : ''}" data-act="select" data-id="${c.id}">${esc(c.label)}</button>`)
      .join('<span class="insp-crumb-sep" aria-hidden="true">›</span>');
  }

  private nodeHtml(n: TreeElement): string {
    const attrs = n.attrs
      .map(([k, v]) => ` <span class="t-an">${esc(k)}</span>${v === '' ? '' : `=<span class="t-av">"${esc(v.length > 80 ? `${v.slice(0, 80)}…` : v)}"</span>`}`)
      .join('');
    const only = n.children && n.children.length === 1 && n.children[0]!.k === 't' ? n.children[0]!.text : null;
    const inline = only !== null ? `<span class="t-text">${esc(only)}</span><span class="t-tag">&lt;/${esc(n.tag)}&gt;</span>` : n.count ? '<span class="t-dots">…</span>' : '';
    return `<span class="t-tag">&lt;${esc(n.tag)}</span>${attrs}<span class="t-tag">&gt;</span>${inline}`;
  }

  private treeRows(): string {
    const out: string[] = [];
    const walk = (n: TreeElement, depth: number) => {
      if (out.length > MAX_ROWS) return;
      const inlineText = !!(n.children && n.children.length === 1 && n.children[0]!.k === 't');
      const canOpen = n.count > 0 && !inlineText;
      const open = canOpen && this.expanded.has(n.id);
      const sel = n.id === this.selected;
      out.push(
        `<div class="insp-row${sel ? ' selected' : ''}" role="treeitem" aria-level="${depth + 1}" aria-selected="${sel}"${canOpen ? ` aria-expanded="${open}"` : ''} style="--d:${Math.min(depth, 24)}">` +
          (canOpen
            ? `<button type="button" class="insp-twisty" data-act="toggle" data-id="${n.id}" aria-label="${esc(open ? t('Свернуть') : t('Развернуть'))}">${open ? '▾' : '▸'}</button>`
            : '<span class="insp-twisty" aria-hidden="true"></span>') +
          `<button type="button" class="insp-node" data-act="select" data-id="${n.id}">${this.nodeHtml(n)}</button></div>`,
      );
      if (!open) return;
      if (!n.children) {
        out.push(`<div class="insp-row insp-note" style="--d:${Math.min(depth + 1, 24)}">${esc(t('Загрузка…'))}</div>`);
        return;
      }
      for (const c of n.children) {
        if (c.k === 't') out.push(`<div class="insp-row insp-textnode" role="treeitem" aria-level="${depth + 2}" style="--d:${Math.min(depth + 1, 24)}"><span class="insp-twisty" aria-hidden="true"></span><span class="t-text">"${esc(c.text)}"</span></div>`);
        else walk(c, depth + 1);
      }
      if (n.more) out.push(`<div class="insp-row insp-note" style="--d:${Math.min(depth + 1, 24)}">${esc(t('…и ещё {count}', { count: n.more }))}</div>`);
      out.push(`<div class="insp-row insp-close" aria-hidden="true" style="--d:${Math.min(depth, 24)}"><span class="insp-twisty"></span><span class="t-tag">&lt;/${esc(n.tag)}&gt;</span></div>`);
    };
    if (this.root) walk(this.root, 0);
    return out.join('');
  }

  private renderTree(): void {
    const tree = this.slot('tree');
    if (!tree) return;
    const empty = this.emptyState();
    tree.innerHTML = empty ?? this.treeRows();
    const crumbs = this.crumbsHtml();
    for (const name of ['crumbs-elements', 'crumbs-styles']) {
      const c = this.slot(name);
      if (c) {
        c.innerHTML = crumbs;
        c.hidden = !crumbs;
        c.querySelector('.current')?.scrollIntoView?.({ inline: 'end', block: 'nearest' });
      }
    }
    const q = this.slot('query');
    if (q) {
      const query = this.query;
      q.hidden = !query;
      q.innerHTML = !query
        ? ''
        : query.error
          ? `<p class="insp-error">${esc(t('Неверный селектор: {error}', { error: query.error }))}</p>`
          : `<div class="insp-query-head"><span>${esc(t('Найдено: {count}', { count: query.total }))}</span><button type="button" class="btn ghost tiny" data-act="query-clear">${esc(t('Скрыть'))}</button></div>` +
            query.results.map((r) => `<button type="button" class="insp-result${r.id === this.selected ? ' selected' : ''}" data-act="select" data-id="${r.id}">${esc(r.label)}</button>`).join('');
    }
    tree.querySelector('.insp-row.selected')?.scrollIntoView?.({ block: 'nearest' });
  }

  private sourceLink(rule: MatchedRule): string {
    if (!rule.src) return '';
    if (rule.origin === 'external') return `<span class="insp-src external" title="${esc(rule.src)}">${esc(fileName(rule.src))}</span>`;
    const loc = this.locate(rule);
    const label = loc ? `${loc.path}${loc.line ? `:${loc.line}` : ''}` : rule.src;
    return `<button type="button" class="insp-src" data-act="open-src" data-path="${esc(loc?.path ?? rule.src)}" data-line="${loc?.line ?? ''}" aria-label="${esc(t('Открыть {name} в редакторе', { name: label }))}">${esc(label)}</button>`;
  }

  /** File and 1-based line of a rule, searched in the project sources (falls back to other CSS files: @import). */
  locate(rule: Pick<MatchedRule, 'src' | 'selector'>): { path: string; line?: number } | null {
    const files = this.ctx.project()?.files;
    if (!rule.src) return null;
    if (!files) return { path: rule.src };
    const text = (p: string) => {
      const f = files[p];
      return f && f.text ? f.content : null;
    };
    const own = text(rule.src);
    const line = own !== null ? findRuleLine(own, rule.selector) : undefined;
    if (line) return { path: rule.src, line };
    for (const p of Object.keys(files)) {
      if (p === rule.src || !/\.(css|html?|php)$/i.test(p)) continue;
      const src = text(p);
      const l = src !== null ? findRuleLine(src, rule.selector) : undefined;
      if (l) return { path: p, line: l };
    }
    return { path: rule.src };
  }

  private declsHtml(decls: Decl[], target: string): string {
    return decls
      .map(
        (d) =>
          `<div class="insp-decl${d.overridden ? ' overridden' : ''}">` +
          (d.truncated
            ? `<span class="insp-decl-text"><span class="p-name">${esc(d.name)}</span>: <span class="p-value">${esc(d.value)}</span>${d.important ? ' <span class="p-imp">!important</span>' : ''};</span>`
            : `<button type="button" class="insp-decl-text" data-act="edit-decl" data-target="${esc(target)}" data-name="${esc(d.name)}" data-value="${esc(d.value)}" data-important="${d.important ? '1' : ''}"><span class="p-name">${esc(d.name)}</span>: <span class="p-value">${esc(d.value)}</span>${d.important ? ' <span class="p-imp">!important</span>' : ''};</button>`) +
          '</div>',
      )
      .join('');
  }

  private boxHtml(b: BoxModel): string {
    const v = (n: number) => (n ? String(Math.round(n * 100) / 100) : '–');
    const ring = (cls: string, name: string, e: BoxModel['margin'], inner: string) =>
      `<div class="bm ${cls}"><span class="bm-name">${esc(name)}</span><span class="bm-t">${v(e.top)}</span><span class="bm-l">${v(e.left)}</span>${inner}<span class="bm-r">${v(e.right)}</span><span class="bm-b">${v(e.bottom)}</span></div>`;
    const content = `<div class="bm bm-content"><span>${v(b.width)} × ${v(b.height)}</span></div>`;
    return `<div class="insp-box" role="img" aria-label="${esc(t('Блочная модель: {width} × {height}', { width: v(b.width), height: v(b.height) }))}">${ring(
      'bm-margin',
      'margin',
      b.margin,
      ring('bm-border', 'border', b.border, ring('bm-padding', 'padding', b.padding, content)),
    )}</div><p class="insp-muted insp-box-meta">${esc(`${b.display} · ${b.position} · box-sizing: ${b.boxSizing}`)}</p>`;
  }

  private renderStyles(): void {
    const box = this.slot('styles');
    if (!box || this.editing) return;
    const empty = this.emptyState();
    if (empty) {
      box.innerHTML = empty;
      return;
    }
    const s = this.styles;
    if (this.selected === null || !s) {
      box.innerHTML = `<p class="insp-empty">${esc(this.selected === null ? t('Выберите элемент в дереве или кнопкой «Выбрать».') : t('Загрузка…'))}</p>`;
      return;
    }
    if (!s.found) {
      box.innerHTML = `<p class="insp-empty">${esc(t('Элемент больше не существует на странице.'))}</p>`;
      return;
    }
    const sel = this.path.length ? selectorFromLabel(this.path[this.path.length - 1]!.label) : s.tag;
    const rules = (s.rules ?? [])
      .map(
        (r, i) => `<section class="insp-rule">
          <div class="insp-rule-head">
            <span class="insp-selector">${esc(r.selector)}</span>
            ${this.sourceLink(r)}
            <button type="button" class="insp-icon-btn" data-act="copy-rule" data-index="${i}" aria-label="${esc(t('Скопировать правило CSS'))}">${icon('copy')}</button>
          </div>
          ${r.conditions?.length ? `<div class="insp-cond">${esc(r.conditions.join(' · '))}</div>` : ''}
          <div class="insp-decls">${this.declsHtml(r.decls, `rule:${r.key}`)}</div>
          <button type="button" class="insp-add" data-act="add-decl" data-target="rule:${esc(r.key)}">+ ${esc(t('Свойство'))}</button>
        </section>`,
      )
      .join('');
    const filter = this.computedFilter.toLowerCase();
    const computed = (s.computed ?? []).filter(([k, val]) => !filter || k.includes(filter) || val.toLowerCase().includes(filter));
    const cut = new Set(s.attrsTruncated ?? []);
    box.innerHTML = `
      <section class="insp-rule">
        <div class="insp-rule-head"><span class="insp-selector">element.style</span>
          <button type="button" class="insp-icon-btn" data-act="copy-inline" aria-label="${esc(t('Скопировать как правило CSS'))}">${icon('copy')}</button></div>
        <div class="insp-decls">${this.declsHtml(s.inline ?? [], 'inline')}</div>
        <button type="button" class="insp-add" data-act="add-decl" data-target="inline">+ ${esc(t('Свойство'))}</button>
      </section>
      ${rules || `<p class="insp-muted insp-pad">${esc(t('Нет подходящих правил CSS.'))}</p>`}
      <h3 class="insp-h">${esc(t('Блочная модель'))}</h3>
      ${s.box ? this.boxHtml(s.box) : ''}
      <h3 class="insp-h">${esc(t('Вычисленные стили'))}</h3>
      <div class="insp-computed-bar">
        <input class="text-input" type="search" data-input="computed-filter" value="${esc(this.computedFilter)}" placeholder="${esc(t('Фильтр'))}" aria-label="${esc(t('Фильтр вычисленных стилей'))}" autocapitalize="off" autocorrect="off" spellcheck="false">
        <label class="insp-check"><input type="checkbox" data-input="computed-all"${this.allComputed ? ' checked' : ''}> ${esc(t('Все'))}</label>
      </div>
      <dl class="insp-computed">${computed.map(([k, val]) => `<div><dt>${esc(k)}</dt><dd>${esc(val)}</dd></div>`).join('') || `<p class="insp-muted">${esc(t('Ничего не найдено'))}</p>`}</dl>
      <h3 class="insp-h">${esc(t('Атрибуты'))}</h3>
      <div class="insp-decls">${(s.attrs ?? [])
        .map(([k, val]) =>
          cut.has(k)
            ? `<div class="insp-decl"><span class="insp-decl-text"><span class="t-an">${esc(k)}</span>=<span class="t-av">"${esc(val)}"</span></span></div>`
            : `<div class="insp-decl"><button type="button" class="insp-decl-text" data-act="edit-attr" data-name="${esc(k)}" data-value="${esc(val)}"><span class="t-an">${esc(k)}</span>=<span class="t-av">"${esc(val)}"</span></button></div>`,
        )
        .join('')}</div>
      <button type="button" class="insp-add" data-act="add-attr">+ ${esc(t('Атрибут'))}</button>
      <p class="insp-muted insp-pad">${esc(t('Изменения — живой эксперимент: они не сохраняются в файлы. Скопируйте правило, чтобы перенести его в CSS.'))} <code>${esc(sel)}</code></p>`;
  }

  private visibleEntries(): NetworkEntry[] {
    return [...this.network.values()]
      .filter((e) => this.netFilter === 'all' || networkFilterOf(e) === this.netFilter)
      .sort((a, b) => a.start - b.start || a.nid - b.nid);
  }

  private renderNetwork(): void {
    const filters = this.slot('net-filters');
    if (filters)
      filters.innerHTML = FILTERS.map(
        (f) => `<button type="button" class="chip${f === this.netFilter ? ' active' : ''}" data-act="net-filter" data-filter="${f}" aria-pressed="${f === this.netFilter}">${esc(filterTitle(f))}</button>`,
      ).join('');
    const box = this.slot('network');
    if (!box) return;
    const empty = this.emptyState();
    if (empty) {
      box.innerHTML = empty;
      return;
    }
    const detail = this.netDetail !== null ? this.network.get(this.netDetail) : undefined;
    if (detail) {
      box.innerHTML = this.netDetailHtml(detail);
      return;
    }
    const list = this.visibleEntries();
    if (!list.length) {
      box.innerHTML = `<p class="insp-empty">${esc(this.network.size ? t('Нет запросов этого типа.') : t('Запросов пока нет. Они появятся, когда страница загрузит данные.'))}</p>`;
      return;
    }
    box.innerHTML = `<div class="insp-net-head" aria-hidden="true"><span>${esc(t('Статус'))}</span><span>${esc(t('Имя'))}</span><span>${esc(t('Тип'))}</span><span>${esc(t('Размер'))}</span><span>${esc(t('Время'))}</span></div>
      <ul class="insp-net-list">${list
        .map(
          (e) => `<li><button type="button" class="insp-net-row" data-act="net-open" data-nid="${e.nid}">
            <span class="n-status ${statusClass(e)}">${e.pending ? '…' : e.error ? esc(t('ошибка')) : e.status || '—'}</span>
            <span class="n-name"><span class="n-file"><span class="n-method">${esc(e.method)}</span> ${esc(fileName(e.url))}</span><span class="n-url">${esc(e.source === 'project' ? t('файл проекта') : e.url)}</span></span>
            <span class="n-type">${esc(e.kind === 'resource' ? (e.initiator ?? e.type) : e.kind)}<br><small>${esc(e.type)}</small></span>
            <span class="n-size">${e.size >= 0 ? esc(formatBytes(e.size)) : '—'}</span>
            <span class="n-time">${e.pending ? '…' : esc(fmtMs(e.duration))}</span>
          </button></li>`,
        )
        .join('')}</ul>`;
  }

  private netDetailHtml(e: NetworkEntry): string {
    const rows = (pairs: [string, string][]) =>
      pairs.length ? `<dl class="insp-kv">${pairs.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : `<p class="insp-muted">${esc(t('Нет данных'))}</p>`;
    const general: [string, string][] = [
      ['URL', e.url],
      [t('Метод'), e.method],
      [t('Статус'), e.error ? `${t('ошибка')}: ${e.error}` : e.pending ? t('выполняется') : `${e.status} ${e.statusText}`.trim()],
      [t('Источник'), e.source === 'project' ? `${t('файл проекта')}${e.path ? `: ${e.path}` : ''}` : t('сеть')],
      [t('Тип'), `${e.kind} · ${e.type}${e.mime ? ` · ${e.mime}` : ''}`],
      [t('Размер'), e.size >= 0 ? formatBytes(e.size) : '—'],
      [t('Время'), fmtMs(e.duration)],
    ];
    const b = this.netBody && this.netBody.nid === e.nid ? this.netBody : null;
    let preview = `<p class="insp-muted">${esc(e.hasBody || e.type === 'image' ? t('Загрузка…') : t('Ответ недоступен для просмотра.'))}</p>`;
    if (b) {
      if (b.dataUrl && /^data:image\//.test(b.dataUrl)) preview = `<img class="insp-img" alt="${esc(fileName(e.url))}" src="${esc(b.dataUrl)}">`;
      else if (b.url && /^data:image\//.test(b.url)) preview = `<img class="insp-img" alt="${esc(fileName(e.url))}" src="${esc(b.url)}">`;
      else if (typeof b.text === 'string') {
        let text = b.text;
        if (/json/i.test(b.mime) || e.type === 'json') {
          try {
            text = JSON.stringify(JSON.parse(text), null, 2);
          } catch {
            /* keep raw */
          }
        }
        preview = `<pre class="insp-pre">${esc(text)}</pre>${b.truncated ? `<p class="insp-muted">${esc(t('Показано начало ответа.'))}</p>` : ''}`;
      } else if (b.url) preview = `<p class="insp-muted">${esc(t('Изображение из сети: {url}', { url: b.url }))}</p>`;
      else preview = `<p class="insp-muted">${esc(t('Ответ недоступен для просмотра.'))}</p>`;
    }
    return `<div class="insp-detail">
      <button type="button" class="btn ghost tiny insp-back" data-act="net-back">${icon('back')}${esc(t('Все запросы'))}</button>
      <h3 class="insp-h">${esc(t('Общее'))}</h3>${rows(general)}
      <h3 class="insp-h">${esc(t('Заголовки запроса'))}</h3>${rows(e.reqHeaders ?? [])}
      <h3 class="insp-h">${esc(t('Заголовки ответа'))}</h3>${rows(e.resHeaders ?? [])}
      <h3 class="insp-h">${esc(t('Ответ'))}</h3>${preview}
    </div>`;
  }

  private renderConsole(): void {
    const box = this.slot('console');
    const count = this.slot('console-count');
    if (count) count.textContent = this.consoleLines.length ? t('Сообщений: {count}', { count: this.consoleLines.length }) : '';
    if (!box) return;
    box.innerHTML = this.consoleLines.length
      ? this.consoleLines.map((l) => `<span class="console-line ${esc(l.level)}">${esc(l.text)}\n</span>`).join('')
      : `<span class="console-line system empty">${esc(t('Консоль пуста'))}</span>`;
    box.scrollTop = box.scrollHeight;
  }

  // ---------------------------------------------------------------- editing

  private openEditor(button: HTMLElement, value: string, commit: (text: string) => void): void {
    const row = button.closest<HTMLElement>('.insp-decl') ?? button.parentElement!;
    this.editing = true;
    const input = document.createElement('input');
    input.className = 'text-input insp-edit';
    input.value = value;
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('spellcheck', 'false');
    input.setAttribute('enterkeyhint', 'done');
    input.setAttribute('aria-label', t('Изменить'));
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      this.editing = false;
      if (save && input.value.trim() !== value.trim()) commit(input.value);
      else this.queue('styles');
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
    if (row.classList.contains('insp-decl')) row.replaceChildren(input);
    else {
      const wrap = document.createElement('div');
      wrap.className = 'insp-decl';
      wrap.append(input);
      button.before(wrap);
    }
    input.focus();
    input.select?.();
  }

  /** Parses `name: value [!important]`. */
  static parseDecl(text: string): { name: string; value: string; important: boolean } | null {
    const s = text.trim().replace(/;\s*$/, '');
    const i = s.indexOf(':');
    if (i <= 0) return s ? { name: s.toLowerCase(), value: '', important: false } : null;
    let value = s.slice(i + 1).trim();
    const imp = /\s*!\s*important\s*$/i.exec(value);
    if (imp) value = value.slice(0, imp.index).trim();
    const name = s.slice(0, i).trim();
    return { name: name.startsWith('--') ? name : name.toLowerCase(), value, important: !!imp };
  }

  /** Parses `name="value"` (quotes optional). */
  static parseAttr(text: string): { name: string; value: string } | null {
    const s = text.trim();
    if (!s) return null;
    const i = s.indexOf('=');
    if (i < 0) return { name: s, value: '' };
    let value = s.slice(i + 1).trim();
    if (/^(["']).*\1$/s.test(value)) value = value.slice(1, -1);
    return { name: s.slice(0, i).trim(), value };
  }

  editDecl(target: string, oldName: string | null, text: string): void {
    if (this.selected === null) return;
    const rule = target.startsWith('rule:') ? target.slice(5) : undefined;
    const next = InspectorPanel.parseDecl(text);
    const base = { id: this.selected, ...(rule ? { rule } : {}) };
    if (oldName && (!next || next.name !== oldName)) this.request({ type: 'inspect:edit-style', ...base, prop: oldName, value: '' });
    if (next) this.request({ type: 'inspect:edit-style', ...base, prop: next.name, value: next.value, important: next.important });
    if (!next && !oldName) this.loadStyles();
  }

  editAttr(oldName: string | null, text: string): void {
    if (this.selected === null) return;
    const next = InspectorPanel.parseAttr(text);
    if (!next) {
      if (oldName) this.request({ type: 'inspect:edit-attr', id: this.selected, name: oldName, value: null });
      else this.loadStyles();
      return;
    }
    this.request({ type: 'inspect:edit-attr', id: this.selected, name: next.name, value: next.value, ...(oldName && oldName !== next.name ? { oldName } : {}) });
  }

  private async copy(text: string): Promise<void> {
    const ok = await copyText(text);
    this.ctx.toast(ok ? t('Правило CSS скопировано') : t('Не удалось скопировать'), ok ? 'success' : 'error');
  }

  ruleText(index: number | 'inline'): string | null {
    const s = this.styles;
    if (!s) return null;
    if (index === 'inline') {
      const sel = this.path.length ? selectorFromLabel(this.path[this.path.length - 1]!.label) : s.tag;
      return cssRuleText(sel, s.inline ?? []);
    }
    const r = s.rules?.[index];
    if (!r) return null;
    const text = cssRuleText(r.selector, r.decls);
    const media = (r.conditions ?? []).filter((c) => c.startsWith('@media') || c.startsWith('@supports'));
    return media.reduceRight((inner, c) => `${c} {\n${inner.replace(/^/gm, '  ')}\n}`, text);
  }

  // ---------------------------------------------------------------- events

  private onClick = (e: MouseEvent): void => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!b || !this.el.contains(b)) return;
    const act = b.dataset.act;
    const id = Number(b.dataset.id);
    switch (act) {
      case 'tab':
        this.setTab(b.dataset.tab as Tab);
        return;
      case 'pick':
        this.send({ type: 'inspect:pick', on: !this.picking });
        return;
      case 'toggle':
        this.toggle(id);
        return;
      case 'select':
        this.select(id, { showStyles: !b.classList.contains('insp-crumb') || this.tab !== 'elements' });
        return;
      case 'query-clear':
        this.query = null;
        this.queue('tree');
        return;
      case 'open-src': {
        const line = Number(b.dataset.line);
        this.ctx.openFile(b.dataset.path ?? '', line > 0 ? line : undefined);
        return;
      }
      case 'copy-rule': {
        const text = this.ruleText(Number(b.dataset.index));
        if (text) void this.copy(text);
        return;
      }
      case 'copy-inline': {
        const text = this.ruleText('inline');
        if (text) void this.copy(text);
        return;
      }
      case 'edit-decl': {
        const name = b.dataset.name ?? '';
        const value = `${name}: ${b.dataset.value ?? ''}${b.dataset.important ? ' !important' : ''}`;
        this.openEditor(b, value, (text) => this.editDecl(b.dataset.target ?? 'inline', name, text));
        return;
      }
      case 'add-decl':
        this.openEditor(b, '', (text) => this.editDecl(b.dataset.target ?? 'inline', null, text));
        return;
      case 'edit-attr': {
        const name = b.dataset.name ?? '';
        this.openEditor(b, `${name}="${b.dataset.value ?? ''}"`, (text) => this.editAttr(name, text));
        return;
      }
      case 'add-attr':
        this.openEditor(b, '', (text) => this.editAttr(null, text));
        return;
      case 'net-filter':
        this.netFilter = (b.dataset.filter as NetworkFilter) ?? 'all';
        this.queue('network');
        return;
      case 'net-clear':
        this.network.clear();
        this.netDetail = null;
        this.send({ type: 'inspect:network-clear' });
        this.queue('network');
        return;
      case 'net-open': {
        const nid = Number(b.dataset.nid);
        this.netDetail = nid;
        this.netBody = null;
        const entry = this.network.get(nid);
        if (entry && (entry.hasBody || entry.type === 'image')) this.request({ type: 'inspect:response', nid });
        this.queue('network');
        return;
      }
      case 'net-back':
        this.netDetail = null;
        this.netBody = null;
        this.queue('network');
        return;
      case 'console-clear':
        this.consoleLines = [];
        this.queue('console');
        return;
    }
  };

  private onKeydown = (e: KeyboardEvent): void => {
    const target = e.target as HTMLElement;
    if (target.getAttribute('role') === 'tab' && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      const i = TABS.indexOf(this.tab);
      const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length]!;
      this.setTab(next);
      this.el.querySelector<HTMLElement>(`#insp-tab-${next}`)?.focus();
      e.preventDefault();
    }
    if (target instanceof HTMLInputElement && target.name === 'selector' && e.key === 'Enter') {
      e.preventDefault();
      this.runQuery(target.value);
    }
  };

  runQuery(selector: string): void {
    const s = selector.trim();
    if (!s) {
      this.query = null;
      this.queue('tree');
      return;
    }
    this.request({ type: 'inspect:query', selector: s }, (rid) => (this.query = { rid, selector: s, results: [], total: 0 }));
  }

  private onInput = (e: Event): void => {
    const target = e.target as HTMLInputElement;
    if (target.dataset.input === 'computed-filter') {
      this.computedFilter = target.value;
      const dl = this.el.querySelector('.insp-computed');
      const f = target.value.toLowerCase();
      dl?.querySelectorAll<HTMLElement>('div').forEach((row) => {
        row.hidden = !!f && !row.textContent?.toLowerCase().includes(f);
      });
    }
  };

  private onChange = (e: Event): void => {
    const target = e.target as HTMLInputElement;
    if (target.dataset.input === 'computed-all') {
      this.allComputed = target.checked;
      this.loadStyles();
    }
  };

  private onFocusOut = (e: FocusEvent): void => {
    const target = e.target as HTMLElement;
    if (target instanceof HTMLInputElement && target.name === 'selector' && target.value.trim() && (!this.query || this.query.selector !== target.value.trim())) {
      this.runQuery(target.value);
    }
  };
}
