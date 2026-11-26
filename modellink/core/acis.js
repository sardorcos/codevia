// Wireframe of ACIS bodies (REGION, 3DSOLID, BODY in DWG/DXF): edges → polylines.
// DWG stores the modeler data as SAT text (up to AutoCAD 2012) or SAB binary ("ACIS BinaryFile" / "ASM BinaryFile4", 2013+).
// Only the topology needed for drawing is read: body → transform, edge → vertices + curve, vertex → point.
// Straight and elliptical (circle, arc, ellipse) edges are exact; spline edges are drawn through their control points
// when they can be found, otherwise as a chord.

const TAG = { INT: 0x04, DOUBLE: 0x06, STR: 0x07, TRUE: 0x0a, FALSE: 0x0b, PTR: 0x0c, TYPE: 0x0d, TYPE_EX: 0x0e, SUB_START: 0x0f, SUB_END: 0x10, END: 0x11, LITERAL: 0x12, LOCATION: 0x13, DIRECTION: 0x14, ENUM: 0x15, DOUBLE2: 0x17 };

/** SAT text → [{name, tokens}] where a token is {p:index} | {n:number} | {s:string}. */
export function parseSat(text) {
  const lines = String(text).replace(/\r/g, '');
  // Header: three lines (counts; product, version, date; units and tolerances). The date line holds length-prefixed strings.
  let pos = 0; for (let i = 0; i < 3; i++) { const nl = lines.indexOf('\n', pos); if (nl < 0) return []; pos = nl + 1; }
  const body = lines.slice(pos), records = [];
  let i = 0; const n = body.length;
  let tokens = [], name = null;
  const flush = () => { if (name) records.push({ name, tokens }); tokens = []; name = null; };
  while (i < n) {
    const c = body[i];
    if (c === ' ' || c === '\n' || c === '\t') { i++; continue; }
    if (c === '#') { flush(); i++; continue; }
    let j = i; while (j < n && body[j] !== ' ' && body[j] !== '\n' && body[j] !== '\t') j++;
    const tok = body.slice(i, j); i = j;
    if (tok[0] === '@' && /^@\d+$/.test(tok)) { const len = Number(tok.slice(1)); tokens.push({ s: body.slice(i + 1, i + 1 + len) }); i += 1 + len; continue; } // "@7 unknown"
    if (name === null) { if (/^-\d+$/.test(tok)) continue; name = tok; continue; } // optional explicit record number ("-12 body …")
    if (tok[0] === '$') { tokens.push({ p: Number(tok.slice(1)) }); continue; }
    const v = Number(tok);
    tokens.push(Number.isFinite(v) && /^[-+.\d]/.test(tok) ? { n: v } : { s: tok });
  }
  flush();
  if (records.length && records[records.length - 1].name.startsWith('End-of-')) records.pop();
  return records;
}

/** SAB binary → the same record list (integers are kept apart from doubles: {i:int}). */
export function parseSab(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  const sig = String.fromCharCode(...u.subarray(0, 15));
  if (sig !== 'ACIS BinaryFile' && sig !== 'ASM BinaryFile4') return [];
  let o = 15 + 16; // signature, then version, record count, entity count, flags
  const str = len => { let s = ''; for (let k = 0; k < len; k++) s += String.fromCharCode(u[o + k]); o += len; return s; };
  for (let k = 0; k < 3 && u[o] === TAG.STR; k++) { o++; const len = u[o++]; o += len; } // product, modeler version, date
  for (let k = 0; k < 3 && u[o] === TAG.DOUBLE; k++) o += 9; // units, tolerances
  const records = []; let name = null, tokens = [], prefix = '';
  while (o < u.length) {
    const tag = u[o++];
    if (tag === TAG.TYPE || tag === TAG.TYPE_EX) {
      const s = str(u[o++]);
      if (name !== null) { tokens.push({ s }); continue; } // type name inside a record (subtype data)
      if (tag === TAG.TYPE_EX) { prefix += s + '-'; continue; }
      name = prefix + s; prefix = ''; continue;
    }
    if (tag === TAG.END) { if (name !== null) records.push({ name, tokens }); name = null; tokens = []; prefix = ''; continue; }
    if (tag === TAG.PTR) { tokens.push({ p: dv.getInt32(o, true) }); o += 4; }
    else if (tag === TAG.INT || tag === TAG.ENUM) { tokens.push({ i: dv.getInt32(o, true) }); o += 4; }
    else if (tag === TAG.DOUBLE || tag === TAG.DOUBLE2) { tokens.push({ n: dv.getFloat64(o, true) }); o += 8; }
    else if (tag === TAG.LOCATION || tag === TAG.DIRECTION) { for (let k = 0; k < 3; k++) { tokens.push({ n: dv.getFloat64(o, true) }); o += 8; } }
    else if (tag === TAG.STR) tokens.push({ s: str(u[o++]) });
    else if (tag === TAG.LITERAL) { const len = dv.getUint32(o, true); o += 4; tokens.push({ s: str(len), literal: true }); }
    else if (tag === TAG.TRUE) tokens.push({ b: true });
    else if (tag === TAG.FALSE) tokens.push({ b: false });
    else if (tag === TAG.SUB_START) tokens.push({ s: '{' });
    else if (tag === TAG.SUB_END) tokens.push({ s: '}' });
    else break; // unknown tag: stop instead of reading garbage
  }
  return records;
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = a => Math.hypot(a[0], a[1], a[2]);

/** Numbers that follow the last pointer of a record (coordinates and directions; ids and pointers come first). */
function tail(rec) {
  let last = -1; rec.tokens.forEach((t, k) => { if (t.p !== undefined) last = k; });
  const out = []; for (let k = last + 1; k < rec.tokens.length; k++) { const t = rec.tokens[k]; if (t.n !== undefined) out.push(t.n); else if (t.literal) for (const w of t.s.trim().split(/\s+/)) { const v = Number(w); if (Number.isFinite(v)) out.push(v); } }
  return out;
}

/**
 * Edges of an ACIS body as 3D polylines in the entity's coordinate system.
 * `data` is SAT text (string) or SAB bytes (Uint8Array). Returns {paths:[[[x,y,z],…]], splines}.
 */
export function acisWireframe(data, { precision = 48 } = {}) {
  const records = typeof data === 'string' ? parseSat(data) : parseSab(data);
  const at = p => (p !== undefined && p >= 0 ? records[p] : undefined);
  // Body transform: p' = (p · R) · scale + t, rows of R first, then the translation and the scale.
  let T = null;
  for (const r of records) if (r.name === 'transform') { const v = tail(r); if (v.length >= 12) T = v; break; }
  const tr = p => { if (!T) return p; const s = T[12] > 0 ? T[12] : 1; return [(p[0] * T[0] + p[1] * T[3] + p[2] * T[6]) * s + T[9], (p[0] * T[1] + p[1] * T[4] + p[2] * T[7]) * s + T[10], (p[0] * T[2] + p[1] * T[5] + p[2] * T[8]) * s + T[11]]; };
  const pointOf = vertex => { if (!vertex) return null; for (const t of vertex.tokens) { const r = at(t.p); if (r && r.name === 'point') { const v = tail(r); return v.length >= 3 ? v.slice(0, 3) : null; } } return null; };
  const paths = []; let splines = 0;
  for (const rec of records) {
    if (rec.name !== 'edge') continue;
    const verts = []; let curve = null, sense = false, seenCurve = false;
    for (const t of rec.tokens) {
      if (t.p !== undefined) { const r = at(t.p); if (!r) continue; if (r.name === 'vertex' && verts.length < 2) verts.push(r); else if (r.name.endsWith('curve') && !seenCurve) { curve = r; seenCurve = true; } }
      else if (seenCurve) { if (t.b !== undefined) { sense = t.b; break; } if (t.s === 'forward' || t.s === 'reversed') { sense = t.s === 'reversed'; break; } }
    }
    const a = pointOf(verts[0]), b = pointOf(verts[1] || verts[0]);
    if (!a || !b) continue;
    const closed = verts.length < 2 || verts[0] === verts[1] || len(sub(a, b)) < 1e-12;
    let pts = null;
    if (curve && curve.name === 'ellipse-curve') {
      const v = tail(curve);
      if (v.length >= 10) {
        const c = v.slice(0, 3), nrm = v.slice(3, 6), major = v.slice(6, 9), ratio = v[9] || 1, ra = len(major), rb = ra * ratio;
        const ux = major.map(x => x / (ra || 1)), nl = len(nrm) || 1, vy = cross(nrm.map(x => x / nl), ux);
        const ang = p => { const d = sub(p, c); return Math.atan2(dot(d, vy) / (rb || 1), dot(d, ux) / (ra || 1)); };
        const t0 = ang(a); let sweep;
        if (closed) sweep = Math.PI * 2; else { sweep = ang(b) - t0; if (!sense) { while (sweep <= 1e-12) sweep += Math.PI * 2; } else { while (sweep >= -1e-12) sweep -= Math.PI * 2; } }
        const steps = Math.max(4, Math.ceil(precision * Math.abs(sweep) / Math.PI));
        pts = Array.from({ length: steps + 1 }, (_, k) => { const t = t0 + sweep * k / steps, cs = Math.cos(t) * ra, sn = Math.sin(t) * rb; return [c[0] + ux[0] * cs + vy[0] * sn, c[1] + ux[1] * cs + vy[1] * sn, c[2] + ux[2] * cs + vy[2] * sn]; });
        if (!closed) { pts[0] = a; pts[pts.length - 1] = b; }
      }
    } else if (curve && curve.name === 'intcurve-curve') {
      splines++;
      pts = splineControl(curve, a, b);
    }
    if (!pts) { if (closed) continue; pts = [a, b]; }
    paths.push(pts.map(tr));
  }
  return { paths, splines };
}

/** Control polygon of a spline edge ("nubs"/"nurbs" block of an intcurve), trimmed to the edge ends; null when not found. */
function splineControl(curve, a, b) {
  const tk = curve.tokens, k0 = tk.findIndex(t => t.s === 'nubs' || t.s === 'nurbs'); if (k0 < 0) return null;
  const rational = tk[k0].s === 'nurbs';
  // nubs <degree> <open|closed|periodic> <knot count> (knot multiplicity)… then control points
  let k = k0 + 1; const nums = [];
  for (; k < tk.length; k++) { const t = tk[k]; if (t.n !== undefined) nums.push(t.n); else if (t.i !== undefined) nums.push(t.i); else if (t.s === '}' || t.s === '{') break; }
  if (nums.length < 4) return null;
  const degree = nums[0], knotCount = nums[1]; let q = 2, total = 0;
  for (let j = 0; j < knotCount && q + 1 < nums.length; j++, q += 2) total += nums[q + 1];
  const count = total - degree + 1, dim = rational ? 4 : 3;
  if (!(count >= 2) || q + count * dim > nums.length) return null;
  const pts = []; for (let j = 0; j < count; j++) pts.push([nums[q + j * dim], nums[q + j * dim + 1], nums[q + j * dim + 2]]);
  const d = (p, r) => len(sub(p, r));
  if (d(pts[0], a) > d(pts[0], b)) pts.reverse();
  pts[0] = a; pts[pts.length - 1] = b;
  return pts;
}
