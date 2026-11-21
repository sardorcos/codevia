import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {parseDXF,parseOBJ,parseSTL,parseGLB} from '../core/geometry.js';
import {dxfToSVG,meshToSTL,meshToOBJ,meshToPLY,meshToGLB,meshToUSDA,meshToUSDZ,zipStore,crc32,jpegToPDF,conversionTargets,baseName} from '../core/convert.js';
const sandbox={module:{exports:{}},setTimeout,clearTimeout,setImmediate,Uint8Array,ArrayBuffer,Promise};sandbox.exports=sandbox.module.exports;sandbox.self=sandbox;
vm.runInNewContext(readFileSync(new URL('../vendor/jszip.min.js',import.meta.url),'utf8'),sandbox);
const JSZip=sandbox.module.exports;

const tetra={vertices:[[0,0,0],[1,0,0],[0,1,0],[0,0,1]],faces:[[0,2,1],[0,1,3],[0,3,2],[1,2,3]]};
const dxf=['0','SECTION','2','ENTITIES','0','LINE','8','0','10','0','20','0','11','100','21','50','0','ARC','10','50','20','25','40','10','50','0','51','90','0','TEXT','10','5','20','8','1','A<B','40','5','0','ENDSEC','0','EOF'].join('\n');

test('DXF → SVG keeps entities and escapes text',()=>{
  const svg=dxfToSVG(parseDXF(dxf));
  assert.match(svg,/^<\?xml/);assert.match(svg,/<line /);assert.match(svg,/<path d="M/);assert.match(svg,/A&lt;B/);
});
test('mesh → STL / OBJ / GLB round-trips through the viewers',()=>{
  assert.equal(parseSTL(meshToSTL(tetra)).faces.length,4);
  const obj=parseOBJ(meshToOBJ(tetra));assert.equal(obj.vertices.length,4);assert.deepEqual(obj.faces,tetra.faces);
  const glb=parseGLB(meshToGLB(tetra));assert.equal(glb.faces.length,4);assert.deepEqual(glb.vertices[1],[1,0,0]);
  assert.match(meshToPLY(tetra),/element face 4/);
});
test('USDZ is a stored zip with 64-byte aligned data',async()=>{
  const z=meshToUSDZ(tetra);const v=new DataView(z.buffer);
  assert.equal(v.getUint32(0,true),0x04034b50);
  const dataStart=30+v.getUint16(26,true)+v.getUint16(28,true);assert.equal(dataStart%64,0);
  const zip=await JSZip.loadAsync(z);const usda=await zip.file('model.usda').async('string');
  assert.match(usda,/^#usda 1.0/);assert.match(usda,/faceVertexCounts = \[3, 3, 3, 3\]/);
  assert.match(meshToUSDA({vertices:[[0,0,0],[500,0,0],[0,500,0]],faces:[[0,1,2]]}),/metersPerUnit = 0.001/);
});
test('zipStore + crc32',async()=>{
  assert.equal(crc32(new TextEncoder().encode('123456789')),0xcbf43926);
  const zip=await JSZip.loadAsync(zipStore([{name:'a.txt',data:new TextEncoder().encode('hi')},{name:'b.txt',data:new Uint8Array([1,2,3])}],{align:64}));
  assert.equal(await zip.file('a.txt').async('string'),'hi');
});
test('JPEG → PDF has a valid xref table',()=>{
  const pdf=jpegToPDF(new Uint8Array([0xff,0xd8,0xff,0xd9]),400,200);const text=new TextDecoder('latin1').decode(pdf);
  assert.ok(text.startsWith('%PDF-1.4'));assert.match(text,/\/MediaBox \[0 0 842 421\]/);
  const start=Number(text.match(/startxref\n(\d+)/)[1]);assert.ok(text.slice(start).startsWith('xref'));
  const offsets=[...text.slice(start).matchAll(/(\d{10}) 00000 n/g)].map(m=>Number(m[1]));
  offsets.forEach((o,i)=>assert.ok(text.slice(o).startsWith(`${i+1} 0 obj`)));
});
test('conversion targets per format',()=>{
  const to=(n,o)=>conversionTargets(n,o).map(t=>t.to);
  assert.deepEqual(to('plan.dxf'),['svg','pdf','png','jpeg','zip']);
  assert.ok(to('part.stl').includes('usdz'));assert.ok(!to('part.stl').includes('stl'));
  assert.deepEqual(to('doc.pdf'),['zip']);assert.ok(to('doc.pdf',{native:true}).includes('png'));
  assert.ok(to('photo.HEIC',{native:true}).every(t=>t));assert.equal(conversionTargets('photo.heic',{native:true})[0].engine,'native');
  assert.ok(!to('photo.jpg').includes('jpeg'));assert.deepEqual(to('x.zip'),[]);
  assert.equal(baseName('a/b/План.v2.dxf'),'План.v2');
});
