import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { templateFiles } from '../../src/core/templates';
import { LIMITS, textFile, type Files } from '../../src/core/types';
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
    expect(snaps.filter((s) => s.kind === 'auto').length).toBe(LIMITS.maxAutoSnapshots);
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
