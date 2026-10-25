// IndexedDB の薄いラッパー。ストアは仕様書7章のデータの形に合わせる。
// データ系のストアへの書き込み・削除は outbox にも記録し、同期（sync.js）で他の端末へ送る。
const DB_NAME = 'yozora';
const DB_VERSION = 2;

export const STORES = ['memos', 'boxes', 'links', 'corrections', 'suggestions', 'meta'];
// 同期・バックアップの対象
export const DATA_STORES = ['memos', 'boxes', 'links', 'corrections', 'suggestions'];
const SYNCED = new Set(DATA_STORES);

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('memos')) {
        const s = db.createObjectStore('memos', { keyPath: 'id' });
        s.createIndex('boxId', 'boxId');
        s.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains('boxes')) db.createObjectStore('boxes', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('links')) db.createObjectStore('links', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('corrections')) db.createObjectStore('corrections', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('suggestions')) db.createObjectStore('suggestions', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      // まだ他の端末に送っていない変更（store|id ごとに最新の1件）
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function store(name, mode = 'readonly') {
  const db = await openDB();
  return db.transaction(name, mode).objectStore(name);
}

// ---------- ローカルの変更の通知（同期のきっかけ） ----------

const writeListeners = new Set();
export function onLocalWrite(fn) {
  writeListeners.add(fn);
}
function wrote() {
  for (const fn of writeListeners) fn();
}

let lastAt = 0;
function stamp() {
  // 同じミリ秒に続けて書いても順番がわかるように
  lastAt = Math.max(Date.now(), lastAt + 1);
  return lastAt;
}

function outboxEntry(name, id, deleted) {
  return { key: `${name}|${id}`, store: name, id, deleted, at: stamp() };
}

// ---------- 読み書き ----------

export async function getAll(name) {
  return wrap((await store(name)).getAll());
}

export async function get(name, key) {
  return wrap((await store(name)).get(key));
}

export async function put(name, value) {
  const db = await openDB();
  if (!SYNCED.has(name)) {
    await wrap(db.transaction(name, 'readwrite').objectStore(name).put(value));
    return value;
  }
  const tx = db.transaction([name, 'outbox'], 'readwrite');
  tx.objectStore(name).put(value);
  tx.objectStore('outbox').put(outboxEntry(name, value.id, false));
  await done(tx);
  wrote();
  return value;
}

export async function del(name, key) {
  const db = await openDB();
  if (!SYNCED.has(name)) return wrap(db.transaction(name, 'readwrite').objectStore(name).delete(key));
  const tx = db.transaction([name, 'outbox'], 'readwrite');
  tx.objectStore(name).delete(key);
  tx.objectStore('outbox').put(outboxEntry(name, key, true));
  await done(tx);
  wrote();
}

// 他の端末から届いた変更を反映する（outbox には積まない）
export async function applyRemote(changes) {
  if (!changes.length) return;
  const db = await openDB();
  const tx = db.transaction([...DATA_STORES], 'readwrite');
  for (const c of changes) {
    if (!SYNCED.has(c.store)) continue;
    if (c.deleted) tx.objectStore(c.store).delete(c.id);
    else if (c.data && c.data.id === c.id) tx.objectStore(c.store).put(c.data);
  }
  await done(tx);
}

// 同期を始める時、今ある全部の行を「未送信」にする
export async function markAllForSync() {
  const db = await openDB();
  const rows = {};
  for (const name of DATA_STORES) rows[name] = await getAll(name);
  const tx = db.transaction('outbox', 'readwrite');
  const ob = tx.objectStore('outbox');
  for (const name of DATA_STORES) for (const r of rows[name]) ob.put(outboxEntry(name, r.id, false));
  await done(tx);
  wrote();
}

export async function getMeta(key, fallback = null) {
  const row = await get('meta', key);
  return row ? row.value : fallback;
}

export async function setMeta(key, value) {
  return put('meta', { key, value });
}

export function newId() {
  return Date.now().toString(36) + '-' + crypto.getRandomValues(new Uint32Array(1))[0].toString(36);
}

// この端末を見分けるID（AIの振り分けを、メモを書いた端末だけで行うために使う）
let deviceIdCache = null;
export async function getDeviceId() {
  if (deviceIdCache) return deviceIdCache;
  let id = await getMeta('deviceId', null);
  if (!id) {
    id = 'd-' + newId();
    await setMeta('deviceId', id);
  }
  deviceIdCache = id;
  return id;
}

// 全部消す時は、同期している他の端末からも消えるように削除として記録する
export async function clearStore(name) {
  if (!SYNCED.has(name)) return wrap((await store(name, 'readwrite')).clear());
  const keys = await wrap((await store(name)).getAllKeys());
  const db = await openDB();
  const tx = db.transaction([name, 'outbox'], 'readwrite');
  tx.objectStore(name).clear();
  for (const k of keys) tx.objectStore('outbox').put(outboxEntry(name, k, true));
  await done(tx);
  wrote();
}

// ---------- バックアップ ----------

export async function exportAll() {
  const out = {};
  for (const name of DATA_STORES) out[name] = await getAll(name);
  return out;
}

export async function replaceAll(data) {
  const before = {};
  for (const name of DATA_STORES) before[name] = await wrap((await store(name)).getAllKeys());
  const db = await openDB();
  const tx = db.transaction([...DATA_STORES, 'outbox'], 'readwrite');
  const ob = tx.objectStore('outbox');
  for (const name of DATA_STORES) {
    const s = tx.objectStore(name);
    const rows = Array.isArray(data[name]) ? data[name] : [];
    const keep = new Set(rows.map((r) => r.id));
    s.clear();
    for (const row of rows) {
      s.put(row);
      ob.put(outboxEntry(name, row.id, false));
    }
    for (const k of before[name]) if (!keep.has(k)) ob.put(outboxEntry(name, k, true));
  }
  await done(tx);
  wrote();
}
