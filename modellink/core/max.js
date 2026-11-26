// 3ds Max (.max) reader: OLE2 container, scene properties, thumbnail and mesh geometry.
// Geometry support: Editable Poly, Editable Mesh and the standard primitives (Box, Sphere,
// GeoSphere, Cylinder, Cone, Tube, Torus, Plane, Teapot); node transforms from the default
// Position/Rotation/Scale controllers. Modifiers, splines, V-Ray proxies and XRefs are not evaluated.
// Format notes: Kaetemi's "3ds Max File Format" articles; olefile; jmplonka/Importer3D (behaviour only).

const td16 = new TextDecoder('utf-16le');

// ---------------------------------------------------------------- OLE2 / Compound File Binary
export function readCFB(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const sig = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
  if (u8.length < 512 || sig.some((b, i) => u8[i] !== b)) throw new Error('Файл не является контейнером 3ds Max (OLE2)');
  const secSize = 1 << dv.getUint16(0x1E, true), miniSize = 1 << dv.getUint16(0x20, true);
  const firstDir = dv.getUint32(0x30, true), cutoff = dv.getUint32(0x38, true);
  const firstMiniFat = dv.getUint32(0x3C, true), firstDifat = dv.getUint32(0x44, true), numDifat = dv.getUint32(0x48, true);
  const ENDCHAIN = 0xFFFFFFFE, FREE = 0xFFFFFFFF;
  const sector = n => (n + 1) * secSize;
  const fatSectors = [];
  for (let i = 0; i < 109; i++) { const s = dv.getUint32(0x4C + i * 4, true); if (s !== FREE) fatSectors.push(s); }
  let difat = firstDifat;
  for (let k = 0; k < numDifat && difat < ENDCHAIN; k++) {
    const base = sector(difat), per = secSize / 4 - 1;
    for (let i = 0; i < per; i++) { const s = dv.getUint32(base + i * 4, true); if (s !== FREE) fatSectors.push(s); }
    difat = dv.getUint32(base + per * 4, true);
  }
  const fat = new Uint32Array(fatSectors.length * secSize / 4);
  fatSectors.forEach((s, i) => { const base = sector(s); for (let j = 0; j < secSize / 4; j++) if (base + j * 4 + 4 <= u8.length) fat[i * secSize / 4 + j] = dv.getUint32(base + j * 4, true); });
  const chain = (start, table, limit) => { const out = []; let s = start; const seen = new Set(); while (s < ENDCHAIN && !seen.has(s) && out.length < limit) { seen.add(s); out.push(s); s = table[s]; } return out; };
  const readChain = (start, size) => {
    const secs = chain(start, fat, Math.ceil(size / secSize) + 1), out = new Uint8Array(size);
    let p = 0; for (const s of secs) { const off = sector(s), n = Math.min(secSize, size - p); if (n <= 0) break; out.set(u8.subarray(off, off + n), p); p += n; }
    return out;
  };
  // Directory
  const dirSecs = chain(firstDir, fat, 1e6);
  const dirBytes = new Uint8Array(dirSecs.length * secSize);
  dirSecs.forEach((s, i) => dirBytes.set(u8.subarray(sector(s), sector(s) + secSize), i * secSize));
  const ddv = new DataView(dirBytes.buffer);
  const entries = [];
  for (let off = 0; off + 128 <= dirBytes.length; off += 128) {
    const nameLen = ddv.getUint16(off + 0x40, true), type = dirBytes[off + 0x42];
    if (!type) continue;
    const name = td16.decode(dirBytes.subarray(off, off + Math.max(0, nameLen - 2)));
    entries.push({ name, type, start: ddv.getUint32(off + 0x74, true), size: ddv.getUint32(off + 0x78, true) });
  }
  const root = entries.find(e => e.type === 5);
  const miniStream = root ? readChain(root.start, root.size) : new Uint8Array(0);
  let miniFat = new Uint32Array(0);
  if (firstMiniFat < ENDCHAIN) {
    const secs = chain(firstMiniFat, fat, 1e6), raw = new Uint8Array(secs.length * secSize);
    secs.forEach((s, i) => raw.set(u8.subarray(sector(s), sector(s) + secSize), i * secSize));
    miniFat = new Uint32Array(raw.buffer, 0, raw.length / 4);
  }
  const streams = new Map();
  for (const e of entries) {
    if (e.type !== 2) continue;
    if (e.size < cutoff) {
      const secs = chain(e.start, miniFat, Math.ceil(e.size / miniSize) + 1), out = new Uint8Array(e.size);
      let p = 0; for (const s of secs) { const off = s * miniSize, n = Math.min(miniSize, e.size - p); if (n <= 0) break; out.set(miniStream.subarray(off, off + n), p); p += n; }
      streams.set(e.name, out);
    } else streams.set(e.name, readChain(e.start, e.size));
  }
  return streams;
}

// ---------------------------------------------------------------- property sets (SummaryInformation)
export function readPropertySet(bytes) {
  if (!bytes || bytes.length < 48) return { props: new Map(), codepage: 1252 };
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const secOff = dv.getUint32(44, true), props = new Map();
  const count = dv.getUint32(secOff + 4, true);
  for (let i = 0; i < count && i < 512; i++) {
    const id = dv.getUint32(secOff + 8 + i * 8, true), off = secOff + dv.getUint32(secOff + 12 + i * 8, true);
    if (off + 4 > bytes.length) continue;
    props.set(id, { type: dv.getUint32(off, true), off: off + 4 });
  }
  const cp = props.get(1); let codepage = cp ? dv.getInt16(cp.off, true) & 0xFFFF : 1252;
  return { props, codepage, dv, bytes };
}
function decodeText(bytes, codepage) {
  const label = codepage === 65001 ? 'utf-8' : codepage === 1251 ? 'windows-1251' : codepage === 1200 ? 'utf-16le' : 'windows-1252';
  try { return new TextDecoder(label).decode(bytes).replace(/\0+$/, ''); } catch { return new TextDecoder().decode(bytes).replace(/\0+$/, ''); }
}

/** 3ds Max File Properties → Contents: [{name:'General', items:['3ds Max Version: 18.00', …]}, …]. */
export function maxSections(docSummary) {
  const ps = readPropertySet(docSummary); const { props, dv, bytes, codepage } = ps;
  const hp = props.get(0x0C), parts = props.get(0x0D); if (!hp || !parts) return [];
  const headings = []; let o = hp.off; const n = dv.getUint32(o, true); o += 4;
  for (let i = 0; i + 1 < n; i += 2) {
    const t1 = dv.getUint32(o, true); o += 4; if (t1 !== 0x1E) break;
    const len = dv.getUint32(o, true); o += 4; const name = decodeText(bytes.subarray(o, o + len), codepage); o += (len + 3) & ~3;
    const t2 = dv.getUint32(o, true); o += 4; const cnt = t2 === 3 ? dv.getInt32(o, true) : 0; o += 4;
    headings.push({ name, count: cnt });
  }
  const items = []; o = parts.off; const m = dv.getUint32(o, true); o += 4;
  for (let i = 0; i < m && o + 4 <= bytes.length; i++) { const len = dv.getUint32(o, true); o += 4; items.push(decodeText(bytes.subarray(o, o + len), codepage)); o += (len + 3) & ~3; }
  let k = 0; return headings.map(h => ({ name: h.name, items: items.slice(k, k += Math.max(0, h.count)) }));
}

/** Thumbnail (VT_CF: DIB or METAFILEPICT with an embedded DIB) → BMP bytes, or null. */
export function maxThumbnail(summary) {
  const { props, dv, bytes } = readPropertySet(summary); const p = props.get(17);
  if (!p || p.type !== 0x47) return null;
  const size = dv.getUint32(p.off, true), tag = dv.getInt32(p.off + 4, true), fmt = dv.getUint32(p.off + 8, true);
  let data = bytes.subarray(p.off + 12, p.off + 4 + size);
  if (tag !== -1) return null;
  if (fmt === 8) return dibToBmp(data);
  if (fmt !== 3) return null;
  data = data.subarray(8); // METAFILEPICT (mm, xExt, yExt, hMF) → WMF
  const w = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = w.getUint32(0, true) === 0x9AC6CDD7 ? 22 : 0;
  o += w.getUint16(o + 2, true) * 2; // header size in words
  while (o + 6 <= data.length) {
    const recWords = w.getUint32(o, true), fn = w.getUint16(o + 4, true);
    if (recWords < 3) break;
    const params = o + 6;
    if (fn === 0x0F43) return dibToBmp(data.subarray(params + 22, o + recWords * 2)); // StretchDIBits
    if (fn === 0x0B41) return dibToBmp(data.subarray(params + 20, o + recWords * 2)); // DibStretchBlt
    if (fn === 0x0940) return dibToBmp(data.subarray(params + 16, o + recWords * 2)); // DibBitBlt
    if (fn === 0) break;
    o += recWords * 2;
  }
  return null;
}
function dibToBmp(dib) {
  if (dib.length < 40) return null;
  const v = new DataView(dib.buffer, dib.byteOffset, dib.byteLength);
  const hdr = v.getUint32(0, true), bits = v.getUint16(14, true), comp = v.getUint32(16, true), used = v.getUint32(32, true);
  const palette = (used || (bits <= 8 ? 1 << bits : 0)) * 4 + (comp === 3 && hdr === 40 ? 12 : 0);
  const out = new Uint8Array(14 + dib.length), o = new DataView(out.buffer);
  out[0] = 0x42; out[1] = 0x4D; o.setUint32(2, out.length, true); o.setUint32(10, 14 + hdr + palette, true);
  out.set(dib, 14); return out;
}

// ---------------------------------------------------------------- chunk trees (Scene, ClassDirectory3, …)
export function readChunks(data, depth = 0) {
  const out = []; const dv = new DataView(data.buffer, data.byteOffset, data.byteLength); let o = 0;
  while (o + 6 <= data.length) {
    const type = dv.getUint16(o, true); let size = dv.getUint32(o + 2, true), head = 6, container = (size & 0x80000000) !== 0;
    size &= 0x7FFFFFFF;
    if (size === 0 && !container) { // 64-bit size
      if (o + 14 > data.length) break;
      const lo = dv.getUint32(o + 6, true), hi = dv.getUint32(o + 10, true);
      container = (hi & 0x80000000) !== 0; size = (hi & 0x7FFFFFFF) * 2 ** 32 + lo; head = 14;
    }
    if (size < head || o + size > data.length) break;
    const body = data.subarray(o + head, o + size);
    out.push(container && depth < 64 ? { type, children: readChunks(body, depth + 1) } : { type, data: body });
    o += size;
  }
  return out;
}
const first = (c, t) => c?.children?.find(x => x.type === t);
const str16 = c => (c?.data ? td16.decode(c.data).replace(/\0+$/, '') : '');
const u32s = d => { const v = new DataView(d.buffer, d.byteOffset, d.byteLength), a = []; for (let i = 0; i + 4 <= d.length; i += 4) a.push(v.getUint32(i, true)); return a; };
const f32s = d => { const v = new DataView(d.buffer, d.byteOffset, d.byteLength), a = []; for (let i = 0; i + 4 <= d.length; i += 4) a.push(v.getFloat32(i, true)); return a; };

/**
 * Reads a .max file. `inflate(bytes)` must decompress zlib/gzip data (Scene streams of some versions are compressed).
 * Returns {sections, thumbnail, objects:[{name, vertices?, faces?, primitive?, matrix, color}], skipped:{class:count}}.
 */
export function readMax(bytes, { inflate = null } = {}) {
  const streams = readCFB(bytes);
  const sections = streams.has('\u0005DocumentSummaryInformation') ? maxSections(streams.get('\u0005DocumentSummaryInformation')) : [];
  let thumbnail = null; try { thumbnail = maxThumbnail(streams.get('\u0005SummaryInformation')); } catch { thumbnail = null; }
  const result = { sections, thumbnail, objects: [], skipped: {}, error: null };
  try {
    const classes = readChunks(streams.get('ClassDirectory3') || streams.get('ClassDirectory') || new Uint8Array(0)).map(c => {
      const info = first(c, 0x2060), name = str16(first(c, 0x2042));
      if (!info?.data || info.data.length < 16) return { name, a: 0, b: 0, sup: 0 };
      const v = u32s(info.data); return { name, a: v[1], b: v[2], sup: v[3] };
    });
    let scene = streams.get('Scene'); if (!scene) throw new Error('В файле нет сцены');
    if (scene[0] === 0x1F && scene[1] === 0x8B || scene[0] === 0x78) { if (!inflate) throw new Error('Сцена сжата'); scene = inflate(scene); }
    const top = readChunks(scene)[0]; if (!top?.children) throw new Error('Не удалось прочитать сцену');
    const nodes = top.children;
    const cls = c => classes[c?.type] || { name: `0x${(c?.type ?? 0).toString(16)}`, a: -1, b: -1, sup: -1 };
    const is = (c, a, b = 0) => { const k = cls(c); return k.a === (a >>> 0) && k.b === (b >>> 0); };
    const refs = c => { const r = first(c, 0x2034); return r?.data ? u32s(r.data).map(i => nodes[i]) : []; };
    const typedRefs = c => { const r = first(c, 0x2035); if (!r?.data) return null; const v = u32s(r.data), m = new Map(); for (let i = 1; i + 1 < v.length; i += 2) m.set(v[i], nodes[v[i + 1]]); return m; };
    const floatValue = (c, def) => {
      if (!c) return def;
      if (is(c, 0x2007)) { const f = first(first(c, 0x7127), 0x2501); return f?.data?.length >= 4 ? f32s(f.data)[0] : def; } // Bezier Float
      if (is(c, 0x498702E7, 0x71F11549)) return floatValue(refs(c)[0], def); // Float Wire
      const direct = first(c, 0x2501); return direct?.data?.length >= 4 ? f32s(direct.data)[0] : def;
    };
    const point3 = (c, def) => refs(c).slice(0, 3).map(f => floatValue(f, def));
    const matMul = (A, B) => { const C = new Array(16).fill(0); for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) for (let j = 0; j < 4; j++) C[r * 4 + j] += A[r * 4 + k] * B[k * 4 + j]; return C; };
    const I = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const position = c => {
      const m = I(); if (!c) return m; let p = null;
      if (is(c, 0x118F7E02, 0xFFEE238A)) p = point3(c, 0); // Position XYZ
      else if (is(c, 0x442312) || is(c, 0x2008)) { const d = first(c, 0x2503); if (d?.data) p = f32s(d.data); }
      else if (is(c, 0x4B4B1002) || first(c, 0x2034)) { const r = refs(c)[0]; if (r && r !== c) return position(r); } // Position List
      if (p) { m[3] = p[0] || 0; m[7] = p[1] || 0; m[11] = p[2] || 0; }
      return m;
    };
    const rotation = c => {
      if (!c) return I();
      let q = null;
      if (is(c, 0x2012)) { const [x, y, z] = point3(c, 0); const cx = Math.cos(x), sx = Math.sin(x), cy = Math.cos(y), sy = Math.sin(y), cz = Math.cos(z), sz = Math.sin(z);
        const Rx = [1, 0, 0, 0, 0, cx, -sx, 0, 0, sx, cx, 0, 0, 0, 0, 1], Ry = [cy, 0, sy, 0, 0, 1, 0, 0, -sy, 0, cy, 0, 0, 0, 0, 1], Rz = [cz, -sz, 0, 0, sz, cz, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
        return matMul(Rz, matMul(Ry, Rx)); }
      if (is(c, 0x442313) || is(c, 0x2006)) { const d = first(c, 0x2504); if (d?.data) q = f32s(d.data); }
      else if (is(c, 0x4B4B1003) || is(c, 0x31381913, 0x3A904167)) return rotation(refs(c)[0]);
      if (!q || q.length < 4) return I();
      let [x, y, z, w] = q; const n = Math.hypot(x, y, z, w) || 1; x /= n; y /= n; z /= n; w /= n;
      w = -w; // 3ds Max stores the inverse rotation
      return [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 0, 2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 0, 2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), 0, 0, 0, 0, 1];
    };
    const scale = c => {
      const m = I(); if (!c) return m; let s = null;
      if (is(c, 0x2010) || is(c, 0x442315)) { const d = first(c, 0x2501) || first(c, 0x2505); if (d?.data) s = f32s(d.data); }
      else if (is(c, 0x118F7C01, 0xFEEE238B)) s = point3(c, 1);
      if (s && s.length >= 3) { m[0] = s[0] || 1; m[5] = s[1] || 1; m[10] = s[2] || 1; }
      return m;
    };
    const controllerMatrix = c => {
      if (!c) return I();
      if (is(c, 0x2005)) { const r = refs(c); return matMul(position(r[0]), matMul(rotation(r[1]), scale(r[2]))); }
      return I();
    };
    const nodeParts = node => {
      const t = typedRefs(node);
      if (t) return { ctrl: t.get(0), obj: t.get(1), mat: t.get(3) };
      const r = refs(node); return { ctrl: r[0], obj: r[1], mat: r[3] };
    };
    const isNode = c => { const k = cls(c); return k.a === 1 && k.b === 0 && k.sup === 1; };
    const worldCache = new Map();
    const world = (node, depth = 0) => {
      if (!node || depth > 64) return I(); if (worldCache.has(node)) return worldCache.get(node);
      const local = controllerMatrix(nodeParts(node).ctrl);
      const p = first(node, 0x0960); const parent = p?.data ? nodes[u32s(p.data)[0]] : null;
      const m = parent && isNode(parent) ? matMul(world(parent, depth + 1), local) : local;
      worldCache.set(node, m); return m;
    };
    // ParamBlock (legacy): parameter i is child i with a 0x0100 float. ParamBlock2: records {short id, …, float at +15}.
    const pblockFloat = (obj, i) => {
      const pb = refs(obj)[0]; if (!pb?.children) return null;
      const child = pb.children[i]; const f = first(child, 0x0100);
      if (f?.data?.length >= 4) return f32s(f.data)[0];
      const id = i - 2;
      for (const rec of pb.children) {
        if (rec.data?.length >= 19) { const v = new DataView(rec.data.buffer, rec.data.byteOffset, rec.data.byteLength); if (v.getInt16(0, true) === id) return v.getFloat32(15, true); }
      }
      return null;
    };
    const geometry = (obj, depth = 0) => {
      if (!obj || depth > 16) return null;
      if (is(obj, 0xE44F10B3)) { // Editable Mesh
        const g = first(obj, 0x08FE), vc = first(g, 0x0914), fc = first(g, 0x0912); if (!vc?.data || !fc?.data) return null;
        const vd = new DataView(vc.data.buffer, vc.data.byteOffset, vc.data.byteLength), n = vd.getUint32(0, true), vertices = [];
        for (let i = 0, o = 4; i < n && o + 12 <= vc.data.length; i++, o += 12) vertices.push([vd.getFloat32(o, true), vd.getFloat32(o + 4, true), vd.getFloat32(o + 8, true)]);
        const fd = new DataView(fc.data.buffer, fc.data.byteOffset, fc.data.byteLength), m = fd.getUint32(0, true), faces = [];
        for (let i = 0, o = 4; i < m && o + 20 <= fc.data.length; i++, o += 20) faces.push([fd.getUint32(o, true), fd.getUint32(o + 4, true), fd.getUint32(o + 8, true)]);
        return { vertices, faces };
      }
      if (is(obj, 0x1BF8338D, 0x192F6098)) { // Editable Poly
        const g = first(obj, 0x08FE); if (!g) return null;
        let vertices = null; const faces = [];
        for (const c of g.children || []) {
          if (c.type === 0x0100 && c.data) { const d = new DataView(c.data.buffer, c.data.byteOffset, c.data.byteLength); vertices = []; for (let o = 4; o + 16 <= c.data.length; o += 16) vertices.push([d.getFloat32(o + 4, true), d.getFloat32(o + 8, true), d.getFloat32(o + 12, true)]); }
        }
        const fchunk = first(g, 0x011A), six = first(g, 0x0108);
        if (fchunk?.data) {
          const d = new DataView(fchunk.data.buffer, fchunk.data.byteOffset, fchunk.data.byteLength); let o = 4;
          try {
            while (o + 4 <= fchunk.data.length) {
              const l = d.getUint32(o, true); o += 4; if (l > 4096) break;
              const pts = []; for (let i = 0; i < l; i++, o += 4) pts.push(d.getUint32(o, true));
              const flags = d.getUint16(o, true); o += 2;
              if (flags & 0x01) o += 4; if (flags & 0x08) o += 2; if (flags & 0x10) o += 4; if (flags & 0x20) o += 4 * 2 * Math.max(0, l - 3);
              for (let i = 1; i + 1 < pts.length; i++) faces.push([pts[0], pts[i], pts[i + 1]]);
            }
          } catch { /* truncated record */ }
        } else if (six?.data) {
          const d = new DataView(six.data.buffer, six.data.byteOffset, six.data.byteLength);
          for (let o = 4; o + 24 <= six.data.length; o += 24) { const v = [0, 1, 2, 3, 4, 5].map(k => d.getInt32(o + k * 4, true)); let e = 5; while (e > 3 && v[e] < 0) e--; const pts = v.slice(1, e + 1); for (let i = 1; i + 1 < pts.length; i++) faces.push([pts[0], pts[i], pts[i + 1]]); }
        }
        return vertices && faces.length ? { vertices, faces } : null;
      }
      const prim = (kind, ...idx) => ({ primitive: kind, params: idx.map(i => pblockFloat(obj, i)) });
      if (is(obj, 0x10)) return prim('box', 2, 3, 4);
      if (is(obj, 0x11)) return prim('sphere', 2);
      if (is(obj, 0x12)) return prim('cylinder', 2, 3);
      if (is(obj, 0x20)) return prim('torus', 2, 3);
      if (is(obj, 0x7B21)) return prim('tube', 2, 3, 4);
      if (is(obj, 0xA86C23DD)) return prim('cone', 2, 3, 4);
      if (is(obj, 0, 0x7F9E)) return prim('sphere', 4);
      if (is(obj, 0x081F1DFC, 0x77566F65)) return prim('plane', 2, 3);
      if (is(obj, 0xACAD13D3, 0xACAD26D9)) return prim('teapot', 2);
      if (is(obj, 0x2032) || is(obj, 0x2033)) { const r = refs(obj); for (let i = r.length - 1; i >= 0; i--) { const g = geometry(r[i], depth + 1); if (g) return g; } return null; } // modifier stack → base object
      return null;
    };
    const colorOf = node => { const c = first(node, 0x0964) || first(node, 0x0974); if (c?.data?.length >= 4) { const v = c.data; return `#${[v[0], v[1], v[2]].map(x => x.toString(16).padStart(2, '0')).join('')}`; } return null; };
    for (const node of nodes) {
      if (!node?.children || !isNode(node)) continue;
      const { obj } = nodeParts(node); if (!obj) continue;
      let g = null; try { g = geometry(obj); } catch { g = null; }
      const name = str16(first(node, 0x0962)) || 'Объект';
      if (!g) { const k = cls(obj).name || 'неизвестный'; if (!/camera|light|target|omni|spot|dummy|helper|point|physical|free|sun|sky|daylight|vray|corona|arnold/i.test(k)) result.skipped[k] = (result.skipped[k] || 0) + 1; continue; }
      result.objects.push({ name, ...g, matrix: world(node), color: colorOf(node) });
    }
  } catch (e) { result.error = e.message; }
  return result;
}

/** Builds triangle meshes for primitives (Z-up, 3ds Max pivots) so everything can be merged and exported. */
export function primitiveMesh(kind, params, seg = 24) {
  const [a = 10, b = 10, c = 10] = params.map(v => (Number.isFinite(v) ? v : null)).map((v, i) => v ?? [10, 10, 10][i]);
  const V = [], F = [];
  const quad = (p, q, r, s) => F.push([p, q, r], [p, r, s]);
  const lathe = (profile, closeTop = true) => { // profile: [[radius, z]], revolved around Z
    const n = seg, base = V.length;
    for (const [r, z] of profile) for (let i = 0; i < n; i++) { const t = i / n * Math.PI * 2; V.push([r * Math.cos(t), r * Math.sin(t), z]); }
    for (let k = 0; k + 1 < profile.length; k++) for (let i = 0; i < n; i++) { const j = (i + 1) % n; quad(base + k * n + i, base + k * n + j, base + (k + 1) * n + j, base + (k + 1) * n + i); }
    return closeTop;
  };
  if (kind === 'box') { // a = length (Y), b = width (X), c = height (Z), pivot at the bottom centre
    const x = Math.abs(b) / 2, y = Math.abs(a) / 2, z0 = Math.min(0, c), z1 = Math.max(0, c);
    for (const [px, py, pz] of [[-x, -y, z0], [x, -y, z0], [x, y, z0], [-x, y, z0], [-x, -y, z1], [x, -y, z1], [x, y, z1], [-x, y, z1]]) V.push([px, py, pz]);
    quad(0, 3, 2, 1); quad(4, 5, 6, 7); quad(0, 1, 5, 4); quad(1, 2, 6, 5); quad(2, 3, 7, 6); quad(3, 0, 4, 7);
  } else if (kind === 'sphere' || kind === 'teapot') {
    const r = Math.abs(a) || 10, rings = seg / 2, prof = [];
    for (let k = 0; k <= rings; k++) { const t = -Math.PI / 2 + k / rings * Math.PI; prof.push([r * Math.cos(t), r * Math.sin(t) + (kind === 'teapot' ? r * 0.75 : 0)]); }
    lathe(prof);
    if (kind === 'teapot') { for (const v of V) { v[0] *= 1.25; v[1] *= 1.25; v[2] *= 0.85; } }
  } else if (kind === 'cylinder' || kind === 'cone' || kind === 'tube') {
    const r1 = Math.abs(a), r2 = kind === 'cylinder' ? r1 : Math.abs(b), h = kind === 'cylinder' ? b : c;
    if (kind === 'tube') { const ri = Math.min(r1, r2), ro = Math.max(r1, r2); lathe([[ri, 0], [ro, 0], [ro, h], [ri, h], [ri, 0]]); }
    else { lathe([[0, 0], [r1, 0], [kind === 'cone' ? r2 : r1, h], [0, h]]); }
  } else if (kind === 'torus') {
    const R = Math.abs(a), r = Math.abs(b), n = seg, m = 12;
    for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) { const u = i / n * Math.PI * 2, v = j / m * Math.PI * 2; V.push([(R + r * Math.cos(v)) * Math.cos(u), (R + r * Math.cos(v)) * Math.sin(u), r * Math.sin(v)]); }
    for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) quad(i * m + j, ((i + 1) % n) * m + j, ((i + 1) % n) * m + (j + 1) % m, i * m + (j + 1) % m);
  } else if (kind === 'plane') {
    const x = Math.abs(b) / 2, y = Math.abs(a) / 2; V.push([-x, -y, 0], [x, -y, 0], [x, y, 0], [-x, y, 0]); quad(0, 1, 2, 3);
  }
  return { vertices: V, faces: F };
}

/** All objects in world space as one triangle mesh (Z-up), for viewing and STL/OBJ/GLB/USDZ export. */
export function maxToMesh(result) {
  const vertices = [], faces = [], parts = [];
  for (const o of result.objects) {
    const g = o.primitive ? primitiveMesh(o.primitive, o.params) : o;
    const base = vertices.length, m = o.matrix;
    for (const [x, y, z] of g.vertices) vertices.push([m[0] * x + m[1] * y + m[2] * z + m[3], m[4] * x + m[5] * y + m[6] * z + m[7], m[8] * x + m[9] * y + m[10] * z + m[11]]);
    for (const f of g.faces) if (f[0] < g.vertices.length && f[1] < g.vertices.length && f[2] < g.vertices.length) faces.push([f[0] + base, f[1] + base, f[2] + base]);
    parts.push({ name: o.name, start: base, count: g.vertices.length, faceCount: g.faces.length, color: o.color, primitive: o.primitive || null });
  }
  return { vertices, faces, parts };
}
