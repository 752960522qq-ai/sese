export async function expandFiles(inputs) {
  const result=[], names=new Set(),limit=384*1024*1024;
  for(const f of inputs){
    if(!/\.zip$/i.test(f.name)){result.push(f);continue;}
    if(f.size>limit)throw Error('关卡 ZIP 过大');
    const {unzipSync}=await import('./vendor/fflate.module.js');
    let total=0;
    const out=unzipSync(new Uint8Array(await f.arrayBuffer()),{filter:entry=>{
      const path=entry.name.split('/'),name=path.at(-1);
      if(!/\.(json|glb)$/i.test(name)||path.some(x=>x.startsWith('.')||x==='__MACOSX'))return false;
      const key=name.normalize('NFC').toLowerCase();
      if(names.has(key))throw Error('ZIP 中有重名文件 '+name);names.add(key);
      const max=(/\.glb$/i.test(name)?96:24)*1024*1024;
      total+=entry.originalSize;
      if(entry.originalSize>max||total>limit)throw Error('ZIP 展开后超过文件大小限制');
      return true;
    }});
    let count=0;
    for(const [path,bytes] of Object.entries(out)){result.push(new File([bytes],path.split('/').at(-1)));count++;}
    if(!count)throw Error('ZIP 里没有关卡、模块或动作文件');
  }
  return result;
}
