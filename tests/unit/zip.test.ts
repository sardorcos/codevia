import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { crc32, decodeCp866, sha256, sha256Js } from '../../src/core/bytes';
import { binaryFile, textFile } from '../../src/core/types';
import { stripCommonRoot, unzip, zipFiles } from '../../src/core/zip';

/** Minimal ZIP writer for crafting edge cases (lying sizes, raw name bytes, flags). */
function craft(entries: Array<{ name: Uint8Array; data: Uint8Array; deflate?: boolean; declaredSize?: number; flags?: number; attr?: number }>): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const body = e.deflate ? new Uint8Array(deflateRawSync(e.data)) : e.data;
    const crc = crc32(e.data);
    const plain = e.declaredSize ?? e.data.length;
    const lh = new Uint8Array(30 + e.name.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, e.flags ?? 0, true);
    lv.setUint16(8, e.deflate ? 8 : 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, plain, true);
    lv.setUint16(26, e.name.length, true);
    lh.set(e.name, 30);
    const ch = new Uint8Array(46 + e.name.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(8, e.flags ?? 0, true);
    cv.setUint16(10, e.deflate ? 8 : 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, plain, true);
    cv.setUint16(28, e.name.length, true);
    cv.setUint32(38, e.attr ?? 0, true);
    cv.setUint32(42, offset, true);
    ch.set(e.name, 46);
    chunks.push(lh, body);
    central.push(ch);
    offset += lh.length + body.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const eo = new Uint8Array(22);
  const ev = new DataView(eo.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const all = [...chunks, ...central, eo];
  const out = new Uint8Array(all.reduce((s, c) => s + c.length, 0));
  let o = 0;
  for (const c of all) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
const enc = (s: string) => new TextEncoder().encode(s);

describe('zip round trip', () => {
  it('preserves names, Cyrillic text and binary bytes', async () => {
    const files = {
      'index.html': textFile('<h1>Привет</h1>'),
      'data/x.json': textFile('{"a":1}'),
      'img/p.png': binaryFile(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255, 7])),
      'Папка/файл.txt': textFile('ё'.repeat(500)),
    };
    const blob = await zipFiles(files);
    const back = await unzip(new Uint8Array(await blob.arrayBuffer()));
    expect(Object.keys(back.files).sort()).toEqual(Object.keys(files).sort());
    expect((back.files['index.html'] as { content: string }).content).toBe('<h1>Привет</h1>');
    expect([...(back.files['img/p.png'] as { data: Uint8Array }).data]).toEqual([0x89, 0x50, 0x4e, 0x47, 0, 255, 7]);
    expect((back.files['Папка/файл.txt'] as { content: string }).content).toBe('ё'.repeat(500));
  });
});

describe('unzip safety', () => {
  it('rejects path traversal', async () => {
    await expect(unzip(craft([{ name: enc('../evil.txt'), data: enc('x') }]))).rejects.toThrow(/небезопасный/);
  });
  it('stops inflating as soon as output exceeds the declared size (zip bomb)', async () => {
    const bomb = craft([{ name: enc('a.txt'), data: new Uint8Array(20 * 1024 * 1024), deflate: true, declaredSize: 100 }]);
    expect(bomb.length).toBeLessThan(100 * 1024);
    await expect(unzip(bomb)).rejects.toThrow(/ZIP-бомба/);
  });
  it('rejects oversized declared entries before inflating', async () => {
    await expect(unzip(craft([{ name: enc('a.txt'), data: enc('x'), declaredSize: 999 * 1024 * 1024 }]))).rejects.toThrow(/слишком большой/);
  });
  it('skips macOS junk and symlinks', async () => {
    const r = await unzip(
      craft([
        { name: enc('index.html'), data: enc('a') },
        { name: enc('__MACOSX/._index.html'), data: enc('junk') },
        { name: enc('.DS_Store'), data: enc('x') },
        { name: enc('link'), data: enc('/etc/passwd'), attr: (0o120777 << 16) >>> 0 },
      ]),
    );
    expect(Object.keys(r.files)).toEqual(['index.html']);
    expect(r.skipped.length).toBe(3);
  });
  it('decodes CP866 names from old Windows archives', async () => {
    const cp866 = new Uint8Array([0xaf, 0xe0, 0xa8, 0xa2, 0xa5, 0xe2, 0x2e, 0x74, 0x78, 0x74]); // привет.txt
    const r = await unzip(craft([{ name: cp866, data: enc('hi') }]));
    expect(Object.keys(r.files)).toEqual(['привет.txt']);
  });
  it('keeps UTF-8 names without the flag when they are valid UTF-8', async () => {
    const r = await unzip(craft([{ name: enc('файл.txt'), data: enc('hi') }]));
    expect(Object.keys(r.files)).toEqual(['файл.txt']);
  });
  it('renames case-colliding duplicates instead of overwriting', async () => {
    const r = await unzip(craft([{ name: enc('A.txt'), data: enc('1') }, { name: enc('a.txt'), data: enc('2') }]));
    expect(Object.keys(r.files).sort()).toEqual(['A.txt', 'a (2).txt']);
    expect(r.renamed.length).toBe(1);
  });
  it('rejects encrypted entries and corrupted data', async () => {
    await expect(unzip(craft([{ name: enc('a.txt'), data: enc('x'), flags: 1 }]))).rejects.toThrow(/Зашифрованные/);
    const z = craft([{ name: enc('a.txt'), data: enc('hello') }]);
    z[30 + 5] ^= 0xff; // flip a data byte
    await expect(unzip(z)).rejects.toThrow(/контрольная сумма/);
    await expect(unzip(enc('not a zip at all'))).rejects.toThrow(/Это не ZIP/);
  });
  it('strips a single shared root folder', () => {
    const r = stripCommonRoot({ 'site/index.html': textFile('a'), 'site/css/a.css': textFile('b') });
    expect(r.root).toBe('site');
    expect(Object.keys(r.files).sort()).toEqual(['css/a.css', 'index.html']);
    expect(stripCommonRoot({ 'a/x': textFile(''), 'b/y': textFile('') }).root).toBeNull();
  });
});

describe('bytes', () => {
  it('decodes CP866', () => {
    expect(decodeCp866(new Uint8Array([0x8f, 0xe0, 0xa8, 0xa2, 0xa5, 0xe2]))).toBe('Привет');
  });
  it('JS SHA-256 matches WebCrypto', async () => {
    for (const s of ['', 'abc', 'Привет', 'x'.repeat(1000)]) {
      expect(sha256Js(enc(s))).toBe(await sha256(enc(s)));
    }
    expect(sha256Js(enc('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
