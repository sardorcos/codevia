// Protected .mlink v2 ("secure envelope"), audit trail and receipts. WebCrypto only (browser, WKWebView, Node 20+).
//
// File layout (ZIP, stored):
//   envelope.json  — public header, authenticated as AES-GCM additional data (cannot be altered without breaking decryption)
//   payload.bin    — AES-256-GCM(inner .mlink v1 ZIP + policy + audit chain)
// Key: PBKDF2-SHA256(password, salt, 310 000) or a random 256-bit key handed over as a QR/text code.
// Receipts (.mlinkack): acknowledgement JSON signed with HMAC-SHA256(key derived from the package key).
//
// Limits (stated honestly in the UI): protection on the recipient's device is a deterrent — the app enforces
// view-only, expiry and one-time opening, but cannot stop a determined person who has the key from photographing the screen.

const subtle = globalThis.crypto?.subtle;
const enc = new TextEncoder(), dec = new TextDecoder();
export const PBKDF2_ITERATIONS = 310000;
const MIN_PBKDF2_ITERATIONS = 100000, MAX_PBKDF2_ITERATIONS = 2000000;

export function cryptoAvailable() { return !!subtle; }
function need() { if (!subtle) throw new Error('Шифрование недоступно на этом устройстве'); }

export const b64u = {
  enc(bytes) { let s = ''; const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); },
  dec(str) { const s = String(str).replace(/-/g, '+').replace(/_/g, '/'); const bin = atob(s + '==='.slice((s.length + 3) % 4)); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; },
};
export const hex = bytes => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
export function randomBytes(n) { const b = new Uint8Array(n); crypto.getRandomValues(b); return b; }
export function uuid() { return crypto.randomUUID ? crypto.randomUUID() : hex(randomBytes(16)).replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5'); }

export async function sha256(data) { need(); const bytes = typeof data === 'string' ? enc.encode(data) : data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data; return hex(await subtle.digest('SHA-256', bytes)); }

/** Raw 32-byte content key from a password (PBKDF2) or from a key code. */
export async function deriveKey(secret, kdf) {
  need();
  if (kdf.alg === 'raw') { let k; try { k = typeof secret === 'string' ? b64u.dec(secret.trim()) : secret; } catch { throw new Error('Неверный ключ доступа'); } if (!k || k.length !== 32) throw new Error('Неверный ключ доступа'); return k; }
  if (kdf.alg !== 'PBKDF2-SHA256') throw new Error('Неизвестный способ защиты пакета');
  // The header is untrusted input: a crafted package must not make the device grind through an absurd iteration count.
  if (!Number.isSafeInteger(kdf.iter) || kdf.iter < MIN_PBKDF2_ITERATIONS || kdf.iter > MAX_PBKDF2_ITERATIONS || typeof kdf.salt !== 'string' || kdf.salt.length < 16 || kdf.salt.length > 128) throw new Error('Неизвестный способ защиты пакета');
  const base = await subtle.importKey('raw', enc.encode(String(secret).normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: b64u.dec(kdf.salt), iterations: kdf.iter }, base, 256));
}
async function aesKey(raw) { return subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']); }
async function macKey(raw) { const k = new Uint8Array(await subtle.digest('SHA-256', new Uint8Array([...raw, ...enc.encode('modellink-receipt')]))); return subtle.importKey('raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); }
export async function hmac(raw, text) { need(); return b64u.enc(await subtle.sign('HMAC', await macKey(raw), enc.encode(text))); }
export async function hmacVerify(raw, text, sig) { need(); try { return await subtle.verify('HMAC', await macKey(raw), b64u.dec(sig), enc.encode(text)); } catch { return false; } }

/** Encrypts bytes for storage at rest (vault, sandbox cache) with a device key. Output: iv(12) || ciphertext. */
export async function sealBytes(raw, bytes) { need(); const iv = randomBytes(12); const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(raw), bytes)); const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12); return out; }
export async function openBytes(raw, sealed) { need(); const u = sealed instanceof Uint8Array ? sealed : new Uint8Array(sealed); try { return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: u.subarray(0, 12) }, await aesKey(raw), u.subarray(12))); } catch { throw new Error('Не удалось расшифровать данные'); } }

// ---------------------------------------------------------------- envelope
/**
 * policy: {recipient:{name,company}, sender, expiresAt (ISO|null), viewOnly, oneTime, checkUrl, title}
 * secret: {password} or {key:Uint8Array(32)}
 * Returns {bytes (ZIP), id, keyCode (when a random key is used), header}
 */
export async function sealPackage(innerBytes, policy, secret, { zipStore }) {
  need();
  const id = uuid(), iv = randomBytes(12);
  let kdf, raw, keyCode = null;
  if (secret.password) { kdf = { alg: 'PBKDF2-SHA256', iter: PBKDF2_ITERATIONS, salt: b64u.enc(randomBytes(16)) }; raw = await deriveKey(secret.password, kdf); }
  else { raw = secret.key || randomBytes(32); kdf = { alg: 'raw' }; keyCode = b64u.enc(raw); }
  const header = {
    format: 'modellink-secure', v: 2, id, created: new Date().toISOString(),
    sender: policy.sender || '', recipient: policy.recipient || null,
    expiresAt: policy.expiresAt || null, viewOnly: !!policy.viewOnly, oneTime: !!policy.oneTime,
    checkUrl: policy.checkUrl || null, cipher: 'AES-256-GCM', kdf, iv: b64u.enc(iv),
  };
  const headerText = JSON.stringify(header);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(headerText) }, await aesKey(raw), innerBytes));
  const bytes = zipStore([{ name: 'envelope.json', data: enc.encode(headerText) }, { name: 'payload.bin', data: ct }]);
  return { bytes, id, keyCode, header, raw };
}

/** Reads the public header without a key (to ask for a password, show recipient and expiry). */
export async function readEnvelope(blob, JSZip) {
  const zip = await JSZip.loadAsync(blob);
  const h = zip.file('envelope.json'); if (!h) return null; // plain v1 package
  const headerText = await h.async('string');
  const header = JSON.parse(headerText);
  if (header.format !== 'modellink-secure' || header.v !== 2) throw new Error('Неподдерживаемая версия защищённого пакета');
  const payload = zip.file('payload.bin'); if (!payload) throw new Error('Пакет повреждён');
  return { header, headerText, payload: await payload.async('uint8array') };
}

export async function openPackage(env, secret, { rawKey = false } = {}) {
  need();
  const raw = await deriveKey(secret, rawKey ? { alg: 'raw' } : env.header.kdf); // a key code (QR) also opens password packages
  try {
    const plain = await subtle.decrypt({ name: 'AES-GCM', iv: b64u.dec(env.header.iv), additionalData: enc.encode(env.headerText) }, await aesKey(raw), env.payload);
    return { inner: new Uint8Array(plain), raw };
  } catch { throw new Error(rawKey || env.header.kdf.alg === 'raw' ? 'Неверный ключ доступа' : 'Неверный пароль'); }
}

/** Policy checks that do not need the network. `seen` = ids opened on this device, `clock` = max time seen. */
export function checkPolicy(header, { now = Date.now(), seen = new Set(), revoked = new Set(), lastSeenTime = 0 } = {}) {
  if (revoked.has(header.id)) return { ok: false, reason: 'Доступ к пакету отозван отправителем' };
  if (lastSeenTime && now < lastSeenTime - 24 * 3600e3) return { ok: false, reason: 'Время на устройстве переведено назад — пакет со сроком действия не откроется' };
  if (header.expiresAt && now > Date.parse(header.expiresAt)) return { ok: false, reason: `Срок действия пакета истёк ${new Date(header.expiresAt).toLocaleDateString('ru-RU')}` };
  if (header.oneTime && seen.has(header.id)) return { ok: false, reason: 'Одноразовый пакет уже был открыт на этом устройстве' };
  return { ok: true };
}

// ---------------------------------------------------------------- QR / text codes for keys
export function keyLink(header, keyCode, password) {
  return password ? `mlink:pass:${header.id}:${b64u.enc(enc.encode(password))}` : `mlink:key:${header.id}:${keyCode}`;
}
export function parseKeyLink(text) {
  const m = /^mlink:(key|pass):([0-9a-f-]{8,64}):([A-Za-z0-9_-]+)$/.exec(String(text || '').trim());
  if (!m) return null;
  return m[1] === 'key' ? { id: m[2], key: m[3] } : { id: m[2], password: dec.decode(b64u.dec(m[3])) };
}

// ---------------------------------------------------------------- audit chain ("black box")
export async function appendAudit(chain, event) {
  const prev = chain.length ? chain[chain.length - 1].h : '0'.repeat(64);
  const entry = { t: new Date().toISOString(), ...event, prev };
  entry.h = await sha256(prev + JSON.stringify({ ...entry, h: undefined }));
  return [...chain, entry];
}
export async function verifyAudit(chain) {
  let prev = '0'.repeat(64);
  for (const e of chain) {
    if (e.prev !== prev) return false;
    const { h, ...rest } = e;
    if (h !== await sha256(prev + JSON.stringify({ ...rest, h: undefined }))) return false;
    prev = h;
  }
  return true;
}

// ---------------------------------------------------------------- acknowledgement receipts
export async function makeReceipt(raw, { packageId, revision, files, name, company, chain }) {
  const body = { format: 'modellink-receipt', v: 1, packageId, revision, files, name, company, at: new Date().toISOString(), chain };
  const text = JSON.stringify(body);
  return JSON.stringify({ body: text, sig: await hmac(raw, text) });
}
export async function verifyReceipt(raw, receiptText) {
  const { body, sig } = JSON.parse(receiptText);
  const ok = await hmacVerify(raw, body, sig);
  const data = JSON.parse(body);
  return { ok: ok && data.format === 'modellink-receipt', data, chainOk: Array.isArray(data.chain) ? await verifyAudit(data.chain) : false };
}
