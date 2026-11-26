// Parses DWG/DXF off the main thread so large drawings do not freeze the interface.
import * as lib from '../vendor/acad-ts.min.js';
import { cadOp } from './cad.js';

self.onmessage = e => {
  const { id, op, bytes, name } = e.data;
  try {
    const result = cadOp(lib, op, new Uint8Array(bytes), name);
    self.postMessage({ id, ok: true, result }, result.bytes ? [result.bytes.buffer] : []);
  } catch (err) {
    self.postMessage({ id, ok: false, error: err?.message || String(err) });
  }
};
