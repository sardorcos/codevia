/** Local-only error journal: nothing leaves the device unless the user shares it. */
export interface LoggedError {
  at: string;
  message: string;
  stack?: string;
}

const MAX = 50;
const log: LoggedError[] = [];

export function recordError(e: unknown, context = ''): void {
  const err = e instanceof Error ? e : new Error(String((e as { message?: string })?.message ?? e));
  log.push({ at: new Date().toISOString(), message: `${context ? context + ': ' : ''}${err.message}`, stack: err.stack?.split('\n').slice(0, 6).join('\n') });
  if (log.length > MAX) log.splice(0, log.length - MAX);
}

export const errorLog = (): readonly LoggedError[] => log;

export function errorReport(version: string): string {
  return [
    `Codevia Pocket ${version}`,
    `UA: ${navigator.userAgent}`,
    '',
    ...log.map((e) => `[${e.at}] ${e.message}${e.stack ? `\n${e.stack}` : ''}`),
  ].join('\n');
}

export function installGlobalErrorHandlers(onError: (message: string) => void): void {
  window.addEventListener('error', (e) => {
    recordError(e.error ?? e.message, 'window');
    onError(e.message);
  });
  window.addEventListener('unhandledrejection', (e) => {
    recordError(e.reason, 'promise');
    onError(String((e.reason as Error)?.message ?? e.reason));
  });
}
