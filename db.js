// IndexedDB の薄いラッパー。ストアは仕様書7章のデータの形に合わせる。
const DB_NAME = 'yozora';
const DB_VERSION = 1;

export const STORES = ['memos', 'boxes', 'links', 'corrections', 'suggestions', 'meta'];

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

async function store(name, mode = 'readonly') {
  const db = await openDB();
  return db.transaction(name, mode).objectStore(name);
}

export async function getAll(name) {
  return wrap((await store(name)).getAll());
}

export async function get(name, key) {
  return wrap((await store(name)).get(key));
}

export async function put(name, value) {
  await wrap((await store(name, 'readwrite')).put(value));
  return value;
}

export async function del(name, key) {
  return wrap((await store(name, 'readwrite')).delete(key));
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

export async function clearStore(name) {
  return wrap((await store(name, 'readwrite')).clear());
}

// バックアップ用：データ系のストアをまとめて読み書きする
export const DATA_STORES = ['memos', 'boxes', 'links', 'corrections', 'suggestions'];

export async function exportAll() {
  const out = {};
  for (const name of DATA_STORES) out[name] = await getAll(name);
  return out;
}

export async function replaceAll(data) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(DATA_STORES, 'readwrite');
    for (const name of DATA_STORES) {
      const s = tx.objectStore(name);
      s.clear();
      for (const row of Array.isArray(data[name]) ? data[name] : []) s.put(row);
    }
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
