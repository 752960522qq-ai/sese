const openDB=new Promise((resolve,reject)=>{
  const q=indexedDB.open('studio.sese.citygame',1);
  q.onupgradeneeded=()=>q.result.createObjectStore('imports',{keyPath:'key'});
  q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);
});
export async function readAll(){
  const db=await openDB;
  return new Promise((ok,fail)=>{const q=db.transaction('imports').objectStore('imports').getAll();q.onsuccess=()=>ok(q.result);q.onerror=()=>fail(q.error);});
}
export async function writeBatch(items){
  const db=await openDB;
  await new Promise((ok,fail)=>{
    const tx=db.transaction('imports','readwrite'),store=tx.objectStore('imports');
    for(const item of items)store.put(item);
    tx.oncomplete=ok;tx.onabort=tx.onerror=()=>fail(tx.error||Error('空间不足，导入未保存'));
  });
}
