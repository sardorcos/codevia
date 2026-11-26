import test from 'node:test';
import assert from 'node:assert/strict';
import * as lib from '../vendor/acad-ts.min.js';
import {cadOp,readCad,cadToDrawing,inkOnLight} from '../core/cad.js';

// Minimal R12-style DXF with a block reference: the INSERT must be expanded into world coordinates.
const dxf=['0','SECTION','2','HEADER','9','$INSUNITS','70','4','0','ENDSEC',
 '0','SECTION','2','BLOCKS','0','BLOCK','8','0','2','BOX','70','0','10','0','20','0','30','0','3','BOX',
 '0','LINE','8','0','10','0','20','0','30','0','11','10','21','0','31','0','0','ENDBLK','8','0','0','ENDSEC',
 '0','SECTION','2','ENTITIES',
 '0','LINE','8','WALLS','62','1','10','0','20','0','30','0','11','100','21','0','31','0',
 '0','CIRCLE','8','0','10','50','20','50','30','0','40','5',
 '0','INSERT','8','0','2','BOX','10','200','20','0','30','0',
 '0','TEXT','8','0','10','1','20','2','30','0','40','2.5','1','Привет',
 '0','ENDSEC','0','EOF'].join('\n');

test('DXF through the CAD engine: colours, blocks, text, units',()=>{
  const {drawing}=cadOp(lib,'drawing',new TextEncoder().encode(dxf),'plan.dxf');
  const lines=drawing.entities.filter(e=>e.type==='line');
  assert.ok(lines.some(l=>l.color==='#ff0000'&&l.layer==='WALLS'),'ACI 1 → red');
  assert.ok(lines.some(l=>Math.abs(l.a[0]-200)<1e-6&&Math.abs(l.b[0]-210)<1e-6),'block line moved by INSERT');
  assert.ok(drawing.entities.some(e=>e.type==='text'&&e.text==='Привет'));
  assert.equal(drawing.units,'мм');
  assert.ok(drawing.bounds.maxX>=210);
});
test('DXF re-export and garbage handling',()=>{
  const {bytes}=cadOp(lib,'dxf',new TextEncoder().encode(dxf),'plan.dxf');
  assert.match(new TextDecoder().decode(bytes.slice(0,200)),/SECTION/);
  assert.throws(()=>cadOp(lib,'drawing',new TextEncoder().encode('AC1009 old'),'old.dwg'),/не поддерживается/);
  assert.throws(()=>cadOp(lib,'drawing',new Uint8Array([1,2,3,4,5,6,7]),'x.dwg'),/DWG/);
});
test('pale colours are darkened on white',()=>{assert.notEqual(inkOnLight('#ffff00'),'#ffff00');assert.equal(inkOnLight('#0000ff'),'#0000ff');});

// Block references are transformed by our own matrix: rotation, non-uniform scale, nesting, MINSERT grid.
const head=['0','SECTION','2','HEADER','9','$INSUNITS','70','4','0','ENDSEC'];
const blockDxf=[...head,
 '0','SECTION','2','TABLES','0','TABLE','2','LAYER','70','2',
 '0','LAYER','2','0','70','0','62','7','6','CONTINUOUS','0','LAYER','2','PROFILE','70','0','62','5','6','CONTINUOUS','0','ENDTAB','0','ENDSEC',
 '0','SECTION','2','BLOCKS',
 '0','BLOCK','8','0','2','PART','70','0','10','0','20','0','30','0','3','PART',
 '0','LINE','8','0','10','0','20','0','30','0','11','10','21','0','31','0',
 '0','CIRCLE','8','0','62','0','10','0','20','0','30','0','40','2',
 '0','POINT','8','Defpoints','10','5','20','5','30','0',
 '0','ENDBLK','8','0',
 '0','BLOCK','8','0','2','OUTER','70','0','10','0','20','0','30','0','3','OUTER',
 '0','INSERT','8','0','2','PART','10','10','20','0','30','0',
 '0','ENDBLK','8','0','0','ENDSEC',
 '0','SECTION','2','ENTITIES',
 '0','INSERT','8','PROFILE','62','1','2','PART','10','100','20','50','30','0','41','2','42','3','50','90',
 '0','INSERT','8','PROFILE','2','OUTER','10','0','20','200','30','0','41','-1',
 '0','INSERT','8','0','2','PART','10','0','20','300','30','0','70','2','71','2','44','20','45','30',
 '0','ENDSEC','0','EOF'].join('\n');

test('block references: rotation, non-uniform scale, base point, nesting, layer 0 and ByBlock inheritance',()=>{
  const {drawing}=cadOp(lib,'drawing',new TextEncoder().encode(blockDxf),'blocks.dxf');
  const near=(p,x,y)=>Math.abs(p[0]-x)<1e-6&&Math.abs(p[1]-y)<1e-6;
  const lines=drawing.entities.filter(e=>e.type==='line');
  const rot=lines.find(l=>near(l.a,100,50));
  assert.ok(rot&&near(rot.b,100,70),'rotated 90° and scaled 2×3');
  assert.equal(rot.layer,'PROFILE','layer 0 content takes the layer of the reference');
  assert.equal(rot.color,'#0000ff','ByLayer on layer 0 → colour of the reference layer');
  assert.ok(drawing.entities.some(e=>e.type==='polyline'&&e.closed&&e.points.length===72&&e.color==='#ff0000'),'circle under non-uniform scale becomes an ellipse outline, ByBlock colour from the reference');
  assert.ok(lines.some(l=>near(l.a,-10,200)&&near(l.b,-20,200)),'nested reference inside a mirrored one');
  assert.equal(lines.filter(l=>Math.abs(l.b[0]-l.a[0]-10)<1e-6&&l.a[1]>=298).length,4,'MINSERT 2×2 grid');
  assert.ok(lines.some(l=>near(l.a,20,330)),'MINSERT spacing');
  assert.ok(!drawing.entities.some(e=>e.type==='circle'&&e.r===0),'points on Defpoints are not drawn');
  assert.deepEqual(drawing.errors,{});
});

test('MTEXT inline colour',async()=>{
  const {mtextColor}=await import('../core/cad.js');
  assert.equal(mtextColor('{\\C1;akfa}'),'#ff0000');
  assert.equal(mtextColor('\\c255;red'),'#ff0000');
  assert.equal(mtextColor('{\\fArial|b1;\\C7;x}'),null);
  assert.equal(mtextColor('plain'),undefined);
});
