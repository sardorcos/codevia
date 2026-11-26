// Copies the bundled front-end libraries into public/libs/<id>/<version>/ so Tools → Libraries can add
// them to a project offline. Also writes public/libs/index.json (versions and sizes) and prints the total.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LIBS, PERMISSIVE } from './libs-manifest.mjs';

const out = 'public/libs';
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const index = [];
let total = 0;
for (const lib of LIBS) {
  const dir = join('node_modules', lib.pkg);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const license = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type;
  if (!PERMISSIVE.test(license ?? '')) throw new Error(`${lib.pkg}: licence "${license}" is not on the permissive list`);
  const dst = join(out, lib.id, pkg.version);
  mkdirSync(dst, { recursive: true });
  const files = [];
  for (const [from, name] of lib.files) {
    const src = join(dir, from);
    if (!existsSync(src)) throw new Error(`${lib.pkg}: missing ${from}`);
    copyFileSync(src, join(dst, name));
    const size = statSync(src).size;
    total += size;
    files.push({ name, size });
  }
  index.push({ id: lib.id, pkg: lib.pkg, version: pkg.version, license, files });
}
writeFileSync(join(out, 'index.json'), JSON.stringify({ libraries: index, total }, null, 2));
console.log(`Front-end libraries copied to ${out}: ${index.length} libraries, ${(total / 1048576).toFixed(2)} MB`);
