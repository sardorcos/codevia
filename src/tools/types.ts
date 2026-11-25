import type { Files, Language, Project, ProjectMeta } from '../core/types';

/**
 * What a tool (HTTP client, JSON viewer, colour tools, GitHub, inspector…) can ask of the app.
 * Tools never import app.ts: the app passes this context when it mounts a tool in a full-screen panel
 * (phone) or a side pane (iPad/Mac). Everything a tool changes in the project goes through here, so
 * saving, history and the open editor stay consistent.
 */
export interface ToolContext {
  /** The open project, or null on the home screen. Treat as read-only; write through writeFiles(). */
  project(): Project | null;
  /** Path of the file open in the editor, if any. */
  activeFile(): string | null;
  /** Writes (adds or overwrites) files of the open project and saves them; `remove` deletes paths.
   *  With `snapshotLabel`, an automatic version is created first so the change can be undone. */
  writeFiles(files: Files, opts?: { remove?: string[]; snapshotLabel?: string }): Promise<void>;
  /** Replaces all files of the open project (one automatic version first, labelled `label`). */
  replaceAllFiles(files: Files, label: string): Promise<void>;
  /** Updates metadata of the open project (e.g. its GitHub link) and saves it. */
  updateMeta(patch: Partial<Pick<ProjectMeta, 'github' | 'entry' | 'name' | 'language'>>): Promise<void>;
  /** Creates a project and opens it. */
  createProject(name: string, language: Language, files: Files, meta?: Partial<Pick<ProjectMeta, 'github' | 'entry'>>): Promise<void>;
  /** Opens a file of the open project in the editor (optionally at a 1-based line) and closes the tool. */
  openFile(path: string, line?: number): void;
  toast(message: string, kind?: 'info' | 'success' | 'error'): void;
  confirm(opts: { title: string; message?: string; ok: string; destructive?: boolean }): Promise<boolean>;
  /** Asks for one line of text (or null when cancelled). */
  prompt(opts: { title: string; label: string; value?: string; ok: string }): Promise<string | null>;
  /** Save/share a file through the system share sheet (iOS) or a download (web). */
  share(data: Blob | Uint8Array | string, filename: string, mime: string): Promise<void>;
  /** Opens a URL outside the app (Safari / system browser). */
  openExternal(url: string): void;
  /** Light haptic feedback on iOS (no-op elsewhere). */
  haptic(kind?: 'light' | 'success' | 'warning' | 'error'): void;
  /** Closes the tool panel. */
  close(): void;
}

export interface Tool {
  id: string;
  /** Russian title (translated with t() by the app). */
  title: string;
  /** Name of an icon from the app's sprite (see index.html <symbol id="i-…">) */
  icon: string;
  /** Whether the tool needs an open project. */
  needsProject?: boolean;
  /** Renders into `root`; returns an optional cleanup function. */
  mount(root: HTMLElement, ctx: ToolContext): void | (() => void);
}
