import type { Files, ProjectFile, ProjectMeta, Snapshot, SnapshotMeta } from '../core/types';
import type { Backend } from './backend';

/** Volatile backend used when no persistent storage is available (the UI then warns that nothing is saved). */
export class MemoryBackend implements Backend {
  readonly kind = 'idb' as const;
  readonly volatile = true;
  private meta = new Map<string, ProjectMeta>();
  private files = new Map<string, Files>();
  private snaps = new Map<string, Map<string, Snapshot>>();
  private blobs = new Map<string, ProjectFile>();
  private settings: Record<string, unknown> = {};

  async init() {}
  async listMeta() {
    return [...this.meta.values()].map((m) => ({ ...m }));
  }
  async putMeta(m: ProjectMeta) {
    this.meta.set(m.id, { ...m });
  }
  async deleteProject(m: ProjectMeta) {
    this.meta.delete(m.id);
    this.files.delete(m.id);
    this.snaps.delete(m.id);
  }
  async readFiles(m: ProjectMeta) {
    return structuredClone(this.files.get(m.id) ?? {});
  }
  async writeFile(m: ProjectMeta, path: string, f: ProjectFile) {
    const files = this.files.get(m.id) ?? {};
    files[path] = structuredClone(f);
    this.files.set(m.id, files);
  }
  async deleteFile(m: ProjectMeta, path: string) {
    delete this.files.get(m.id)?.[path];
  }
  async listFolders(): Promise<string[]> {
    return [];
  }

  async renameFolder() {}
  async putBlob(h: string, f: ProjectFile) {
    this.blobs.set(h, structuredClone(f));
  }
  async hasBlob(h: string) {
    return this.blobs.has(h);
  }
  async getBlob(h: string) {
    const b = this.blobs.get(h);
    return b ? structuredClone(b) : null;
  }
  async deleteBlob(h: string) {
    this.blobs.delete(h);
  }
  async listBlobHashes() {
    return [...this.blobs.keys()];
  }
  async listSnapshots(pid: string): Promise<SnapshotMeta[]> {
    return [...(this.snaps.get(pid)?.values() ?? [])]
      .map(({ entries: _e, ...m }) => m)
      .sort((a, b) => a.at.localeCompare(b.at));
  }
  async getSnapshot(pid: string, id: string) {
    return structuredClone(this.snaps.get(pid)?.get(id) ?? null);
  }
  async putSnapshot(s: Snapshot) {
    const m = this.snaps.get(s.projectId) ?? new Map();
    m.set(s.id, structuredClone(s));
    this.snaps.set(s.projectId, m);
  }
  async deleteSnapshot(pid: string, id: string) {
    this.snaps.get(pid)?.delete(id);
  }
  async getSettings() {
    return { ...this.settings };
  }
  async putSettings(s: Record<string, unknown>) {
    this.settings = { ...s };
  }
}
