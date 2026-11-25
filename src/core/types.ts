export type TextFile = { text: true; content: string };
export type BinaryFile = { text: false; data: Uint8Array };
export type ProjectFile = TextFile | BinaryFile;
export type Files = Record<string, ProjectFile>;

export type Language = 'web' | 'python' | 'php' | 'javascript';

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
  /** Link to a GitHub repository, set by clone / first push (see docs/GITHUB.md). */
  github?: GitHubLink;
  schema: 2;
}

/** Sync state of a project linked to a GitHub repository. Paths are project-relative. */
export interface GitHubLink {
  owner: string;
  repo: string;
  branch: string;
  /** SHA of the commit the project was last synced with. */
  baseCommit: string;
  /** Git blob SHA-1 of every tracked file at `baseCommit`: path → sha. */
  baseTree: Record<string, string>;
  /** Git file modes that differ from the regular `100644` (e.g. `100755`), so pushes keep them. */
  modes?: Record<string, string>;
  /** Folder inside the repository that the project maps to (monorepos), without slashes at the ends. */
  subdir?: string;
  pagesUrl?: string;
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
  /** Python: download packages that are not built in (Pyodide CDN, PyPI) on first import. */
  pythonDownloads: boolean;
  onboardingDone: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  density: 'compact',
  editorFont: 14,
  wrapLines: false,
  previewNetwork: false,
  pythonDownloads: true,
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
