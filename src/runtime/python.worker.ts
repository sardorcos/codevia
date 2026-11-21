/// <reference lib="webworker" />
import type { RunRequest, WorkerMessage } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

interface PyodideLike {
  version: string;
  FS: {
    mkdirTree(path: string): void;
    writeFile(path: string, data: string | Uint8Array): void;
    rmdir(path: string): void;
    analyzePath(path: string): { exists: boolean };
  };
  setStdout(opts: { write: (buf: Uint8Array) => number }): void;
  setStderr(opts: { write: (buf: Uint8Array) => number }): void;
  setStdin(opts: { stdin: () => string | null | undefined; isatty?: boolean }): void;
  runPythonAsync(code: string, opts?: { globals?: unknown }): Promise<unknown>;
  globals: { get(name: string): unknown };
}

const post = (m: WorkerMessage) => self.postMessage(m);
let pyodidePromise: Promise<PyodideLike> | null = null;
let runCounter = 0;
/** Absolute URL of the bundled Pyodide folder, sent by the main thread. */
let indexURL = '';

function load(): Promise<PyodideLike> {
  // Cache the promise, not the instance: a preload followed by a quick Run must not start two interpreters.
  if (!pyodidePromise) {
    pyodidePromise = (async () => {
      post({ type: 'status', text: 'Загрузка Python…' });
      const mod = (await import(/* @vite-ignore */ `${indexURL}pyodide.mjs`)) as {
        loadPyodide(o: { indexURL: string }): Promise<PyodideLike>;
      };
      const py = await mod.loadPyodide({ indexURL });
      post({ type: 'ready', version: py.version });
      return py;
    })();
    pyodidePromise.catch(() => {
      pyodidePromise = null;
    });
  }
  return pyodidePromise;
}

const RUNNER = `
import sys, os, runpy, traceback
def __codevia_run(entry, workdir):
    os.chdir(workdir)
    if workdir not in sys.path:
        sys.path.insert(0, workdir)
    for name in list(sys.modules):
        mod = sys.modules.get(name)
        f = getattr(mod, '__file__', None) or ''
        if f.startswith(workdir):
            del sys.modules[name]
    try:
        runpy.run_path(entry, run_name='__main__')
        return 0
    except SystemExit as e:
        code = e.code
        if code is None:
            return 0
        if isinstance(code, int):
            return code
        print(code, file=sys.stderr)
        return 1
    except BaseException:
        etype, value, tb = sys.exc_info()
        frames = [f for f in traceback.extract_tb(tb) if f.filename.startswith(workdir)]
        print('Traceback (most recent call last):', file=sys.stderr)
        for line in traceback.format_list(frames):
            print(line.replace(workdir + '/', ''), end='', file=sys.stderr)
        for line in traceback.format_exception_only(etype, value):
            print(line.replace(workdir + '/', ''), end='', file=sys.stderr)
        if etype is ModuleNotFoundError:
            print('\\nПодсказка: доступна стандартная библиотека Python и модули вашего проекта. '
                  'Сторонние пакеты (numpy, requests и др.) пока не поддерживаются офлайн.', file=sys.stderr)
        return 1
    finally:
        sys.stdout.flush(); sys.stderr.flush()
        if sys.path and sys.path[0] == workdir:
            sys.path.pop(0)
`;

async function run(req: RunRequest): Promise<void> {
  const started = performance.now();
  const py = await load();
  const workdir = `/home/pyodide/run${++runCounter}`;
  py.FS.mkdirTree(workdir);
  for (const f of req.files) {
    const full = `${workdir}/${f.path}`;
    py.FS.mkdirTree(full.slice(0, full.lastIndexOf('/')));
    py.FS.writeFile(full, f.text ? (f.content ?? '') : (f.data ?? new Uint8Array()));
  }
  // Raw (unbatched) streams so a prompt printed without newline appears before input() reads.
  const outDec = new TextDecoder();
  const errDec = new TextDecoder();
  py.setStdout({ write: (buf) => (post({ type: 'stdout', id: req.id, text: outDec.decode(buf, { stream: true }) }), buf.length) });
  py.setStderr({ write: (buf) => (post({ type: 'stderr', id: req.id, text: errDec.decode(buf, { stream: true }) }), buf.length) });
  const lines = (req.stdin ?? '').split('\n');
  let stdinUsed = 0;
  py.setStdin({
    stdin: () => {
      if (stdinUsed >= lines.length || (stdinUsed === lines.length - 1 && lines[stdinUsed] === '')) {
        post({ type: 'stderr', id: req.id, text: 'input(): поле «Ввод» закончилось — добавьте строки перед запуском.\n' });
        return null;
      }
      const line = lines[stdinUsed++]!;
      post({ type: 'stdout', id: req.id, text: line + '\n' });
      return line + '\n';
    },
  });
  await py.runPythonAsync(RUNNER);
  const fn = py.globals.get('__codevia_run') as (entry: string, workdir: string) => number;
  const exitCode = Number(fn(`${workdir}/${req.entry}`, workdir)) || 0;
  post({ type: 'done', id: req.id, exitCode, ms: Math.round(performance.now() - started) });
}

self.onmessage = (ev: MessageEvent<(RunRequest | { type: 'preload' }) & { base?: string }>) => {
  const msg = ev.data;
  if (msg.base) indexURL = msg.base;
  if (msg.type === 'preload') {
    load().catch((e) => post({ type: 'fatal', message: `Не удалось загрузить Python: ${(e as Error).message}` }));
    return;
  }
  run(msg).catch((e) => post({ type: 'fatal', id: msg.id, message: (e as Error)?.message ?? String(e) }));
};
