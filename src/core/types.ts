export type TextFile = { text: true; content: string };
export type BinaryFile = { text: false; data: Uint8Array };
export type ProjectFile = TextFile | BinaryFile;
export type Files = Record<string, ProjectFile>;

export type Language = 'web' | 'python' | 'php';

export interface ProjectMeta {
  id: string;
  name: string;
  language: Language;
  createdAt: string;
  updatedAt: string;
  /** Folder name inside the app's Documents directory (visible in the Files app). */
  folder: string;
  fileCount: number;
  size: number;
  /** File started by Run / opened by Preview. */
  entry?: string;
  schema: 2;
}

export interface Project extends ProjectMeta {
  files: Files;
}

export interface SnapshotEntry {
  hash: string;
  text: boolean;
  size: number;
}

export type SnapshotKind = 'manual' | 'auto';

export interface SnapshotMeta {
  id: string;
  projectId: string;
  at: string;
  label: string;
  kind: SnapshotKind;
  fileCount: number;
}

export interface Snapshot extends SnapshotMeta {
  entries: Record<string, SnapshotEntry>;
}

export interface Settings {
  density: 'compact' | 'comfortable';
  editorFont: number;
  wrapLines: boolean;
  previewNetwork: boolean;
  onboardingDone: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  density: 'compact',
  editorFont: 14,
  wrapLines: false,
  previewNetwork: false,
  onboardingDone: false,
};

export const LIMITS = {
  maxProjects: 200,
  maxFilesPerProject: 3000,
  maxFileBytes: 15 * 1024 * 1024,
  maxProjectBytes: 120 * 1024 * 1024,
  maxZipBytes: 60 * 1024 * 1024,
  maxManualSnapshots: 30,
  maxAutoSnapshots: 10,
} as const;

export const textFile = (content: string): TextFile => ({ text: true, content });
export const binaryFile = (data: Uint8Array): BinaryFile => ({ text: false, data });
