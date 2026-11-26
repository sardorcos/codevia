import type { Files, ProjectFile, ProjectMeta, Snapshot, SnapshotMeta } from '../core/types';
import { isQuotaError, StorageError, type Backend } from './backend';
import { t } from '../i18n';

const DB_NAME = 'codevia-pocket';
const DB_VERSION = 1;

type FileRow = { projectId: string; path: string; text: boolean; content?: string; data?: Uint8Array };
type BlobRow = { hash: string; text: boolean; content?: string; data?: Uint8Array };

const toFile = (r: { text: boolean; content?: string; data?: Uint8Array }): ProjectFile =>
  r.text ? { text: true, content: r.content ?? '' } : { text: false, data: r.data ?? new Uint8Array() };

function wrapError(e: unknown): StorageError {
  if (e instanceof StorageError) return e;
  if (isQuotaError(e)) return new StorageError(t('Недостаточно места для сохранения. Освободите память или экспортируйте проекты.'), true);
  return new StorageError(t('Ошибка хранилища: {error}', { error: String((e as Error)?.message ?? e) }));
}

export class IdbBackend implements Backend {
  readonly kind = 'idb' as const;
  private db!: IDBDatabase;

  constructor(private factory: IDBFactory = globalThis.indexedDB) {}

  async init(): Promise<void> {
    if (!this.factory) throw new StorageError(t('Хранилище браузера недоступно'));
    this.db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = this.factory.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('meta', { keyPath: 'id' });
        db.createObjectStore('files', { keyPath: ['projectId', 'path'] }).createIndex('projectId', 'projectId');
        db.createObjectStore('snapshots', { keyPath: ['projectId', 'id'] }).createIndex('projectId', 'projectId');
        db.createObjectStore('blobs', { keyPath: 'hash' });
        db.createObjectStore('kv', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(wrapError(req.error));
      req.onblocked = () => reject(new StorageError(t('Хранилище занято другой вкладкой')));
    });
    this.db.onversionchange = () => this.db.close();
  }

  /** Runs `fn` in a transaction and resolves only after the transaction commits (or rejects on abort/quota). */
  private tx<T>(stores: string[], mode: IDBTransactionMode, fn: (tx: IDBTransaction) => T | Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let tx: IDBTransaction;
      try {
        tx = this.db.transaction(stores, mode);
      } catch (e) {
        reject(wrapError(e));
        return;
      }
      let result: T;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(wrapError(tx.error ?? new Error(t('Транзакция прервана'))));
      tx.onerror = (ev) => {
        ev.preventDefault();
      };
      Promise.resolve(fn(tx)).then(
        (r) => {
          result = r;
        },
        (e) => {
          try {
            tx.abort();
          } catch {
            /* already finished */
          }
          reject(wrapError(e));
        },
      );
    });
  }

  private req<T>(r: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }

  listMeta(): Promise<ProjectMeta[]> {
    return this.tx(['meta'], 'readonly', (tx) => this.req(tx.objectStore('meta').getAll() as IDBRequest<ProjectMeta[]>));
  }

  putMeta(meta: ProjectMeta): Promise<void> {
    return this.tx(['meta'], 'readwrite', (tx) => void tx.objectStore('meta').put(meta));
  }

  deleteProject(meta: ProjectMeta): Promise<void> {
    return this.tx(['meta', 'files', 'snapshots'], 'readwrite', async (tx) => {
      tx.objectStore('meta').delete(meta.id);
      const range = IDBKeyRange.only(meta.id);
      for (const store of ['files', 'snapshots']) {
        const keys = await this.req(tx.objectStore(store).index('projectId').getAllKeys(range));
        for (const k of keys) tx.objectStore(store).delete(k);
      }
    });
  }

  readFiles(meta: ProjectMeta): Promise<Files> {
    return this.tx(['files'], 'readonly', async (tx) => {
      const rows = (await this.req(tx.objectStore('files').index('projectId').getAll(IDBKeyRange.only(meta.id)))) as FileRow[];
      const files: Files = {};
      for (const r of rows) files[r.path] = toFile(r);
      return files;
    });
  }

  writeFile(meta: ProjectMeta, path: string, file: ProjectFile): Promise<void> {
    const row: FileRow = file.text
      ? { projectId: meta.id, path, text: true, content: file.content }
      : { projectId: meta.id, path, text: false, data: file.data };
    return this.tx(['files'], 'readwrite', (tx) => void tx.objectStore('files').put(row));
  }

  deleteFile(meta: ProjectMeta, path: string): Promise<void> {
    return this.tx(['files'], 'readwrite', (tx) => void tx.objectStore('files').delete([meta.id, path]));
  }

  async listFolders(): Promise<string[]> {
    return [];
  }

  async renameFolder(): Promise<void> {
    /* folder names are cosmetic in IndexedDB */
  }

  putBlob(hash: string, file: ProjectFile): Promise<void> {
    const row: BlobRow = file.text ? { hash, text: true, content: file.content } : { hash, text: false, data: file.data };
    return this.tx(['blobs'], 'readwrite', (tx) => void tx.objectStore('blobs').put(row));
  }

  async hasBlob(hash: string): Promise<boolean> {
    const n = await this.tx(['blobs'], 'readonly', (tx) => this.req(tx.objectStore('blobs').count(hash)));
    return n > 0;
  }

  async getBlob(hash: string): Promise<ProjectFile | null> {
    const row = (await this.tx(['blobs'], 'readonly', (tx) => this.req(tx.objectStore('blobs').get(hash)))) as BlobRow | undefined;
    return row ? toFile(row) : null;
  }

  deleteBlob(hash: string): Promise<void> {
    return this.tx(['blobs'], 'readwrite', (tx) => void tx.objectStore('blobs').delete(hash));
  }

  async listBlobHashes(): Promise<string[]> {
    return (await this.tx(['blobs'], 'readonly', (tx) => this.req(tx.objectStore('blobs').getAllKeys()))) as string[];
  }

  async listSnapshots(projectId: string): Promise<SnapshotMeta[]> {
    const rows = (await this.tx(['snapshots'], 'readonly', (tx) =>
      this.req(tx.objectStore('snapshots').index('projectId').getAll(IDBKeyRange.only(projectId))),
    )) as Snapshot[];
    return rows.map(({ entries: _e, ...meta }) => meta).sort((a, b) => a.at.localeCompare(b.at));
  }

  async getSnapshot(projectId: string, id: string): Promise<Snapshot | null> {
    const row = await this.tx(['snapshots'], 'readonly', (tx) => this.req(tx.objectStore('snapshots').get([projectId, id])));
    return (row as Snapshot | undefined) ?? null;
  }

  putSnapshot(snapshot: Snapshot): Promise<void> {
    return this.tx(['snapshots'], 'readwrite', (tx) => void tx.objectStore('snapshots').put(snapshot));
  }

  deleteSnapshot(projectId: string, id: string): Promise<void> {
    return this.tx(['snapshots'], 'readwrite', (tx) => void tx.objectStore('snapshots').delete([projectId, id]));
  }

  async getSettings(): Promise<Record<string, unknown>> {
    const row = (await this.tx(['kv'], 'readonly', (tx) => this.req(tx.objectStore('kv').get('settings')))) as
      | { value: Record<string, unknown> }
      | undefined;
    return row?.value ?? {};
  }

  putSettings(settings: Record<string, unknown>): Promise<void> {
    return this.tx(['kv'], 'readwrite', (tx) => void tx.objectStore('kv').put({ key: 'settings', value: settings }));
  }
}
