// DWG / DXF → ModelLink drawing, using acad-ts (MIT, port of ACadSharp) for parsing.
// The drawing is a flat list of primitives in world coordinates with resolved colours:
//   {type:'line',a,b} {type:'polyline',points,closed,fill} {type:'circle',c,r} {type:'text',p,text,height,rotation}
// plus {layer, color:'#rrggbb'|null}. null colour means "ink" (ACI 7: black on light, white on dark).

import { parseDXF } from './geometry.js';

const MAX_PRIMITIVES = 400000;
const MAX_DEPTH = 12;

function aciHex(color) {
  if (!color) return null;
  try {
    if (color.isTrueColor) return '#' + [color.r, color.g, color.b].map(v => v.toString(16).padStart(2, '0')).join('');
    const i = color.index;
    if (i === 7 || i === 0 || i === 256 || i === 255) return null;
    const rgb = color.constructor.getIndexRGB ? color.constructor.getIndexRGB(i) : [color.r, color.g, color.b];
    if (!rgb || rgb.length < 3) return null;
    if (rgb[0] > 235 && rgb[1] > 235 && rgb[2] > 235) return null; // white → ink
    return '#' + rgb.slice(0, 3).map(v => (v | 0).toString(16).padStart(2, '0')).join('');
  } catch { return null; }
}

/** Parses DWG (AC1012…AC1032) or DXF bytes. `lib` is the acad-ts module. */
export function readCad(lib, bytes, name = '') {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const head = new TextDecoder('latin1').decode(data.subarray(0, 6));
  const isDwg = /^AC\d{4}$/.test(head) || /\.dwg$/i.test(name);
  const notes = [];
  const listener = (_s, e) => { if (e?.message && notes.length < 50) notes.push(String(e.message)); };
  let doc;
  if (isDwg) {
    if (!/^AC10(1[2-9]|2\d|3\d)$/.test(head)) {
      throw new Error(head.startsWith('AC') ? `Версия DWG ${head} не поддерживается (нужен R13–2018+)` : 'Файл не похож на DWG');
    }
    doc = lib.DwgReader.readFromStream(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), listener);
  } else {
    doc = lib.DxfReader.readFromStream(data, listener);
  }
  return { doc, version: isDwg ? head : 'DXF', notes };
}

/** Flattens model space (with nested block references) into primitives. */
export function cadToDrawing(doc, { precision = 48 } = {}) {
  const out = [];
  const layers = new Map();
  let truncated = false;
  const ocs = (p, n) => (n && n.z < -0.5 ? [-p.x, p.y] : [p.x, p.y]); // extrusion (0,0,-1) mirrors X
  const pts = (list, n) => list.map(p => ocs(p, n));
  const push = (prim, ent, inherited) => {
    if (out.length >= MAX_PRIMITIVES) { truncated = true; return; }
    const layer = ent.layer;
    const layerName = layer?.name ?? '0';
    if (!layers.has(layerName)) layers.set(layerName, { name: layerName, color: aciHex(layer?.color), visible: layer ? layer.isOn !== false && !((layer.layerFlags ?? 0) & 1) : true, count: 0 });
    layers.get(layerName).count++;
    let color = null;
    try {
      const own = ent.color;
      if (own && own.isByBlock) color = inherited ?? null;
      else if (own && own.isByLayer) color = aciHex(layer?.color);
      else color = aciHex(own);
    } catch { color = null; }
    prim.layer = layerName; prim.color = color;
    out.push(prim);
  };

  const visit = (ent, depth, inherited) => {
    if (!ent || ent.isInvisible || truncated) return;
    const kind = ent.constructor?.name || '';
    try {
      switch (kind) {
        case 'Line': push({ type: 'line', a: [ent.startPoint.x, ent.startPoint.y], b: [ent.endPoint.x, ent.endPoint.y] }, ent, inherited); return;
        case 'XLine': case 'Ray': return; // infinite construction lines
        case 'Point': { const p = ent.location ?? ent.position; if (p) push({ type: 'circle', c: [p.x, p.y], r: 0, point: true }, ent, inherited); return; }
        case 'Circle': { const [x, y] = ocs(ent.center, ent.normal); push({ type: 'circle', c: [x, y], r: ent.radius }, ent, inherited); return; }
        case 'Arc': push({ type: 'polyline', points: pts(ent.polygonalVertexes(Math.max(8, Math.ceil(precision * Math.abs(ent.sweep ?? Math.PI) / Math.PI))), ent.normal), closed: false }, ent, inherited); return;
        case 'Ellipse': push({ type: 'polyline', points: pts(ent.polygonalVertexes(precision * 2)), closed: !!ent.isFullEllipse }, ent, inherited); return;
        case 'Spline': {
          const r = ent.tryPolygonalVertexes ? ent.tryPolygonalVertexes(precision * 2) : { success: true, points: ent.polygonalVertexes(precision * 2) };
          const list = r.success && r.points?.length ? r.points : (ent.fitPoints?.length ? ent.fitPoints : ent.controlPoints);
          if (list?.length > 1) push({ type: 'polyline', points: pts(list), closed: !!ent.isClosed }, ent, inherited);
          return;
        }
        case 'LwPolyline': { const p = ent.getPoints(precision); if (p.length > 1) push({ type: 'polyline', points: pts(p, ent.normal), closed: ent.isClosed, width: ent.constantWidth || 0 }, ent, inherited); return; }
        case 'Polyline2D': case 'Polyline3D': case 'Polyline': {
          const p = ent.getPoints ? ent.getPoints(precision) : [...ent.vertices].map(v => v.location);
          if (p.length > 1) push({ type: 'polyline', points: pts(p, ent.normal), closed: ent.isClosed }, ent, inherited);
          return;
        }
        case 'Solid': case 'Trace': case 'Face3D': {
          const c = [ent.firstCorner, ent.secondCorner, ent.fourthCorner, ent.thirdCorner].filter(Boolean);
          if (kind === 'Face3D') c.splice(0, 4, ent.firstCorner, ent.secondCorner, ent.thirdCorner, ent.fourthCorner);
          push({ type: 'polyline', points: pts(c, ent.normal), closed: true, fill: kind !== 'Face3D' }, ent, inherited);
          return;
        }
        case 'Hatch': {
          for (const path of ent.paths || []) {
            const p = path.getPoints ? path.getPoints(precision) : [];
            if (p.length > 2) push({ type: 'polyline', points: pts(p, ent.normal), closed: true, fill: !!ent.isSolid, hatch: !ent.isSolid }, ent, inherited);
          }
          return;
        }
        case 'TextEntity': case 'AttributeEntity': {
          const value = ent.value; if (!value) return;
          const base = (ent.horizontalAlignment || ent.verticalAlignment) && ent.alignmentPoint ? ent.alignmentPoint : ent.insertPoint;
          const [x, y] = ocs(base, ent.normal);
          push({ type: 'text', p: [x, y], text: cleanText(value), height: ent.height || 2.5, rotation: ent.rotation || 0, align: alignOf(ent.horizontalAlignment) }, ent, inherited);
          return;
        }
        case 'MText': {
          const text = cleanText(ent.plainText ?? ent.value ?? ''); if (!text) return;
          const lines = text.split('\n'); const h = ent.height || 2.5;
          const rot = ent.rotation ?? (ent.alignmentPoint ? Math.atan2(ent.alignmentPoint.y, ent.alignmentPoint.x) : 0);
          const ap = ent.attachmentPoint || 1; const col = (ap - 1) % 3; const row = Math.floor((ap - 1) / 3);
          const dy = row === 0 ? h : row === 1 ? h - (lines.length - 1) * h * 0.83 : h - (lines.length - 1) * h * 1.66;
          lines.forEach((line, i) => {
            const off = dy - i * h * 1.66;
            const x = ent.insertPoint.x - Math.sin(rot) * off, y = ent.insertPoint.y + Math.cos(rot) * off - h;
            push({ type: 'text', p: [x, y], text: line, height: h, rotation: rot, align: col === 0 ? 'left' : col === 1 ? 'center' : 'right' }, ent, inherited);
          });
          return;
        }
        case 'Insert': {
          if (depth >= MAX_DEPTH || !ent.block) return;
          const color = ent.color?.isByLayer ? aciHex(ent.layer?.color) : ent.color?.isByBlock ? inherited : aciHex(ent.color);
          for (const child of ent.explode()) visit(child, depth + 1, color);
          for (const att of ent.attributes || []) visit(att, depth + 1, color);
          return;
        }
        case 'Wipeout': case 'Viewport': case 'AttributeDefinition': case 'Solid3D': case 'Region': case 'Body': return;
        default:
          if (kind.startsWith('Dimension') || kind === 'Leader' || kind === 'MultiLeader' || kind === 'Tolerance') {
            const block = ent.block;
            if (block && depth < MAX_DEPTH) for (const child of block.entities || []) visit(child, depth + 1, aciHex(ent.color));
          }
      }
    } catch { /* one malformed entity must not hide the drawing */ }
  };

  for (const ent of doc.modelSpace?.entities || []) visit(ent, 0, null);
  return finish(out, [...layers.values()], truncated);
}

function alignOf(h) { return h === 1 || h === 4 ? 'center' : h === 2 ? 'right' : 'left'; }
/** UTF-8 text decoded as ANSI_1252 (DXF without $DWGCODEPAGE) looks like "ÐŸÑ€Ð¸": re-decode it. */
export function fixMojibake(s) {
  if (!/[\u00C0-\u00FF][\u0080-\u00BF\u0152-\u2122]/.test(s)) return s;
  const cp1252 = { 0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A, 0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92, 0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C, 0x017E: 0x9E, 0x0178: 0x9F };
  const bytes = [];
  for (const ch of s) { const c = ch.codePointAt(0); if (c < 256) bytes.push(c); else if (cp1252[c]) bytes.push(cp1252[c]); else return s; }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes)); } catch { return s; }
}
function cleanText(s) {
  return fixMojibake(String(s))
    .replace(/\\P/g, '\n').replace(/\\[ACFHQTW][^;]*;/g, '').replace(/\\[LlOoKk]/g, '').replace(/[{}]/g, '')
    .replace(/%%[cC]/g, 'Ø').replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±').replace(/\\~/g, ' ')
    .slice(0, 2000);
}

/** Bounds from the dense part of the drawing (outliers far away would shrink the plan to a dot). */
export function finish(entities, layers, truncated = false) {
  const boxes = [];
  for (const e of entities) {
    if (e.type === 'polyline' && e.points.length > 4000) { const k = Math.ceil(e.points.length / 4000); e.points = e.points.filter((_, i) => i % k === 0 || i === e.points.length - 1); }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const add = (x, y) => { if (Number.isFinite(x) && Number.isFinite(y)) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } };
    if (e.type === 'line') { add(...e.a); add(...e.b); }
    else if (e.type === 'polyline') for (const p of e.points) add(p[0], p[1]);
    else if (e.type === 'circle') { add(e.c[0] - e.r, e.c[1] - e.r); add(e.c[0] + e.r, e.c[1] + e.r); }
    else if (e.type === 'text') { add(...e.p); add(e.p[0] + e.height * e.text.length * 0.6, e.p[1] + e.height); }
    if (x0 <= x1) boxes.push([x0, y0, x1, y1]);
  }
  if (!boxes.length) throw new Error('В чертеже нет видимой 2D-геометрии в пространстве модели');
  const q = (arr, f) => { const s = Float64Array.from(arr).sort(); return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * f)))]; };
  const full = i => [Math.min(...boxes.map(b => b[i])), Math.max(...boxes.map(b => b[i + 2]))];
  // Trim objects lying far from everything else (a stray point 1000 km away would shrink the plan to a dot).
  const pick = i => {
    const f = full(i); if (boxes.length < 20) return f;
    const lo = q(boxes.map(b => b[i]), 0.05), hi = q(boxes.map(b => b[i + 2]), 0.95), span = (hi - lo) || 1;
    if (f[1] - f[0] <= span * 6) return f;
    return [Math.max(f[0], lo - span * 0.1), Math.min(f[1], hi + span * 0.1)];
  };
  const [minX, maxX] = pick(0), [minY, maxY] = pick(1);
  return { entities, layers: layers.sort((a, b) => b.count - a.count), bounds: { minX, minY, maxX, maxY }, truncated };
}

/** Pale CAD colours (yellow, cyan, light grey) are unreadable on white: darken them for light backgrounds. */
export function inkOnLight(hex) {
  if (!hex) return hex;
  const n = parseInt(hex.slice(1), 16), r = n >> 16 & 255, g = n >> 8 & 255, b = n & 255;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  if (lum < 0.55) return hex;
  const k = 0.55 / lum * 0.8;
  return '#' + [r, g, b].map(v => Math.round(v * k).toString(16).padStart(2, '0')).join('');
}

const UNIT_NAMES = { 1: 'дюйм', 2: 'фут', 3: 'миля', 4: 'мм', 5: 'см', 6: 'м', 7: 'км', 8: 'микродюйм', 9: 'мил', 10: 'ярд', 14: 'дм' };

/**
 * One entry point for the worker and the main-thread fallback.
 * op 'drawing' → {drawing}; op 'dxf' → {bytes} (DWG/DXF re-written as ASCII DXF).
 */
export function cadOp(lib, op, bytes, name = '') {
  const isDxf = /\.dxf$/i.test(name);
  let parsed;
  try { parsed = readCad(lib, bytes, name); }
  catch (e) {
    if (op === 'drawing' && isDxf) { // very old or hand-made DXF: fall back to the simple reader
      const d = parseDXF(new TextDecoder().decode(bytes));
      return { drawing: { ...d, layers: d.layers.map(n => ({ name: n, color: null, visible: true, count: 0 })), version: 'DXF', units: null, truncated: false } };
    }
    throw e;
  }
  if (op === 'dxf') {
    let size = Math.max(4 << 20, bytes.byteLength * 12);
    for (let attempt = 0; attempt < 3; attempt++, size *= 3) {
      const out = new Uint8Array(size);
      try {
        new lib.DxfWriter(out, parsed.doc).write();
        let n = out.length; while (n > 0 && out[n - 1] === 0) n--;
        if (n < out.length - 16) return { bytes: out.slice(0, n) };
      } catch (e) { if (!/range|bounds|offset/i.test(e.message)) throw e; }
    }
    throw new Error('Чертёж слишком большой для экспорта в DXF');
  }
  const drawing = cadToDrawing(parsed.doc);
  const unitCode = parsed.doc.header?.insUnits;
  drawing.version = parsed.version;
  drawing.units = UNIT_NAMES[unitCode] || null;
  drawing.notes = parsed.notes.slice(0, 5);
  return { drawing };
}

export function versionLabel(v) {
  return ({ AC1012: 'R13', AC1014: 'R14', AC1015: '2000', AC1018: '2004', AC1021: '2007', AC1024: '2010', AC1027: '2013', AC1032: '2018+' })[v] || v || '';
}
