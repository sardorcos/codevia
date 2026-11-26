/**
 * View-models of the source-control panel (no DOM, no network): the changes list with selection and
 * the secret gate, the conflict choices of a pull, and the top-bar badge.
 */
import type { Project } from '../../core/types';
import { ShaCache, status, type ConflictResolution, type PullConflict, type PullPlan, type PushChange, type PushPlan } from '../../github/sync';
import type { SecretReason } from '../../github/secrets';

export type ChangeStatus = PushChange['status'];

export interface ChangeItem {
  path: string;
  status: ChangeStatus;
  secret?: SecretReason;
  selected: boolean;
}

export type PushBlock = 'nothing_selected' | 'secrets_unconfirmed';

/**
 * The commit screen's list: changes grouped Modified / Added / Deleted, each with a checkbox.
 * Files that look like secrets start unchecked; when any of them is checked, pushing stays blocked
 * until the user confirms explicitly. Selection carries over when the list is rebuilt.
 */
export class ChangesModel {
  readonly items: ChangeItem[];
  readonly ignored: string[];
  private readonly byPath = new Map<string, PushChange>();
  private confirmed = false;

  constructor(plan: PushPlan, previous?: ChangesModel | null) {
    this.ignored = [...plan.ignored].sort();
    this.items = plan.changes.map((c) => {
      this.byPath.set(c.path, c);
      const prev = previous?.item(c.path);
      const selected = prev && prev.status === c.status && prev.secret === c.secret ? prev.selected : !c.secret;
      const item: ChangeItem = { path: c.path, status: c.status, selected };
      if (c.secret) item.secret = c.secret;
      return item;
    });
    // A confirmation covers exactly the secret files it was given for.
    if (previous?.confirmed) {
      const before = new Set(previous.selectedSecrets().map((i) => i.path));
      const now = this.selectedSecrets().map((i) => i.path);
      this.confirmed = now.length > 0 && now.every((p) => before.has(p));
    }
  }

  item(path: string): ChangeItem | undefined {
    return this.items.find((i) => i.path === path);
  }

  groups(): { modified: ChangeItem[]; added: ChangeItem[]; deleted: ChangeItem[] } {
    const pick = (s: ChangeStatus) => this.items.filter((i) => i.status === s);
    return { modified: pick('modified'), added: pick('added'), deleted: pick('deleted') };
  }

  get total(): number {
    return this.items.length;
  }

  get selectedCount(): number {
    return this.items.filter((i) => i.selected).length;
  }

  toggle(path: string, on?: boolean): void {
    const item = this.item(path);
    if (!item) return;
    item.selected = on ?? !item.selected;
    if (item.secret) this.confirmed = false;
  }

  /** Checks or unchecks everything except secret files (those are always chosen one by one). */
  selectAll(on: boolean): void {
    for (const i of this.items) if (!i.secret || !on) i.selected = on;
    if (!on) this.confirmed = false;
  }

  get allSelected(): boolean {
    return this.items.filter((i) => !i.secret).every((i) => i.selected);
  }

  secrets(): ChangeItem[] {
    return this.items.filter((i) => i.secret);
  }

  selectedSecrets(): ChangeItem[] {
    return this.items.filter((i) => i.secret && i.selected);
  }

  get secretsConfirmed(): boolean {
    return this.confirmed;
  }

  confirmSecrets(on: boolean): void {
    this.confirmed = on && this.selectedSecrets().length > 0;
  }

  /** Why Commit & Push is disabled, or null when it can go ahead. */
  block(): PushBlock | null {
    if (!this.selectedCount) return 'nothing_selected';
    if (this.selectedSecrets().length && !this.confirmed) return 'secrets_unconfirmed';
    return null;
  }

  /** The PushChange objects of the checked files (for executePush and defaultCommitMessage). */
  selectedChanges(): PushChange[] {
    return this.items.filter((i) => i.selected).map((i) => this.byPath.get(i.path)!);
  }
}

/** Commit message from a subject line and an optional description. */
export function commitMessage(subject: string, description: string): string {
  const s = subject.trim();
  const d = description.trim();
  return d ? `${s}\n\n${d}` : s;
}

// --- pull ---

export interface PullSummary {
  updated: number;
  deleted: number;
  conflicts: number;
  /** Local changes that stay as they are (pushed later). */
  keptLocal: number;
}

export function pullSummary(plan: PullPlan): PullSummary {
  return {
    updated: plan.apply.length,
    deleted: plan.deleteLocal.length,
    conflicts: plan.conflicts.length,
    keptLocal: plan.keepLocal.length,
  };
}

/** True when executing the plan changes no project file (only the link moves forward). */
export const pullChangesNoFiles = (plan: PullPlan): boolean => !plan.apply.length && !plan.deleteLocal.length && !plan.conflicts.length;

/**
 * Choices for the conflicts of one pull. Every file starts as "keep mine", so nothing is overwritten
 * unless the user picks GitHub's version.
 */
export class ConflictState {
  private readonly choice = new Map<string, ConflictResolution>();
  private readonly touched = new Set<string>();

  constructor(readonly conflicts: readonly PullConflict[]) {
    for (const c of conflicts) this.choice.set(c.path, 'local');
  }

  get(path: string): ConflictResolution {
    return this.choice.get(path) ?? 'local';
  }

  set(path: string, resolution: ConflictResolution): void {
    if (!this.choice.has(path)) return;
    this.choice.set(path, resolution);
    this.touched.add(path);
  }

  setAll(resolution: ConflictResolution): void {
    for (const c of this.conflicts) this.set(c.path, resolution);
  }

  /** Whether the user has looked at / chosen for this file. */
  decided(path: string): boolean {
    return this.touched.has(path);
  }

  get undecided(): number {
    return this.conflicts.filter((c) => !this.touched.has(c.path)).length;
  }

  counts(): { local: number; remote: number } {
    let remote = 0;
    for (const v of this.choice.values()) if (v === 'remote') remote++;
    return { local: this.choice.size - remote, remote };
  }

  /** For executePull. */
  resolutions(): Record<string, ConflictResolution> {
    return Object.fromEntries(this.choice);
  }
}

// --- badge ---

export interface QuickStatus {
  added: number;
  modified: number;
  deleted: number;
  total: number;
}

interface CacheEntry {
  key: string;
  status: QuickStatus;
}

const statusCache = new Map<string, CacheEntry>();
const shaCaches = new Map<string, { cache: ShaCache; uses: number }>();

function shaCacheFor(projectId: string): ShaCache {
  let entry = shaCaches.get(projectId);
  // Recreated now and then so old file contents do not pile up in memory.
  if (!entry || entry.uses > 40) shaCaches.set(projectId, (entry = { cache: new ShaCache(), uses: 0 }));
  entry.uses++;
  return entry.cache;
}

const cacheKey = (project: Project): string => `${project.github?.baseCommit ?? ''}|${project.updatedAt}|${project.fileCount}`;

/**
 * Counts of local changes against the link's `baseTree`. Local only: hashes files, never uses the
 * network. Null when the project is not linked.
 */
export async function quickStatus(project: Project): Promise<QuickStatus | null> {
  const link = project.github;
  if (!link) return null;
  const st = await status(project.files, link, shaCacheFor(project.id));
  const result: QuickStatus = {
    added: st.added.length,
    modified: st.modified.length,
    deleted: st.deleted.length,
    total: st.added.length + st.modified.length + st.deleted.length,
  };
  statusCache.set(project.id, { key: cacheKey(project), status: result });
  return result;
}

/**
 * Top-bar badge: the branch name, plus the number of local changes not pushed yet once
 * quickStatus() has computed it for the project's current state. Null when not linked.
 */
export function githubBadge(project: Pick<Project, 'id' | 'github' | 'updatedAt' | 'fileCount'>): { label: string; ahead?: number } | null {
  const link = project.github;
  if (!link) return null;
  const cached = statusCache.get(project.id);
  const badge: { label: string; ahead?: number } = { label: link.branch };
  if (cached && cached.key === cacheKey(project as Project) && cached.status.total > 0) badge.ahead = cached.status.total;
  return badge;
}

/** Records a fresh count (the panel computes status itself and shares it with the badge). */
export function rememberStatus(project: Project, st: QuickStatus): void {
  statusCache.set(project.id, { key: cacheKey(project), status: st });
}

// --- last sync time (a per-device convenience, not part of the project) ---

const SYNC_KEY = 'codevia.github.lastSync.';

export function lastSyncTime(projectId: string): string | null {
  try {
    return globalThis.localStorage?.getItem(SYNC_KEY + projectId) ?? null;
  } catch {
    return null;
  }
}

export function markSynced(projectId: string, at = new Date()): void {
  try {
    globalThis.localStorage?.setItem(SYNC_KEY + projectId, at.toISOString());
  } catch {
    /* storage blocked */
  }
}
