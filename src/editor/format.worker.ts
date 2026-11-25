/// <reference lib="webworker" />
import { formatCode, FormatError, type FormatRequest } from './format-core';

/** Formats code off the main thread so typing stays smooth on large files. */
interface WorkerRequest extends FormatRequest {
  id: number;
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const { id, ...req } = e.data;
  try {
    const res = await formatCode(req);
    self.postMessage({ id, ok: true, ...res });
  } catch (err) {
    const fe = err instanceof FormatError ? err : null;
    self.postMessage({ id, ok: false, error: fe?.message ?? String((err as Error)?.message ?? err), line: fe?.line });
  }
};
