import { t } from '../i18n';
const TEXT_EXT = new Set([
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'json', 'py', 'php', 'phtml',
  'md', 'markdown', 'txt', 'yaml', 'yml', 'toml', 'xml', 'svg', 'sh', 'ini', 'env', 'gitignore', 'htaccess', 'csv',
  'sql', 'vue', 'svelte', 'map', 'webmanifest', 'conf', 'log', 'tsv', 'lock', 'editorconfig', 'prettierrc', 'twig',
]);

export const basename = (p: string): string => (p || '').split('/').pop() ?? '';
export const dirname = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
export const extOf = (p: string): string => {
  const name = basename(p);
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
};

export function isTextPath(p: string): boolean {
  const ext = extOf(p);
  if (!ext) return true;
  return TEXT_EXT.has(ext);
}

export type FileKind = 'html' | 'css' | 'js' | 'php' | 'py' | 'json' | 'md' | 'image' | 'font' | 'other';

export function fileKind(p: string): FileKind {
  const ext = extOf(p);
  if (['html', 'htm'].includes(ext)) return 'html';
  if (['css', 'scss', 'sass', 'less'].includes(ext)) return 'css';
  if (['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx'].includes(ext)) return 'js';
  if (['php', 'phtml'].includes(ext)) return 'php';
  if (ext === 'py') return 'py';
  if (['json', 'webmanifest', 'map'].includes(ext)) return 'json';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico', 'bmp'].includes(ext)) return 'image';
  if (['woff', 'woff2', 'ttf', 'otf', 'eot'].includes(ext)) return 'font';
  if (isTextPath(p)) return 'md';
  return 'other';
}

const MIME: Record<string, string> = {
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript',
  cjs: 'text/javascript', json: 'application/json', webmanifest: 'application/manifest+json', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  ico: 'image/x-icon', bmp: 'image/bmp', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm', txt: 'text/plain',
  md: 'text/markdown', csv: 'text/csv', xml: 'application/xml', pdf: 'application/pdf', wasm: 'application/wasm',
};
export const mimeOf = (p: string): string => MIME[extOf(p)] ?? (isTextPath(p) ? 'text/plain' : 'application/octet-stream');

const MAX_PATH = 400;
/** Names that collide with Object.prototype members and would break plain-object lookups. */
const RESERVED = new Set(Object.getOwnPropertyNames(Object.prototype));

/** Makes an archive/picker name acceptable to normalizePath without losing the file. */
export const sanitizeImportName = (name: string): string => name.replace(/[?#]/g, '_');
const MAX_SEGMENT = 200;

/**
 * Normalises a user- or archive-supplied relative path. Rejects absolute paths, traversal,
 * empty segments, control characters and overly long names.
 */
export function normalizePath(source: unknown): string {
  const raw = String(source ?? '').trim().replace(/\\/g, '/');
  if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) throw new Error(t('Недопустимый абсолютный путь'));
  const path = raw.replace(/^(\.\/)+/, '');
  if (!path) throw new Error(t('Укажите имя файла'));
  if (/[\u0000-\u001f\u007f]/.test(path)) throw new Error(t('Имя файла содержит недопустимые символы'));
  const parts = path.split('/');
  if (parts.some((x) => x === '..' || x === '.' || !x)) throw new Error(t('Недопустимый путь файла'));
  if (/[?#]/.test(path)) throw new Error(t('Символы «?» и «#» в именах файлов не поддерживаются'));
  if (parts.some((x) => RESERVED.has(x))) throw new Error(t('Это имя зарезервировано, выберите другое'));
  if (path.length > MAX_PATH || parts.some((x) => x.length > MAX_SEGMENT)) throw new Error(t('Слишком длинное имя файла'));
  return path;
}

/** Resolves `ref` relative to the file at `fromPath`. Returns null when it escapes the project root. */
export function resolveRelative(fromPath: string, ref: string): string | null {
  let target = ref.split(/[?#]/)[0] ?? '';
  try {
    target = decodeURIComponent(target);
  } catch {
    /* keep raw */
  }
  if (!target) return null;
  const parts = target.startsWith('/') ? [] : dirname(fromPath).split('/').filter(Boolean);
  for (const seg of target.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/') || null;
}

/** True for references that point outside the project (network, data URIs, anchors, etc.). */
export const isExternalRef = (ref: string): boolean =>
  /^(#|[a-z][a-z0-9+.-]*:|\/\/)/i.test(ref.trim());

/** macOS/Windows archive junk that should never become project files. */
export function isJunkPath(p: string): boolean {
  const parts = p.split('/');
  const name = parts[parts.length - 1] ?? '';
  return (
    parts.includes('__MACOSX') ||
    name === '.DS_Store' ||
    name === 'Thumbs.db' ||
    name === 'desktop.ini' ||
    name.startsWith('._')
  );
}

/** Returns a path not present in `taken` (case-insensitive), e.g. `logo (2).png`. */
export function uniquePath(path: string, taken: Iterable<string>): string {
  const lower = new Set([...taken].map((x) => x.toLowerCase()));
  if (!lower.has(path.toLowerCase())) return path;
  const dir = dirname(path);
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; ; i++) {
    const candidate = `${dir ? dir + '/' : ''}${stem} (${i})${ext}`;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
}

/** Makes a folder name that is safe for iOS Files and unique among `taken`. */
export function safeFolderName(name: string, taken: Iterable<string>): string {
  const cleaned =
    name
      .replace(/[/\\:*?"<>|#%\u0000-\u001f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s]+|[.\s]+$/g, '')
      .slice(0, 80) || t('Проект');
  return uniquePath(cleaned, taken);
}
