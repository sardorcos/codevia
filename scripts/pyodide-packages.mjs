// Downloads the Python packages that ship inside the app (offline) into public/pyodide/.
// Everything else from the Pyodide distribution stays available on demand from the Pyodide CDN
// (see src/runtime/python.worker.ts). Every wheel is verified against pyodide-lock.json (SHA-256).
//
// Env:
//   CODEVIA_PY_BUNDLE=none   skip downloading (only on-demand packages)
//   CODEVIA_PY_STRICT=1      fail the build if a package cannot be downloaded (CI release builds)
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';

const lock = JSON.parse(readFileSync('node_modules/pyodide/pyodide-lock.json', 'utf8'));
const version = JSON.parse(readFileSync('node_modules/pyodide/package.json', 'utf8')).version;
const cdn = `https://cdn.jsdelivr.net/pyodide/v${version}/full/`;
const dst = 'public/pyodide';
const strict = process.env.CODEVIA_PY_STRICT === '1';
const wanted = JSON.parse(readFileSync('scripts/pyodide-bundle.json', 'utf8')).packages;

mkdirSync(dst, { recursive: true });
const norm = (n) => n.toLowerCase().replace(/[-_.]+/g, '-');
const byName = new Map(Object.values(lock.packages).map((p) => [norm(p.name), p]));

// Dependency closure of the wanted packages.
const closure = new Map();
const visit = (name) => {
  const p = byName.get(norm(name));
  if (!p) throw new Error(`Package not in pyodide-lock.json: ${name}`);
  if (closure.has(p.name)) return;
  closure.set(p.name, p);
  for (const d of p.depends ?? []) visit(d);
};
wanted.forEach(visit);

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const bundled = [];
let bytes = 0;

if (process.env.CODEVIA_PY_BUNDLE === 'none') {
  console.log('Python packages: bundling skipped (CODEVIA_PY_BUNDLE=none)');
} else {
  for (const p of closure.values()) {
    const file = `${dst}/${p.file_name}`;
    if (existsSync(file) && sha256(readFileSync(file)) === p.sha256) {
      bundled.push(p.name);
      bytes += statSync(file).size;
      continue;
    }
    try {
      const res = await fetch(cdn + p.file_name);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (sha256(buf) !== p.sha256) throw new Error('SHA-256 mismatch');
      writeFileSync(file, buf);
      bundled.push(p.name);
      bytes += buf.length;
    } catch (e) {
      const msg = `Python package ${p.name}: ${e.message}`;
      if (strict) throw new Error(msg);
      console.warn(`${msg} — it will be downloaded on demand instead`);
    }
  }
}

bundled.sort();
writeFileSync(`${dst}/bundled.json`, JSON.stringify({ version, cdn, packages: bundled }, null, 1));
console.log(`Python packages bundled: ${bundled.length}/${closure.size} (${(bytes / 1048576).toFixed(1)} MB); ` +
  `${Object.keys(lock.packages).length - bundled.length} more available on demand`);
