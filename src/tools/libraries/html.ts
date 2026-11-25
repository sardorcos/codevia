import type { LibFile, Library } from './catalog';
import { projectPath } from './catalog';

/**
 * Pure edits of an HTML page for Tools → Libraries. Idempotent: adding twice changes nothing, and
 * removing touches only the tags that point into `libs/<id>/`.
 * - CSS goes into <head>, before the page's own stylesheets (so the page can override the library).
 * - Scripts go before </body>, before the page's own scripts (so they can use the library);
 *   files marked `place: 'head'` (Tailwind's browser build) go at the end of <head>.
 */

export type LibraryState = 'added' | 'other' | 'none';

/** `../` prefix that leads from the HTML file to the project root. */
export const rootPrefix = (htmlPath: string): string => '../'.repeat(Math.max(0, htmlPath.split('/').length - 1));

export const libHref = (lib: Library, file: LibFile, prefix = ''): string => `${prefix}${projectPath(lib, file)}`;

export function tagFor(lib: Library, file: LibFile, prefix = ''): string {
  const href = libHref(lib, file, prefix);
  return file.kind === 'css' ? `<link rel="stylesheet" href="${href}">` : `<script src="${href}"${file.defer ? ' defer' : ''}></script>`;
}

const refRe = (id: string) => new RegExp(`(?:href|src)\\s*=\\s*["']?(?:\\.\\.\\/|\\.\\/|\\/)*libs\\/${id}\\/`, 'i');

const tagRefs = (html: string): string[] => [...html.matchAll(/<(?:link|script)\b[^>]*>/gi)].map((m) => m[0]);

/** Whether the page includes the library from the project (`added`), from elsewhere such as a CDN (`other`), or not at all. */
export function detectLibrary(html: string, lib: Library): LibraryState {
  const tags = tagRefs(html);
  if (tags.some((tag) => refRe(lib.id).test(tag))) return 'added';
  if (tags.some((tag) => lib.detect.test(tag))) return 'other';
  return 'none';
}

/** Whether `file` of `lib` is referenced by a tag of the page. */
function hasFile(html: string, lib: Library, file: LibFile): boolean {
  const re = new RegExp(`(?:href|src)\\s*=\\s*["']?(?:\\.\\.\\/|\\.\\/|\\/)*libs\\/${lib.id}\\/${file.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
  return tagRefs(html).some((tag) => re.test(tag));
}

const isLibTag = (tag: string) => /(?:href|src)\s*=\s*["']?(?:\.\.\/|\.\/|\/)*libs\//i.test(tag);

function lineStart(html: string, pos: number): number {
  return html.lastIndexOf('\n', pos - 1) + 1;
}

/** Indentation unit used by the file (tab or N spaces, default 2). */
function indentUnit(html: string): string {
  if (/^\t+</m.test(html)) return '\t';
  const sizes = [...html.matchAll(/^( +)</gm)].map((m) => m[1]!.length).filter((n) => n > 0);
  const min = sizes.length ? Math.min(...sizes) : 2;
  return ' '.repeat(Math.min(min, 4));
}

/**
 * Inserts `lines` before position `pos`. When `pos` starts a line (after indentation), each line gets
 * `indent` and its own line; otherwise they are inserted inline.
 */
function insertAt(html: string, pos: number, lines: string[], indent: string | null): string {
  const ls = lineStart(html, pos);
  const before = html.slice(ls, pos);
  if (/^[ \t]*$/.test(before)) {
    const own = indent ?? before;
    return html.slice(0, ls) + lines.map((l) => `${l ? own + l : ''}\n`).join('') + html.slice(ls);
  }
  return html.slice(0, pos) + lines.join('') + html.slice(pos);
}

function closeTag(html: string, name: 'head' | 'body'): number {
  const m = new RegExp(`</${name}\\s*>`, 'i').exec(html);
  return m ? m.index : -1;
}

/** Inserts tags at the end of <head> or before a given element inside it. */
function addToHead(html: string, tags: string[], beforeUserCss: boolean): string {
  if (!tags.length) return html;
  const unit = indentUnit(html);
  const end = closeTag(html, 'head');
  const headOpen = /<head\b[^>]*>/i.exec(html);
  if (end >= 0) {
    if (beforeUserCss) {
      const from = headOpen ? headOpen.index + headOpen[0].length : 0;
      const re = /<link\b[^>]*\brel\s*=\s*["']?stylesheet[^>]*>|<style\b[^>]*>/gi;
      re.lastIndex = from;
      for (let m = re.exec(html); m && m.index < end; m = re.exec(html)) {
        if (!isLibTag(m[0])) return insertAt(html, m.index, tags, null);
      }
    }
    const ls = lineStart(html, end);
    const closingIndent = /^[ \t]*$/.test(html.slice(ls, end)) ? html.slice(ls, end) : '';
    return insertAt(html, end, tags, closingIndent + unit);
  }
  // No </head>: put them before <body>, after <html>, or at the very top.
  const body = /<body\b/i.exec(html);
  if (body) return insertAt(html, body.index, tags, null);
  const htmlOpen = /<html\b[^>]*>/i.exec(html);
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length;
    return `${html.slice(0, at)}\n${tags.join('\n')}${html.slice(at)}`;
  }
  return `${tags.join('\n')}\n${html}`;
}

function addToBody(html: string, tags: string[]): string {
  if (!tags.length) return html;
  const unit = indentUnit(html);
  const bodyOpen = /<body\b[^>]*>/i.exec(html);
  const end = closeTag(html, 'body');
  const from = bodyOpen ? bodyOpen.index + bodyOpen[0].length : Math.max(0, closeTag(html, 'head'));
  const stop = end >= 0 ? end : html.length;
  // Before the page's first own script, so it can use the library.
  const re = /<script\b[^>]*>/gi;
  re.lastIndex = from;
  for (let m = re.exec(html); m && m.index < stop; m = re.exec(html)) {
    if (!isLibTag(m[0])) return insertAt(html, m.index, tags, null);
  }
  if (end >= 0) {
    const ls = lineStart(html, end);
    const closingIndent = /^[ \t]*$/.test(html.slice(ls, end)) ? html.slice(ls, end) : '';
    return insertAt(html, end, tags, closingIndent + unit);
  }
  const close = /<\/html\s*>/i.exec(html);
  if (close) return insertAt(html, close.index, tags, null);
  return `${html}${html.endsWith('\n') || !html ? '' : '\n'}${tags.join('\n')}\n`;
}

/** Adds the library's tags that are not on the page yet. `prefix` leads from the page to the project root. */
export function addLibraryToHtml(html: string, lib: Library, prefix = ''): { html: string; changed: boolean } {
  const missing = lib.files.filter((f) => !hasFile(html, lib, f));
  if (!missing.length) return { html, changed: false };
  const css = missing.filter((f) => f.kind === 'css').map((f) => tagFor(lib, f, prefix));
  const headJs = missing.filter((f) => f.kind === 'js' && f.place === 'head').map((f) => tagFor(lib, f, prefix));
  const bodyJs = missing.filter((f) => f.kind === 'js' && f.place !== 'head').map((f) => tagFor(lib, f, prefix));
  let out = addToHead(html, css, true);
  out = addToHead(out, headJs, false);
  out = addToBody(out, bodyJs);
  return { html: out, changed: out !== html };
}

/** Removes the tags that point into `libs/<id>/` (whole lines when the tag is alone on its line). */
export function removeLibraryFromHtml(html: string, lib: Library): { html: string; changed: boolean } {
  const ref = String.raw`(?:href|src)\s*=\s*["']?(?:\.\.\/|\.\/|\/)*libs\/${lib.id}\/[^"'\s>]*["']?`;
  const link = String.raw`<link\b[^>]*${ref}[^>]*>`;
  const script = String.raw`<script\b[^>]*${ref}[^>]*>\s*<\/script\s*>`;
  let out = html;
  for (const tag of [link, script]) {
    out = out.replace(new RegExp(String.raw`^[ \t]*${tag}[ \t]*\r?\n`, 'gim'), '');
    out = out.replace(new RegExp(tag, 'gi'), '');
  }
  return { html: out, changed: out !== html };
}

/** Inserts an example snippet just before </body> (after the library scripts). No-op when it is already there. */
export function insertSnippet(html: string, snippet: string): { html: string; changed: boolean } {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  if (norm(html).includes(norm(snippet))) return { html, changed: false };
  const unit = indentUnit(html);
  const end = closeTag(html, 'body');
  const lines = snippet.split('\n');
  if (end < 0) return { html: `${html}${html.endsWith('\n') || !html ? '' : '\n'}${snippet}\n`, changed: true };
  const ls = lineStart(html, end);
  const closingIndent = /^[ \t]*$/.test(html.slice(ls, end)) ? html.slice(ls, end) : '';
  return { html: insertAt(html, end, lines, closingIndent + unit), changed: true };
}
