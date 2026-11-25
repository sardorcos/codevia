import { crc32, decodeZipName, encodeUtf8 } from './bytes';
import { toProjectFile } from './files';
import { isJunkPath, normalizePath, sanitizeImportName, uniquePath } from './paths';
import { type Files, LIMITS } from './types';
import { t } from '../i18n';

export interface UnzipOptions {
  maxEntries?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

export interface UnzipResult {
  files: Files;
  skipped: string[];
  renamed: Array<{ from: string; to: string }>;
}

export class ZipError extends Error {}

/** Inflates raw-deflate data, aborting as soon as output exceeds `limit` bytes (zip-bomb guard). */
export async function inflateRawLimited(data: Uint8Array, limit: number): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') throw new ZipError(t('Это устройство не поддерживает распаковку Deflate'));
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new ZipError(t('Файл в архиве больше, чем указано в заголовке (возможна ZIP-бомба)'));
      }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof ZipError) throw e;
    throw new ZipError(t('Не удалось распаковать данные архива'));
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

export async function unzip(bytes: Uint8Array, opts: UnzipOptions = {}): Promise<UnzipResult> {
  const maxEntries = opts.maxEntries ?? LIMITS.maxFilesPerProject;
  const maxFile = opts.maxFileBytes ?? LIMITS.maxFileBytes;
  const maxTotal = opts.maxTotalBytes ?? LIMITS.maxProjectBytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new ZipError(t('Это не ZIP-архив или он повреждён'));
  const count = view.getUint16(end + 10, true);
  const dirOffset = view.getUint32(end + 16, true);
  if (count === 0xffff || dirOffset === 0xffffffff) throw new ZipError(t('Архивы ZIP64 (больше 4 ГБ) не поддерживаются'));
  if (count > maxEntries) throw new ZipError(t('В архиве больше {count} файлов', { count: maxEntries }));

  const files: Files = {};
  const skipped: string[] = [];
  const renamed: Array<{ from: string; to: string }> = [];
  let pos = dirOffset;
  let total = 0;
  for (let idx = 0; idx < count; idx++) {
    if (pos + 46 > bytes.length || view.getUint32(pos, true) !== 0x02014b50) throw new ZipError(t('Повреждён каталог ZIP'));
    const flags = view.getUint16(pos + 8, true);
    const method = view.getUint16(pos + 10, true);
    const crc = view.getUint32(pos + 16, true);
    const packed = view.getUint32(pos + 20, true);
    const plain = view.getUint32(pos + 24, true);
    const nameSize = view.getUint16(pos + 28, true);
    const extraSize = view.getUint16(pos + 30, true);
    const commentSize = view.getUint16(pos + 32, true);
    const externalAttr = view.getUint32(pos + 38, true);
    const localOffset = view.getUint32(pos + 42, true);
    if (pos + 46 + nameSize > bytes.length) throw new ZipError(t('Повреждён каталог ZIP'));
    const rawName = decodeZipName(bytes.subarray(pos + 46, pos + 46 + nameSize), (flags & 0x800) !== 0);
    pos += 46 + nameSize + extraSize + commentSize;

    const name = rawName.replace(/\\/g, '/');
    if (name.endsWith('/')) continue;
    if (isJunkPath(name)) {
      skipped.push(name);
      continue;
    }
    // Unix symlinks (S_IFLNK) are never materialised.
    if (((externalAttr >>> 16) & 0o170000) === 0o120000) {
      skipped.push(name);
      continue;
    }
    if (flags & 1) throw new ZipError(t('Зашифрованные ZIP-архивы не поддерживаются'));
    let safe: string;
    try {
      safe = normalizePath(sanitizeImportName(name));
    } catch {
      throw new ZipError(t('В архиве небезопасный путь: {name}', { name }));
    }
    if (plain > maxFile) throw new ZipError(t('Файл {name} слишком большой', { name: safe }));
    if (total + plain > maxTotal) throw new ZipError(t('Архив слишком большой после распаковки'));
    if (method !== 0 && method !== 8) throw new ZipError(t('Неподдерживаемый метод сжатия в {name}', { name: safe }));
    if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new ZipError(t('Повреждён заголовок файла в ZIP'));
    }
    const start = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    if (start + packed > bytes.length) throw new ZipError(t('Данные ZIP обрезаны'));
    const packedBytes = bytes.subarray(start, start + packed);
    const content = method === 8 ? await inflateRawLimited(packedBytes, plain) : packedBytes.slice();
    if (content.length !== plain || crc32(content) !== crc) throw new ZipError(t('Неверная контрольная сумма: {name}', { name: safe }));
    total += plain;

    const finalPath = uniquePath(safe, Object.keys(files));
    if (finalPath !== safe) renamed.push({ from: safe, to: finalPath });
    files[finalPath] = toProjectFile(finalPath, content);
  }
  return { files, skipped, renamed };
}

/** Strips one shared top-level folder (e.g. `site/index.html` → `index.html`), the common GitHub/Finder layout. */
export function stripCommonRoot(files: Files): { files: Files; root: string | null } {
  const paths = Object.keys(files);
  if (!paths.length) return { files, root: null };
  const first = paths[0]!.split('/')[0]!;
  if (!paths.every((p) => p.includes('/') && p.split('/')[0] === first)) return { files, root: null };
  const out: Files = {};
  for (const p of paths) out[p.slice(first.length + 1)] = files[p]!;
  return { files: out, root: first };
}

function dosDateTime(date: Date): { date: number; time: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
  };
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined' || data.length < 64) return null;
  try {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

/** Builds a ZIP with UTF-8 names; entries are deflated when that makes them smaller. */
export async function zipFiles(files: Files, now = new Date()): Promise<Blob> {
  const parts: BlobPart[] = [];
  const central: Uint8Array[] = [];
  const { date, time } = dosDateTime(now);
  let offset = 0;
  let count = 0;
  for (const [path, f] of Object.entries(files)) {
    const name = encodeUtf8(normalizePath(path));
    const data = f.text ? encodeUtf8(f.content) : f.data;
    if (data.byteLength > 0xfffffffe) throw new ZipError(t('Файл {name} слишком большой для ZIP', { name: path }));
    const check = crc32(data);
    const deflated = await deflateRaw(data);
    const useDeflate = deflated !== null && deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x800, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, check, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    parts.push(local as BlobPart, body as BlobPart);

    const c = new Uint8Array(46 + name.length);
    const cv = new DataView(c.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 0x0314, true); // made by: Unix, spec 2.0
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x800, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, check, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(38, (0o100644 << 16) >>> 0, true);
    cv.setUint32(42, offset, true);
    c.set(name, 46);
    central.push(c);
    offset += local.length + body.length;
    if (++count > 0xfffe) throw new ZipError(t('Слишком много файлов для ZIP'));
  }
  const centralSize = central.reduce((s, x) => s + x.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, count, true);
  ev.setUint16(10, count, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  return new Blob([...parts, ...(central as BlobPart[]), eocd as BlobPart], { type: 'application/zip' });
}
