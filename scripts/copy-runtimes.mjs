// Copies the Pyodide runtime into public/ so it ships inside the app bundle (no CDN at run time).
import { cpSync, mkdirSync, existsSync } from 'node:fs';
const src = 'node_modules/pyodide';
const dst = 'public/pyodide';
mkdirSync(dst, { recursive: true });
for (const f of ['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json']) {
  if (!existsSync(`${src}/${f}`)) throw new Error(`Pyodide file missing: ${f}`);
  cpSync(`${src}/${f}`, `${dst}/${f}`);
}
console.log('Pyodide runtime copied to public/pyodide');
