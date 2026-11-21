import { describe, expect, it } from 'vitest';
import { guessLegacyEncoding } from '../../src/core/bytes';
import { toProjectFile } from '../../src/core/files';
import { normalizePath, safeFolderName, sanitizeImportName } from '../../src/core/paths';
import { textFile, type Files, type ProjectMeta } from '../../src/core/types';
import { MemoryBackend } from '../../src/storage/memory';
import { Repository } from '../../src/storage/repository';

/** Memory backend that also has "real" folders on disk, like the iOS Documents directory. */
class DiskLikeBackend extends MemoryBackend {
  disk = new Map<string, Files>();
  override async listFolders() {
    const metaFolders = (await this.listMeta()).map((m) => m.folder);
    return [...new Set([...this.disk.keys(), ...metaFolders])];
  }
  override async readFiles(m: ProjectMeta) {
    return this.disk.get(m.folder) ?? super.readFiles(m);
  }
}

describe('text decoding never corrupts files', () => {
  it('keeps valid UTF-8 (with BOM) as text, exactly', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('Привет')]);
    const f = toProjectFile('a.txt', bytes);
    expect(f.text).toBe(true);
    expect(new TextEncoder().encode((f as { content: string }).content)).toEqual(bytes);
  });
  it('keeps Windows-1251 and UTF-16 text as untouched binary', () => {
    const cp1251 = new Uint8Array([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]); // «Привет»
    const f = toProjectFile('index.php', cp1251);
    expect(f.text).toBe(false);
    expect((f as { data: Uint8Array }).data).toEqual(cp1251);
    expect(guessLegacyEncoding(cp1251)).toBe('windows-1251');
    expect(new TextDecoder('windows-1251').decode(cp1251)).toBe('Привет');
    expect(guessLegacyEncoding(new Uint8Array([0xff, 0xfe, 0x41, 0]))).toBe('utf-16le');
  });
  it('treats extension-less binaries as binary', () => {
    expect(toProjectFile('LICENSE', new Uint8Array([0, 1, 2, 255])).text).toBe(false);
    expect(toProjectFile('Makefile', new TextEncoder().encode('all:\n')).text).toBe(true);
  });
});

describe('names', () => {
  it('rejects Object.prototype names and ? #', () => {
    for (const bad of ['__proto__', 'a/constructor', 'toString', 'x?.js', 'a#b.css']) expect(() => normalizePath(bad)).toThrow();
    expect(sanitizeImportName('page?id=1#x.html')).toBe('page_id=1_x.html');
  });
  it('keeps # and % out of folder names', () => {
    expect(safeFolderName('Сайт #1 100%', [])).toBe('Сайт 1 100');
  });
});

describe('repository vs files that already exist on disk', () => {
  it('never reuses a folder that exists without metadata', async () => {
    const backend = new DiskLikeBackend();
    backend.disk.set('Мой сайт', { 'index.html': textFile('USER FILE') });
    const repo = new Repository(backend);
    await repo.init();
    const p = await repo.createProject('Мой сайт', 'web', { 'index.html': textFile('template') });
    expect(p.folder).toBe('Мой сайт (2)');
  });
  it('adopts orphan folders as projects', async () => {
    const backend = new DiskLikeBackend();
    backend.disk.set('Скрипты', { 'main.py': textFile('print(1)'), 'util.py': textFile('') });
    backend.disk.set('Inbox', { 'x.zip': textFile('') });
    const repo = new Repository(backend);
    await repo.init();
    expect(await repo.adoptOrphanFolders()).toBe(1);
    const [meta] = await repo.listProjects();
    expect(meta).toMatchObject({ name: 'Скрипты', folder: 'Скрипты', language: 'python', fileCount: 2 });
    expect(await repo.adoptOrphanFolders()).toBe(0);
  });
});

describe('repository write queue', () => {
  it('serialises snapshot creation and garbage collection (no dangling blobs)', async () => {
    const repo = new Repository(new MemoryBackend());
    await repo.init();
    const p = await repo.createProject('Q', 'web', { 'a.txt': textFile('same'), 'b.txt': textFile('other') });
    const v = await repo.createSnapshot(p, 'v1', 'manual');
    // Delete the only snapshot (triggers GC) while a new snapshot reuses the same blobs.
    await Promise.all([repo.deleteSnapshot(p.id, v.id), repo.createSnapshot(p, 'v2', 'manual')]);
    const [snap] = await repo.listSnapshots(p.id);
    p.files['a.txt'] = textFile('changed');
    await repo.restoreSnapshot(p, snap!.id); // throws if a blob had been collected
    expect((p.files['a.txt'] as { content: string }).content).toBe('same');
  });
  it('replaceFiles writes new content before deleting old files', async () => {
    const backend = new MemoryBackend();
    const order: string[] = [];
    const write = backend.writeFile.bind(backend);
    const del = backend.deleteFile.bind(backend);
    backend.writeFile = async (m, path, f) => (order.push(`w:${path}`), write(m, path, f));
    backend.deleteFile = async (m, path) => (order.push(`d:${path}`), del(m, path));
    const repo = new Repository(backend);
    await repo.init();
    const p = await repo.createProject('R', 'web', { 'old.txt': textFile('x') });
    order.length = 0;
    await repo.replaceFiles(p, { 'new.txt': textFile('y') });
    expect(order).toEqual(['w:new.txt', 'd:old.txt']);
  });
});
