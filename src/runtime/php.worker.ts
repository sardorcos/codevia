/// <reference lib="webworker" />
// PHP 8.3 via php-wasm (seanmorris), used under its Apache-2.0 option.
import './worker-dom-stub';
import { PhpBase } from 'php-wasm/PhpBase.mjs';
import type { RunRequest, WorkerMessage } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

const post = (m: WorkerMessage) => self.postMessage(m);
const DOCROOT = '/var/www/project';

type OutputEvent = Event & { detail: string[] };
interface PhpRuntime extends EventTarget {
  binary: Promise<unknown>;
  run(code: string): Promise<number>;
  refresh(): Promise<number>;
  mkdir(path: string): Promise<unknown>;
  writeFile(path: string, data: string | Uint8Array): Promise<unknown>;
  analyzePath(path: string): Promise<{ exists: boolean }>;
}

let phpPromise: Promise<PhpRuntime> | null = null;
let sink: { id: string; out: string[]; err: string[] } | null = null;

function load(): Promise<PhpRuntime> {
  if (!phpPromise) {
    post({ type: 'status', text: 'Загрузка PHP…' });
    phpPromise = (async () => {
      const php = new (PhpBase as unknown as new (loader: Promise<unknown>, args: object) => PhpRuntime)(
        import('php-wasm/php8.3-web.mjs'),
        { version: '8.3', autoTransaction: false },
      );
      php.addEventListener('output', (e) => sink?.out.push(...(e as OutputEvent).detail));
      php.addEventListener('error', (e) => sink?.err.push(...(e as OutputEvent).detail));
      await php.binary;
      sink = { id: 'version', out: [], err: [] };
      await php.run('<?php echo PHP_VERSION;');
      post({ type: 'ready', version: sink.out.join('').trim() });
      sink = null;
      return php;
    })();
    phpPromise.catch(() => {
      phpPromise = null;
    });
  }
  return phpPromise;
}

async function mkdirp(php: PhpRuntime, dir: string): Promise<void> {
  let cur = '';
  for (const seg of dir.split('/').filter(Boolean)) {
    cur += '/' + seg;
    if (!(await php.analyzePath(cur)).exists) await php.mkdir(cur);
  }
}

const phpString = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

async function run(req: RunRequest): Promise<void> {
  const started = performance.now();
  const php = await load();
  // Fresh interpreter state for every run (functions/classes/globals from the previous run are gone).
  await php.refresh();
  const root = `${DOCROOT}/r${Date.now().toString(36)}`;
  await mkdirp(php, root);
  for (const f of req.files) {
    const full = `${root}/${f.path}`;
    await mkdirp(php, full.slice(0, full.lastIndexOf('/')));
    await php.writeFile(full, f.text ? (f.content ?? '') : (f.data ?? new Uint8Array()));
  }
  sink = { id: req.id, out: [], err: [] };
  const script = `${root}/${req.entry}`;
  const bootstrap = `<?php
$__q = ${phpString(req.query ?? '')};
parse_str($__q, $_GET);
$_REQUEST = $_GET;
$_SERVER['REQUEST_METHOD'] = 'GET';
$_SERVER['QUERY_STRING'] = $__q;
$_SERVER['SCRIPT_NAME'] = $_SERVER['PHP_SELF'] = ${phpString('/' + req.entry)};
$_SERVER['REQUEST_URI'] = ${phpString('/' + req.entry)} . ($__q !== '' ? '?' . $__q : '');
$_SERVER['DOCUMENT_ROOT'] = ${phpString(root)};
$_SERVER['SCRIPT_FILENAME'] = ${phpString(script)};
$_SERVER['HTTP_HOST'] = 'localhost';
unset($__q);
chdir(${phpString(script.slice(0, script.lastIndexOf('/')))});
ini_set('display_errors', '1');
error_reporting(E_ALL);
include ${phpString(script)};
`;
  let exitCode: number;
  try {
    exitCode = Number(await php.run(bootstrap)) || 0;
  } catch (e) {
    sink.err.push(String((e as Error)?.message ?? e));
    exitCode = 255;
  }
  const clean = (s: string) => s.replaceAll(root + '/', '').replaceAll(root, '');
  const out = clean(sink.out.join(''));
  const err = clean(sink.err.join(''));
  sink = null;
  if (err) post({ type: 'stderr', id: req.id, text: err.endsWith('\n') ? err : err + '\n' });
  if (/<\s*(!doctype|html|body|head|div|p|h[1-6]|table|ul|span|a|br|section|main)\b/i.test(out)) post({ type: 'html', id: req.id, html: out });
  post({ type: 'stdout', id: req.id, text: out });
  post({ type: 'done', id: req.id, exitCode, ms: Math.round(performance.now() - started) });
}

self.onmessage = (ev: MessageEvent<RunRequest | { type: 'preload' }>) => {
  const msg = ev.data;
  if (msg.type === 'preload') {
    load().catch((e) => post({ type: 'fatal', message: `Не удалось загрузить PHP: ${(e as Error).message}` }));
    return;
  }
  run(msg).catch((e) => post({ type: 'fatal', id: msg.id, message: String((e as Error)?.message ?? e) }));
};
