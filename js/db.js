/* Tiny IndexedDB wrapper: keeps imported media files and the project in the browser
   so a page reload does not lose the edit. */
const DB = (() => {
  const NAME = 'quikweb', VERSION = 1;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('IndexedDB unavailable'));
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(store, mode, fn) {
    return open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      const req = fn(s);
      t.oncomplete = () => resolve(req && req.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }

  return {
    putFile: (id, blob) => tx('files', 'readwrite', s => s.put(blob, id)).catch(() => null),
    getFile: (id) => tx('files', 'readonly', s => s.get(id)).catch(() => null),
    deleteFile: (id) => tx('files', 'readwrite', s => s.delete(id)).catch(() => null),
    allFileIds: () => tx('files', 'readonly', s => s.getAllKeys()).catch(() => []),
    putKV: (k, v) => tx('kv', 'readwrite', s => s.put(v, k)).catch(() => null),
    getKV: (k) => tx('kv', 'readonly', s => s.get(k)).catch(() => null),
    clear: async () => {
      await tx('files', 'readwrite', s => s.clear()).catch(() => null);
      await tx('kv', 'readwrite', s => s.clear()).catch(() => null);
    }
  };
})();
