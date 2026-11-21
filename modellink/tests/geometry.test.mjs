import test from 'node:test';
import assert from 'node:assert/strict';
import {parseDXF,parseOBJ,parseSTL,parseGLB,meshBounds} from '../core/geometry.js';
import {kindFor,latestFiles,fileInfo} from '../core/storage.js';
import {validPath,validatePackageManifest,PACKAGE_VERSION} from '../core/pack.js';

test('DXF reads line, polyline, circle and text',()=>{
  const rows=[
    [0,'SECTION'],[2,'ENTITIES'],
    [0,'LINE'],[8,'Layer1'],[10,'0'],[20,'0'],[11,'100'],[21,'50'],
    [0,'CIRCLE'],[10,'40'],[20,'30'],[40,'10'],
    [0,'LWPOLYLINE'],[70,'1'],[10,'1'],[20,'1'],[10,'4'],[20,'1'],[10,'4'],[20,'4'],
    [0,'TEXT'],[10,'5'],[20,'8'],[1,'Проверка'],[40,'12'],[0,'ENDSEC'],[0,'EOF']
  ];
  const d=parseDXF(rows.map(x=>x.join('\n')).join('\n'));
  assert.equal(d.entities.length,4);
  assert.deepEqual(d.entities.map(e=>e.type),['line','circle','polyline','text']);
  assert.ok(d.bounds.maxX>=100);
  assert.ok(d.entities[2].closed);
});
test('invalid DXF has actionable error',()=>assert.throws(()=>parseDXF('0\nEOF\n'),/поддерживаемых/));
test('OBJ quad triangulates and negative vertex refs work',()=>{
  const mesh=parseOBJ('v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf -4 -3 -2 -1\n');
  assert.equal(mesh.faces.length,2);assert.equal(mesh.vertices.length,4);
});
test('binary STL reads one triangle',()=>{
  const buffer=new ArrayBuffer(134),v=new DataView(buffer);
  v.setUint32(80,1,true);
  for(const [i,p] of [[0,[0,0,0]],[1,[1,0,0]],[2,[0,1,0]]])for(let n=0;n<3;n++)v.setFloat32(84+12+i*12+n*4,p[n],true);
  const m=parseSTL(buffer);assert.equal(m.faces.length,1);assert.deepEqual(m.vertices[2],[0,1,0]);
});
test('ascii STL works',()=>{
  const bytes=new TextEncoder().encode('solid a facet normal 0 0 1 outer loop vertex 0 0 0 vertex 1 0 0 vertex 0 1 0 endloop endfacet endsolid');
  assert.equal(parseSTL(bytes).faces.length,1);
});
test('GLB parses a minimal triangle and accepts local transform',()=>{
  const gltf={asset:{version:'2.0'},buffers:[{byteLength:36}],bufferViews:[{buffer:0,byteOffset:0,byteLength:36}],accessors:[{bufferView:0,componentType:5126,count:3,type:'VEC3'}],meshes:[{primitives:[{attributes:{POSITION:0}}]}],nodes:[{mesh:0,translation:[5,0,0]}],scenes:[{nodes:[0]}],scene:0};
  const json=new TextEncoder().encode(JSON.stringify(gltf)),jsonLen=(json.length+3)&~3;
  const total=12+8+jsonLen+8+36,buf=new ArrayBuffer(total),v=new DataView(buf),bytes=new Uint8Array(buf);
  v.setUint32(0,0x46546c67,true);v.setUint32(4,2,true);v.setUint32(8,total,true);
  v.setUint32(12,jsonLen,true);v.setUint32(16,0x4e4f534a,true);bytes.set(json,20);
  bytes.fill(32,20+json.length,20+jsonLen);v.setUint32(20+jsonLen,36,true);v.setUint32(24+jsonLen,0x004e4942,true);
  for(const [i,n] of [0,0,0,1,0,0,0,1,0].entries())v.setFloat32(28+jsonLen+i*4,n,true);
  const mesh=parseGLB(buf);assert.equal(mesh.faces.length,1);assert.equal(mesh.vertices[0][0],5);assert.equal(meshBounds(mesh).max[0],6);
});
test('latestFiles selects most recent revisions',()=>{
  const files=[{groupId:'a',version:1,createdAt:1},{groupId:'a',version:2,createdAt:2},{groupId:'b',version:1,createdAt:3}];
  assert.equal(latestFiles(files).length,2);assert.equal(latestFiles(files).find(x=>x.groupId==='a').version,2);
});
test('format handling distinguishes viewing from transfer',()=>{
  assert.equal(kindFor('drawing.DXF'),'drawing');assert.equal(kindFor('model.STEP'),'source');
  assert.equal(fileInfo('factory.STEP').preview,'source');assert.equal(fileInfo('assembly.GLB').preview,'partial');
});
test('package paths reject traversal and invalid manifest',()=>{
  assert.ok(validPath('files/0000'));assert.equal(validPath('../outside'),false);assert.equal(validPath('/absolute'),false);
  const m={format:'modellink-package',version:PACKAGE_VERSION,project:{name:'Test'},files:[],notes:[]};
  assert.ok(validatePackageManifest(m));assert.throws(()=>validatePackageManifest({...m,version:2}));
  assert.throws(()=>validatePackageManifest({...m,files:[{path:'../secret',entry:'files/001',size:20,id:'1'}]}));
});
