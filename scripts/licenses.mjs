// Collects licence texts of every production dependency into public/THIRD_PARTY_LICENSES.txt (shipped in the app).
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const tree = JSON.parse(execSync('npm ls --omit=dev --all --json', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
const seen = new Map();
(function walk(deps = {}) {
  for (const [name, info] of Object.entries(deps)) {
    if (!seen.has(name)) seen.set(name, info.version);
    walk(info.dependencies);
  }
})(tree.dependencies);

const parts = ['Codevia Pocket — third-party software notices', '='.repeat(60), ''];
for (const [name, version] of [...seen].sort(([a], [b]) => a.localeCompare(b))) {
  const dir = join('node_modules', name);
  if (!existsSync(dir)) continue;
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const license = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? 'see package';
  const files = readdirSync(dir).filter((f) => /^(licen[cs]e|copying|notice)/i.test(f) && !/gpl/i.test(f));
  parts.push(`${name}@${version} — ${name === 'php-wasm' ? 'Apache-2.0 (chosen from "Apache-2.0 OR GPL-2.0-only")' : license}`, '-'.repeat(60));
  for (const f of files) parts.push(readFileSync(join(dir, f), 'utf8').trim(), '');
  if (!files.length) parts.push(`Licensed under ${license}.`, '');
  parts.push('');
}
parts.push(
  'CPython (bundled inside Pyodide) — Python Software Foundation License Version 2. https://docs.python.org/3/license.html',
  'PHP (bundled inside php-wasm) — PHP License 3.01. https://www.php.net/license/3_01.txt',
);
// Python packages bundled with the app: licence texts straight from each wheel's .dist-info.
const bundledPath = 'public/pyodide/bundled.json';
if (existsSync(bundledPath)) {
  const lock = JSON.parse(readFileSync('node_modules/pyodide/pyodide-lock.json', 'utf8')).packages;
  const names = JSON.parse(readFileSync(bundledPath, 'utf8')).packages ?? [];
  for (const name of names) {
    const pkg = Object.values(lock).find((p) => p.name === name);
    const wheel = pkg && join('public/pyodide', pkg.file_name);
    if (!wheel || !existsSync(wheel)) continue;
    let text = '';
    try {
      text = execSync(
        `python3 -I -c "import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);n=[i for i in z.namelist() if '.dist-info/' in i and any(k in i.rsplit('/',1)[-1].upper() for k in ('LICEN','COPYING','NOTICE'))];print('\\n\\n'.join(z.read(i).decode('utf-8','replace') for i in n))" "${wheel}"`,
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 },
      ).trim();
    } catch {
      /* python3 missing: the name and version are still listed */
    }
    parts.push(`Python package ${name} ${pkg.version} (bundled)`, '-'.repeat(60), text || 'See the licence inside the package (.dist-info).', '', '');
  }
}
writeFileSync('public/THIRD_PARTY_LICENSES.txt', parts.join('\n'));
console.log(`Licence notices written for ${seen.size} packages`);
