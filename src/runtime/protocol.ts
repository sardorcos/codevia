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
  /** PHP only: urlencoded form body for $_POST (form method=post in the preview). */
  post?: string;
  /** Absolute URL of bundled runtime assets (Pyodide). */
  base?: string;
  /** Interface language for messages produced by the runtime itself. */
  lang?: 'en' | 'ru';
  /** Python: allow downloading packages that are not bundled (Pyodide CDN, PyPI via micropip). */
  allowNetwork?: boolean;
  /** Runtime messages already translated by the app (any interface language); keys as in the workers' MSG tables. */
  messages?: Record<string, string>;
  /** Interactive input: when input()/prompt() runs out of lines, stop and ask the app for the next line. */
  interactive?: boolean;
}

export type WorkerMessage =
  | { type: 'status'; text: string }
  | { type: 'ready'; version: string }
  | { type: 'stdout'; id: string; text: string }
  | { type: 'stderr'; id: string; text: string }
  | { type: 'html'; id: string; html: string }
  /** An image produced by the program (matplotlib figure, PIL Image.show()), base64 PNG. */
  | { type: 'image'; id: string; mime: string; data: string }
  /** The program asked for input beyond the given lines (interactive runs). It has stopped; the app replays it with one more line. */
  | { type: 'need-input'; id: string }
  | { type: 'done'; id: string; exitCode: number; ms: number }
  | { type: 'fatal'; id?: string; message: string };

/**
 * Collects small writes into larger messages: a program printing in a tight loop must not flood the
 * main thread with one message per line. Flushes by size or age (checked on every write, because a
 * synchronous Python run never yields to timers) and explicitly before input and at the end.
 */
/** Exit code of a run that stopped to ask for more input (interactive mode). */
export const NEED_INPUT_EXIT = 199;

export class OutputBatcher {
  private buf = '';
  private last = 0;

  constructor(
    private send: (text: string) => void,
    private maxChars = 4096,
    private maxAgeMs = 50,
    private now: () => number = () => performance.now(),
  ) {}

  write(text: string): void {
    if (!text) return;
    if (!this.buf) this.last = this.now();
    this.buf += text;
    if (this.buf.length >= this.maxChars || this.now() - this.last >= this.maxAgeMs) this.flush();
  }

  flush(): void {
    if (!this.buf) return;
    const text = this.buf;
    this.buf = '';
    this.last = this.now();
    this.send(text);
  }
}
