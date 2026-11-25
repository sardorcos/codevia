import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import zlib from 'node:zlib';
import {readMax,maxToMesh,primitiveMesh,readCFB} from '../core/max.js';

// Test scene from github.com/NeKidaem/max_dump (MIT): 3ds Max 2016, a teapot on a plane.
const bytes=new Uint8Array(readFileSync(new URL('./fixtures/teapot.max',import.meta.url)));
test('.max: OLE streams, properties, thumbnail, objects',()=>{
  assert.ok(readCFB(bytes).has('Scene'));
  const r=readMax(bytes,{inflate:b=>new Uint8Array(zlib.unzipSync(b))});
  assert.equal(r.error,null);
  const general=r.sections.find(s=>s.name==='General');assert.ok(general.items.some(i=>/3ds Max Version/.test(i)));
  assert.ok(r.thumbnail&&r.thumbnail[0]===0x42&&r.thumbnail[1]===0x4D,'thumbnail converted to BMP');
  assert.deepEqual(r.objects.map(o=>o.primitive),['teapot','plane']);
  const plane=r.objects.find(o=>o.primitive==='plane');assert.ok(plane.params.every(v=>v>0));
  assert.ok(maxToMesh(r).faces.length>100);
});
test('primitive meshes are closed and sized',()=>{
  const box=primitiveMesh('box',[20,10,5]);assert.equal(box.vertices.length,8);assert.equal(box.faces.length,12);
  assert.equal(Math.max(...box.vertices.map(v=>v[2])),5);
  assert.ok(primitiveMesh('torus',[10,2]).faces.length>100);
});
test('not a .max file',()=>assert.throws(()=>readMax(new Uint8Array(600)),/OLE2/));
