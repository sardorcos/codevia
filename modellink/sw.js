const CACHE_NAME = 'modellink-shell-0.4.1';
const CORE = ['./','./index.html','./styles.css','./app.js','./core/storage.js','./core/geometry.js','./core/pack.js','./vendor/jszip.min.js','./vendor/capacitor-core.js','./assets/app-icon.png','./assets/icons/logo.png'];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(CORE)).then(()=>self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k=>k.startsWith('modellink-shell-')&&k!==CACHE_NAME).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch', e => {
  if(e.request.method!=='GET'||new URL(e.request.url).origin!==location.origin) return;
  e.respondWith(fetch(e.request).then(response => {if(response.ok){const copy=response.clone();caches.open(CACHE_NAME).then(cache=>cache.put(e.request,copy));}return response;}).catch(()=>caches.match(e.request).then(x=>x||caches.match('./index.html'))));
});
