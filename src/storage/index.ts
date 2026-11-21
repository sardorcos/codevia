import { Capacitor } from '@capacitor/core';
import { textFile, binaryFile, type Files, type Language } from '../core/types';
import type { Backend } from './backend';
import { FsBackend } from './fs';
import { IdbBackend } from './idb';
import { MemoryBackend } from './memory';
import { Repository } from './repository';

export interface StorageInit {
  repo: Repository;
  volatile: boolean;
  error?: string;
}

function chooseBackend(): Backend {
  const forced = new URLSearchParams(globalThis.location?.search ?? '').get('store');
  if (forced === 'memory') return new MemoryBackend();
  if (forced === 'fs' || Capacitor.isNativePlatform()) return new FsBackend();
  return new IdbBackend();
}

export async function openStorage(): Promise<StorageInit> {
  const backend = chooseBackend();
  const repo = new Repository(backend);
  try {
    await repo.init();
    if (backend instanceof MemoryBackend) return { repo, volatile: true, error: 'Включён временный режим хранения' };
    void navigator.storage?.persist?.().catch(() => undefined);
    return { repo, volatile: false };
  } catch (e) {
    const mem = new Repository(new MemoryBackend());
    await mem.init();
    return { repo: mem, volatile: true, error: (e as Error).message };
  }
}

// ---------- migration from the UI 0.3 prototype (single "app" record in IndexedDB "codevia-ui-0-3") ----------

type LegacyFile = { text: boolean; content?: string; data?: Uint8Array };
type LegacyProject = {
  name: string;
  language?: string;
  files: Record<string, LegacyFile>;
  history?: Array<{ label: string; files: Record<string, LegacyFile> }>;
};

/** Opens the legacy DB only if it already exists (never creates it). */
function readLegacyState(): Promise<{ projects?: LegacyProject[] } | null> {
  return new Promise((resolve) => {
    if (!globalThis.indexedDB) return resolve(null);
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open('codevia-ui-0-3');
    } catch {
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      req.transaction?.abort(); // DB did not exist: abort so it is not created
    };
    req.onerror = () => resolve(null);
    req.onsuccess = () => {
      const db = req.result;
      try {
        if (!db.objectStoreNames.contains('state')) {
          db.close();
          return resolve(null);
        }
        const get = db.transaction('state', 'readonly').objectStore('state').get('app');
        get.onsuccess = () => {
          db.close();
          resolve((get.result as { projects?: LegacyProject[] }) ?? null);
        };
        get.onerror = () => {
          db.close();
          resolve(null);
        };
      } catch {
        db.close();
        resolve(null);
      }
    };
  });
}

const toFiles = (legacy: Record<string, LegacyFile>): Files =>
  Object.fromEntries(
    Object.entries(legacy).map(([p, f]) => [p, f.text ? textFile(f.content ?? '') : binaryFile(new Uint8Array(f.data ?? []))]),
  );

/** Imports projects saved by the 0.3 prototype once. The legacy database is left untouched as a backup. */
export async function migrateLegacy(repo: Repository): Promise<number> {
  const settings = (await repo.backend.getSettings()) as Record<string, unknown>;
  if (settings.legacyMigrated) return 0;
  const state = await readLegacyState();
  let count = 0;
  for (const lp of state?.projects ?? []) {
    try {
      const lang: Language = lp.language === 'python' || lp.language === 'php' ? lp.language : 'web';
      const project = await repo.createProject(lp.name, lang, toFiles(lp.files));
      for (const h of lp.history ?? []) {
        const current = project.files;
        project.files = toFiles(h.files);
        await repo.createSnapshot(project, h.label || 'Версия из 0.3', 'manual');
        project.files = current;
      }
      count++;
    } catch {
      /* skip broken legacy project, continue with the rest */
    }
  }
  await repo.backend.putSettings({ ...settings, legacyMigrated: true });
  return count;
}
