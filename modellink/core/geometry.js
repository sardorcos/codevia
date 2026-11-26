export function parseDXF(text){
  const lines=String(text).replace(/\r/g,'').split('\n');
  const pairs=[];for(let i=0;i+1<lines.length;i+=2)pairs.push([Number(lines[i].trim()),lines[i+1].trim()]);
  const entities=[];let section='';let count=0;
  const num=(p,c,d=0)=>{const item=p.find(([code])=>code===c);return item?Number(item[1])||0:d;};
  const str=(p,c,d='')=>p.find(([code])=>code===c)?.[1]??d;
  let inside=false;
  for(let i=0;i<pairs.length;){
    const [code,val]=pairs[i];
    if(code===0 && val==='SECTION'){section=pairs[i+1]?.[1]||'';i+=2;inside=section==='ENTITIES';continue;}
    if(code===0 && val==='ENDSEC'){inside=false;section='';i++;continue;}
    if(!inside || code!==0){i++;continue;}
    const type=val.toUpperCase();i++;
    const body=[];
    while(i<pairs.length&&pairs[i][0]!==0){body.push(pairs[i]);i++;}
    if(++count>150000)throw new Error('В чертеже слишком много элементов');
    const layer=str(body,8,'0');
    if(type==='LINE')entities.push({type:'line',layer,a:[num(body,10),num(body,20)],b:[num(body,11),num(body,21)]});
    if(type==='POINT')entities.push({type:'point',layer,p:[num(body,10),num(body,20)]});
    if(type==='CIRCLE')entities.push({type:'circle',layer,c:[num(body,10),num(body,20)],r:Math.abs(num(body,40))});
    if(type==='ARC')entities.push({type:'arc',layer,c:[num(body,10),num(body,20)],r:Math.abs(num(body,40)),start:num(body,50),end:num(body,51)});
    if(type==='TEXT'||type==='MTEXT')entities.push({type:'text',layer,p:[num(body,10),num(body,20)],text:str(body,1).replace(/[{}]/g,'').slice(0,100),height:Math.abs(num(body,40,10))||10});
    if(type==='LWPOLYLINE'){
      const points=[];let x;
      for(const [c,v] of body){if(c===10){x=Number(v);}if(c===20&&x!==undefined){points.push([x,Number(v)]);x=undefined;}}
      if(points.length>=2)entities.push({type:'polyline',layer,points,closed:((num(body,70)|0)&1)!==0});
    }
  }
  if(!entities.length)throw new Error('Нет поддерживаемых объектов DXF. Исходник сохранён.');
  const points=[];
  for(const e of entities){if(e.type==='line')points.push(e.a,e.b);if(e.type==='point'||e.type==='text')points.push(e.p);if(e.type==='polyline')points.push(...e.points);if(e.type==='circle'||e.type==='arc')points.push([e.c[0]-e.r,e.c[1]-e.r],[e.c[0]+e.r,e.c[1]+e.r]);}
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for(const [x,y] of points)if(Number.isFinite(x)&&Number.isFinite(y)){minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);}
  if(!Number.isFinite(minX))throw new Error('Не удалось определить границы DXF');
  return {entities,layers:[...new Set(entities.map(e=>e.layer))].sort(),bounds:{minX,minY,maxX,maxY}};
}
export function parseOBJ(input){
  const vertices=[],faces=[];
  for(const line of String(input).split(/\r?\n/)){
    const lineTrim=line.trim();if(!lineTrim||lineTrim.startsWith('#'))continue;
    const pieces=lineTrim.split(/\s+/);
    if(pieces[0]==='v'&&pieces.length>=4){const nums=pieces.slice(1,4).map(Number);if(nums.every(Number.isFinite))vertices.push(nums);}
    if(pieces[0]==='f'&&pieces.length>=4){
      const ids=pieces.slice(1).map(v=>{const i=Number(v.split('/')[0]);return i<0?vertices.length+i:i-1;}).filter(v=>Number.isInteger(v)&&v>=0&&v<vertices.length);
      for(let j=1;j<ids.length-1;j++)faces.push([ids[0],ids[j],ids[j+1]]);
    }
    if(vertices.length>500000||faces.length>250000)throw new Error('Модель слишком большая для облегчённого просмотра');
  }
  return validateMesh({vertices,faces});
}
export function parseSTL(data){
  const buffer=data instanceof ArrayBuffer?data:data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength);
  const view=new DataView(buffer),vertices=[],faces=[];
  const ascii=()=>{
    const s=new TextDecoder().decode(buffer);
    const found=[...s.matchAll(/\bvertex\s+(-?[\d.eE+]+)\s+(-?[\d.eE+]+)\s+(-?[\d.eE+]+)/g)];
    if(!found.length)throw new Error('Файл STL не содержит треугольников');
    for(let i=0;i+2<found.length;i+=3){const a=vertices.length;for(let k=0;k<3;k++)vertices.push([Number(found[i+k][1]),Number(found[i+k][2]),Number(found[i+k][3])]);faces.push([a,a+1,a+2]);}
  };
  const count=buffer.byteLength>=84?view.getUint32(80,true):0;
  if(count>0&&84+count*50===buffer.byteLength){
    if(count>250000)throw new Error('STL слишком большой для облегчённого просмотра');
    for(let i=0;i<count;i++){
      const offset=84+i*50,a=vertices.length;
      for(let j=0;j<3;j++){
        const off=offset+12+j*12;
        vertices.push([view.getFloat32(off,true),view.getFloat32(off+4,true),view.getFloat32(off+8,true)]);
      }
      faces.push([a,a+1,a+2]);
    }
  }else ascii();
  return validateMesh({vertices,faces});
}
const identity=()=>[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
function multiply(a,b){const c=new Array(16).fill(0);for(let col=0;col<4;col++)for(let row=0;row<4;row++)for(let k=0;k<4;k++)c[col*4+row]+=a[k*4+row]*b[col*4+k];return c;}
function transform(m,p){return [m[0]*p[0]+m[4]*p[1]+m[8]*p[2]+m[12],m[1]*p[0]+m[5]*p[1]+m[9]*p[2]+m[13],m[2]*p[0]+m[6]*p[1]+m[10]*p[2]+m[14]];}
function nodeMatrix(node){
  if(node.matrix?.length===16)return node.matrix;
  const [x,y,z,w]=node.rotation||[0,0,0,1];const [sx,sy,sz]=node.scale||[1,1,1];const [tx,ty,tz]=node.translation||[0,0,0];
  return [(1-2*(y*y+z*z))*sx,(2*(x*y+z*w))*sx,(2*(x*z-y*w))*sx,0,(2*(x*y-z*w))*sy,(1-2*(x*x+z*z))*sy,(2*(y*z+x*w))*sy,0,(2*(x*z+y*w))*sz,(2*(y*z-x*w))*sz,(1-2*(x*x+y*y))*sz,0,tx,ty,tz,1];
}
export function parseGLB(data){
  const buffer=data instanceof ArrayBuffer?data:data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength), view=new DataView(buffer);
  if(view.byteLength<20||view.getUint32(0,true)!==0x46546c67||view.getUint32(4,true)!==2)throw new Error('Поддерживается GLB версии glTF 2.0');
  if(view.getUint32(8,true)!==buffer.byteLength)throw new Error('Неверная длина файла GLB');
  let offset=12,json,bin;
  while(offset+8<=buffer.byteLength){
    const size=view.getUint32(offset,true),type=view.getUint32(offset+4,true);offset+=8;
    if(offset+size>buffer.byteLength)throw new Error('Некорректный GLB');
    if(type===0x4E4F534A)json=JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,offset,size)).replace(/\0+$/g,''));
    if(type===0x004E4942)bin=new DataView(buffer,offset,size);
    offset+=size;
  }
  if(!json||!bin)throw new Error('Отсутствует геометрия GLB');
  const accessor=id=>{
    const a=json.accessors?.[id],b=json.bufferViews?.[a?.bufferView];
    if(!a||!b||b.buffer!==0||a.sparse)throw new Error('Неподдерживаемый accessor GLB');
    const dims={SCALAR:1,VEC2:2,VEC3:3,VEC4:4}[a.type];
    const bytes={5120:1,5121:1,5122:2,5123:2,5125:4,5126:4}[a.componentType];
    if(!dims||!bytes||a.count>1500000)throw new Error('Неподдерживаемые данные GLB');
    const stride=b.byteStride||dims*bytes;const start=(b.byteOffset||0)+(a.byteOffset||0);
    const result=[];
    for(let i=0;i<a.count;i++){
      const vec=[];for(let c=0;c<dims;c++){
        const at=start+i*stride+c*bytes;
        if(at+bytes>bin.byteLength)throw new Error('Нарушены границы GLB');
        let value;
        switch(a.componentType){case 5121:value=bin.getUint8(at);break;case 5123:value=bin.getUint16(at,true);break;case 5125:value=bin.getUint32(at,true);break;case 5126:value=bin.getFloat32(at,true);break;case 5122:value=bin.getInt16(at,true);break;default:value=bin.getInt8(at);}
        vec.push(value);
      }result.push(dims===1?vec[0]:vec);
    }
    return result;
  };
  const vertices=[],faces=[],nodes=json.nodes||[],used=new Set();
  const walk=(nodeId,parent,depth)=>{
    if(depth>80||used.has(`${depth}:${nodeId}`))return;
    used.add(`${depth}:${nodeId}`);
    const node=nodes[nodeId];if(!node)return;
    const m=multiply(parent,nodeMatrix(node));
    const mesh=json.meshes?.[node.mesh];
    for(const primitive of mesh?.primitives||[]){
      if((primitive.mode??4)!==4||primitive.attributes?.POSITION===undefined)continue;
      const positions=accessor(primitive.attributes.POSITION);
      const indices=primitive.indices!==undefined?accessor(primitive.indices):positions.map((_,i)=>i);
      const base=vertices.length;
      vertices.push(...positions.map(v=>transform(m,v)));
      for(let i=0;i+2<indices.length;i+=3)faces.push([base+indices[i],base+indices[i+1],base+indices[i+2]]);
      if(faces.length>250000||vertices.length>500000)throw new Error('GLB слишком большой для облегчённого просмотра');
    }
    for(const child of node.children||[])walk(child,m,depth+1);
  };
  const roots=json.scenes?.[json.scene??0]?.nodes||nodes.map((_,i)=>i);
  roots.forEach(id=>walk(id,identity(),0));
  return validateMesh({vertices,faces});
}
export function validateMesh(mesh){
  if(!mesh.vertices.length||!mesh.faces.length)throw new Error('Нет поддерживаемой полигональной геометрии');
  if(mesh.vertices.some(p=>p.length<3||p.some(v=>!Number.isFinite(v))))throw new Error('Некорректные координаты модели');
  return mesh;
}
export function meshBounds(mesh){
  let min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
  for(const v of mesh.vertices)for(let j=0;j<3;j++){min[j]=Math.min(min[j],v[j]);max[j]=Math.max(max[j],v[j]);}
  return {min,max,center:min.map((n,i)=>(n+max[i])/2),span:Math.max(1e-6,...max.map((n,i)=>n-min[i]))};
}
