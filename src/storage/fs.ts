import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { base64ToBytes, bytesToBase64 } from '../core/bytes';
import { isJunkPath, isTextPath } from '../core/paths';
import type { Files, ProjectFile, ProjectMeta, Snapshot, SnapshotMeta } from '../core/types';
import { isQuotaError, StorageError, type Backend } from './backend';

/**
 * Native storage. Project files live as real files in Documents/<folder> (visible in the Files app,
 * backed up with the device); metadata, history and settings live in Library/Codevia.
 */
const DOCS = Directory.Documents;
const LIB = Directory.Library;
const ROOT = 'Codevia';

const wrap = async <T>(p: Promise<T>): Promise<T> => {
  try {
    return await p;
  } catch (e) {
    if (isQuotaError(e)) throw new StorageError('На устройстве закончилось место. Освободите память и повторите.', true);
    throw new StorageError(`Ошибка файловой системы: ${(e as Error)?.message ?? e}`);
  }
};

async function readText(path: string, directory: Directory): Promise<string | null> {
  try {
    const r = await Filesystem.readFile({ path, directory, encoding: Encoding.UTF8 });
    return typeof r.data === 'string' ? r.data : await r.data.text();
  } catch {
    return null;
  }
}

async function readBinary(path: string, directory: Directory): Promise<Uint8Array | null> {
  try {
    const r = await Filesystem.readFile({ path, directory });
    if (typeof r.data === 'string') return base64ToBytes(r.data);
    return new Uint8Array(await r.data.arrayBuffer());
  } catch {
    return null;
  }
}

async function list(path: string, directory: Directory): Promise<Array<{ name: string; type: 'file' | 'directory' }>> {
  try {
    const r = await Filesystem.readdir({ path, directory });
    return r.files.map((f) => ({ name: f.name, type: f.type }));
  } catch {
    return [];
  }
}

const writeAny = async (path: string, directory: Directory, file: ProjectFile): Promise<void> => {
  await wrap<unknown>(
    file.text
      ? Filesystem.writeFile({ path, directory, data: file.content, encoding: Encoding.UTF8, recursive: true })
      : Filesystem.writeFile({ path, directory, data: bytesToBase64(file.data), recursive: true }),
  );
};

async function removeQuiet(path: string, directory: Directory, dir = false): Promise<void> {
  try {
    if (dir) await Filesystem.rmdir({ path, directory, recursive: true });
    else await Filesystem.deleteFile({ path, directory });
  } catch {
    /* already gone */
  }
}

export class FsBackend implements Backend {
  readonly kind = 'fs' as const;

  async init(): Promise<void> {
    for (const sub of ['meta', 'snapshots', 'blobs']) {
      try {
        await Filesystem.mkdir({ path: `${ROOT}/${sub}`, directory: LIB, recursive: true });
      } catch {
        /* exists */
      }
    }
  }

  async listMeta(): Promise<ProjectMeta[]> {
    const out: ProjectMeta[] = [];
    for (const f of await list(`${ROOT}/meta`, LIB)) {
      if (!f.name.endsWith('.json')) continue;
      const text = await readText(`${ROOT}/meta/${f.name}`, LIB);
      try {
        if (text) out.push(JSON.parse(text) as ProjectMeta);
      } catch {
        /* skip corrupt record, keep files on disk */
      }
    }
    return out;
  }

  putMeta(meta: ProjectMeta): Promise<void> {
    return writeAny(`${ROOT}/meta/${meta.id}.json`, LIB, { text: true, content: JSON.stringify(meta) });
  }

  async deleteProject(meta: ProjectMeta): Promise<void> {
    await removeQuiet(meta.folder, DOCS, true);
    await removeQuiet(`${ROOT}/snapshots/${meta.id}`, LIB, true);
    await removeQuiet(`${ROOT}/meta/${meta.id}.json`, LIB);
  }

  async readFiles(meta: ProjectMeta): Promise<Files> {
    const files: Files = {};
    const walk = async (rel: string): Promise<void> => {
      for (const entry of await list(rel ? `${meta.folder}/${rel}` : meta.folder, DOCS)) {
        const path = rel ? `${rel}/${entry.name}` : entry.name;
        if (isJunkPath(path)) continue;
        if (entry.type === 'directory') await walk(path);
        else if (isTextPath(path)) {
          const text = await readText(`${meta.folder}/${path}`, DOCS);
          if (text !== null) files[path] = { text: true, content: text };
        } else {
          const data = await readBinary(`${meta.folder}/${path}`, DOCS);
          if (data) files[path] = { text: false, data };
        }
      }
    };
    await walk('');
    return files;
  }

  writeFile(meta: ProjectMeta, path: string, file: ProjectFile): Promise<void> {
    return writeAny(`${meta.folder}/${path}`, DOCS, file);
  }

  async deleteFile(meta: ProjectMeta, path: string): Promise<void> {
    await removeQuiet(`${meta.folder}/${path}`, DOCS);
    // Remove now-empty parent folders so the Files app mirrors the project tree.
    const parts = path.split('/').slice(0, -1);
    while (parts.length) {
      const dir = `${meta.folder}/${parts.join('/')}`;
      if ((await list(dir, DOCS)).length) break;
      await removeQuiet(dir, DOCS, true);
      parts.pop();
    }
  }

  async renameFolder(meta: ProjectMeta, folder: string): Promise<void> {
    if (meta.folder === folder) return;
    await wrap(Filesystem.rename({ from: meta.folder, to: folder, directory: DOCS, toDirectory: DOCS }));
  }

  putBlob(hash: string, file: ProjectFile): Promise<void> {
    return writeAny(`${ROOT}/blobs/${hash}${file.text ? '.t' : '.b'}`, LIB, file);
  }

  async hasBlob(hash: string): Promise<boolean> {
    for (const suffix of ['.t', '.b']) {
      try {
        await Filesystem.stat({ path: `${ROOT}/blobs/${hash}${suffix}`, directory: LIB });
        return true;
      } catch {
        /* try next */
      }
    }
    return false;
  }

  async getBlob(hash: string, text: boolean): Promise<ProjectFile | null> {
    if (text) {
      const t = await readText(`${ROOT}/blobs/${hash}.t`, LIB);
      return t === null ? null : { text: true, content: t };
    }
    const b = await readBinary(`${ROOT}/blobs/${hash}.b`, LIB);
    return b ? { text: false, data: b } : null;
  }

  async deleteBlob(hash: string): Promise<void> {
    await removeQuiet(`${ROOT}/blobs/${hash}.t`, LIB);
    await removeQuiet(`${ROOT}/blobs/${hash}.b`, LIB);
  }

  async listBlobHashes(): Promise<string[]> {
    return (await list(`${ROOT}/blobs`, LIB)).map((f) => f.name.replace(/\.[tb]$/, ''));
  }

  async listSnapshots(projectId: string): Promise<SnapshotMeta[]> {
    const out: SnapshotMeta[] = [];
    for (const f of await list(`${ROOT}/snapshots/${projectId}`, LIB)) {
      const text = await readText(`${ROOT}/snapshots/${projectId}/${f.name}`, LIB);
      try {
        if (text) {
          const { entries: _e, ...meta } = JSON.parse(text) as Snapshot;
          out.push(meta);
        }
      } catch {
        /* skip */
      }
    }
    return out.sort((a, b) => a.at.localeCompare(b.at));
  }

  async getSnapshot(projectId: string, id: string): Promise<Snapshot | null> {
    const text = await readText(`${ROOT}/snapshots/${projectId}/${id}.json`, LIB);
    return text ? (JSON.parse(text) as Snapshot) : null;
  }

  putSnapshot(s: Snapshot): Promise<void> {
    return writeAny(`${ROOT}/snapshots/${s.projectId}/${s.id}.json`, LIB, { text: true, content: JSON.stringify(s) });
  }

  deleteSnapshot(projectId: string, id: string): Promise<void> {
    return removeQuiet(`${ROOT}/snapshots/${projectId}/${id}.json`, LIB);
  }

  async getSettings(): Promise<Record<string, unknown>> {
    const text = await readText(`${ROOT}/settings.json`, LIB);
    try {
      return text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  putSettings(settings: Record<string, unknown>): Promise<void> {
    return writeAny(`${ROOT}/settings.json`, LIB, { text: true, content: JSON.stringify(settings) });
  }
}
