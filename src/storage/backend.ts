import type { Files, ProjectFile, ProjectMeta, Settings, Snapshot, SnapshotMeta } from '../core/types';

/** Low-level persistence. Implementations: IndexedDB (web) and the native filesystem (iOS). */
export interface Backend {
  readonly kind: 'idb' | 'fs';
  init(): Promise<void>;
  listMeta(): Promise<ProjectMeta[]>;
  putMeta(meta: ProjectMeta): Promise<void>;
  deleteProject(meta: ProjectMeta): Promise<void>;
  readFiles(meta: ProjectMeta): Promise<Files>;
  writeFile(meta: ProjectMeta, path: string, file: ProjectFile): Promise<void>;
  deleteFile(meta: ProjectMeta, path: string): Promise<void>;
  /** Moves the project folder (filesystem only; IndexedDB ignores folder names). */
  renameFolder(meta: ProjectMeta, folder: string): Promise<void>;
  putBlob(hash: string, file: ProjectFile): Promise<void>;
  hasBlob(hash: string): Promise<boolean>;
  getBlob(hash: string, text: boolean): Promise<ProjectFile | null>;
  deleteBlob(hash: string): Promise<void>;
  listBlobHashes(): Promise<string[]>;
  listSnapshots(projectId: string): Promise<SnapshotMeta[]>;
  getSnapshot(projectId: string, id: string): Promise<Snapshot | null>;
  putSnapshot(snapshot: Snapshot): Promise<void>;
  deleteSnapshot(projectId: string, id: string): Promise<void>;
  getSettings(): Promise<Partial<Settings> & Record<string, unknown>>;
  putSettings(settings: Record<string, unknown>): Promise<void>;
}

export class StorageError extends Error {
  constructor(
    message: string,
    readonly quota = false,
  ) {
    super(message);
  }
}

export function isQuotaError(e: unknown): boolean {
  const name = (e as { name?: string })?.name ?? '';
  const msg = String((e as { message?: string })?.message ?? e);
  return name === 'QuotaExceededError' || /quota|no space|disk full|ENOSPC/i.test(msg);
}

export function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new StorageError(message)), ms);
    }),
  ]);
}
