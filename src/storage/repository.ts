import { encodeUtf8, makeId, sha256 } from '../core/bytes';
import { safeFolderName } from '../core/paths';
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

const WRITE_TIMEOUT = 20_000;
const now = () => new Date().toISOString();
const fileSize = (f: ProjectFile) => (f.text ? encodeUtf8(f.content).length : f.data.byteLength);
export const filesSize = (files: Files) => Object.values(files).reduce((s, f) => s + fileSize(f), 0);

/** High-level project operations on top of a Backend: limits, metadata bookkeeping, history with deduplication. */
export class Repository {
  constructor(readonly backend: Backend) {}

  private guard<T>(p: Promise<T>): Promise<T> {
    return withTimeout(p, WRITE_TIMEOUT, 'Сохранение не завершилось вовремя. Проверьте свободное место.');
  }

  async init(): Promise<void> {
    await this.backend.init();
  }

  async listProjects(): Promise<ProjectMeta[]> {
    const list = await this.backend.listMeta();
    return list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async createProject(name: string, language: Language, files: Files): Promise<Project> {
    const existing = await this.backend.listMeta();
    if (existing.length >= LIMITS.maxProjects) throw new StorageError(`Можно хранить не более ${LIMITS.maxProjects} проектов`);
    const size = filesSize(files);
    if (size > LIMITS.maxProjectBytes) throw new StorageError('Проект слишком большой');
    if (Object.keys(files).length > LIMITS.maxFilesPerProject) throw new StorageError('В проекте слишком много файлов');
    const stamp = now();
    const meta: ProjectMeta = {
      id: makeId(),
      name: name.trim().slice(0, 80) || 'Новый проект',
      language,
      createdAt: stamp,
      updatedAt: stamp,
      folder: safeFolderName(name, existing.map((m) => m.folder)),
      fileCount: Object.keys(files).length,
      size,
      schema: 2,
    };
    try {
      for (const [path, f] of Object.entries(files)) await this.guard(this.backend.writeFile(meta, path, f));
      await this.guard(this.backend.putMeta(meta));
    } catch (e) {
      await this.backend.deleteProject(meta).catch(() => undefined);
      throw e;
    }
    return { ...meta, files };
  }

  async openProject(meta: ProjectMeta): Promise<Project> {
    const files = await this.backend.readFiles(meta);
    const fresh = { ...meta, fileCount: Object.keys(files).length, size: filesSize(files) };
    if (fresh.fileCount !== meta.fileCount || fresh.size !== meta.size) await this.backend.putMeta(fresh).catch(() => undefined);
    return { ...fresh, files };
  }

  private async touch(project: Project): Promise<void> {
    project.updatedAt = now();
    project.fileCount = Object.keys(project.files).length;
    project.size = filesSize(project.files);
    const { files: _files, ...meta } = project;
    await this.guard(this.backend.putMeta(meta));
  }

  async saveFile(project: Project, path: string): Promise<void> {
    const f = project.files[path];
    if (!f) return;
    if (fileSize(f) > LIMITS.maxFileBytes) throw new StorageError('Файл слишком большой для сохранения');
    await this.guard(this.backend.writeFile(project, path, f));
    await this.touch(project);
  }

  async addFile(project: Project, path: string, file: ProjectFile): Promise<void> {
    if (project.files[path]) throw new StorageError('Такой файл уже существует');
    if (Object.keys(project.files).length >= LIMITS.maxFilesPerProject) throw new StorageError('Достигнут лимит файлов');
    project.files[path] = file;
    try {
      await this.saveFile(project, path);
    } catch (e) {
      delete project.files[path];
      throw e;
    }
  }

  async deleteFile(project: Project, path: string): Promise<void> {
    await this.guard(this.backend.deleteFile(project, path));
    delete project.files[path];
    await this.touch(project);
  }

  async renameFile(project: Project, from: string, to: string): Promise<void> {
    const f = project.files[from];
    if (!f) return;
    if (project.files[to]) throw new StorageError('Файл с таким именем уже существует');
    await this.guard(this.backend.writeFile(project, to, f));
    await this.guard(this.backend.deleteFile(project, from));
    project.files[to] = f;
    delete project.files[from];
    await this.touch(project);
  }

  async renameProject(project: Project, name: string): Promise<void> {
    const clean = name.trim().slice(0, 80);
    if (!clean) throw new StorageError('Укажите название');
    const others = (await this.backend.listMeta()).filter((m) => m.id !== project.id).map((m) => m.folder);
    const folder = safeFolderName(clean, others);
    await this.guard(this.backend.renameFolder(project, folder));
    project.folder = folder;
    project.name = clean;
    await this.touch(project);
  }

  async setEntry(project: Project, entry: string): Promise<void> {
    project.entry = entry;
    const { files: _files, ...meta } = project;
    await this.guard(this.backend.putMeta(meta));
  }

  async duplicateProject(project: Project): Promise<Project> {
    return this.createProject(`${project.name} (копия)`, project.language, structuredClone(project.files));
  }

  async deleteProject(meta: ProjectMeta): Promise<void> {
    await this.guard(this.backend.deleteProject(meta));
    await this.collectGarbage();
  }

  /** Replaces all files (restore / bulk import) writing only what changed. */
  async replaceFiles(project: Project, files: Files): Promise<void> {
    for (const path of Object.keys(project.files)) {
      if (!files[path]) await this.guard(this.backend.deleteFile(project, path));
    }
    for (const [path, f] of Object.entries(files)) {
      const old = project.files[path];
      const same =
        old && old.text === f.text && (f.text ? (old as { content: string }).content === f.content : sameBytes((old as { data: Uint8Array }).data, f.data));
      if (!same) await this.guard(this.backend.writeFile(project, path, f));
    }
    project.files = files;
    await this.touch(project);
  }

  // ---------- history ----------

  listSnapshots(projectId: string): Promise<SnapshotMeta[]> {
    return this.backend.listSnapshots(projectId);
  }

  async createSnapshot(project: Project, label: string, kind: SnapshotKind): Promise<SnapshotMeta> {
    const entries: Snapshot['entries'] = {};
    for (const [path, f] of Object.entries(project.files)) {
      const bytes = f.text ? encodeUtf8(f.content) : f.data;
      const hash = await sha256(bytes);
      if (!(await this.backend.hasBlob(hash))) await this.guard(this.backend.putBlob(hash, f));
      entries[path] = { hash, text: f.text, size: bytes.length };
    }
    const snapshot: Snapshot = {
      id: makeId(),
      projectId: project.id,
      at: now(),
      label,
      kind,
      fileCount: Object.keys(entries).length,
      entries,
    };
    await this.guard(this.backend.putSnapshot(snapshot));
    await this.prune(project.id);
    const { entries: _e, ...meta } = snapshot;
    return meta;
  }

  async restoreSnapshot(project: Project, snapshotId: string): Promise<void> {
    const snap = await this.backend.getSnapshot(project.id, snapshotId);
    if (!snap) throw new StorageError('Версия не найдена');
    const files: Files = {};
    for (const [path, e] of Object.entries(snap.entries)) {
      const f = await this.backend.getBlob(e.hash, e.text);
      if (!f) throw new StorageError(`Повреждена версия: нет данных для ${path}`);
      files[path] = f;
    }
    await this.createSnapshot(project, `Перед восстановлением «${snap.label}»`, 'auto');
    await this.replaceFiles(project, files);
  }

  async deleteSnapshot(projectId: string, id: string): Promise<void> {
    await this.backend.deleteSnapshot(projectId, id);
    await this.collectGarbage();
  }

  /** Keeps the newest N manual and N automatic versions independently, so autosaves never evict manual ones. */
  private async prune(projectId: string): Promise<void> {
    const all = await this.backend.listSnapshots(projectId);
    const drop = [
      ...all.filter((s) => s.kind === 'manual').slice(0, -LIMITS.maxManualSnapshots),
      ...all.filter((s) => s.kind === 'auto').slice(0, -LIMITS.maxAutoSnapshots),
    ];
    for (const s of drop) await this.backend.deleteSnapshot(projectId, s.id);
    if (drop.length) await this.collectGarbage();
  }

  /** Deletes content blobs no snapshot references any more. */
  async collectGarbage(): Promise<void> {
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

  async saveSettings(s: Settings & Record<string, unknown>): Promise<void> {
    await this.guard(this.backend.putSettings(s));
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
