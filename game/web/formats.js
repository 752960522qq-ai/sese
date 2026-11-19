import {chapterNode} from './chapter-nodes.js';
import {readCombination} from './scene-file.js';
import {BASE_POSES} from './duel.js';
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const vec=(v,n)=>Array.isArray(v)&&v.length===n&&v.every(Number.isFinite);
const fail=m=>{throw Error(m);};
const str=(v,max=120)=>typeof v==='string'&&v.trim().length>0&&v.length<=max;
const id=v=>str(v,90)&&/^[A-Za-z0-9_.-]+$/.test(v);
const filename=v=>str(v,180)&&!/[\\/\u0000-\u001f]/.test(v)&&v!=='.'&&v!=='..';
const within=(n,a,b)=>Number.isFinite(n)&&n>=a&&n<=b;
export function encounter(n) {
  n.goal??='first';n.background??=.55;n.danger??=85;n.lead??={id:'lead'};
  n.opponents??=[{id:'partner',label:'对手',model:'leon'}];
  if(!['first','all'].includes(n.goal)||!within(n.background,0,1)||!within(n.danger,80,90))fail('多人结算或危险阈值无效');
  if(!Array.isArray(n.opponents)||n.opponents.length<1||n.opponents.length>15)fail('每个模块支持 1 至 15 名对手');
  const ids=new Set();
  for(const [i,a] of [n.lead,...n.opponents].entries()){
    if(!object(a)||!id(a.id)||ids.has(a.id))fail('玩家和对手须使用不同的角色 ID');
    ids.add(a.id);a.label??=i?'对手 '+i:'甄芙';a.model??=i?'leon':'zhenfu';
    if(!str(a.label,40)||!['zhenfu','leon','leonSuit'].includes(a.model)||(!i&&a.model!=='zhenfu'))fail('模块演员设置无效');
    for(const [key,value,lo,hi] of [['start',0,0,99.99],['stamina',100,0,100],['sensitivity',1,.1,5],['attack',1,.1,5],['defense',1,.1,5],['gain',i?1.10:1.06,0,20]]){
      a[key]??=value;if(!within(a[key],lo,hi))fail(a.id+' 的 '+key+' 超出范围');
    }
  }
  n.poses??=BASE_POSES.map(p=>({...p}));
  if(!Array.isArray(n.poses)||!n.poses.length||n.poses.length>12)fail('姿势列表无效');
  for(const p of n.poses){
    if(!object(p)||!str(p.name,40)||!within(p.self,.1,5)||!within(p.other,.1,5)||(p.file&&!filename(p.file)))fail('姿势或动作文件无效');
    if(p.seconds!==undefined&&!within(p.seconds,.1,3600))fail('动作循环长度无效');
    if(p.multipliers&&(!object(p.multipliers)||Object.entries(p.multipliers).some(([k,v])=>!ids.has(k)||!within(v,0,10))))fail('角色倍率无效');
    if(p.events!==undefined){
      if(!Array.isArray(p.events)||p.events.length>1000||!p.seconds)fail('数值事件须指定循环长度');
      let last=-1;
      for(const e of p.events){
        if(!object(e)||!within(e.at,.001,p.seconds)||e.at<=last||!object(e.delta)||Object.entries(e.delta).some(([k,v])=>!ids.has(k)||!within(v,0,100)))fail('数值事件时间或角色无效');
        last=e.at;
      }
    }
  }
  n.rewards??={win:20,great:35,lose:-5};
  for(const k of ['win','great','lose'])if(!Number.isSafeInteger(n.rewards?.[k])||Math.abs(n.rewards[k])>100000)fail('结算值无效');
  return n;
}
export function documentModule(d){
  if(d.type!=='sese-encounter-module'||d.version!==1||!id(d.id)||!str(d.title))fail('对局模块标识或版本有误');
  encounter(d);
  return {kind:'module',title:d.title,data:d,refs:[...new Set(d.poses.filter(p=>p.file).map(p=>p.file.split('#')[0]))]};
}
export function documentLevel(data) {
  if(!object(data)||data.type!=='sese-story-level'||data.version!==1)fail('不支持此关卡格式或版本');
  const n=data.nodes;
  if(!id(data.id)||!str(data.title)||!id(data.start)||!object(n)||!Object.hasOwn(n,data.start)||Object.keys(n).length>800)fail('关卡标识、标题或起始节点有误');
  if(!['hero13-v23','hero13-v24'].includes(data.city)||!vec(data.spawn,3))fail('城市须为 hero13-v23 或 hero13-v24，出生点须为三维坐标');
  const links=[], refs=new Set();
  for(const [key,node] of Object.entries(n)){
    if(!id(key)||!object(node))fail('节点无效 '+key);
    const link=(v)=>{if(!id(v)||!Object.hasOwn(n,v))fail(key+' 指向不存在的节点 '+String(v));links.push([key,v]);};
    const ref=(v)=>{if(!filename(v))fail(key+' 的动作文件名无效');refs.add(v.split('#')[0]);};
    switch(node.kind) {
      case 'dialogue':
        if(!str(node.text,4000)||(node.speaker!==undefined&&!str(node.speaker,80)))fail(key+' 缺少对白');
        if(node.choices!==undefined){
          if(!Array.isArray(node.choices)||!node.choices.length||node.choices.length>8)fail(key+' 选项无效');
          node.choices.forEach(c=>{if(!object(c)||!str(c.label,100))fail(key+' 选项文字无效');link(c.next);});
        }else link(node.next);
        break;
      case 'walk':
        if(!vec(node.position,3)||!within(node.radius,0.5,100)||!str(node.label))fail(key+' 的目的地无效');
        link(node.next);break;
      case 'motion':
        ref(node.file);if(node.seconds!==undefined&&!within(node.seconds,.1,3600))fail(key+' 的播放时长无效');
        link(node.next);break;
      case 'encounter':
        if(!str(node.label))fail(key+' 缺少对局名称');
        if(node.module){ref(node.module);}else{encounter(node);for(const p of node.poses)if(p.file)ref(p.file);}
        link(node.win);link(node.great??node.win);if(node.lose)link(node.lose);break;
      case 'end':if(!str(node.text,4000))fail(key+' 缺少结尾');break;
      default:if(!chapterNode(node,link))fail(key+' 包含未知节点类型');
    }
  }
  const seen=new Set([data.start]),pending=[data.start],adj=new Map();
  for(const [a,b] of links){if(!adj.has(a))adj.set(a,[]);adj.get(a).push(b);}
  while(pending.length){for(const k of adj.get(pending.pop())??[])if(!seen.has(k)){pending.push(k);seen.add(k);}}
  if(![...seen].some(k=>n[k].kind==='end'))fail('起点没有通往结尾的路径');
  return {kind:'level',title:data.title,data,refs:[...refs]};
}
function actionScene(doc,file) {
  if(doc.type==='sese-action'){
    if(doc.version!==1||!object(doc.actor))fail('独立动作文件格式有误');
    const a=doc.actor;
    doc={type:'sese-pose-combination',version:1,name:doc.name??file,
      scene:{format:1,actors:[{p:[0,0,0],yaw:0,id:'lead',label:a.type==='leonSuit'?'西装里昂':a.type==='leon'?'里昂':'甄芙',rate:1,time:0,dir:1,offsets:{},keys:[],...a}]}};
  }
  const parsed=readCombination(JSON.stringify(doc));const s=parsed.scene;
  if(s.format!==1||!s.actors.length||s.actors.length>16)fail('动作角色数量或版本有误');
  if(new Set(s.actors.map(a=>a.id)).size!==s.actors.length)fail('搭配中有重复角色');
  for(const a of s.actors){
    if(!['zhenfu','leon','leonSuit'].includes(a.type)||!str(a.id)||!vec(a.p,3)||!Number.isFinite(a.yaw)||!str(a.clip)||!within(a.rate,0,12)||!Number.isFinite(a.time))fail('动作中的角色参数无效');
    if(a.clip==='@keys'&&!a.keys.length)fail('自编动作缺少关键帧');
  }
  if(s.camera&&(!vec(s.camera.p,3)||!vec(s.camera.target,3)))fail('动作镜头坐标无效');
  return {kind:'motion',title:parsed.name||file,data:s};
}
export async function readImport(file,readGlb) {
  const name=file.name.normalize('NFC');
  const glb=/\.glb$/i.test(name);
  if(!filename(name)||file.size>(glb?96:24)*1024*1024)fail('文件名无效或文件过大');
  if(glb)return {...await readGlb(file),name};
  let doc;
  try{doc=JSON.parse((await file.text()).replace(/^\uFEFF/,''));}catch{fail(name+' 不是有效 JSON');}
  const r=doc?.type==='sese-story-level'?documentLevel(doc):doc?.type==='sese-encounter-module'?documentModule(doc):actionScene(doc??{},name);
  return {...r,name};
}
