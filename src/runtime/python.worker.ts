/// <reference lib="webworker" />
import { NEED_INPUT_EXIT, OutputBatcher, type RunRequest, type WorkerMessage } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

interface PyodideFS {
  mkdirTree(path: string): void;
  writeFile(path: string, data: string | Uint8Array): void;
  readdir(path: string): string[];
  stat(path: string): { mode: number };
  isDir(mode: number): boolean;
  unlink(path: string): void;
  rmdir(path: string): void;
  analyzePath(path: string): { exists: boolean };
}

interface PyodideLike {
  version: string;
  FS: PyodideFS;
  setStdout(opts: { write: (buf: Uint8Array) => number }): void;
  setStderr(opts: { write: (buf: Uint8Array) => number }): void;
  setStdin(opts: { stdin: () => string | null | undefined; isatty?: boolean }): void;
  runPythonAsync(code: string, opts?: { globals?: unknown }): Promise<unknown>;
  loadPackagesFromImports(code: string, opts?: { messageCallback?: (m: string) => void; errorCallback?: (m: string) => void }): Promise<unknown>;
  loadPackage(names: string | string[], opts?: { messageCallback?: (m: string) => void; errorCallback?: (m: string) => void }): Promise<unknown>;
  registerJsModule(name: string, module: object): void;
  globals: { get(name: string): unknown };
}

interface LockPackage {
  name: string;
  file_name: string;
  imports?: string[];
  depends?: string[];
}
interface Lockfile {
  info: Record<string, unknown>;
  packages: Record<string, LockPackage>;
}

const post = (m: WorkerMessage) => self.postMessage(m);
let pyodidePromise: Promise<PyodideLike> | null = null;
/** Absolute URL of the bundled Pyodide folder, sent by the main thread. */
let indexURL = '';
let lang: 'en' | 'ru' = 'en';
let allowNetwork = true;
let cdnBase = '';
let bundledNames = new Set<string>();
let lockPackages: Record<string, LockPackage> = {};
/** The run that currently owns stdout/images (for callbacks from Python). */
let currentId = '';
/** Set when an interactive run needs a line the app has not given yet. */
let needInput = false;

/** One fixed folder: a fresh copy of the project on every run, so edited modules are never stale. */
const WORKDIR = '/home/pyodide/project';

const MSG = {
  loading: { en: 'Loading Python…', ru: 'Загрузка Python…' },
  loadingPkg: { en: 'Loading {name}…', ru: 'Загрузка {name}…' },
  stdinEnd: {
    en: 'input(): the Input field has no more lines — add lines before running.\n',
    ru: 'input(): поле «Ввод» закончилось — добавьте строки перед запуском.\n',
  },
  loadFailed: { en: 'Could not load Python: {msg}', ru: 'Не удалось загрузить Python: {msg}' },
  offline: {
    en: 'Package “{name}” is not built into the app. Turn on “Download Python packages” in Settings and connect to the internet — it downloads once and then works offline.',
    ru: 'Пакет «{name}» не встроен в приложение. Включите «Загружать пакеты Python» в настройках и подключитесь к интернету — он скачается один раз и дальше будет работать офлайн.',
  },
  pkgFailed: { en: 'Could not load package {name}: {msg}', ru: 'Не удалось загрузить пакет {name}: {msg}' },
  installing: { en: 'Installing {name} (PyPI)…', ru: 'Установка {name} (PyPI)…' },
} as const;
let overrides: Record<string, string> = {};
const wmsg = (k: keyof typeof MSG, p: Record<string, string> = {}) =>
  (overrides[k] ?? MSG[k][lang]).replace(/\{(\w+)\}/g, (_, n: string) => p[n] ?? '');

// ---------------------------------------------------------------------------------------------
// Package cache: wheels downloaded from the CDN are kept in IndexedDB, so a package needs the
// network only once. Integrity is checked against the SHA-256 that Pyodide passes from its lockfile.

const CACHE_DB = 'codevia-python-packages';

function openCache(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(CACHE_DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('wheels');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function cacheGet(url: string): Promise<ArrayBuffer | null> {
  const db = await openCache();
  if (!db) return null;
  return new Promise((resolve) => {
    const r = db.transaction('wheels').objectStore('wheels').get(url);
    r.onsuccess = () => resolve((r.result as ArrayBuffer | undefined) ?? null);
    r.onerror = () => resolve(null);
  });
}

async function cachePut(url: string, data: ArrayBuffer): Promise<void> {
  const db = await openCache();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction('wheels', 'readwrite');
    tx.objectStore('wheels').put(data, url);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

async function sha256Base64(data: ArrayBuffer): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  let s = '';
  for (const b of d) s += String.fromCharCode(b);
  return btoa(s);
}

const nativeFetch = self.fetch.bind(self);
const isRemotePackage = (url: string) =>
  url.startsWith('https://cdn.jsdelivr.net/') || url.startsWith('https://files.pythonhosted.org/') || url.startsWith('https://pypi.org/');

self.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!isRemotePackage(url)) return nativeFetch(input, init);
  const isWheel = /\.(whl|zip|tar)$/.test(new URL(url).pathname);
  if (isWheel) {
    const cached = await cacheGet(url);
    if (cached) return new Response(cached, { status: 200 });
  }
  if (!allowNetwork) throw new TypeError('network disabled');
  const { integrity, ...rest } = init ?? {};
  const res = await nativeFetch(input, rest);
  if (!isWheel || !res.ok) return res;
  const data = await res.arrayBuffer();
  if (integrity?.startsWith('sha256-') && `sha256-${await sha256Base64(data)}` !== integrity) {
    throw new TypeError(`integrity check failed for ${url}`);
  }
  await cachePut(url, data);
  return new Response(data, { status: 200 });
}) as typeof fetch;

// ---------------------------------------------------------------------------------------------

async function buildLockfile(): Promise<Lockfile> {
  const lock = (await (await nativeFetch(`${indexURL}pyodide-lock.json`)).json()) as Lockfile;
  let bundled: { cdn?: string; packages?: string[] } = {};
  try {
    bundled = await (await nativeFetch(`${indexURL}bundled.json`)).json();
  } catch {
    // Older bundle without the manifest: everything comes from the CDN.
  }
  cdnBase = bundled.cdn ?? '';
  bundledNames = new Set(bundled.packages ?? []);
  // Bundled wheels stay relative (served from the app); the rest point at the Pyodide CDN.
  for (const p of Object.values(lock.packages)) {
    if (!bundledNames.has(p.name) && cdnBase && !/^https?:/.test(p.file_name)) p.file_name = cdnBase + p.file_name;
  }
  lockPackages = lock.packages;
  return lock;
}

function load(): Promise<PyodideLike> {
  // Cache the promise, not the instance: a preload followed by a quick Run must not start two interpreters.
  if (!pyodidePromise) {
    pyodidePromise = (async () => {
      post({ type: 'status', text: wmsg('loading') });
      const mod = (await import(/* @vite-ignore */ `${indexURL}pyodide.mjs`)) as {
        loadPyodide(o: { indexURL: string; lockFileContents: Lockfile; packageBaseUrl: string; env?: Record<string, string> }): Promise<PyodideLike>;
      };
      const py = await mod.loadPyodide({
        indexURL,
        lockFileContents: await buildLockfile(),
        packageBaseUrl: indexURL,
        env: { MPLBACKEND: 'AGG' },
      });
      py.registerJsModule('_codevia', {
        need_input: () => needInput,
        image: (mime: string, data: string) => {
          flushAll();
          post({ type: 'image', id: currentId, mime, data });
        },
      });
      await py.runPythonAsync(SETUP);
      post({ type: 'ready', version: py.version });
      return py;
    })();
    pyodidePromise.catch(() => {
      pyodidePromise = null;
    });
  }
  return pyodidePromise;
}

/** Hooks installed once per interpreter: figures and PIL images are shown in the console. */
const SETUP = `
import sys, io, base64, importlib.abc, importlib.machinery
import _codevia

def _codevia_png(save):
    import warnings
    buf = io.BytesIO()
    # Rendering for the console must not print library deprecation noise into the user's output.
    with warnings.catch_warnings():
        warnings.simplefilter('ignore')
        save(buf)
    _codevia.image('image/png', base64.b64encode(buf.getvalue()).decode('ascii'))

def _codevia_show_figures(*args, **kwargs):
    import matplotlib.pyplot as plt
    for num in plt.get_fignums():
        fig = plt.figure(num)
        _codevia_png(lambda b: fig.savefig(b, format='png', dpi=110, bbox_inches='tight'))
    plt.close('all')

def _codevia_patch(name, module):
    if name == 'matplotlib.pyplot':
        module.show = _codevia_show_figures
    elif name == 'PIL.Image':
        def _show(self, title=None, **kwargs):
            img = self if self.mode in ('RGB', 'RGBA', 'L') else self.convert('RGBA')
            _codevia_png(lambda b: img.save(b, format='PNG'))
        module.Image.show = _show

class _CodeviaFinder(importlib.abc.MetaPathFinder):
    targets = ('matplotlib.pyplot', 'PIL.Image')
    def find_spec(self, name, path, target=None):
        if name not in self.targets:
            return None
        for finder in sys.meta_path:
            if finder is self:
                continue
            spec = finder.find_spec(name, path, target) if hasattr(finder, 'find_spec') else None
            if spec is not None and spec.loader is not None:
                loader = spec.loader
                original = loader.exec_module
                def exec_module(module, _orig=original, _name=name):
                    _orig(module)
                    _codevia_patch(_name, module)
                loader.exec_module = exec_module
                return spec
        return None

sys.meta_path.insert(0, _CodeviaFinder())
`;

const RUNNER = `
import sys, os, runpy, traceback, importlib
def __codevia_run(entry, workdir, hint):
    os.chdir(workdir)
    if workdir not in sys.path:
        sys.path.insert(0, workdir)
    for name in list(sys.modules):
        mod = sys.modules.get(name)
        f = getattr(mod, '__file__', None) or ''
        if f.startswith(workdir + '/'):
            del sys.modules[name]
    importlib.invalidate_caches()
    try:
        runpy.run_path(entry, run_name='__main__')
        if 'matplotlib.pyplot' in sys.modules:
            import matplotlib.pyplot as plt
            if plt.get_fignums():
                plt.show()
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
        import _codevia
        if etype is EOFError and _codevia.need_input():
            return ${NEED_INPUT_EXIT}
        frames = [f for f in traceback.extract_tb(tb) if f.filename.startswith(workdir)]
        print('Traceback (most recent call last):', file=sys.stderr)
        for line in traceback.format_list(frames):
            print(line.replace(workdir + '/', ''), end='', file=sys.stderr)
        for line in traceback.format_exception_only(etype, value):
            print(line.replace(workdir + '/', ''), end='', file=sys.stderr)
        if etype is ModuleNotFoundError and hint:
            print('\\n' + hint, file=sys.stderr)
        return 1
    finally:
        sys.stdout.flush(); sys.stderr.flush()
`;

const HINT = {
  en: 'Tip: the standard library, the packages listed in Settings → Python packages, and your project modules are available. For other PyPI packages, list them in requirements.txt.',
  ru: 'Подсказка: доступны стандартная библиотека, пакеты из «Настройки → Пакеты Python» и модули проекта. Другие пакеты PyPI перечислите в requirements.txt.',
};

let out: OutputBatcher | null = null;
let err: OutputBatcher | null = null;
const flushAll = () => {
  out?.flush();
  err?.flush();
};

/** Deletes the previous run's copy of the project (and its memory). */
function clearDir(fs: PyodideFS, dir: string): void {
  if (!fs.analyzePath(dir).exists) return;
  for (const name of fs.readdir(dir)) {
    if (name === '.' || name === '..') continue;
    const p = `${dir}/${name}`;
    if (fs.isDir(fs.stat(p).mode)) {
      clearDir(fs, p);
      fs.rmdir(p);
    } else fs.unlink(p);
  }
}

/** Top-level module names imported by the project's Python files. */
function importedModules(code: string): Set<string> {
  const names = new Set<string>();
  for (const m of code.matchAll(/^\s*(?:from\s+([A-Za-z_][\w]*)[\w.]*\s+import|import\s+([^#\n]+))/gm)) {
    if (m[1]) names.add(m[1]);
    else for (const part of m[2]!.split(',')) {
      const n = part.trim().split(/\s+/)[0]?.split('.')[0];
      if (n) names.add(n);
    }
  }
  return names;
}

/** Loads Pyodide packages the code imports (bundled or downloaded), with readable errors. */
async function loadImports(py: PyodideLike, code: string, localModules: Set<string>): Promise<void> {
  const byImport = new Map<string, LockPackage>();
  for (const p of Object.values(lockPackages)) for (const i of p.imports ?? []) byImport.set(i, p);
  const needed = [...importedModules(code)].filter((n) => !localModules.has(n)).map((n) => byImport.get(n)).filter((p): p is LockPackage => !!p);
  if (!needed.length) return;
  const errors: string[] = [];
  await py.loadPackage(
    needed.map((p) => p.name),
    {
      messageCallback: (m) => {
        const name = /Loading ([\w.-]+)/.exec(m)?.[1];
        if (name) post({ type: 'status', text: wmsg('loadingPkg', { name }) });
      },
      errorCallback: (m) => errors.push(m),
    },
  );
  if (!errors.length) return;
  // Name the packages that failed: offline (not bundled, network off) gets an actionable hint.
  for (const p of needed) {
    if (!errors.some((m) => m.includes(p.name))) continue;
    err?.write((bundledNames.has(p.name) || allowNetwork ? wmsg('pkgFailed', { name: p.name, msg: errors.find((m) => m.includes(p.name)) ?? '' }) : wmsg('offline', { name: p.name })) + '\n');
  }
}

/** requirements.txt: installs extra pure-Python packages from PyPI with micropip (cached afterwards). */
async function installRequirements(py: PyodideLike, text: string): Promise<void> {
  const reqs = text
    .split('\n')
    .map((l) => l.replace(/#.*/, '').trim())
    .filter((l) => l && !l.startsWith('-'));
  if (!reqs.length) return;
  await py.loadPackage('micropip');
  post({ type: 'status', text: wmsg('installing', { name: reqs.join(', ') }) });
  await py.runPythonAsync(`import micropip\nawait micropip.install(${JSON.stringify(reqs)})`);
}

async function run(req: RunRequest): Promise<void> {
  const started = performance.now();
  if (req.lang) lang = req.lang;
  if (req.allowNetwork !== undefined) allowNetwork = req.allowNetwork;
  if (req.messages) overrides = req.messages;
  const py = await load();
  currentId = req.id;
  out = new OutputBatcher((text) => post({ type: 'stdout', id: req.id, text }));
  err = new OutputBatcher((text) => post({ type: 'stderr', id: req.id, text }));
  const outDec = new TextDecoder();
  const errDec = new TextDecoder();
  py.setStdout({ write: (buf) => (out!.write(outDec.decode(buf, { stream: true })), buf.length) });
  py.setStderr({ write: (buf) => (err!.write(errDec.decode(buf, { stream: true })), buf.length) });

  clearDir(py.FS, WORKDIR);
  py.FS.mkdirTree(WORKDIR);
  let code = '';
  const localModules = new Set<string>();
  let requirements = '';
  for (const f of req.files) {
    const full = `${WORKDIR}/${f.path}`;
    py.FS.mkdirTree(full.slice(0, full.lastIndexOf('/')));
    py.FS.writeFile(full, f.text ? (f.content ?? '') : (f.data ?? new Uint8Array()));
    if (f.text && f.path.endsWith('.py')) code += (f.content ?? '') + '\n';
    const top = f.path.split('/')[0]!.replace(/\.py$/, '');
    localModules.add(top);
    if (f.path === 'requirements.txt' && f.text) requirements = f.content ?? '';
  }

  try {
    if (requirements) await installRequirements(py, requirements);
  } catch (e) {
    err.write(wmsg('pkgFailed', { name: 'requirements.txt', msg: String((e as Error)?.message ?? e).split('\n').slice(-2).join(' ') }) + '\n');
  }
  try {
    await loadImports(py, code, localModules);
  } catch (e) {
    err.write(String((e as Error)?.message ?? e) + '\n');
  }

  const lines = (req.stdin ?? '').split('\n');
  let stdinUsed = 0;
  needInput = false;
  py.setStdin({
    stdin: () => {
      flushAll();
      if (stdinUsed >= lines.length || (stdinUsed === lines.length - 1 && lines[stdinUsed] === '')) {
        // Interactive: stop here (EOF) and let the app ask the user; the run is replayed with one more line.
        if (req.interactive) {
          needInput = true;
          return null;
        }
        post({ type: 'stderr', id: req.id, text: wmsg('stdinEnd') });
        return null;
      }
      const line = lines[stdinUsed++]!;
      post({ type: 'stdout', id: req.id, text: line + '\n' });
      return line + '\n';
    },
  });
  await py.runPythonAsync(RUNNER);
  const fn = py.globals.get('__codevia_run') as (entry: string, workdir: string, hint: string) => number;
  let exitCode: number;
  try {
    exitCode = Number(fn(`${WORKDIR}/${req.entry}`, WORKDIR, overrides.hint ?? HINT[lang])) || 0;
  } finally {
    flushAll();
    // Free the copy right away: big data files must not stay in the worker's memory between runs.
    clearDir(py.FS, WORKDIR);
  }
  if (needInput) post({ type: 'need-input', id: req.id });
  post({ type: 'done', id: req.id, exitCode, ms: Math.round(performance.now() - started) });
}

self.onmessage = (ev: MessageEvent<(RunRequest | { type: 'preload'; lang?: 'en' | 'ru'; allowNetwork?: boolean }) & { base?: string }>) => {
  const msg = ev.data;
  if (msg.base) indexURL = msg.base;
  if (msg.lang) lang = msg.lang;
  if (msg.allowNetwork !== undefined) allowNetwork = msg.allowNetwork;
  if ((msg as { messages?: Record<string, string> }).messages) overrides = (msg as { messages: Record<string, string> }).messages;
  if (msg.type === 'preload') {
    load().catch((e) => post({ type: 'fatal', message: wmsg('loadFailed', { msg: (e as Error).message }) }));
    return;
  }
  run(msg).catch((e) => {
    flushAll();
    post({ type: 'fatal', id: msg.id, message: (e as Error)?.message ?? String(e) });
  });
};
