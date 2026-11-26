// DWG / DXF → ModelLink drawing, using acad-ts (MIT, port of ACadSharp) for parsing.
// The drawing is a flat list of primitives in world coordinates with resolved colours:
//   {type:'line',a,b} {type:'polyline',points,closed,fill} {type:'circle',c,r} {type:'text',p,text,height,rotation}
// plus {layer, color:'#rrggbb'|null}. null colour means "ink" (ACI 7: black on light, white on dark).

import { parseDXF } from './geometry.js';
import { acisWireframe } from './acis.js';

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
  const skipped = {}, errors = {}, xlines = [];
  const arrow = (from, tip, size, ent, inherited) => { const dx = tip[0] - from[0], dy = tip[1] - from[1], l = Math.hypot(dx, dy) || 1, ux = dx / l, uy = dy / l, w = size / 3; push({ type: 'polyline', points: [tip, [tip[0] - ux * size + uy * w, tip[1] - uy * size - ux * w], [tip[0] - ux * size - uy * w, tip[1] - uy * size + ux * w]], closed: true, fill: true }, ent, inherited); };
  const ocs = (p, n) => (n && n.z < -0.5 ? [-p.x, p.y] : [p.x, p.y]); // extrusion (0,0,-1) mirrors X
  const pts = (list, n) => list.map(p => ocs(p, n));
  const ltGlobal = Number(doc.header?.lineTypeScale) > 0 ? Number(doc.header.lineTypeScale) : 1;
  const dashOf = ent => {
    try {
      const lt = ent.getActiveLineType ? ent.getActiveLineType() : ent.lineType;
      const segs = lt?.segments; if (!segs || segs.length < 2) return null;
      const k = ltGlobal * (Number(ent.lineTypeScale) > 0 ? Number(ent.lineTypeScale) : 1);
      const total = segs.reduce((a, g) => a + Math.abs(g.length || 0), 0); if (!(total > 0)) return null;
      const dash = segs.map(g => Math.max(Math.abs(g.length || 0), total * 0.03) * k);
      if (dash.length % 2) dash.push(total * 0.03 * k);
      return dash;
    } catch { return null; }
  };
  // Block references are drawn with our own affine transform (x' = a·x + c·y + e, y' = b·x + d·y + f) instead of
  // Insert.explode(): one child that cannot be cloned/transformed by the library must not hide the whole block.
  let M = null, hatchLines = 0;
  const mul = (A, B) => [A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1], A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3], A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5]];
  const tp = q => [M[0] * q[0] + M[2] * q[1] + M[4], M[1] * q[0] + M[3] * q[1] + M[5]];
  const transform = prim => {
    const sx = Math.hypot(M[0], M[1]), sy = Math.hypot(M[2], M[3]), det = M[0] * M[3] - M[1] * M[2], k = Math.sqrt(Math.abs(det)) || 1;
    if (prim.type === 'line') { prim.a = tp(prim.a); prim.b = tp(prim.b); }
    else if (prim.type === 'polyline') prim.points = prim.points.map(tp);
    else if (prim.type === 'circle') {
      if (prim.r > 0 && Math.abs(sx - sy) > 1e-6 * Math.max(sx, sy)) { // non-uniform scale: circle → ellipse outline
        const n = 72, c = prim.c, r = prim.r; prim.type = 'polyline'; prim.closed = true; delete prim.c; delete prim.r;
        prim.points = Array.from({ length: n }, (_, i) => tp([c[0] + r * Math.cos(i / n * 2 * Math.PI), c[1] + r * Math.sin(i / n * 2 * Math.PI)]));
      } else { prim.c = tp(prim.c); prim.r *= sx; }
    } else if (prim.type === 'text') {
      const r = prim.rotation || 0; let dx = M[0] * Math.cos(r) + M[2] * Math.sin(r), dy = M[1] * Math.cos(r) + M[3] * Math.sin(r);
      const ux = -M[0] * Math.sin(r) + M[2] * Math.cos(r), uy = -M[1] * Math.sin(r) + M[3] * Math.cos(r);
      const dl = Math.hypot(dx, dy) || 1, ul = Math.hypot(ux, uy) || 1;
      prim.p = tp(prim.p);
      if (det < 0) { dx = -dx; dy = -dy; prim.align = prim.align === 'left' ? 'right' : prim.align === 'right' ? 'left' : prim.align; } // mirrored block: keep text readable
      prim.rotation = Math.atan2(dy, dx); prim.width = (prim.width || 1) * dl / ul; prim.height *= ul;
    }
    if (prim.dash) prim.dash = prim.dash.map(v => v * k);
    if (prim.width && prim.type === 'polyline') prim.width *= k;
  };
  const push = (prim, ent, inh) => {
    if (out.length >= MAX_PRIMITIVES) { truncated = true; return; }
    if (prim.type !== 'text' && !prim.fill) { const d = dashOf(ent); if (d) prim.dash = d; }
    if (M) transform(prim);
    let layer = ent.layer;
    if (inh?.layer && (!layer || layer.name === '0')) layer = inh.layer; // layer 0 inside a block takes the layer of the reference
    const layerName = layer?.name ?? '0';
    if (!layers.has(layerName)) layers.set(layerName, { name: layerName, color: aciHex(layer?.color), visible: layer ? layer.isOn !== false && !((layer.layerFlags ?? 0) & 1) : true, count: 0 });
    layers.get(layerName).count++;
    let color = null;
    try {
      const own = ent.color;
      if (prim.color !== undefined) color = prim.color; // inline colour (MTEXT \C)
      else if (own && own.isByBlock) color = inh?.color ?? null;
      else if (own && own.isByLayer) color = aciHex(layer?.color);
      else color = aciHex(own);
    } catch { color = null; }
    prim.layer = layerName; prim.color = color;
    out.push(prim);
  };

  const refStyle = (ent, inh) => { // colour and layer that a block / dimension reference hands down to its content
    let layer = ent.layer; if (inh?.layer && (!layer || layer.name === '0')) layer = inh.layer;
    let color = null; try { const own = ent.color; color = own?.isByBlock ? (inh?.color ?? null) : !own || own.isByLayer ? aciHex(layer?.color) : aciHex(own); } catch { /* ink */ }
    return { color, layer };
  };
  const visit = (ent, depth, inherited) => {
    if (!ent || ent.isInvisible || truncated) return;
    const kind = ent.constructor?.name || '';
    try {
      switch (kind) {
        case 'Line': push({ type: 'line', a: [ent.startPoint.x, ent.startPoint.y], b: [ent.endPoint.x, ent.endPoint.y] }, ent, inherited); return;
        case 'XLine': case 'Ray': if (ent.firstPoint && ent.direction) { const p0 = [ent.firstPoint.x, ent.firstPoint.y], p1 = [p0[0] + ent.direction.x, p0[1] + ent.direction.y], a = M ? tp(p0) : p0, b = M ? tp(p1) : p1; xlines.push({ p: a, d: [b[0] - a[0], b[1] - a[1]], ray: kind === 'Ray', ent, inherited }); } return;
        case 'MLine': {
          const verts = ent.vertices || []; const n = Math.max(0, ...verts.map(v => v.segments?.length || 0)); const closed = ((ent.flags ?? 0) & 2) !== 0;
          for (let k = 0; k < n; k++) { const pts2 = verts.map(v => { const off = v.segments?.[k]?.parameters?.[0] ?? 0; return [v.position.x + v.miter.x * off, v.position.y + v.miter.y * off]; }); if (pts2.length > 1) push({ type: 'polyline', points: pts2, closed }, ent, inherited); }
          return;
        }
        case 'Leader': {
          const v = (ent.vertices || []).map(q => [q.x, q.y]); if (v.length < 2) return;
          push({ type: 'polyline', points: v, closed: false }, ent, inherited);
          if (ent.arrowHeadEnabled !== false) arrow(v[1], v[0], (ent.style?.arrowSize || 2.5) * (ent.style?.scaleFactor || 1), ent, inherited);
          return;
        }
        case 'MultiLeader': {
          const cd = ent.contextData; if (!cd) return; const size = (ent.arrowheadSize || cd.arrowheadSize || 2.5) * (cd.scaleFactor || 1);
          for (const root of cd.leaderRoots || []) for (const line of root.lines || []) {
            const v = (line.points || []).map(q => [q.x, q.y]); if (root.connectionPoint) v.push([root.connectionPoint.x, root.connectionPoint.y]);
            if (v.length > 1) { push({ type: 'polyline', points: v, closed: false }, ent, inherited); arrow(v[1], v[0], size, ent, inherited); }
          }
          const label = cleanText(cd.textLabel || ''); if (label && cd.textLocation) {
            const th = cd.textHeight || 2.5; const ls = label.split('\n');
            ls.forEach((t, i) => push({ type: 'text', p: [cd.textLocation.x, cd.textLocation.y - th - i * th * 1.667], text: t, height: th, rotation: cd.textRotation || 0, align: 'left' }, ent, inherited));
          }
          return;
        }
        case 'Tolerance': { const t = cleanText(String(ent.text || '').replace(/%%v/gi, ' | ')); if (t && ent.insertionPoint) push({ type: 'text', p: [ent.insertionPoint.x, ent.insertionPoint.y], text: t, height: (ent.style?.textHeight || 2.5) * (ent.style?.scaleFactor || 1), rotation: ent.direction ? Math.atan2(ent.direction.y, ent.direction.x) : 0, align: 'left', valign: 'middle' }, ent, inherited); return; }
        case 'Mesh': { const v = ent.vertices || []; for (const f of ent.faces || []) { const q = f.map(i => v[i]).filter(Boolean).map(p => [p.x, p.y]); if (q.length > 1) push({ type: 'polyline', points: q, closed: true }, ent, inherited); } return; }
        case 'PolyfaceMesh': {
          const verts = [...(ent.vertices || [])].map(x => x.location).filter(Boolean);
          for (const f of ent.faces || []) { const idx = [f.index1, f.index2, f.index3, f.index4].filter(i => i); const q = idx.map(i => verts[Math.abs(i) - 1]).filter(Boolean).map(p => [p.x, p.y]); if (q.length > 1) push({ type: 'polyline', points: q, closed: true }, ent, inherited); }
          return;
        }
        case 'RasterImage': case 'PdfUnderlay': case 'DwfUnderlay': case 'DgnUnderlay': {
          if (ent.insertPoint && ent.uVector && ent.vVector && ent.size) { const o = ent.insertPoint, u = ent.uVector, w = ent.vVector, sx = ent.size.x, sy = ent.size.y; push({ type: 'polyline', points: [[o.x, o.y], [o.x + u.x * sx, o.y + u.y * sx], [o.x + u.x * sx + w.x * sy, o.y + u.y * sx + w.y * sy], [o.x + w.x * sy, o.y + w.y * sy]], closed: true }, ent, inherited); }
          skipped[kind] = (skipped[kind] || 0) + 1; return;
        }
        case 'Point': { if (inherited?.dim || /^defpoints$/i.test(ent.layer?.name || '')) return; const p = ent.location ?? ent.position; if (p) push({ type: 'circle', c: [p.x, p.y], r: 0, point: true }, ent, inherited); return; }
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
          const loops = [];
          for (const path of ent.paths || []) { const p = path.getPoints ? path.getPoints(precision) : []; if (p.length > 2) loops.push(pts(p, ent.normal)); }
          if (!loops.length) return;
          if (ent.isSolid) { for (const l of loops) push({ type: 'polyline', points: l, closed: true, fill: true }, ent, inherited); return; }
          // Pattern hatch: real pattern lines when their number is sane, otherwise a light tint of the area.
          let lines = null;
          try {
            const bb = ent.getBoundingBox?.(), diag = bb ? Math.hypot(bb.max.x - bb.min.x, bb.max.y - bb.min.y) : 0;
            const est = (ent.pattern?.lines || []).reduce((a, l) => a + (Math.abs(l.lineOffset) > 1e-9 ? diag / Math.abs(l.lineOffset) : Infinity), 0);
            if (est > 0 && est < 1500 && hatchLines < 80000 && !(ent.normal && ent.normal.z < -0.5)) lines = ent.explodePattern();
          } catch { lines = null; }
          if (lines && lines.length) { hatchLines += lines.length; for (const l of lines) push({ type: 'line', a: [l.startPoint.x, l.startPoint.y], b: [l.endPoint.x, l.endPoint.y], hatch: true }, ent, inherited); }
          else for (const l of loops) push({ type: 'polyline', points: l, closed: true, fill: true, hatch: true }, ent, inherited);
          return;
        }
        case 'TextEntity': case 'AttributeEntity': {
          const value = ent.value; if (!value) return;
          const ha = ent.horizontalAlignment || 0, va = ent.verticalAlignment || 0;
          const hasAlign = (ha || va) && ent.alignmentPoint && (ent.alignmentPoint.x || ent.alignmentPoint.y);
          let base = hasAlign ? ent.alignmentPoint : ent.insertPoint, align = alignOf(ha), valign = ['alphabetic', 'bottom', 'middle', 'top'][va] || 'alphabetic', rotation = ent.rotation || 0;
          if ((ha === 3 || ha === 5) && hasAlign) { // Aligned / Fit: text spans insert → alignment point
            base = { x: (ent.insertPoint.x + ent.alignmentPoint.x) / 2, y: (ent.insertPoint.y + ent.alignmentPoint.y) / 2 };
            rotation = Math.atan2(ent.alignmentPoint.y - ent.insertPoint.y, ent.alignmentPoint.x - ent.insertPoint.x); align = 'center';
          }
          if (ha === 4) valign = 'middle';
          const [x, y] = ocs(base, ent.normal);
          push({ type: 'text', p: [x, y], text: cleanText(value).replace(/\n/g, ' '), height: ent.height || 2.5, rotation, align, valign, width: ent.widthFactor || 1 }, ent, inherited);
          return;
        }
        case 'MText': {
          const text = cleanText(ent.plainText ?? ent.value ?? ''); if (!text) return;
          const h = ent.height || 2.5, boxW = ent.rectangleWidth || 0;
          const lines = [];
          for (const para of text.split('\n')) { // wrap to the MTEXT frame width (approximate glyph width)
            if (!(boxW > 0)) { lines.push(para); continue; }
            const max = Math.max(1, Math.floor(boxW / (h * 0.62)));
            let cur = '';
            for (const word of para.split(' ')) { if (cur && (cur + ' ' + word).length > max) { lines.push(cur); cur = word; } else cur = cur ? cur + ' ' + word : word; }
            lines.push(cur);
          }
          const rot = ent.rotation ?? (ent.alignmentPoint ? Math.atan2(ent.alignmentPoint.y, ent.alignmentPoint.x) : 0);
          const ap = ent.attachmentPoint || 1; const col = (ap - 1) % 3; const row = Math.floor((ap - 1) / 3);
          const gap = h * 1.667 * (ent.lineSpacing > 0 ? ent.lineSpacing : 1), H = h + (lines.length - 1) * gap;
          const first = row === 0 ? -h : row === 1 ? H / 2 - h : H - h; // baseline of line 1 relative to the attachment point (Y up)
          const inline = mtextColor(ent.value);
          lines.forEach((line, i) => {
            const off = first - i * gap;
            const x = ent.insertPoint.x - Math.sin(rot) * off, y = ent.insertPoint.y + Math.cos(rot) * off;
            const prim = { type: 'text', p: [x, y], text: line, height: h, rotation: rot, align: col === 0 ? 'left' : col === 1 ? 'center' : 'right' };
            if (inline !== undefined) prim.color = inline;
            push(prim, ent, inherited);
          });
          return;
        }
        case 'Insert': case 'TableEntity': {
          if (depth >= MAX_DEPTH || !ent.block) return;
          const style = refStyle(ent, inherited);
          const sx = Number.isFinite(ent.xScale) && ent.xScale ? ent.xScale : 1, sy = Number.isFinite(ent.yScale) && ent.yScale ? ent.yScale : 1, r = ent.rotation || 0;
          const co = Math.cos(r), si = Math.sin(r), bp = ent.block.blockEntity?.basePoint ?? { x: 0, y: 0 }, ip = ent.insertPoint ?? { x: 0, y: 0 };
          const mirror = ent.normal && ent.normal.z < -0.5 ? -1 : 1; // extrusion (0,0,-1): the reference lives in a mirrored OCS
          const A = co * sx, B = si * sx, C = -si * sy, D = co * sy;
          const cols = Math.max(1, Math.min(200, ent.columnCount | 0 || 1)), rows = Math.max(1, Math.min(200, ent.rowCount | 0 || 1));
          const saved = M;
          let list; try { list = ent.block.getSortedEntities ? ent.block.getSortedEntities() : [...(ent.block.entities || [])]; } catch { list = [...(ent.block.entities || [])]; }
          try {
            for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
              const ox = i * (ent.columnSpacing || 0), oy = j * (ent.rowSpacing || 0); // MINSERT grid, in the rotated frame of the reference
              const ex = ip.x + co * ox - si * oy - (A * bp.x + C * bp.y), ey = ip.y + si * ox + co * oy - (B * bp.x + D * bp.y);
              const L = [mirror * A, B, mirror * C, D, mirror * ex, ey];
              M = saved ? mul(saved, L) : L;
              for (const child of list) visit(child, depth + 1, style);
            }
          } finally { M = saved; }
          for (const att of ent.attributes || []) visit(att, depth + 1, style);
          return;
        }
        case 'Wipeout': case 'Viewport': case 'AttributeDefinition': return;
        case 'Solid3D': case 'Region': case 'Body': { // ACIS bodies: draw the edges (regions are flat, solids are seen from the top)
          let paths = [];
          try { const data = ent.isBinaryAcisData ? ent.acisData : ent.getAcisText?.(); if (data && data.length) paths = acisWireframe(data, { precision }).paths; } catch { paths = []; }
          if (!paths.length) { skipped[kind] = (skipped[kind] || 0) + 1; return; }
          for (const path of paths) if (path.length > 1) push({ type: 'polyline', points: path.map(q => [q[0], q[1]]), closed: false }, ent, inherited);
          return;
        }
        case 'Shape': case 'Ole2Frame': skipped[kind] = (skipped[kind] || 0) + 1; return;
        default:
          if (kind.startsWith('Dimension')) {
            const block = ent.block;
            if (block && depth < MAX_DEPTH) { const style = { ...refStyle(ent, inherited), dim: true }; for (const child of block.entities || []) visit(child, depth + 1, style); }
            else skipped[kind] = (skipped[kind] || 0) + 1;
          } else if (kind) skipped[kind] = (skipped[kind] || 0) + 1;
      }
    } catch { errors[kind] = (errors[kind] || 0) + 1; /* one malformed entity must not hide the drawing */ }
  };

  for (const ent of doc.modelSpace?.entities || []) visit(ent, 0, null);
  let space = 'model';
  if (!out.length && doc.paperSpace) { // drawing lives only on a sheet
    for (const ent of doc.paperSpace.entities || []) if (ent.constructor?.name !== 'Viewport') visit(ent, 0, null);
    space = 'paper';
  }
  const d = finish(out, [...layers.values()], truncated); d.space = space;
  if (xlines.length) { // construction lines: long segments through the drawing extents (not counted in the bounds)
    const b = d.bounds, L = Math.hypot(b.maxX - b.minX, b.maxY - b.minY) * 3 || 1000;
    for (const x of xlines) { const l = Math.hypot(...x.d) || 1, u = [x.d[0] / l, x.d[1] / l]; const a = x.ray ? x.p : [x.p[0] - u[0] * L, x.p[1] - u[1] * L]; push({ type: 'line', a, b: [x.p[0] + u[0] * L, x.p[1] + u[1] * L], construction: true }, x.ent, x.inherited); }
  }
  d.skipped = skipped; d.errors = errors;
  return d;
}

/** First inline colour of an MTEXT value: \C<aci>; or \c<b<<16|g<<8|r>; → '#rrggbb', null (ink) or undefined (none). */
export function mtextColor(value) {
  const m = /\\([Cc])(\d+);/.exec(String(value || '')); if (!m) return undefined;
  const n = Number(m[2]);
  if (m[1] === 'c') return n === 0 ? undefined : '#' + [n & 255, n >> 8 & 255, n >> 16 & 255].map(v => v.toString(16).padStart(2, '0')).join('');
  if (n === 0 || n === 256) return undefined;
  if (n === 7 || n === 255) return null;
  return ACI[n] || undefined;
}
const ACI = { 1: '#ff0000', 2: '#ffff00', 3: '#00ff00', 4: '#00ffff', 5: '#0000ff', 6: '#ff00ff', 8: '#808080', 9: '#c0c0c0', 250: '#333333', 251: '#505050', 252: '#696969', 253: '#828282', 254: '#bebebe' };

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
  const boxes = [], hatchBoxes = [];
  for (const e of entities) {
    if (e.type === 'polyline' && e.points.length > 4000) { const k = Math.ceil(e.points.length / 4000); e.points = e.points.filter((_, i) => i % k === 0 || i === e.points.length - 1); }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const add = (x, y) => { if (Number.isFinite(x) && Number.isFinite(y)) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } };
    if (e.type === 'line') { add(...e.a); add(...e.b); }
    else if (e.type === 'polyline') for (const p of e.points) add(p[0], p[1]);
    else if (e.type === 'circle' || e.type === 'arc') { add(e.c[0] - e.r, e.c[1] - e.r); add(e.c[0] + e.r, e.c[1] + e.r); }
    else if (e.type === 'text') { add(...e.p); add(e.p[0] + e.height * e.text.length * 0.6 * Math.cos(e.rotation || 0), e.p[1] + e.height); }
    else if (e.type === 'point') add(...e.p);
    if (x0 <= x1) (e.hatch && e.type === 'line' ? hatchBoxes : boxes).push([x0, y0, x1, y1]); // thousands of hatch lines must not skew the stray filter
  }
  if (!boxes.length) boxes.push(...hatchBoxes);
  if (!boxes.length) throw new Error('В чертеже нет видимой 2D-геометрии в пространстве модели');
  // Drop only real strays: objects whose centre lies far outside the interquartile range of all centres.
  const q = (arr, f) => arr[Math.min(arr.length - 1, Math.max(0, Math.round((arr.length - 1) * f)))];
  const cx = Float64Array.from(boxes.map(b => (b[0] + b[2]) / 2)).sort(), cy = Float64Array.from(boxes.map(b => (b[1] + b[3]) / 2)).sort();
  const fence = (arr) => { const lo = q(arr, 0.25), hi = q(arr, 0.75), iqr = Math.max(hi - lo, (arr[arr.length - 1] - arr[0]) * 0.02, 1e-9); return [lo - iqr * 4, hi + iqr * 4]; };
  const [fx0, fx1] = fence(cx), [fy0, fy1] = fence(cy);
  let kept = boxes.length > 20 ? boxes.filter(b => { const x = (b[0] + b[2]) / 2, y = (b[1] + b[3]) / 2; return x >= fx0 && x <= fx1 && y >= fy0 && y <= fy1; }) : boxes;
  if (kept.length < boxes.length * 0.5) kept = boxes;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of kept) { if (b[0] < minX) minX = b[0]; if (b[1] < minY) minY = b[1]; if (b[2] > maxX) maxX = b[2]; if (b[3] > maxY) maxY = b[3]; }
  return { entities, layers: layers.sort((a, b) => b.count - a.count), bounds: { minX, minY, maxX, maxY }, truncated, strays: boxes.length - kept.length };
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
