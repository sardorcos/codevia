import type { Issue } from './core/diagnostics';
import { DEFAULT_SETTINGS, type Project, type ProjectMeta, type Settings, type SnapshotMeta } from './core/types';

export type Route = 'welcome' | 'home' | 'workspace' | 'history' | 'diagnostics' | 'settings' | 'privacy' | 'licenses';
export type View = 'files' | 'code' | 'preview' | 'run';
export type SaveState = 'saved' | 'saving' | 'error';

export interface ConsoleLine {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug' | 'stdout' | 'stderr' | 'system';
  text: string;
  /** An image the program produced (matplotlib figure, PIL image): base64 data. */
  image?: { mime: string; data: string };
}

export interface AppState {
  route: Route;
  view: View;
  projects: ProjectMeta[];
  project: Project | null;
  currentPath: string;
  tabs: string[];
  fileFilter: 'all' | 'code' | 'assets';
  fileQuery: string;
  /** Multi-select mode in Files and the selected paths. */
  selecting: boolean;
  selected: string[];
  /** iPad / Mac / landscape: files, code and preview side by side. */
  wide: boolean;
  /** Right pane of the wide layout. */
  side: 'preview' | 'run';
  /** Errors found by the editor's linter in the open file. */
  diagErrors: number;
  projectQuery: string;
  previewPage: string;
  previewQuery: string;
  previewConsole: ConsoleLine[];
  consoleOpen: boolean;
  fullscreen: boolean;
  run: {
    running: boolean;
    status: string;
    output: ConsoleLine[];
    exitCode: number | null;
    ms: number | null;
    stdin: string;
    /** The program is waiting for the next line of input (interactive replay). */
    awaitingInput?: boolean;
  };
  save: SaveState;
  saveError: string;
  snapshots: SnapshotMeta[];
  issues: Issue[];
  settings: Settings & Record<string, unknown>;
  volatile: boolean;
  storageError: string;
  keyboardOpen: boolean;
  busy: string;
}

export const initialState = (): AppState => ({
  route: 'home',
  view: 'files',
  projects: [],
  project: null,
  currentPath: '',
  tabs: [],
  fileFilter: 'all',
  fileQuery: '',
  selecting: false,
  selected: [],
  wide: false,
  side: 'preview',
  diagErrors: 0,
  projectQuery: '',
  previewPage: '',
  previewQuery: '',
  previewConsole: [],
  consoleOpen: false,
  fullscreen: false,
  run: { running: false, status: '', output: [], exitCode: null, ms: null, stdin: '' },
  save: 'saved',
  saveError: '',
  snapshots: [],
  issues: [],
  settings: { ...DEFAULT_SETTINGS },
  volatile: false,
  storageError: '',
  keyboardOpen: false,
  busy: '',
});
