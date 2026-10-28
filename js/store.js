// 変換したルートを端末の中（IndexedDB）に保存する
const DB = 'kml-light', STORE = 'routes';

let dbp;
const db = () => dbp ??= new Promise((res, rej) => {
  const r = indexedDB.open(DB, 1);
  r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});

async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => res(req.result);
    t.onerror = () => rej(t.error);
  });
}

export const listRoutes = () => tx('readonly', s => s.getAll());
export const putRoute = r => tx('readwrite', s => s.put(r));
export const deleteRoute = id => tx('readwrite', s => s.delete(id));
