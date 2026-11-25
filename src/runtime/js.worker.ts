/// <reference lib="webworker" />
// Runs a JavaScript / TypeScript project like a tiny Node: CommonJS + ES modules between project
// files, console output, timers, prompt() fed from the Input field, process.exit, fs/path over
// the project files. "Stop" terminates the worker, which is the only reliable way to interrupt code.
import { compileModule, dirOf, formatArgs, formatTable, inspect, makeBuiltins, resolveModule } from './js-core';
import { OutputBatcher, type RunRequest, type WorkerMessage } from './protocol';

declare const self: DedicatedWorkerGlobalScope;
const post = (m: WorkerMessage) => self.postMessage(m);

const MSG = {
  notFound: {
    en: "Cannot find module '{spec}' (from {from}). Project files and the built-ins fs, path, util and events are available; npm packages are not installed on the device.",
    ru: "Модуль '{spec}' не найден (из {from}). Доступны файлы проекта и встроенные fs, path, util, events; пакеты npm на устройстве не установлены.",
  },
  stdinEnd: {
    en: 'prompt(): the Input field has no more lines — add lines before running.\n',
    ru: 'prompt(): поле «Ввод» закончилось — добавьте строки перед запуском.\n',
  },
} as const;

class ExitSignal {
  constructor(readonly code: number) {}
}

let lang: 'en' | 'ru' = 'en';
const wmsg = (k: keyof typeof MSG, p: Record<string, string> = {}) => MSG[k][lang].replace(/\{(\w+)\}/g, (_, n: string) => p[n] ?? '');

/** How many lines `new Function` adds before the body in this engine (for stack line numbers). */
const lineOffset = (() => {
  try {
    new Function('throw new Error("probe")\n//# sourceURL=__codevia_probe__')();
  } catch (e) {
    const m = /__codevia_probe__:(\d+)/.exec(String((e as Error).stack));
    if (m) return Number(m[1]) - 1;
  }
  return 0;
})();

function run(req: RunRequest): void {
  const started = performance.now();
  if (req.lang) lang = req.lang;
  const out = new OutputBatcher((text) => post({ type: 'stdout', id: req.id, text }));
  const err = new OutputBatcher((text) => post({ type: 'stderr', id: req.id, text }));
  const flush = () => {
    out.flush();
    err.flush();
  };
  let finished = false;
  let exitCode = 0;
  const finish = (code: number) => {
    if (finished) return;
    finished = true;
    exitCode = code;
    flush();
    post({ type: 'done', id: req.id, exitCode, ms: Math.round(performance.now() - started) });
  };

  // --- Project files (writable in memory for fs.writeFileSync during the run) ---
  const files = new Map<string, string | Uint8Array>();
  for (const f of req.files) files.set(f.path, f.text ? (f.content ?? '') : (f.data ?? new Uint8Array()));
  const builtins = makeBuiltins({ read: (p) => files.get(p), write: (p, d) => files.set(p, d), list: () => [...files.keys()] });

  // --- Error printing with project-relative stack lines ---
  const fixStack = (stack: string) =>
    stack
      .split('\n')
      .filter((l) => !/js\.worker|js-core|__codevia|sucrase/.test(l))
      .map((l) => l.replace(/([\w./-]+\.(?:m|c)?[jt]sx?):(\d+)/g, (_, file: string, line: string) => `${file}:${Math.max(1, Number(line) - lineOffset)}`))
      .join('\n');
  const printError = (e: unknown) => {
    if (e instanceof ExitSignal) return;
    if (e instanceof Error) {
      const head = `${e.name}: ${e.message}`;
      const stack = e.stack ? fixStack(e.stack) : '';
      err.write(head + (stack && !stack.startsWith(head) ? '\n' + stack : stack.replace(head, '')) + '\n');
    } else err.write('Uncaught ' + inspect(e, {}, new Set(), 0, true) + '\n');
  };

  // --- console ---
  let indent = '';
  const timers = new Map<string, number>();
  const counts = new Map<string, number>();
  const writeOut = (s: string) => out.write(indent ? s.replace(/^/gm, indent) + '\n' : s + '\n');
  const writeErr = (s: string) => err.write(indent ? s.replace(/^/gm, indent) + '\n' : s + '\n');
  const consoleObj = {
    log: (...a: unknown[]) => writeOut(formatArgs(a)),
    info: (...a: unknown[]) => writeOut(formatArgs(a)),
    debug: (...a: unknown[]) => writeOut(formatArgs(a)),
    warn: (...a: unknown[]) => writeErr(formatArgs(a)),
    error: (...a: unknown[]) => writeErr(formatArgs(a)),
    dir: (v: unknown) => writeOut(inspect(v)),
    table: (v: unknown) => writeOut(formatTable(v)),
    assert: (cond: unknown, ...a: unknown[]) => {
      if (!cond) writeErr('Assertion failed' + (a.length ? ': ' + formatArgs(a) : ''));
    },
    count: (label = 'default') => {
      const n = (counts.get(label) ?? 0) + 1;
      counts.set(label, n);
      writeOut(`${label}: ${n}`);
    },
    countReset: (label = 'default') => counts.delete(label),
    time: (label = 'default') => timers.set(label, performance.now()),
    timeLog: (label = 'default') => writeOut(`${label}: ${(performance.now() - (timers.get(label) ?? performance.now())).toFixed(3)}ms`),
    timeEnd: (label = 'default') => {
      writeOut(`${label}: ${(performance.now() - (timers.get(label) ?? performance.now())).toFixed(3)}ms`);
      timers.delete(label);
    },
    group: (...a: unknown[]) => {
      if (a.length) writeOut(formatArgs(a));
      indent += '  ';
    },
    groupEnd: () => {
      indent = indent.slice(2);
    },
    clear: () => {},
    trace: (...a: unknown[]) => writeErr('Trace' + (a.length ? ': ' + formatArgs(a) : '') + '\n' + fixStack(new Error().stack ?? '')),
  };
  (consoleObj as Record<string, unknown>).groupCollapsed = consoleObj.group;

  // --- stdin for prompt() / readline-style input ---
  const lines = (req.stdin ?? '').split('\n');
  let stdinUsed = 0;
  const prompt = (message?: string) => {
    if (message) out.write(String(message));
    flush();
    if (stdinUsed >= lines.length || (stdinUsed === lines.length - 1 && lines[stdinUsed] === '')) {
      err.write(wmsg('stdinEnd'));
      return null;
    }
    const line = lines[stdinUsed++]!;
    out.write(line + '\n');
    return line;
  };

  // --- timers: the run is finished when the main module settled and nothing is scheduled ---
  let pending = 0;
  let mainSettled = false;
  const maybeFinish = () => {
    if (mainSettled && pending === 0) setTimeout(() => mainSettled && pending === 0 && finish(exitCode), 0);
  };
  const guard = (fn: () => void) => {
    try {
      fn();
    } catch (e) {
      if (e instanceof ExitSignal) return finish(e.code);
      printError(e);
      exitCode = 1;
    }
  };
  const nativeSetTimeout = self.setTimeout.bind(self);
  const nativeClearTimeout = self.clearTimeout.bind(self);
  const nativeSetInterval = self.setInterval.bind(self);
  const nativeClearInterval = self.clearInterval.bind(self);
  const liveTimeouts = new Set<number>();
  const liveIntervals = new Set<number>();
  const sandboxTimers = {
    setTimeout: (fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      pending++;
      const id = nativeSetTimeout(() => {
        if (!liveTimeouts.delete(id)) return;
        pending--;
        guard(() => fn(...args));
        maybeFinish();
      }, ms);
      liveTimeouts.add(id);
      return id;
    },
    clearTimeout: (id: number) => {
      if (liveTimeouts.delete(id)) {
        pending--;
        nativeClearTimeout(id);
        maybeFinish();
      }
    },
    setInterval: (fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      pending++;
      const id = nativeSetInterval(() => guard(() => fn(...args)), ms);
      liveIntervals.add(id);
      return id;
    },
    clearInterval: (id: number) => {
      if (liveIntervals.delete(id)) {
        pending--;
        nativeClearInterval(id);
        maybeFinish();
      }
    },
  };
  const trackPromise = <T>(p: Promise<T>): Promise<T> => {
    pending++;
    return p.finally(() => {
      pending--;
      maybeFinish();
    });
  };
  const sandboxFetch = (...a: Parameters<typeof fetch>) => trackPromise(fetch(...a));

  const processObj = {
    argv: ['node', req.entry],
    env: {} as Record<string, string>,
    platform: 'ios',
    version: 'v22.0.0-codevia',
    versions: { node: '22.0.0-codevia' },
    cwd: () => '/',
    exit: (code = 0) => {
      throw new ExitSignal(Number(code) || 0);
    },
    stdout: { write: (s: unknown) => (out.write(String(s)), true) },
    stderr: { write: (s: unknown) => (err.write(String(s)), true) },
    nextTick: (fn: (...a: unknown[]) => void, ...args: unknown[]) => queueMicrotask(() => guard(() => fn(...args))),
    hrtime: { bigint: () => BigInt(Math.round(performance.now() * 1e6)) },
    memoryUsage: () => ({ heapUsed: 0, heapTotal: 0, rss: 0 }),
    on: () => processObj,
  };

  // --- module loader ---
  const cache = new Map<string, { exports: unknown }>();
  const exists = (p: string) => files.has(p);
  const load = (path: string, wrapAsync: boolean): unknown => {
    const hit = cache.get(path);
    if (hit) return hit.exports;
    const source = files.get(path);
    const text = typeof source === 'string' ? source : new TextDecoder().decode(source);
    const module = { exports: {} as unknown };
    cache.set(path, module);
    if (path.endsWith('.json')) {
      module.exports = JSON.parse(text);
      return module.exports;
    }
    const code = compileModule(path, text);
    const require = (spec: string) => {
      if (spec in builtins) return builtins[spec];
      const target = resolveModule(path, spec, exists);
      if (!target) throw new Error(wmsg('notFound', { spec, from: path }));
      return load(target, false);
    };
    const body = wrapAsync ? `return (async () => {${code}\n})();` : code;
    const fn = new Function(
      'require', 'module', 'exports', '__filename', '__dirname', 'console', 'process', 'prompt',
      'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'fetch', 'global',
      `${body}\n//# sourceURL=${path}`,
    );
    const result = fn(
      require, module, module.exports, path, dirOf(path), consoleObj, processObj, prompt,
      sandboxTimers.setTimeout, sandboxTimers.clearTimeout, sandboxTimers.setInterval, sandboxTimers.clearInterval,
      sandboxFetch, globalThis,
    );
    return wrapAsync ? result : module.exports;
  };

  self.addEventListener('unhandledrejection', (ev) => {
    ev.preventDefault();
    if (ev.reason instanceof ExitSignal) return finish(ev.reason.code);
    printError(ev.reason);
    exitCode = 1;
    maybeFinish();
  });
  (globalThis as Record<string, unknown>).prompt = prompt;
  (globalThis as Record<string, unknown>).alert = (m: unknown) => writeOut(String(m));

  try {
    const result = load(req.entry, true) as Promise<unknown>;
    Promise.resolve(result).then(
      () => {
        mainSettled = true;
        maybeFinish();
      },
      (e) => {
        if (e instanceof ExitSignal) return finish(e.code);
        printError(e);
        exitCode = 1;
        mainSettled = true;
        maybeFinish();
      },
    );
  } catch (e) {
    // Syntax errors from the transpiler land here.
    if (e instanceof ExitSignal) return finish(e.code);
    printError(e);
    finish(1);
  }
}

self.onmessage = (ev: MessageEvent<RunRequest | { type: 'preload'; lang?: 'en' | 'ru' }>) => {
  const msg = ev.data;
  if (msg.lang) lang = msg.lang;
  if (msg.type === 'preload') {
    post({ type: 'ready', version: 'JavaScript (ES2023) · TypeScript' });
    return;
  }
  try {
    run(msg);
  } catch (e) {
    post({ type: 'fatal', id: msg.id, message: (e as Error)?.message ?? String(e) });
  }
};
