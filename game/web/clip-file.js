import * as T from './vendor/three.module.min.js';
import {GLTFLoader} from './vendor/loaders/GLTFLoader.js';
import {validContactBodies} from './scene-file.js';
const cache=new Map();
let skeletons;
function pieces(bytes) {
  const v=new DataView(bytes);
  if(bytes.byteLength<28||v.getUint32(0,true)!==0x46546c67||v.getUint32(4,true)!==2||v.getUint32(8,true)!==bytes.byteLength||v.getUint32(16,true)!==0x4e4f534a)throw Error('需要 glTF 2.0 二进制动作文件');
  const n=v.getUint32(12,true),i=20+n;
  if(i+8>bytes.byteLength||v.getUint32(i+4,true)!==0x004e4942||v.getUint32(i,true)>bytes.byteLength-i-8)throw Error('GLB 的二进制数据不完整');
  const json=JSON.parse(new TextDecoder().decode(new Uint8Array(bytes,20,n)));
  if(json.buffers?.length!==1||json.buffers[0].uri||!Array.isArray(json.animations)||!json.animations.length)throw Error('GLB 需要内嵌骨骼动作');
  return {json,bin:new Uint8Array(bytes,i+8,v.getUint32(i,true))};
}
export async function inspectGlb(file){
  const data=await file.arrayBuffer(),{json}=pieces(data);
  skeletons??=Promise.all(['zhenfu','leon','leonSuit'].map(async type=>{
    const spec=await (await fetch('./models/'+type+'/actor.gltf')).json();
    return {type,bones:new Set(spec.skins[0].joints.map(i=>T.PropertyBinding.sanitizeNodeName(spec.nodes[i].name)))};
  }));
  const rigs=await skeletons;
  const clips=json.animations.map((a,i)=>{
    const targets=new Set(a.channels.filter(c=>['rotation','translation','scale'].includes(c.target.path)).map(c=>T.PropertyBinding.sanitizeNodeName(json.nodes[c.target.node]?.name||'')));
    const options=rigs.map(r=>({type:r.type,hits:[...targets].filter(name=>r.bones.has(name)).length})).sort((a,b)=>b.hits-a.hits);
    if(!options[0].hits||options[0].hits<targets.size*.5)return null;
    const bodies=a.extras?.contactBodies,type=options[0].type;
    if(!validContactBodies(bodies,type))throw Error('GLB 片段的碰撞体或轨迹无效');
    const bones=rigs.find(r=>r.type===type).bones;
    for(const b of bodies||[])if(!['rim','model'].includes(b.anchor)&&!bones.has(T.PropertyBinding.sanitizeNodeName(b.anchor)))
      throw Error('角色缺少碰撞体锚点 '+b.anchor);
    return {name:a.name||'clip_'+i,index:i,type:options[0].type};
  }).filter(Boolean);
  if(!clips.length)throw Error('该 GLB 没有可映射到甄芙或里昂的同名骨骼片段');
  return {kind:'glb',title:file.name,data,clips};
}
export async function glbClip(record,which,actor) {
  const key=which||record.clips[0].name;
  const c=record.clips.find(c=>c.name===key);
  if(!c)throw Error('文件中没有动作 '+key);
  const cacheKey=record.name+'|'+record.date+'|'+key;
  if(cache.has(cacheKey))return cache.get(cacheKey);
  const {json,bin}=pieces(record.data);
  const a=json.animations[c.index];
  const channels=a.channels.filter(ch=>{
    const n=json.nodes[ch.target.node]?.name;
    return n&&actor.bones.has(T.PropertyBinding.sanitizeNodeName(n))&&['rotation','translation','scale'].includes(ch.target.path);
  });
  const uri=URL.createObjectURL(new Blob([bin]));
  try{
    const nodes=json.nodes.map(n=>({name:n.name||''}));
    const stripped={asset:{version:'2.0'},scene:0,scenes:[{nodes:nodes.map((_,i)=>i)}],nodes,
      buffers:[{byteLength:json.buffers[0].byteLength,uri}],bufferViews:json.bufferViews,accessors:json.accessors,
      animations:[{name:key,samplers:a.samplers,channels}]};
    const parsed=await new GLTFLoader().parseAsync(stripped,'');
    const clip=parsed.animations[0];if(!clip?.tracks.length)throw Error('动作没有可播放的骨骼轨道');
    if(a.extras?.contactBodies){
      if(!validContactBodies(a.extras.contactBodies,actor.type))throw Error('GLB 片段的碰撞体或轨迹无效');
      for(const body of a.extras.contactBodies)if(!['model','rim'].includes(body.anchor)&&
        !actor.bones.has(T.PropertyBinding.sanitizeNodeName(body.anchor)))throw Error('角色缺少碰撞体锚点 '+body.anchor);
      clip.userData={contactBodies:a.extras.contactBodies};
    }
    if(cache.size>12)cache.clear();cache.set(cacheKey,clip);return clip;
  }finally{URL.revokeObjectURL(uri);}
}
