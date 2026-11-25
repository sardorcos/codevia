import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {sealPackage,readEnvelope,openPackage,checkPolicy,keyLink,parseKeyLink,appendAudit,verifyAudit,makeReceipt,verifyReceipt,sealBytes,openBytes,randomBytes,PBKDF2_ITERATIONS} from '../core/secure.js';
import {zipStore} from '../core/convert.js';
const sandbox={module:{exports:{}},setTimeout,clearTimeout,setImmediate,Uint8Array,ArrayBuffer,Promise};sandbox.exports=sandbox.module.exports;sandbox.self=sandbox;
vm.runInNewContext(readFileSync(new URL('../vendor/jszip.min.js',import.meta.url),'utf8'),sandbox);const JSZip=sandbox.module.exports;
const inner=new TextEncoder().encode('inner package bytes');
const policy={recipient:{name:'Иван Петров',company:'ООО Завод'},sender:'Бюро',expiresAt:new Date(Date.now()+86400e3).toISOString(),viewOnly:true,oneTime:false};

test('password envelope: round trip, wrong password, header tampering',async()=>{
  const {bytes,id}=await sealPackage(inner,policy,{password:'секрет-123'},{zipStore});
  const env=await readEnvelope(bytes,JSZip);
  assert.equal(env.header.id,id);assert.equal(env.header.recipient.name,'Иван Петров');assert.equal(env.header.kdf.iter,PBKDF2_ITERATIONS);
  const {inner:out}=await openPackage(env,'секрет-123');assert.deepEqual(out,inner);
  await assert.rejects(openPackage(env,'wrong'),/Неверный пароль/);
  const forged={...env,headerText:env.headerText.replace('"viewOnly":true','"viewOnly":false')};
  await assert.rejects(openPackage(forged,'секрет-123'),/Неверный пароль/,'header is authenticated');
});
test('random key envelope and QR links',async()=>{
  const {bytes,keyCode,header}=await sealPackage(inner,{},{},{zipStore});
  const link=keyLink(header,keyCode);const parsed=parseKeyLink(link);assert.equal(parsed.id,header.id);
  const env=await readEnvelope(bytes,JSZip);assert.deepEqual((await openPackage(env,parsed.key)).inner,inner);
  assert.equal(parseKeyLink(keyLink(header,null,'pa ss')).password,'pa ss');assert.equal(parseKeyLink('hello'),null);
});
test('policy: expiry, one-time, revocation, clock rollback',()=>{
  const h={id:'a',expiresAt:new Date(Date.now()-1000).toISOString()};
  assert.match(checkPolicy(h).reason,/истёк/);
  assert.match(checkPolicy({id:'a',oneTime:true},{seen:new Set(['a'])}).reason,/Одноразовый/);
  assert.match(checkPolicy({id:'a'},{revoked:new Set(['a'])}).reason,/отозван/);
  assert.match(checkPolicy({id:'a'},{lastSeenTime:Date.now()+3*86400e3}).reason,/назад/);
  assert.ok(checkPolicy({id:'a'}).ok);
});
test('audit chain and signed receipts',async()=>{
  let chain=await appendAudit([],{type:'created',who:'Бюро'});chain=await appendAudit(chain,{type:'opened',who:'Иван'});
  assert.ok(await verifyAudit(chain));const bad=chain.map(e=>({...e}));bad[0].who='Другой';assert.equal(await verifyAudit(bad),false);
  const raw=randomBytes(32);const r=await makeReceipt(raw,{packageId:'p',revision:2,files:[],name:'Иван',company:'Завод',chain});
  const v=await verifyReceipt(raw,r);assert.ok(v.ok&&v.chainOk);assert.equal(v.data.name,'Иван');
  assert.equal((await verifyReceipt(randomBytes(32),r)).ok,false);
});
test('sealed bytes at rest',async()=>{const k=randomBytes(32);const s=await sealBytes(k,inner);assert.deepEqual(await openBytes(k,s),inner);await assert.rejects(openBytes(randomBytes(32),s));});
