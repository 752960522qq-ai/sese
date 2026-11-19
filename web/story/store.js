import { fileKey } from './project.js';

let opening;
function database() {
  if (!opening)
    opening = new Promise((resolve, reject) => {
      const q = indexedDB.open('sese.pose.story', 1);
      q.onupgradeneeded = () => {
        q.result.createObjectStore('files', { keyPath: 'key' });
        q.result.createObjectStore('settings');
      };
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => {
        opening = null;
        reject(q.error);
      };
    });
  return opening;
}
export async function loadDraft() {
  const db = await database();
  return new Promise((ok, no) => {
    const tx = db.transaction(['files', 'settings']);
    const files = tx.objectStore('files').getAll(),
      ui = tx.objectStore('settings').get('current');
    tx.oncomplete = () => ok({ files: files.result, ui: ui.result });
    tx.onerror = tx.onabort = () => no(tx.error || Error('无法读取剧情草稿'));
  });
}
export async function saveDraft(records, ui) {
  const db = await database();
  return new Promise((ok, no) => {
    const tx = db.transaction(['files', 'settings'], 'readwrite');
    for (const r of records) tx.objectStore('files').put({ ...r, key: fileKey(r.name) });
    tx.objectStore('settings').put(ui, 'current');
    tx.oncomplete = ok;
    tx.onerror = tx.onabort = () => no(tx.error || Error('草稿未保存，请检查可用空间'));
  });
}
