/** Renders a line diff: unified or side by side, with collapsed unchanged regions that expand on tap. */
import { plural, t } from '../../i18n';
import { collapseUnchanged, diffLines, diffStats, sideBySide, type DiffOp, type DiffRow } from './diff';
import { esc } from './ui';

const MAX_ROWS = 4000;

const UNCHANGED = { one: 'Без изменений: {count} строка', few: 'Без изменений: {count} строки', many: 'Без изменений: {count} строк' };

function lineHtml(op: DiffOp): string {
  const cls = op.type === 'add' ? 'add' : op.type === 'del' ? 'del' : 'eq';
  const sign = op.type === 'add' ? '+' : op.type === 'del' ? '−' : ' ';
  const a = op.type === 'add' ? '' : String(op.a);
  const b = op.type === 'del' ? '' : String(op.b);
  return `<div class="gh-dl gh-dl-${cls}"><span class="gh-ln">${a}</span><span class="gh-ln">${b}</span><span class="gh-sign" aria-hidden="true">${sign}</span><span class="gh-text">${esc(op.text) || ' '}</span></div>`;
}

function sideCell(op: DiffOp | undefined): string {
  if (!op) return '<span class="gh-ln"></span><span class="gh-text gh-empty"></span>';
  const cls = op.type === 'add' ? 'add' : op.type === 'del' ? 'del' : 'eq';
  const n = op.type === 'add' ? op.b : op.a;
  return `<span class="gh-ln gh-dl-${cls}">${n}</span><span class="gh-text gh-dl-${cls}">${esc(op.text) || ' '}</span>`;
}

const skipHtml = (index: number, count: number): string =>
  `<button class="gh-skip" data-skip="${index}">⋯ ${esc(plural(count, UNCHANGED))}</button>`;

export interface DiffViewOptions {
  /** Labels of the old and new side (e.g. "GitHub" / "Mine"). */
  oldLabel: string;
  newLabel: string;
  mode?: 'unified' | 'split';
}

/** Mounts an interactive diff of `oldText` → `newText` into `host`. */
export function mountDiff(host: HTMLElement, oldText: string, newText: string, opts: DiffViewOptions): { added: number; removed: number } {
  const ops = diffLines(oldText, newText);
  const stats = diffStats(ops);
  let rows: DiffRow[] = collapseUnchanged(ops, 3);
  let mode = opts.mode ?? 'unified';

  const draw = () => {
    if (!stats.added && !stats.removed) {
      host.innerHTML = `<div class="empty-state">${esc(t('Содержимое не отличается'))}</div>`;
      return;
    }
    const shown = rows.slice(0, MAX_ROWS);
    let body: string;
    if (mode === 'unified') {
      body = shown.map((r, i) => (r.type === 'skip' ? skipHtml(i, r.count) : lineHtml(r))).join('');
    } else {
      body = sideBySide(shown)
        .map((r) => (r.skip ? skipHtml(rows.indexOf(r.skip), r.skip.count) : `<div class="gh-srow">${sideCell(r.left)}${sideCell(r.right)}</div>`))
        .join('');
    }
    host.innerHTML = `<div class="gh-diff-tools">
        <span class="gh-diff-legend"><span class="gh-dl-del">− ${esc(opts.oldLabel)}</span> <span class="gh-dl-add">+ ${esc(opts.newLabel)}</span></span>
        <div class="segmented gh-mode" role="group" aria-label="${esc(t('Вид сравнения'))}">
          <button class="${mode === 'unified' ? 'active' : ''}" data-mode="unified" aria-pressed="${mode === 'unified'}">${esc(t('Общий'))}</button>
          <button class="${mode === 'split' ? 'active' : ''}" data-mode="split" aria-pressed="${mode === 'split'}">${esc(t('Рядом'))}</button>
        </div>
      </div>
      <div class="gh-diff ${mode === 'split' ? 'split' : ''}" role="region" aria-label="${esc(t('Сравнение строк'))}">${body}</div>
      ${rows.length > MAX_ROWS ? `<p class="subtxt gh-pad">${esc(t('Показаны первые {count} строк сравнения.', { count: MAX_ROWS }))}</p>` : ''}`;
  };

  host.addEventListener('click', (e) => {
    const el = e.target as HTMLElement;
    const skip = el.closest<HTMLElement>('[data-skip]');
    if (skip) {
      const i = Number(skip.dataset.skip);
      const r = rows[i];
      if (r?.type === 'skip') {
        rows = [...rows.slice(0, i), ...r.ops, ...rows.slice(i + 1)];
        draw();
      }
      return;
    }
    const m = el.closest<HTMLElement>('[data-mode]');
    if (m && (m.dataset.mode === 'unified' || m.dataset.mode === 'split') && m.dataset.mode !== mode) {
      mode = m.dataset.mode;
      draw();
    }
  });
  draw();
  return stats;
}
