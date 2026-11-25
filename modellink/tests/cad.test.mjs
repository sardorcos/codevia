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
