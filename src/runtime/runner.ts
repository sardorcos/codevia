import { makeId } from '../core/bytes';
import type { Files } from '../core/types';
import type { RunFile, RunRequest, WorkerMessage } from './protocol';

export type RuntimeKind = 'python' | 'php';

export interface RunCallbacks {
  onStatus?(text: string): void;
  onStdout(text: string): void;
  onStderr(text: string): void;
  onHtml?(html: string): void;
}

export interface RunOutcome {
  exitCode: number;
  ms: number;
  stopped?: boolean;
}

function createWorker(kind: RuntimeKind): Worker {
  return kind === 'python'
    ? new Worker(new URL('./python.worker.ts', import.meta.url), { type: 'module', name: 'python' })
    : new Worker(new URL('./php.worker.ts', import.meta.url), { type: 'module', name: 'php' });
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
  readonly versions = new Map<RuntimeKind, string>();

  constructor(private assetBase: string) {}

  private worker(kind: RuntimeKind, cb?: RunCallbacks): Worker {
    let w = this.workers.get(kind);
    if (!w) {
      w = createWorker(kind);
      w.onerror = (e) => {
        e.preventDefault();
        this.active?.fail(new Error(e.message || 'Сбой среды выполнения'));
        this.dispose(kind);
      };
      this.workers.set(kind, w);
    }
    w.onmessage = (ev: MessageEvent<WorkerMessage>) => this.handle(kind, ev.data, cb);
    return w;
  }

  private handle(kind: RuntimeKind, m: WorkerMessage, cb?: RunCallbacks): void {
    if (m.type === 'ready') {
      this.versions.set(kind, m.version);
      return;
    }
    if (m.type === 'status') {
      cb?.onStatus?.(m.text);
      return;
    }
    if (!this.active || ('id' in m && m.id && m.id !== this.active.id)) return;
    switch (m.type) {
      case 'stdout':
        cb?.onStdout(m.text);
        break;
      case 'stderr':
        cb?.onStderr(m.text);
        break;
      case 'html':
        cb?.onHtml?.(m.html);
        break;
      case 'done': {
        const a = this.active;
        this.active = null;
        a.finish({ exitCode: m.exitCode, ms: m.ms });
        break;
      }
      case 'fatal': {
        const a = this.active;
        this.active = null;
        a.fail(new Error(m.message));
        break;
      }
    }
  }

  preload(kind: RuntimeKind): void {
    this.worker(kind).postMessage({ type: 'preload', base: this.assetBase });
  }

  get running(): boolean {
    return this.active !== null;
  }

  run(kind: RuntimeKind, files: Files, entry: string, cb: RunCallbacks, extra: { stdin?: string; query?: string } = {}): Promise<RunOutcome> {
    if (this.active) return Promise.reject(new Error('Программа уже выполняется'));
    const id = makeId();
    const w = this.worker(kind, cb);
    return new Promise<RunOutcome>((resolve, reject) => {
      this.active = { kind, id, finish: resolve, fail: reject };
      const req: RunRequest = { type: 'run', id, entry, files: toRunFiles(files, kind), base: this.assetBase, ...extra };
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
