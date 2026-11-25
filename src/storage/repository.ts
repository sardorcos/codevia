import { decodeUtf8, encodeUtf8, makeId, sha256, utf8Length } from '../core/bytes';
import { safeFolderName } from '../core/paths';
import { detectLanguage } from '../core/templates';
import {
  DEFAULT_SETTINGS,
  LIMITS,
  type Files,
  type Language,
  type Project,
  type ProjectFile,
  type ProjectMeta,
  type Settings,
  type Snapshot,
  type SnapshotKind,
  type SnapshotMeta,
} from '../core/types';
import { StorageError, withTimeout, type Backend } from './backend';
import { t } from '../i18n';

const WRITE_TIMEOUT = 20_000;
const now = () => new Date().toISOString();
/** Sizes of text files, remembered per file object and content (strings are immutable), so an
 *  autosave only measures the files that changed instead of re-encoding the whole project. */
const sizeCache = new WeakMap<ProjectFile, { content: string; size: number }>();
export function fileSize(f: ProjectFile): number {
  if (!f.text) return f.data.byteLength;
  const hit = sizeCache.get(f);
  if (hit && hit.content === f.content) return hit.size;
  const size = utf8Length(f.content);
  sizeCache.set(f, { content: f.content, size });
  return size;
}
export const filesSize = (files: Files) => Object.values(files).reduce((s, f) => s + fileSize(f), 0);

/** Converts a stored blob to the kind (text/binary) a snapshot entry expects. */
const asKind = (f: ProjectFile, text: boolean): ProjectFile =>
  f.text === text ? f : f.text ? { text: false, data: encodeUtf8(f.content) } : { text: true, content: decodeUtf8(f.data) };

/** Automatic versions younger than this are never pruned (a burst of deletions must stay undoable). */
const AUTO_KEEP_MS = 24 * 60 * 60 * 1000;
/** Hard cap on automatic versions per project, even within the protection window. */
const AUTO_HARD_CAP = 60;
/** Garbage collection reads every snapshot; run it at most this often, outside the save path. */
const GC_DELAY_MS = 30_000;
const metaOf = (p: Project): ProjectMeta => {
  const { files: _files, ...meta } = p;
  return meta;
};

/**
 * High-level project operations on top of a Backend: limits, metadata bookkeeping, history with
 * deduplication. Every mutating operation runs through one queue, so snapshot writes, garbage
 * collection, saves and deletes can never interleave (e.g. GC removing a blob a snapshot is reusing).
 */
export class Repository {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly backend: Backend) {}

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private guard<T>(p: Promise<T>): Promise<T> {
    return withTimeout(p, WRITE_TIMEOUT, t('Сохранение не завершилось вовремя. Проверьте свободное место.'));
  }

  async init(): Promise<void> {
    await this.backend.init();
  }

  async listProjects(): Promise<ProjectMeta[]> {
    const list = await this.backend.listMeta();
    return list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Folder names already taken: by projects and by anything else that exists on disk. */
  private async takenFolders(exceptId?: string): Promise<string[]> {
    const metas = (await this.backend.listMeta()).filter((m) => m.id !== exceptId).map((m) => m.folder);
    return [...metas, ...(await this.backend.listFolders())];
  }

  /**
   * Folders that appeared in Documents without metadata (copied in via the Files app, or whose
   * metadata was lost) become projects instead of being silently ignored or overwritten.
   */
  adoptOrphanFolders(): Promise<number> {
    return this.exclusive(async () => {
      const metas = await this.backend.listMeta();
      const known = new Set(metas.map((m) => m.folder.toLowerCase()));
      let adopted = 0;
      for (const folder of await this.backend.listFolders()) {
        if (known.has(folder.toLowerCase()) || folder.startsWith('.') || folder === 'Inbox') continue;
        if (metas.length + adopted >= LIMITS.maxProjects) break;
        const stamp = now();
        const probe: ProjectMeta = { id: makeId(), name: folder, language: 'web', createdAt: stamp, updatedAt: stamp, folder, fileCount: 0, size: 0, schema: 2 };
        const files = await this.backend.readFiles(probe);
        probe.language = detectLanguage(Object.keys(files));
        probe.fileCount = Object.keys(files).length;
        probe.size = filesSize(files);
        await this.guard(this.backend.putMeta(probe));
        adopted++;
      }
      return adopted;
    });
  }

  createProject(name: string, language: Language, files: Files): Promise<Project> {
    return this.exclusive(async () => {
      const existing = await this.backend.listMeta();
      if (existing.length >= LIMITS.maxProjects) throw new StorageError(t('Можно хранить не более {count} проектов', { count: LIMITS.maxProjects }));
      const size = filesSize(files);
      if (size > LIMITS.maxProjectBytes) throw new StorageError(t('Проект слишком большой'));
      if (Object.keys(files).length > LIMITS.maxFilesPerProject) throw new StorageError(t('В проекте слишком много файлов'));
      const stamp = now();
      const meta: ProjectMeta = {
        id: makeId(),
        name: name.trim().slice(0, 80) || t('Новый проект'),
        language,
        createdAt: stamp,
        updatedAt: stamp,
        folder: safeFolderName(name, await this.takenFolders()),
        fileCount: Object.keys(files).length,
        size,
        schema: 2,
      };
      try {
        for (const [path, f] of Object.entries(files)) await this.guard(this.backend.writeFile(meta, path, f));
        await this.guard(this.backend.putMeta(meta));
      } catch (e) {
        // The folder name was free on disk, so removing it cannot touch the user's own files.
        await this.backend.deleteProject(meta).catch(() => undefined);
        throw e;
      }
      return { ...meta, files };
    });
  }

  async openProject(meta: ProjectMeta): Promise<Project> {
    const files = await this.backend.readFiles(meta);
    const fresh = { ...meta, fileCount: Object.keys(files).length, size: filesSize(files) };
    if (fresh.fileCount !== meta.fileCount || fresh.size !== meta.size) {
      await this.exclusive(() => this.backend.putMeta(fresh)).catch(() => undefined);
    }
    return { ...fresh, files };
  }

  private async touch(project: Project): Promise<void> {
    project.updatedAt = now();
    project.fileCount = Object.keys(project.files).length;
    project.size = filesSize(project.files);
    await this.guard(this.backend.putMeta(metaOf(project)));
  }

  /** Persists the given files of `project` (one metadata update at the end). */
  saveFiles(project: Project, paths: string[]): Promise<void> {
    return this.exclusive(async () => {
      for (const path of paths) {
        const f = project.files[path];
        if (!f) continue;
        if (fileSize(f) > LIMITS.maxFileBytes) throw new StorageError(t('Файл {name} слишком большой для сохранения', { name: path }));
        await this.guard(this.backend.writeFile(project, path, f));
      }
      await this.touch(project);
    });
  }

  saveFile(project: Project, path: string): Promise<void> {
    return this.saveFiles(project, [path]);
  }

  async addFile(project: Project, path: string, file: ProjectFile): Promise<void> {
    if (Object.prototype.hasOwnProperty.call(project.files, path)) throw new StorageError(t('Такой файл уже существует'));
    if (Object.keys(project.files).length >= LIMITS.maxFilesPerProject) throw new StorageError(t('Достигнут лимит файлов'));
    project.files[path] = file;
    try {
      await this.saveFiles(project, [path]);
    } catch (e) {
      delete project.files[path];
      throw e;
    }
  }

  deleteFile(project: Project, path: string): Promise<void> {
    return this.exclusive(async () => {
      await this.guard(this.backend.deleteFile(project, path));
      delete project.files[path];
      await this.touch(project);
    });
  }

  renameFile(project: Project, from: string, to: string): Promise<void> {
    return this.exclusive(async () => {
      const f = project.files[from];
      if (!f) return;
      if (Object.prototype.hasOwnProperty.call(project.files, to)) throw new StorageError(t('Файл с таким именем уже существует'));
      await this.guard(this.backend.writeFile(project, to, f));
      await this.guard(this.backend.deleteFile(project, from));
      project.files[to] = f;
      delete project.files[from];
      await this.touch(project);
    });
  }

  renameProject(project: Project, name: string): Promise<void> {
    return this.exclusive(async () => {
      const clean = name.trim().slice(0, 80);
      if (!clean) throw new StorageError(t('Укажите название'));
      const oldFolder = project.folder;
      const folder = safeFolderName(clean, (await this.takenFolders(project.id)).filter((f) => f !== oldFolder));
      await this.guard(this.backend.renameFolder(project, folder));
      try {
        await this.guard(this.backend.putMeta({ ...metaOf(project), folder, name: clean, updatedAt: now() }));
      } catch (e) {
        // Keep folder and metadata consistent: move the folder back.
        await this.backend.renameFolder({ ...metaOf(project), folder }, oldFolder).catch(() => undefined);
        throw e;
      }
      project.folder = folder;
      project.name = clean;
      project.updatedAt = now();
    });
  }

  setEntry(project: Project, entry: string): Promise<void> {
    project.entry = entry;
    return this.exclusive(() => this.guard(this.backend.putMeta(metaOf(project))));
  }

  async duplicateProject(project: Project): Promise<Project> {
    const copy = await this.createProject(t('{name} (копия)', { name: project.name }), project.language, structuredClone(project.files));
    if (project.entry && copy.files[project.entry]) await this.setEntry(copy, project.entry);
    return copy;
  }

  deleteProject(meta: ProjectMeta): Promise<void> {
    return this.exclusive(async () => {
      await this.guard(this.backend.deleteProject(meta));
      await this.collectGarbageUnlocked();
    });
  }

  /** Replaces all files (restore / bulk import). Writes first, deletes after, so a failure never loses data. */
  replaceFiles(project: Project, files: Files): Promise<void> {
    return this.exclusive(() => this.replaceFilesUnlocked(project, files));
  }

  private async replaceFilesUnlocked(project: Project, files: Files): Promise<void> {
    for (const [path, f] of Object.entries(files)) {
      const old = project.files[path];
      if (!old || !sameFile(old, f)) await this.guard(this.backend.writeFile(project, path, f));
    }
    for (const path of Object.keys(project.files)) {
      if (!Object.prototype.hasOwnProperty.call(files, path)) await this.guard(this.backend.deleteFile(project, path));
    }
    project.files = files;
    await this.touch(project);
  }

  // ---------- history ----------

  listSnapshots(projectId: string): Promise<SnapshotMeta[]> {
    return this.backend.listSnapshots(projectId);
  }

  createSnapshot(project: Project, label: string, kind: SnapshotKind): Promise<SnapshotMeta> {
    return this.exclusive(() => this.createSnapshotUnlocked(project, label, kind));
  }

  private async createSnapshotUnlocked(project: Project, label: string, kind: SnapshotKind): Promise<SnapshotMeta> {
    const entries: Snapshot['entries'] = {};
    for (const [path, f] of Object.entries(project.files)) {
      const bytes = f.text ? encodeUtf8(f.content) : f.data;
      const hash = await sha256(bytes);
      if (!(await this.backend.hasBlob(hash))) await this.guard(this.backend.putBlob(hash, f));
      entries[path] = { hash, text: f.text, size: bytes.length };
    }
    const snapshot: Snapshot = { id: makeId(), projectId: project.id, at: now(), label, kind, fileCount: Object.keys(entries).length, entries };
    await this.guard(this.backend.putSnapshot(snapshot));
    await this.prune(project.id);
    const { entries: _e, ...meta } = snapshot;
    return meta;
  }

  restoreSnapshot(project: Project, snapshotId: string): Promise<void> {
    return this.exclusive(async () => {
      const snap = await this.backend.getSnapshot(project.id, snapshotId);
      if (!snap) throw new StorageError(t('Версия не найдена'));
      const files: Files = {};
      for (const [path, e] of Object.entries(snap.entries)) {
        const f = await this.backend.getBlob(e.hash, e.text);
        if (!f) throw new StorageError(t('Повреждена версия: нет данных для {name}', { name: path }));
        files[path] = asKind(f, e.text);
      }
      await this.createSnapshotUnlocked(project, t('Перед восстановлением «{name}»', { name: snap.label }), 'auto');
      await this.replaceFilesUnlocked(project, files);
    });
  }

  deleteSnapshot(projectId: string, id: string): Promise<void> {
    return this.exclusive(async () => {
      await this.backend.deleteSnapshot(projectId, id);
      await this.collectGarbageUnlocked();
    });
  }

  /**
   * Keeps the newest N manual versions, and automatic versions that are among the newest N or younger
   * than 24 hours (up to a hard cap). Manual and automatic versions never evict each other.
   */
  private async prune(projectId: string, nowMs = Date.now()): Promise<void> {
    const all = await this.backend.listSnapshots(projectId);
    const autos = all.filter((s) => s.kind === 'auto');
    const keepAuto = new Set(autos.slice(-LIMITS.maxAutoSnapshots).map((s) => s.id));
    for (const s of autos.slice(-AUTO_HARD_CAP)) if (nowMs - Date.parse(s.at) < AUTO_KEEP_MS) keepAuto.add(s.id);
    const drop = [...all.filter((s) => s.kind === 'manual').slice(0, -LIMITS.maxManualSnapshots), ...autos.filter((s) => !keepAuto.has(s.id))];
    for (const s of drop) await this.backend.deleteSnapshot(projectId, s.id);
    if (drop.length) this.scheduleGarbageCollection();
  }

  private gcTimer: ReturnType<typeof setTimeout> | undefined;

  /** Coalesces garbage collection into one idle run instead of one per version save. */
  private scheduleGarbageCollection(): void {
    if (this.gcTimer) return;
    this.gcTimer = setTimeout(() => {
      this.gcTimer = undefined;
      void this.collectGarbage().catch(() => undefined);
    }, GC_DELAY_MS);
  }

  collectGarbage(): Promise<void> {
    return this.exclusive(() => this.collectGarbageUnlocked());
  }

  /** Deletes content blobs no snapshot references any more. */
  private async collectGarbageUnlocked(): Promise<void> {
    const referenced = new Set<string>();
    for (const meta of await this.backend.listMeta()) {
      for (const s of await this.backend.listSnapshots(meta.id)) {
        const full = await this.backend.getSnapshot(meta.id, s.id);
        Object.values(full?.entries ?? {}).forEach((e) => referenced.add(e.hash));
      }
    }
    for (const hash of await this.backend.listBlobHashes()) {
      if (!referenced.has(hash)) await this.backend.deleteBlob(hash);
    }
  }

  // ---------- settings ----------

  async loadSettings(): Promise<Settings & Record<string, unknown>> {
    const raw = await this.backend.getSettings().catch(() => ({}));
    return { ...DEFAULT_SETTINGS, ...(raw as Partial<Settings>) };
  }

  saveSettings(s: Settings & Record<string, unknown>): Promise<void> {
    return this.exclusive(() => this.guard(this.backend.putSettings(s)));
  }
}

function sameFile(a: ProjectFile, b: ProjectFile): boolean {
  if (a.text !== b.text) return false;
  if (a.text) return a.content === (b as { content: string }).content;
  const x = a.data;
  const y = (b as { data: Uint8Array }).data;
  if (x.byteLength !== y.byteLength) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}
