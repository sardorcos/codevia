// 3D models: loading (three.js loaders + own .max reader) and a WebGL viewer for phones.
// Formats: GLB/glTF, FBX, OBJ, STL, 3DS, DAE (Collada), PLY, 3MF, MAX (3ds Max scene).

let THREE = null;
export async function three() { if (!THREE) THREE = await import('../vendor/three.min.js'); return THREE; }

export const MODEL_EXT = new Set(['glb', 'gltf', 'fbx', 'obj', 'stl', '3ds', 'dae', 'ply', '3mf', 'max']);
const ext = name => String(name).split('.').at(-1).toLowerCase();

/** Parses a file into a three.js Object3D (Y-up). Also returns notes for the info line. */
export async function loadModel(blob, name) {
  const T = await three(); const e = ext(name);
  // External textures (paths from the author's computer) are not available: use a neutral 1×1 texture instead of a 404.
  const manager = new T.LoadingManager();
  const WHITE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
  let missing = 0;
  manager.setURLModifier(url => (/^(data|blob):/.test(url) ? url : (missing++, WHITE)));
  const buf = () => blob.arrayBuffer(), txt = () => blob.text();
  let root, info = {};
  if (e === 'glb' || e === 'gltf') {
    const data = e === 'glb' ? await buf() : await txt();
    if (e === 'gltf' && /"uri"\s*:\s*"(?!data:)/.test(data)) info.warning = 'Внешние файлы glTF (.bin, текстуры) не найдены — используйте GLB';
    const gltf = await new Promise((res, rej) => new T.GLTFLoader(manager).parse(data, '', res, err => rej(new Error(err?.message || 'Не удалось прочитать glTF'))));
    root = gltf.scene;
  } else if (e === 'fbx') root = new T.FBXLoader(manager).parse(await buf(), '');
  else if (e === 'obj') root = new T.OBJLoader(manager).parse(await txt());
  else if (e === 'stl') { const g = new T.STLLoader().parse(await buf()); root = new T.Group(); root.rotation.x = -Math.PI / 2; root.add(new T.Mesh(g, new T.MeshStandardMaterial({ color: g.hasColors ? 0xffffff : 0xb8c4d8, vertexColors: !!g.hasColors, metalness: 0.1, roughness: 0.6 }))); } // STL is Z-up
  else if (e === '3ds') root = new T.TDSLoader(manager).parse(await buf(), '');
  else if (e === 'dae') root = new T.ColladaLoader(manager).parse(await txt(), '').scene;
  else if (e === 'ply') { const g = new T.PLYLoader().parse(await buf()); if (!g.index && !g.attributes.normal) g.computeVertexNormals(); root = g.index || g.attributes.position.count % 3 === 0 && g.attributes.normal ? new T.Mesh(g, new T.MeshStandardMaterial({ color: 0xb8c4d8, vertexColors: !!g.attributes.color })) : new T.Points(g, new T.PointsMaterial({ size: 0.01, vertexColors: !!g.attributes.color })); }
  else if (e === '3mf') root = new T.ThreeMFLoader(manager).parse(await buf());
  else if (e === 'max') { const r = await loadMax(T, await buf()); root = r.root; info = r.info; }
  else throw new Error('Формат 3D-модели не поддерживается');
  if (missing) info.warning = info.warning || `Текстуры во внешних файлах не найдены (${missing}) — показаны цвета материалов`;
  root.updateMatrixWorld(true);
  let triangles = 0, meshes = 0;
  root.traverse(o => {
    if (!o.isMesh) return; meshes++;
    const g = o.geometry; triangles += g.index ? g.index.count / 3 : g.attributes.position.count / 3;
    if (!g.attributes.normal) g.computeVertexNormals();
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) if (m) { m.side = T.DoubleSide; if (m.isMeshBasicMaterial && !m.map) o.material = new T.MeshStandardMaterial({ color: m.color, side: T.DoubleSide }); }
  });
  if (!meshes && !info.thumbnail) throw new Error(info.error || 'В файле нет полигональной геометрии');
  return { root, info: { ...info, triangles: Math.round(triangles), meshes } };
}

async function loadMax(T, arrayBuffer) {
  const { readMax, primitiveMesh } = await import('./max.js');
  const r = readMax(new Uint8Array(arrayBuffer), { inflate: b => (b[0] === 0x1F ? T.gunzipSync(b) : T.unzlibSync(b)) });
  const group = new T.Group(); group.rotation.x = -Math.PI / 2; // 3ds Max is Z-up
  const palette = [0x8fb3e8, 0x9bd3ae, 0xe8c38f, 0xd99fb8, 0xb6a6e8, 0x9fd9d9];
  r.objects.forEach((o, i) => {
    let geo;
    if (o.primitive === 'teapot') { geo = new T.TeapotGeometry(Math.abs(o.params[0] || 10), 8); geo.rotateX(Math.PI / 2); geo.computeBoundingBox(); geo.translate(0, 0, -geo.boundingBox.min.z); }
    else if (o.primitive) geo = meshToGeometry(T, primitiveMesh(o.primitive, o.params));
    else geo = meshToGeometry(T, o);
    const mesh = new T.Mesh(geo, new T.MeshStandardMaterial({ color: o.color ? new T.Color(o.color) : palette[i % palette.length], roughness: 0.65, metalness: 0.05, side: T.DoubleSide }));
    mesh.name = o.name; mesh.matrixAutoUpdate = false; mesh.matrix.fromArray(o.matrix).transpose(); group.add(mesh);
  });
  const skipped = Object.entries(r.skipped).map(([k, v]) => `${k} ×${v}`);
  return { root: group, info: { sections: r.sections, thumbnail: r.thumbnail, skipped, error: r.error, objects: r.objects.length } };
}

function meshToGeometry(T, m) {
  const pos = new Float32Array(m.vertices.length * 3); m.vertices.forEach((v, i) => pos.set(v, i * 3));
  const g = new T.BufferGeometry(); g.setAttribute('position', new T.BufferAttribute(pos, 3));
  const idx = new Uint32Array(m.faces.length * 3); m.faces.forEach((f, i) => idx.set(f, i * 3)); g.setIndex(new T.BufferAttribute(idx, 1));
  g.computeVertexNormals(); return g;
}

/** World-space triangle mesh of everything (for STL/OBJ/PLY/GLB/USDZ export). */
export function objectToMesh(root) {
  const vertices = [], faces = []; root.updateMatrixWorld(true);
  root.traverse(o => {
    if (!o.isMesh) return; const g = o.geometry, p = g.attributes.position, base = vertices.length, m = o.matrixWorld.elements;
    for (let i = 0; i < p.count; i++) { const x = p.getX(i), y = p.getY(i), z = p.getZ(i); vertices.push([m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]]); }
    if (g.index) { const a = g.index.array; for (let i = 0; i + 2 < a.length; i += 3) faces.push([a[i] + base, a[i + 1] + base, a[i + 2] + base]); }
    else for (let i = 0; i + 2 < p.count; i += 3) faces.push([base + i, base + i + 1, base + i + 2]);
  });
  if (!faces.length) throw new Error('Нет полигонов для экспорта');
  return { vertices, faces };
}

/**
 * Interactive viewer. opts: {canvas, overlay, dark, notes:[{point,locationType,text}], onTap(kind,data), units}
 * Returns controller {fit, zoom, setTool, setWireframe, snapshot, redraw, dispose, measure}.
 */
export async function createViewer(model, opts) {
  const T = await three(); const { canvas, overlay } = opts;
  const renderer = new T.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, alpha: false });
  renderer.setPixelRatio(Math.min(2.5, window.devicePixelRatio || 1)); renderer.outputColorSpace = T.SRGBColorSpace;
  const scene = new T.Scene(); const bg = () => new T.Color(opts.dark() ? 0x161c27 : 0xf3f6fb); scene.background = bg();
  const pmrem = new T.PMREMGenerator(renderer); scene.environment = pmrem.fromScene(new T.RoomEnvironment(), 0.04).texture;
  scene.add(new T.HemisphereLight(0xffffff, 0x445066, 0.6)); const sun = new T.DirectionalLight(0xffffff, 1.4); sun.position.set(1, 2, 1.5); scene.add(sun);
  scene.add(model.root);
  const box = new T.Box3().setFromObject(model.root); const size = box.getSize(new T.Vector3()), center = box.getCenter(new T.Vector3());
  const radius = Math.max(size.length() / 2, 1e-6);
  const camera = new T.PerspectiveCamera(40, 1, radius / 1000, radius * 1000);
  const controls = new T.OrbitControls(camera, canvas); controls.enableDamping = true; controls.dampingFactor = 0.12; controls.screenSpacePanning = true;
  controls.touches = { ONE: T.TOUCH.ROTATE, TWO: T.TOUCH.DOLLY_PAN };
  const grid = new T.GridHelper(radius * 4, 20, 0x8899bb, 0x8899bb); grid.material.opacity = 0.18; grid.material.transparent = true; grid.position.set(center.x, box.min.y, center.z); scene.add(grid);
  const fit = () => { const d = radius / Math.sin(T.MathUtils.degToRad(camera.fov / 2)) * 1.05; camera.position.copy(center).add(new T.Vector3(0.9, 0.6, 1).normalize().multiplyScalar(d)); controls.target.copy(center); camera.near = d / 1000; camera.far = d * 100; camera.updateProjectionMatrix(); controls.update(); redraw(); };
  let w = 0, h = 0, raf = 0, tool = 'view', measure = [], measureLine = null;
  const resize = () => { w = canvas.parentElement.clientWidth; h = canvas.parentElement.clientHeight; renderer.setSize(w, h, false); camera.aspect = w / Math.max(1, h); camera.updateProjectionMatrix(); redraw(); };
  const project = p => { const v = new T.Vector3(p.x, p.y, p.z).project(camera); return { x: (v.x + 1) / 2 * w, y: (1 - v.y) / 2 * h, visible: v.z < 1 }; };
  const markers = [];
  const placeOverlay = () => {
    for (const m of markers) { const s = m.point ? project(m.point) : { x: m.nx * w, y: m.ny * h, visible: true }; m.el.style.transform = `translate(${s.x}px,${s.y}px) translate(-50%,-50%)`; m.el.style.display = s.visible ? '' : 'none'; }
  };
  const render = () => { raf = 0; const moving = controls.update(); renderer.render(scene, camera); placeOverlay(); if (moving) redraw(); };
  function redraw() { if (!raf) raf = requestAnimationFrame(render); }
  controls.addEventListener('change', redraw);
  const setNotes = notes => {
    for (const m of markers) m.el.remove(); markers.length = 0;
    notes.forEach((n, i) => { const el = document.createElement('div'); el.className = 'model-pin'; el.textContent = String(i + 1); el.title = n.text; overlay.append(el);
      markers.push(n.locationType === 'model3d' ? { el, point: n.point } : { el, nx: n.point?.x ?? 0.5, ny: n.point?.y ?? 0.5 }); });
    redraw();
  };
  const raycaster = new T.Raycaster();
  const pick = (cx, cy) => { const r = canvas.getBoundingClientRect(); raycaster.setFromCamera(new T.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1), camera); const hit = raycaster.intersectObject(model.root, true)[0]; return hit ? hit.point : null; };
  let down = null;
  canvas.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY, t: Date.now(), n: e.isPrimary }; });
  canvas.addEventListener('pointerup', e => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8 || Date.now() - down.t > 600) { down = null; return; } down = null;
    if (tool === 'view') return;
    const p = pick(e.clientX, e.clientY); if (!p) { opts.onTap?.('miss'); return; }
    if (tool === 'comment') { opts.onTap?.('comment', { x: p.x, y: p.y, z: p.z }); return; }
    if (tool === 'measure') {
      if (measure.length >= 2) measure = [];
      measure.push(p.clone());
      if (measureLine) { scene.remove(measureLine); measureLine.geometry.dispose(); measureLine = null; }
      for (const m of markers.filter(m => m.measure)) m.el.remove();
      for (let i = markers.length - 1; i >= 0; i--) if (markers[i].measure) markers.splice(i, 1);
      measure.forEach(q => { const el = document.createElement('div'); el.className = 'model-dot'; overlay.append(el); markers.push({ el, point: q, measure: true }); });
      if (measure.length === 2) {
        measureLine = new T.Line(new T.BufferGeometry().setFromPoints(measure), new T.LineBasicMaterial({ color: 0x2e61f2, depthTest: false })); measureLine.renderOrder = 10; scene.add(measureLine);
        const d = measure[0].distanceTo(measure[1]); const el = document.createElement('div'); el.className = 'model-label'; el.textContent = `${fmt(d)}${opts.units ? ' ' + opts.units : ''}`; overlay.append(el);
        markers.push({ el, point: measure[0].clone().add(measure[1]).multiplyScalar(0.5), measure: true }); opts.onTap?.('measured', d);
      }
      redraw();
    }
  });
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null; ro?.observe(canvas.parentElement);
  resize(); fit(); setNotes(opts.notes || []);
  return {
    fit, redraw, setNotes,
    zoom(k) { const dir = camera.position.clone().sub(controls.target); camera.position.copy(controls.target).add(dir.multiplyScalar(1 / k)); controls.update(); redraw(); },
    setTool(t) { tool = t; controls.enableRotate = true; if (t !== 'measure') { measure = []; if (measureLine) { scene.remove(measureLine); measureLine = null; } for (let i = markers.length - 1; i >= 0; i--) if (markers[i].measure) { markers[i].el.remove(); markers.splice(i, 1); } } redraw(); },
    setWireframe(on) { model.root.traverse(o => { if (o.isMesh) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { if (m) m.wireframe = on; }); }); redraw(); },
    setBackground() { scene.background = bg(); redraw(); },
    snapshot() { renderer.render(scene, camera); return new Promise(res => canvas.toBlob(res, 'image/png')); },
    dispose() { cancelAnimationFrame(raf); ro?.disconnect(); controls.dispose(); renderer.dispose(); pmrem.dispose(); for (const m of markers) m.el.remove(); },
  };
}
function fmt(v) { const a = Math.abs(v); return a >= 100 ? v.toFixed(1) : a >= 1 ? v.toFixed(2) : v.toPrecision(3); }
