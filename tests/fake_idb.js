/* In-memory IndexedDB shim for about:blank browser design tests only. */
(() => {
 let created=false;
 const kv=new Map();
 Object.defineProperty(window, "indexedDB", {configurable:true,value:{open(){
  const req={};
  const db={objectStoreNames:{contains(){return created}},createObjectStore(){created=true},transaction(){
   const tx={oncomplete:null,onerror:null,objectStore(){return {
     get(key){const r={};queueMicrotask(()=>{r.result=kv.get(key);r.onsuccess?.()});return r},
     put(value,key){kv.set(key,value);queueMicrotask(()=>tx.oncomplete?.());return {}}
   }}};return tx}};
  queueMicrotask(()=>{req.result=db;if(!created)req.onupgradeneeded?.();req.onsuccess?.()});return req
 }}});
})();
