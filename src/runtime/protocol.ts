export interface RunFile {
  path: string;
  text: boolean;
  content?: string;
  data?: Uint8Array;
}

export interface RunRequest {
  type: 'run';
  id: string;
  entry: string;
  files: RunFile[];
  stdin?: string;
  /** PHP only: query string for $_GET. */
  query?: string;
  /** Absolute URL of bundled runtime assets (Pyodide). */
  base?: string;
}

export type WorkerMessage =
  | { type: 'status'; text: string }
  | { type: 'ready'; version: string }
  | { type: 'stdout'; id: string; text: string }
  | { type: 'stderr'; id: string; text: string }
  | { type: 'html'; id: string; html: string }
  | { type: 'done'; id: string; exitCode: number; ms: number }
  | { type: 'fatal'; id?: string; message: string };
