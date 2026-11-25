import { makeId } from '../core/bytes';
import type { Files } from '../core/types';
import type { RunFile, RunRequest, WorkerMessage } from './protocol';
import { getLang, t } from '../i18n';

export type RuntimeKind = 'python' | 'php' | 'javascript';

export interface RunCallbacks {
  onStatus?(text: string): void;
  onStdout(text: string): void;
  onStderr(text: string): void;
  onHtml?(html: string): void;
  /** An image produced by the program (matplotlib figure, PIL image), base64 data. */
  onImage?(mime: string, data: string): void;
}

export interface RunOutcome {
  exitCode: number;
  ms: number;
  stopped?: boolean;
}

/**
 * Workers write their own messages (status, load errors, hints in stderr) in Russian; they are
 * translated here so the workers stay language-agnostic. Anything else (program output, runtime
 * errors) passes through unchanged.
 */
export function localizeWorkerText(text: string): string {
  if (getLang() === 'ru') return text;
  const m = /^Не удалось загрузить (Python|PHP): ([\s\S]*)$/.exec(text);
  if (m) return t('Не удалось загрузить {runtime}: {error}', { runtime: m[1]!, error: m[2]! });
  const known: Array<[string, string]> = [
    ['Загрузка Python…', t('Загрузка Python…')],
    ['Загрузка PHP…', t('Загрузка PHP…')],
    ['input(): поле «Ввод» закончилось — добавьте строки перед запуском.', t('input(): поле «Ввод» закончилось — добавьте строки перед запуском.')],
    [
      'Подсказка: доступна стандартная библиотека Python и модули вашего проекта. Сторонние пакеты (numpy, requests и др.) пока не поддерживаются офлайн.',
      t('Подсказка: доступна стандартная библиотека Python и модули вашего проекта. Сторонние пакеты (numpy, requests и др.) пока не поддерживаются офлайн.'),
    ],
  ];
  for (const [ru, en] of known) if (text.includes(ru)) text = text.split(ru).join(en);
  return text;
}

function createWorker(kind: RuntimeKind): Worker {
  if (kind === 'python') return new Worker(new URL('./python.worker.ts', import.meta.url), { type: 'module', name: 'python' });
  if (kind === 'javascript') return new Worker(new URL('./js.worker.ts', import.meta.url), { type: 'module', name: 'javascript' });
  return new Worker(new URL('./php.worker.ts', import.meta.url), { type: 'module', name: 'php' });
}

/** Options every run and preload carries (interface language, package downloads). */
export interface RuntimeOptions {
  lang?: 'en' | 'ru';
  allowNetwork?: boolean;
}

const toRunFiles = (files: Files, kind: RuntimeKind): RunFile[] =>
  Object.entries(files)
    // Only what the runtime can use; skip big media to keep start-up fast.
    .filter(([p, f]) => f.text || (kind === 'php' ? true : !/\.(mp4|mov|webm|mp3|wav)$/i.test(p)))
    .map(([path, f]) => (f.text ? { path, text: true, content: f.content } : { path, text: false, data: f.data }));

/**
 * Owns one worker per runtime. "Stop" terminates the worker (the only reliable way to interrupt
 * WebAssembly), and the next run transparently starts a fresh one.
 */
export class Runner {
  private workers = new Map<RuntimeKind, Worker>();
  private active: { kind: RuntimeKind; id: string; finish: (o: RunOutcome) => void; fail: (e: Error) => void } | null = null;
  /** Callbacks of the current run; preloading never replaces them. */
  private callbacks: RunCallbacks | null = null;
  readonly versions = new Map<RuntimeKind, string>();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private assetBase: string,
    /** Runtimes hold 50–150 MB each; free them after this long without use so iOS does not kill the web view. */
    private idleMs = 3 * 60_000,
  ) {}

  private touchIdle(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.active) this.disposeAll();
    }, this.idleMs);
  }

  /** Terminates every runtime worker (used when leaving a project or after inactivity). */
  disposeAll(): void {
    if (this.active) this.stop();
    for (const kind of [...this.workers.keys()]) this.dispose(kind);
  }

  private worker(kind: RuntimeKind): Worker {
    let w = this.workers.get(kind);
    if (!w) {
      w = createWorker(kind);
      w.onerror = (e) => {
        e.preventDefault();
        const a = this.active?.kind === kind ? this.active : null;
        this.dispose(kind);
        if (a) {
          this.active = null;
          a.fail(new Error(e.message || t('Среда выполнения не загрузилась. Попробуйте ещё раз.')));
        }
      };
      w.onmessage = (ev: MessageEvent<WorkerMessage>) => this.handle(kind, ev.data);
      this.workers.set(kind, w);
    }
    return w;
  }

  private handle(kind: RuntimeKind, m: WorkerMessage): void {
    const cb = this.active?.kind === kind ? this.callbacks : null;
    if (m.type === 'ready') {
      this.versions.set(kind, m.version);
      return;
    }
    if (m.type === 'status') {
      cb?.onStatus?.(localizeWorkerText(m.text));
      return;
    }
    if (!this.active || ('id' in m && m.id && m.id !== this.active.id)) return;
    switch (m.type) {
      case 'stdout':
        cb?.onStdout(m.text);
        break;
      case 'stderr':
        cb?.onStderr(localizeWorkerText(m.text));
        break;
      case 'html':
        cb?.onHtml?.(m.html);
        break;
      case 'image':
        cb?.onImage?.(m.mime, m.data);
        break;
      case 'done': {
        const a = this.active;
        this.active = null;
        this.touchIdle();
        a.finish({ exitCode: m.exitCode, ms: m.ms });
        break;
      }
      case 'fatal': {
        const a = this.active;
        this.active = null;
        this.touchIdle();
        a.fail(new Error(localizeWorkerText(m.message)));
        break;
      }
    }
  }

  /** Language and network permission sent with every request; the app updates it from Settings. */
  options: RuntimeOptions = {};

  preload(kind: RuntimeKind): void {
    // Only one heavy runtime at a time.
    for (const other of [...this.workers.keys()]) if (other !== kind && !this.active) this.dispose(other);
    this.touchIdle();
    this.worker(kind).postMessage({ type: 'preload', base: this.assetBase, ...this.options });
  }

  get running(): boolean {
    return this.active !== null;
  }

  run(kind: RuntimeKind, files: Files, entry: string, cb: RunCallbacks, extra: { stdin?: string; query?: string; post?: string } = {}): Promise<RunOutcome> {
    if (this.active) return Promise.reject(new Error(t('Программа уже выполняется')));
    const id = makeId();
    for (const other of [...this.workers.keys()]) if (other !== kind) this.dispose(other);
    this.touchIdle();
    const w = this.worker(kind);
    this.callbacks = cb;
    return new Promise<RunOutcome>((resolve, reject) => {
      this.active = { kind, id, finish: resolve, fail: reject };
      const req: RunRequest = { type: 'run', id, entry, files: toRunFiles(files, kind), base: this.assetBase, ...this.options, ...extra };
      w.postMessage(req);
    });
  }

  stop(): void {
    const a = this.active;
    if (!a) return;
    this.dispose(a.kind);
    this.active = null;
    a.finish({ exitCode: 130, ms: 0, stopped: true });
  }

  private dispose(kind: RuntimeKind): void {
    this.workers.get(kind)?.terminate();
    this.workers.delete(kind);
  }
}
