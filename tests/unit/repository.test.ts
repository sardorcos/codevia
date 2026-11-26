import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { templateFiles } from '../../src/core/templates';
import { LIMITS, binaryFile, textFile, type Files } from '../../src/core/types';
import { IdbBackend } from '../../src/storage/idb';
import { MemoryBackend } from '../../src/storage/memory';
import { Repository } from '../../src/storage/repository';
import type { Backend } from '../../src/storage/backend';

const backends: Array<[string, () => Backend]> = [
  ['memory', () => new MemoryBackend()],
  ['indexeddb', () => new IdbBackend(new IDBFactory())],
];

describe.each(backends)('Repository on %s', (_name, make) => {
  const setup = async () => {
    const repo = new Repository(make());
    await repo.init();
    return repo;
  };

  it('creates, lists, opens and edits projects', async () => {
    const repo = await setup();
    const p = await repo.createProject('Сайт', 'web', templateFiles('web', 'Сайт'));
    expect((await repo.listProjects()).map((x) => x.name)).toEqual(['Сайт']);
    p.files['index.html'] = textFile('<h1>new</h1>');
    await repo.saveFile(p, 'index.html');
    const [meta] = await repo.listProjects();
    const reopened = await repo.openProject(meta!);
    expect((reopened.files['index.html'] as { content: string }).content).toBe('<h1>new</h1>');
    expect(reopened.fileCount).toBe(Object.keys(reopened.files).length);
  });

  it('renames, moves and deletes files', async () => {
    const repo = await setup();
    const p = await repo.createProject('P', 'python', templateFiles('python', 'P'));
    await repo.renameFile(p, 'calculations.py', 'lib/calc.py');
    await repo.deleteFile(p, 'README.md');
    const reopened = await repo.openProject((await repo.listProjects())[0]!);
    expect(Object.keys(reopened.files).sort()).toEqual(['data/orders.json', 'lib/calc.py', 'main.py']);
    await expect(repo.addFile(p, 'main.py', textFile(''))).rejects.toThrow(/существует/);
  });

  it('snapshots dedupe content, restore creates a safety version, GC removes unused blobs', async () => {
    const repo = await setup();
    const p = await repo.createProject('H', 'web', { 'a.txt': textFile('one'), 'b.txt': textFile('same') });
    const v1 = await repo.createSnapshot(p, 'v1', 'manual');
    p.files['a.txt'] = textFile('two');
    await repo.saveFile(p, 'a.txt');
    await repo.createSnapshot(p, 'v2', 'manual');
    expect((await repo.backend.listBlobHashes()).length).toBe(3); // one, two, same
    await repo.restoreSnapshot(p, v1.id);
    expect((p.files['a.txt'] as { content: string }).content).toBe('one');
    const snaps = await repo.listSnapshots(p.id);
    expect(snaps.map((s) => s.kind)).toEqual(['manual', 'manual', 'auto']);
    for (const s of snaps) await repo.deleteSnapshot(p.id, s.id);
    expect(await repo.backend.listBlobHashes()).toEqual([]);
  });

  it('automatic versions never evict manual ones', async () => {
    const repo = await setup();
    const p = await repo.createProject('L', 'web', { 'a.txt': textFile('x') });
    await repo.createSnapshot(p, 'manual', 'manual');
    for (let i = 0; i < LIMITS.maxAutoSnapshots + 3; i++) await repo.createSnapshot(p, `auto ${i}`, 'auto');
    const snaps = await repo.listSnapshots(p.id);
    expect(snaps.filter((s) => s.kind === 'manual').length).toBe(1);
    // All automatic versions are younger than 24 hours, so none is pruned yet (audit 3, R5).
    expect(snaps.filter((s) => s.kind === 'auto').length).toBe(LIMITS.maxAutoSnapshots + 3);
  });

  it('prunes automatic versions only after 24 hours, keeping the newest N', async () => {
    const repo = await setup();
    const p = await repo.createProject('Old', 'web', { 'a.txt': textFile('x') });
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      for (let i = 0; i < LIMITS.maxAutoSnapshots + 5; i++) await repo.createSnapshot(p, `old ${i}`, 'auto');
      vi.setSystemTime(new Date('2026-01-03T00:00:00Z'));
      await repo.createSnapshot(p, 'new', 'auto');
    } finally {
      vi.useRealTimers();
    }
    const autos = (await repo.listSnapshots(p.id)).filter((s) => s.kind === 'auto');
    expect(autos.length).toBe(LIMITS.maxAutoSnapshots);
    expect(autos.at(-1)?.label).toBe('new');
  });

  it('restores identical bytes stored once as binary and once as text (audit 3, R2)', async () => {
    const repo = await setup();
    const a = await repo.createProject('A', 'web', { '.gitkeep': binaryFile(new Uint8Array()) });
    await repo.createSnapshot(a, 'with gitkeep', 'manual');
    const b = await repo.createProject('B', 'python', { '__init__.py': textFile(''), 'main.py': textFile('print(1)') });
    const snap = await repo.createSnapshot(b, 'with init', 'manual');
    b.files['main.py'] = textFile('print(2)');
    await repo.saveFiles(b, ['main.py']);
    await repo.restoreSnapshot(b, snap.id);
    expect(b.files['__init__.py']).toEqual(textFile(''));
    expect(b.files['main.py']).toEqual(textFile('print(1)'));
  });

  it('enforces size limits and rolls back a failed project creation', async () => {
    const repo = await setup();
    const big: Files = { 'a.txt': textFile('x'.repeat(LIMITS.maxProjectBytes + 1)) };
    await expect(repo.createProject('Big', 'web', big)).rejects.toThrow(/слишком большой/);
    expect(await repo.listProjects()).toEqual([]);
  });

  it('deletes a project with its history', async () => {
    const repo = await setup();
    const p = await repo.createProject('D', 'web', { 'a.txt': textFile('x') });
    await repo.createSnapshot(p, 'v', 'manual');
    await repo.deleteProject(p);
    expect(await repo.listProjects()).toEqual([]);
    expect(await repo.listSnapshots(p.id)).toEqual([]);
    expect(await repo.backend.listBlobHashes()).toEqual([]);
  });

  it('persists settings', async () => {
    const repo = await setup();
    const s = await repo.loadSettings();
    s.editorFont = 18;
    await repo.saveSettings(s);
    expect((await repo.loadSettings()).editorFont).toBe(18);
  });
});

describe('IndexedDB failure handling', () => {
  it('rejects (instead of hanging) when a transaction aborts with QuotaExceededError', async () => {
    const backend = new IdbBackend(new IDBFactory());
    await backend.init();
    // Simulate the browser aborting the commit because storage is full.
    const db = (backend as unknown as { db: IDBDatabase }).db;
    const original = db.transaction.bind(db);
    (db as unknown as { transaction: typeof db.transaction }).transaction = ((stores: string[], mode: IDBTransactionMode) => {
      const tx = original(stores, mode);
      if (mode === 'readwrite') {
        queueMicrotask(() => {
          Object.defineProperty(tx, 'error', { value: new DOMException('full', 'QuotaExceededError') });
          tx.abort();
        });
      }
      return tx;
    }) as typeof db.transaction;
    const repo = new Repository(backend);
    await expect(repo.createProject('Q', 'web', { 'a.txt': textFile('x') })).rejects.toMatchObject({ quota: true });
  });
});
