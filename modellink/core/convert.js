// Format conversion without DOM dependencies: vector drawings, meshes, PDF wrapping, ZIP store.
// Raster steps (canvas) live in app.js; everything here is pure and covered by Node tests.

const enc=new TextEncoder();
const n6=v=>{const r=Math.round(v*1e6)/1e6;return Object.is(r,-0)?'0':String(r);};
const escXml=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));

export function baseName(name){const s=String(name||'file').split('/').at(-1);const i=s.lastIndexOf('.');return (i>0?s.slice(0,i):s)||'file';}
export function extOf(name){const s=String(name||'');const i=s.lastIndexOf('.');return i>0?s.slice(i+1).toLowerCase():'';}

// ---------------------------------------------------------------- drawing (DXF/DWG) → SVG
export function dxfToSVG(drawing,{stroke='#1d2a40',background='#ffffff',margin=0.04,hiddenLayers=null}={}){
  const b=drawing.bounds;const w=Math.max(1e-9,b.maxX-b.minX),h=Math.max(1e-9,b.maxY-b.minY);
  const pad=Math.max(w,h)*margin;const vbW=w+pad*2,vbH=h+pad*2;
  const X=x=>n6(x-b.minX+pad),Y=y=>n6(b.maxY-y+pad); // flip Y: CAD is Y-up
  const sw=n6(Math.max(vbW,vbH)/1200);const parts=[];
  const tone=c=>{if(!c||background!=='#ffffff')return c;const n=parseInt(c.slice(1),16),r=n>>16&255,g=n>>8&255,bb=n&255,l=(0.299*r+0.587*g+0.114*bb)/255;if(l<0.55)return c;const k=0.55/l*0.8;return '#'+[r,g,bb].map(v=>Math.round(v*k).toString(16).padStart(2,'0')).join('');};
  const col=e=>tone(e.color)||stroke;
  for(const e of drawing.entities){
    if(hiddenLayers&&hiddenLayers.has(e.layer))continue;
    const c=col(e),st=(e.color?` stroke="${c}"`:'')+(e.dash?` stroke-dasharray="${e.dash.map(n6).join(' ')}"`:'');
    if(e.type==='line')parts.push(`<line x1="${X(e.a[0])}" y1="${Y(e.a[1])}" x2="${X(e.b[0])}" y2="${Y(e.b[1])}"${st}/>`);
    else if(e.type==='circle'){if(e.r>0)parts.push(`<circle cx="${X(e.c[0])}" cy="${Y(e.c[1])}" r="${n6(e.r)}"${st}/>`);else parts.push(`<circle cx="${X(e.c[0])}" cy="${Y(e.c[1])}" r="${sw}" fill="${c}" stroke="none"/>`);}
    else if(e.type==='arc'){
      const s=e.start*Math.PI/180,t=e.end*Math.PI/180;let sweep=t-s;while(sweep<=0)sweep+=Math.PI*2;
      const p1=[e.c[0]+e.r*Math.cos(s),e.c[1]+e.r*Math.sin(s)],p2=[e.c[0]+e.r*Math.cos(t),e.c[1]+e.r*Math.sin(t)];
      parts.push(`<path d="M${X(p1[0])} ${Y(p1[1])}A${n6(e.r)} ${n6(e.r)} 0 ${sweep>Math.PI?1:0} 0 ${X(p2[0])} ${Y(p2[1])}"${st}/>`);
    }
    else if(e.type==='polyline'){const tag=e.closed?'polygon':'polyline';const fill=e.fill?` fill="${c}" fill-opacity="${e.hatch?0.18:0.85}"`:'';
      parts.push(`<${tag} points="${e.points.map(p=>`${X(p[0])},${Y(p[1])}`).join(' ')}"${st}${fill}/>`);}
    else if(e.type==='point')parts.push(`<circle cx="${X(e.p[0])}" cy="${Y(e.p[1])}" r="${sw}" fill="${c}" stroke="none"/>`);
    else if(e.type==='text'){const anchor=e.align==='center'?'middle':e.align==='right'?'end':'start';const rot=e.rotation?` transform="rotate(${n6(-e.rotation*180/Math.PI)} ${X(e.p[0])} ${Y(e.p[1])})"`:'';
      const base=e.valign==='middle'?' dominant-baseline="central"':e.valign==='top'?' dominant-baseline="hanging"':'';parts.push(`<text x="${X(e.p[0])}" y="${Y(e.p[1])}" font-size="${n6(e.height)}" fill="${c}" stroke="none" text-anchor="${anchor}"${base}${rot}>${escXml(e.text)}</text>`);}
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n6(vbW)} ${n6(vbH)}" width="${n6(vbW)}" height="${n6(vbH)}">`+
    `<rect x="0" y="0" width="${n6(vbW)}" height="${n6(vbH)}" fill="${background}"/>`+
    `<g fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" font-family="Arial, sans-serif">${parts.join('')}</g></svg>\n`;
}
export const drawingToSVG=dxfToSVG;

// ---------------------------------------------------------------- meshes
function bounds(mesh){const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];for(const v of mesh.vertices)for(let j=0;j<3;j++){if(v[j]<min[j])min[j]=v[j];if(v[j]>max[j])max[j]=v[j];}return {min,max};}
function normal(a,b,c){const u=[b[0]-a[0],b[1]-a[1],b[2]-a[2]],v=[c[0]-a[0],c[1]-a[1],c[2]-a[2]];const n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];const l=Math.hypot(...n)||1;return n.map(x=>x/l);}

export function meshToSTL(mesh,header='ModelLink export'){
  const count=mesh.faces.length,buf=new ArrayBuffer(84+count*50),view=new DataView(buf);
  new Uint8Array(buf).set(enc.encode(String(header).slice(0,79)));view.setUint32(80,count,true);
  mesh.faces.forEach((f,i)=>{const o=84+i*50,[a,b,c]=f.map(k=>mesh.vertices[k]);const n=normal(a,b,c);
    [n,a,b,c].forEach((v,j)=>{for(let k=0;k<3;k++)view.setFloat32(o+j*12+k*4,v[k],true);});});
  return buf;
}
export function meshToOBJ(mesh,name='Model'){
  const out=[`# ModelLink export`,`o ${String(name).replace(/\s+/g,'_')}`];
  for(const v of mesh.vertices)out.push(`v ${n6(v[0])} ${n6(v[1])} ${n6(v[2])}`);
  for(const f of mesh.faces)out.push(`f ${f[0]+1} ${f[1]+1} ${f[2]+1}`);
  return out.join('\n')+'\n';
}
export function meshToPLY(mesh){
  const out=['ply','format ascii 1.0','comment ModelLink export',`element vertex ${mesh.vertices.length}`,'property float x','property float y','property float z',`element face ${mesh.faces.length}`,'property list uchar int vertex_indices','end_header'];
  for(const v of mesh.vertices)out.push(`${n6(v[0])} ${n6(v[1])} ${n6(v[2])}`);
  for(const f of mesh.faces)out.push(`3 ${f[0]} ${f[1]} ${f[2]}`);
  return out.join('\n')+'\n';
}
export function meshToGLB(mesh){
  const {min,max}=bounds(mesh);
  const pos=new Float32Array(mesh.vertices.length*3);mesh.vertices.forEach((v,i)=>pos.set(v,i*3));
  const idx=new Uint32Array(mesh.faces.length*3);mesh.faces.forEach((f,i)=>idx.set(f,i*3));
  const binLen=pos.byteLength+idx.byteLength;
  const json={asset:{version:'2.0',generator:'ModelLink'},scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0,name:'Model'}],
    meshes:[{primitives:[{attributes:{POSITION:0},indices:1,material:0,mode:4}]}],
    materials:[{pbrMetallicRoughness:{baseColorFactor:[0.78,0.83,0.92,1],metallicFactor:0,roughnessFactor:0.8},doubleSided:true}],
    buffers:[{byteLength:binLen}],
    bufferViews:[{buffer:0,byteOffset:0,byteLength:pos.byteLength,target:34962},{buffer:0,byteOffset:pos.byteLength,byteLength:idx.byteLength,target:34963}],
    accessors:[{bufferView:0,componentType:5126,count:mesh.vertices.length,type:'VEC3',min,max},{bufferView:1,componentType:5125,count:idx.length,type:'SCALAR'}]};
  let jsonBytes=enc.encode(JSON.stringify(json));const jsonPad=(4-jsonBytes.length%4)%4;
  const jsonLen=jsonBytes.length+jsonPad,binPad=(4-binLen%4)%4,total=12+8+jsonLen+8+binLen+binPad;
  const out=new Uint8Array(total),view=new DataView(out.buffer);
  view.setUint32(0,0x46546c67,true);view.setUint32(4,2,true);view.setUint32(8,total,true);
  view.setUint32(12,jsonLen,true);view.setUint32(16,0x4e4f534a,true);out.set(jsonBytes,20);out.fill(0x20,20+jsonBytes.length,20+jsonLen);
  const b=20+jsonLen;view.setUint32(b,binLen+binPad,true);view.setUint32(b+4,0x004e4942,true);
  out.set(new Uint8Array(pos.buffer),b+8);out.set(new Uint8Array(idx.buffer),b+8+pos.byteLength);
  return out.buffer;
}
/** Text USD for AR Quick Look. CAD exports are usually millimetres; big spans are scaled as mm. */
export function meshToUSDA(mesh,{upAxis='Y'}={}){
  const {min,max}=bounds(mesh);const span=Math.max(...max.map((v,i)=>v-min[i]));
  const metersPerUnit=span>20?0.001:1;
  return `#usda 1.0\n(\n    defaultPrim = "Model"\n    metersPerUnit = ${metersPerUnit}\n    upAxis = "${upAxis==='Z'?'Z':'Y'}"\n)\n\n`+
`def Xform "Model" (\n    kind = "component"\n)\n{\n    def Mesh "Geometry"\n    {\n`+
`        uniform bool doubleSided = 1\n        float3[] extent = [(${min.map(n6).join(', ')}), (${max.map(n6).join(', ')})]\n`+
`        int[] faceVertexCounts = [${mesh.faces.map(()=>3).join(', ')}]\n`+
`        int[] faceVertexIndices = [${mesh.faces.map(f=>f.join(', ')).join(', ')}]\n`+
`        point3f[] points = [${mesh.vertices.map(v=>`(${n6(v[0])}, ${n6(v[1])}, ${n6(v[2])})`).join(', ')}]\n`+
`        color3f[] primvars:displayColor = [(0.78, 0.83, 0.92)]\n        uniform token subdivisionScheme = "none"\n    }\n}\n`;
}
export function meshToUSDZ(mesh,opts){return zipStore([{name:'model.usda',data:enc.encode(meshToUSDA(mesh,opts))}],{align:64});}

// ---------------------------------------------------------------- ZIP (store only; USDZ needs 64-byte data alignment)
const CRC_TABLE=(()=>{const t=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[n]=c>>>0;}return t;})();
export function crc32(bytes){let c=0xffffffff;for(let i=0;i<bytes.length;i++)c=CRC_TABLE[(c^bytes[i])&0xff]^(c>>>8);return (c^0xffffffff)>>>0;}
export function zipStore(files,{align=1}={}){
  const chunks=[],central=[];let offset=0;
  for(const f of files){
    const name=enc.encode(f.name),data=f.data instanceof Uint8Array?f.data:new Uint8Array(f.data),crc=crc32(data);
    let extra=0;if(align>1){const rem=(offset+30+name.length)%align;if(rem){extra=align-rem;if(extra<4)extra+=align;}}
    const local=new Uint8Array(30+name.length+extra),lv=new DataView(local.buffer);
    lv.setUint32(0,0x04034b50,true);lv.setUint16(4,10,true);lv.setUint16(8,0,true);lv.setUint32(14,crc,true);lv.setUint32(18,data.length,true);lv.setUint32(22,data.length,true);
    lv.setUint16(26,name.length,true);lv.setUint16(28,extra,true);local.set(name,30);
    if(extra){lv.setUint16(30+name.length,0x1986,true);lv.setUint16(32+name.length,extra-4,true);}
    const cd=new Uint8Array(46+name.length),cv=new DataView(cd.buffer);
    cv.setUint32(0,0x02014b50,true);cv.setUint16(4,20,true);cv.setUint16(6,10,true);cv.setUint32(16,crc,true);cv.setUint32(20,data.length,true);cv.setUint32(24,data.length,true);
    cv.setUint16(28,name.length,true);cv.setUint32(42,offset,true);cd.set(name,46);
    chunks.push(local,data);central.push(cd);offset+=local.length+data.length;
  }
  const cdSize=central.reduce((s,c)=>s+c.length,0),end=new Uint8Array(22),ev=new DataView(end.buffer);
  ev.setUint32(0,0x06054b50,true);ev.setUint16(8,files.length,true);ev.setUint16(10,files.length,true);ev.setUint32(12,cdSize,true);ev.setUint32(16,offset,true);
  const out=new Uint8Array(offset+cdSize+22);let p=0;for(const c of [...chunks,...central,end]){out.set(c,p);p+=c.length;}
  return out;
}

// ---------------------------------------------------------------- JPEG → single-page PDF
export function jpegToPDF(jpeg,width,height){
  const bytes=jpeg instanceof Uint8Array?jpeg:new Uint8Array(jpeg);
  const k=842/Math.max(width,height);const pw=Math.max(1,Math.round(width*k)),ph=Math.max(1,Math.round(height*k)); // longest side = A4 height
  const content=`q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
  const objs=[
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`,
    null,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
  const parts=[enc.encode('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')];let length=parts[0].length;const offsets=[];
  objs.forEach((o,i)=>{offsets.push(length);let chunk;
    if(o===null){const head=enc.encode(`${i+1} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>\nstream\n`),tail=enc.encode('\nendstream\nendobj\n');chunk=new Uint8Array(head.length+bytes.length+tail.length);chunk.set(head);chunk.set(bytes,head.length);chunk.set(tail,head.length+bytes.length);}
    else chunk=enc.encode(`${i+1} 0 obj\n${o}\nendobj\n`);
    parts.push(chunk);length+=chunk.length;});
  const xref=`xref\n0 ${objs.length+1}\n0000000000 65535 f \n${offsets.map(o=>String(o).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size ${objs.length+1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`;
  parts.push(enc.encode(xref));
  const out=new Uint8Array(parts.reduce((s,p)=>s+p.length,0));let p=0;for(const c of parts){out.set(c,p);p+=c.length;}
  return out;
}

// ---------------------------------------------------------------- what can a file become
export const TEXT_EXT=new Set(['txt','md','markdown','csv','tsv','json','xml','html','htm','css','js','mjs','ts','py','php','java','c','h','cpp','swift','kt','rb','go','rs','sh','yml','yaml','ini','cfg','conf','log','sql','gcode','nc','tex','svg','toml','env','properties']);
export const IMAGE_EXT=new Set(['png','jpg','jpeg','gif','webp','bmp','svg','heic','heif','tif','tiff']);
export const MESH_EXT=new Set(['stl','obj','glb','gltf','fbx','3ds','dae','ply','3mf','max']);
/**
 * Conversion targets for a file. `engine`: 'js' (here + canvas), 'native' (iOS: PDFKit/UIKit) or 'zip'.
 */
export function conversionTargets(name,{native=false}={}){
  const ext=extOf(name),t=[];
  const add=(to,label,engine,note='')=>{if(to!==ext&&!(to==='jpeg'&&ext==='jpg'))t.push({to,label,engine,note});};
  if(ext==='dxf'||ext==='dwg'){add('pdf','PDF','js','Видимые слои, белый фон');add('svg','SVG — вектор','js');add('png','PNG','js');add('jpeg','JPEG','js');if(ext==='dwg')add('dxf','DXF (ASCII)','js','Открывается в любой CAD-программе');}
  if(MESH_EXT.has(ext)){add('usdz','USDZ — AR на iPhone','js');add('glb','GLB (glTF)','js');add('obj','OBJ','js');add('stl','STL — 3D-печать','js');add('ply','PLY','js');add('png','PNG — снимок вида','js');if(ext==='max')add('thumb','PNG — миниатюра из файла','js');}
  if(IMAGE_EXT.has(ext)){const e=native&&['heic','heif','tif','tiff'].includes(ext)?'native':'js';add('png','PNG',e);add('jpeg','JPEG',e);add('pdf','PDF',e);}
  if(ext==='pdf'&&native){add('png','PNG — страницы','native','Каждая страница отдельным файлом');add('jpeg','JPEG — страницы','native','Каждая страница отдельным файлом');}
  if(native&&(TEXT_EXT.has(ext)&&ext!=='svg'||['rtf'].includes(ext)))add('pdf','PDF','native',ext==='html'||ext==='htm'?'Вёрстка HTML':'');
  if(ext!=='zip')add('zip','ZIP-архив','zip');
  return t;
}
