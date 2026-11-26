/**
 * Git blob hashing: `sha1("blob " + size + "\0" + bytes)`, the id GitHub reports for every file.
 * Lets the app compare local files with a remote tree without downloading anything.
 */
import { encodeUtf8 } from '../core/bytes';

const hex = (bytes: Uint8Array): string => [...bytes].map((x) => x.toString(16).padStart(2, '0')).join('');

/** Pure-JS SHA-1, used when WebCrypto is unavailable (e.g. a non-secure context). */
export function sha1Js(data: Uint8Array): string {
  const h = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]);
  const padded = new Uint8Array(((data.length + 9 + 63) >> 6) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  const dv = new DataView(padded.buffer);
  const bits = data.length * 8;
  dv.setUint32(padded.length - 4, bits >>> 0);
  dv.setUint32(padded.length - 8, Math.floor(bits / 2 ** 32));
  const w = new Uint32Array(80);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!;
      w[i] = (x << 1) | (x >>> 31);
    }
    let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!, e = h[4]!;
    for (let i = 0; i < 80; i++) {
      let f: number, k: number;
      if (i < 20) [f, k] = [(b & c) | (~b & d), 0x5a827999];
      else if (i < 40) [f, k] = [b ^ c ^ d, 0x6ed9eba1];
      else if (i < 60) [f, k] = [(b & c) | (b & d) | (c & d), 0x8f1bbcdc];
      else [f, k] = [b ^ c ^ d, 0xca62c1d6];
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]!) >>> 0;
      e = d;
      d = c;
      c = ((b << 30) | (b >>> 2)) >>> 0;
      b = a;
      a = t;
    }
    h[0] = h[0]! + a;
    h[1] = h[1]! + b;
    h[2] = h[2]! + c;
    h[3] = h[3]! + d;
    h[4] = h[4]! + e;
  }
  return [...h].map((x) => x.toString(16).padStart(8, '0')).join('');
}

/** Git blob SHA-1 of `bytes` (WebCrypto, with a JS fallback). */
export async function gitBlobSha1(bytes: Uint8Array): Promise<string> {
  const header = encodeUtf8(`blob ${bytes.length}\0`);
  const buf = new Uint8Array(header.length + bytes.length);
  buf.set(header);
  buf.set(bytes, header.length);
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    try {
      return hex(new Uint8Array(await subtle.digest('SHA-1', buf as BufferSource)));
    } catch {
      /* fall through to the JS implementation */
    }
  }
  return sha1Js(buf);
}
