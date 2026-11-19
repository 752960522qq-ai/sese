const database = new Promise((ok, fail) => {
  const request = indexedDB.open('sese.pose.studio', 2);
  request.onupgradeneeded = () => {
    const db = request.result;
    for (const store of ['scenes', 'actions', 'settings'])
      if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: 'id' });
  };
  request.onsuccess = () => ok(request.result);
  request.onerror = () => fail(request.error);
});
export async function entries(store) {
  const db = await database;
  return new Promise((ok, fail) => {
    const r = db.transaction(store).objectStore(store).getAll();
    r.onsuccess = () => ok(r.result.sort((a, b) => b.date - a.date));
    r.onerror = () => fail(r.error);
  });
}
export async function put(store, id, name, data) {
  const db = await database;
  return new Promise((ok, fail) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put({ version: 1, id, name, date: Date.now(), data });
    tx.oncomplete = ok;
    tx.onabort = tx.onerror = () => fail(tx.error || Error('无法写入存档'));
  });
}
export async function get(store, id) {
  const db = await database;
  return new Promise((ok, fail) => {
    const r = db.transaction(store).objectStore(store).get(id);
    r.onsuccess = () => (r.result ? ok(r.result.data) : fail(Error('存档不存在')));
    r.onerror = () => fail(r.error);
  });
}

export async function peek(store, id) {
  const db = await database;
  return new Promise((ok, fail) => {
    const r = db.transaction(store).objectStore(store).get(id);
    r.onsuccess = () => ok(r.result?.data);
    r.onerror = () => fail(r.error);
  });
}
export async function drop(store, id) {
  const db = await database;
  return new Promise((ok, fail) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(id);
    tx.oncomplete = ok;
    tx.onabort = tx.onerror = () => fail(tx.error);
  });
}
