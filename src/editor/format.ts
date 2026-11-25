import { EditorSelection, type ChangeSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { t } from '../i18n';
import type { FormatRequest, FormatResult } from './format-core';
import { canFormat } from './format-kind';

export { canFormat };

/**
 * "Format document" (Prettier style). Prettier and its plugins load lazily inside a module Worker
 * (format.worker.ts), so neither the startup bundle nor typing pays for them.
 */
export interface FormatOptions {
  /** Contents of `.prettierrc` (JSON) from the project root, if the project has one. */
  prettierrc?: string;
}

export interface FormatOutcome {
  changed: boolean;
  error?: string;
}

type Backend = (req: FormatRequest) => Promise<FormatResult>;

const TIMEOUT_MS = 30_000;
let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (r: FormatResult) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

function failAll(message: string) {
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    p.reject(new Error(message));
    pending.delete(id);
  }
}

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL('./format.worker.ts', import.meta.url), { type: 'module', name: 'format' });
  w.onmessage = (e: MessageEvent<{ id: number; ok: boolean; formatted?: string; cursorOffset?: number; error?: string; line?: number }>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    clearTimeout(p.timer);
    if (e.data.ok) p.resolve({ formatted: e.data.formatted!, cursorOffset: e.data.cursorOffset ?? 0 });
    else p.reject(new Error(e.data.line ? `${e.data.error} (${t('строка {line}', { line: e.data.line })})` : e.data.error));
  };
  w.onerror = (e) => {
    e.preventDefault?.();
    failAll(e.message || 'Worker error');
    w.terminate();
    if (worker === w) worker = null;
  };
  worker = w;
  return w;
}

const workerBackend: Backend = (req) =>
  new Promise<FormatResult>((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(t('Форматирование заняло слишком много времени')));
      worker?.terminate();
      worker = null;
      failAll(t('Форматирование прервано'));
    }, TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    getWorker().postMessage({ id, ...req });
  });

let backend: Backend = workerBackend;

/** Replaces the worker (tests run formatCode from format-core directly). `null` restores the worker. */
export function setFormatBackend(fn: Backend | null): void {
  backend = fn ?? workerBackend;
}

/** The smallest single change turning `a` into `b` (common prefix and suffix kept). */
export function minimalChange(a: string, b: string): { from: number; to: number; insert: string } {
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) {
    endA--;
    endB--;
  }
  return { from: start, to: endA, insert: b.slice(start, endB) };
}

/**
 * Formats the document of `view` as the file `path`. The result is applied as one undoable
 * transaction that keeps the cursor at the same code. Never throws.
 */
export async function formatDocument(view: EditorView, path: string, opts: FormatOptions = {}): Promise<FormatOutcome> {
  if (!canFormat(path)) return { changed: false, error: t('Для этого типа файлов форматирование недоступно') };
  const doc = view.state.doc;
  const code = doc.toString();
  let res: FormatResult;
  try {
    res = await backend({ code, path, prettierrc: opts.prettierrc, cursorOffset: view.state.selection.main.head });
  } catch (e) {
    return { changed: false, error: t('Не удалось отформатировать: {message}', { message: String((e as Error)?.message ?? e) }) };
  }
  if (view.state.doc !== doc) return { changed: false, error: t('Текст изменился во время форматирования, попробуйте ещё раз') };
  if (res.formatted === code) return { changed: false };
  const change: ChangeSpec = minimalChange(code, res.formatted);
  const cursor = Math.max(0, Math.min(res.cursorOffset, res.formatted.length));
  view.dispatch({
    changes: change,
    selection: EditorSelection.cursor(cursor),
    scrollIntoView: true,
    userEvent: 'format',
  });
  return { changed: true };
}
