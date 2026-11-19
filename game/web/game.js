import {CityWorld} from './world.js';
import {readImport} from './formats.js';
import {inspectGlb} from './clip-file.js';
import {readAll,writeBatch} from './library.js';
import {newDuel,advance,act,chooseTarget,canAct,inDanger,hitWindow,needle,payout,MOVES,SPEEDS} from './duel.js';

const $=id=>document.getElementById(id),files=new Map(),built=new Set(),pressed=new Set();
const startPos=[140.77,16.7,-654],storageKey='city.save.v1';
const districtNames=['主岛西南','主岛南部西段','主岛南部东段','主岛东南','主岛西北','主岛北部西段','主岛北部东段','主岛东北','西岛西南','西岛东南','西岛西北','西岛东北','东岛西南','东岛东南','东岛西北','东岛东北','公共桥梁','公共水面'];
const outcomes={win:'胜利',great:'大胜',lose:'失败'};
let profile;
try{profile=JSON.parse(localStorage.getItem(storageKey))||{};}catch{profile={};}
profile={points:0,clothes:{pumps:true,stockings:true},run:null,done:{},...profile};
let world,level,node,config,battle,screen='loading',menu=null,pending=false,ready=false,visit=0,poseIndex=0,visualPose=-1,visualRequest=0;
let motionTime=0,motionEnd=0,previewReturn='library',before='',stick=[0,0],pointer=null,toastId,selection='level',currentDistrict=7;
let cards=[],combatRefs=null;
const keyOf=r=>r.kind==='level'?'level:'+r.data.id.toLowerCase():r.name.normalize('NFC').toLowerCase();
const resolve=name=>files.get(name.split('#')[0].normalize('NFC').toLowerCase());
const part=name=>name?.includes('#')?name.slice(name.indexOf('#')+1):undefined;
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
function notify(s){$('toast').textContent=s;$('toast').hidden=false;clearTimeout(toastId);toastId=setTimeout(()=>$('toast').hidden=true,4200);}
window.cityNotice=notify;
function persist(){try{localStorage.setItem(storageKey,JSON.stringify(profile));}catch{notify('设备存储空间不足，当前进度只能保留在本次运行');}}
function checkpoint(){
  if(level&&profile.run){profile.run.position=world.pos.toArray();profile.run.key=keyOf(level);}
  persist();
}
function btn(text,fn,cls,into=$('actions')){
  const b=el('button',cls,text);b.onclick=()=>{if(!pending)Promise.resolve().then(fn).catch(e=>notify(e.message));};into.append(b);return b;
}
function card(title,description,fn,into=$('content')){
  const b=btn('',fn,'card',into);b.append(el('strong','',title));if(description)b.append(el('span','',description));return b;
}
function panel(k,title,copy=''){
  $('panel').hidden=false;$('panel').scrollTop=0;$('eyebrow').textContent=k;$('title').textContent=title;$('copy').textContent=copy;
  $('content').replaceChildren();$('actions').replaceChildren();
}
function resetStick(){pressed.clear();pointer=null;stick=[0,0];$('stick').firstElementChild.style.transform='';}
function bars(){
  const walking=ready&&!menu&&screen==='walk';
  $('stick').hidden=!walking;$('objective').hidden=!walking;$('combat').hidden=!!menu||screen!=='battle';
  $('pause').hidden=!!menu||!['battle','film','preview'].includes(screen);$('journal').hidden=!ready;
  $('location').hidden=!ready||(!menu&&screen==='battle');$('location').textContent='第 '+String(currentDistrict).padStart(2,'0')+' 区  /  '+districtNames[currentDistrict-1];
  if(!walking)resetStick();
}
async function busy(label,fn){
  if(pending)return;pending=true;resetStick();const old=screen;
  try{if(label){screen='loading';bars();panel('正在载入',label,'正在读取本地资源…');}await fn();}
  catch(e){console.error(e);notify(e.message);if(screen==='loading'){screen=old;menu='error';panel('读取未完成','暂时无法打开',e.message);btn('返回手记',()=>openMenu('home'),'primary');}}
  finally{pending=false;bars();}
}
function deps(record,seen=new Set()){
  if(seen.has(record))return [];seen.add(record);let out=[];
  for(const n of record.refs??[]){const r=resolve(n);if(!r)out.push(n);else out.push(...deps(r,seen));}
  return [...new Set(out)];
}
function assertCast(n){
  for(const p of n.poses){if(!p.file)continue;const r=resolve(p.file);if(!r)throw Error('缺少动作 '+p.file);
    if(!['motion','glb'].includes(r.kind))throw Error(p.file+' 不是动作文件');
    if(r.kind==='motion')for(const a of [n.lead,...n.opponents])if(!r.data.actors.some(s=>s.id===a.id&&s.type===a.model))throw Error('动作 '+p.file+' 缺少匹配的演员 '+a.id+'（'+a.model+'）');
    if(r.kind==='glb'){const clip=part(p.file)?r.clips.find(c=>c.name===part(p.file)):r.clips[0];if(!clip||![n.lead,...n.opponents].some(a=>a.model===clip.type))throw Error('GLB 片段或目标骨架不匹配');}
  }
}
function validateRefs(r){
  const missing=deps(r);if(missing.length)throw Error('待导入文件 · '+missing.join('、'));
  for(const t of Object.values(r.data.nodes)){
    if(t.kind==='motion'&&!['glb','motion'].includes(resolve(t.file)?.kind))throw Error(t.file+' 不是动作文件');
    if(t.kind==='encounter'){const m=t.module?resolve(t.module):null;if(t.module&&m?.kind!=='module')throw Error('关卡引用的对局模块类型不符');assertCast(m?.data??t);}
  }
}
function home(){
  menu='home';bars();panel('城市手记','甄芙 · 城市篇',profile.run?'上次的关卡进度已保留。':'从主岛北部的东风汽车销售中心出发。');
  const cont=profile.run&&files.get(profile.run.key);
  if(cont)card('继续 · '+cont.title,'从当前剧情节点继续',()=>launch(cont,true));
  const def=files.get('level:city.district07');
  if(def)card(def.title,'城市剧情  /  第 07 区',()=>launch(def));
  card('三人模块联调','甄芙与两名对手  /  独立数值条',()=>launch(files.get('level:author.first-meeting')));
  btn('关卡与动作',()=>openMenu('library'),'primary');btn('衣柜',()=>openMenu('wardrobe'));btn('自由探索',()=>freeWalk());btn('街区地图',()=>openMenu('map'));
  $('content').append(el('div','minor','手记积分  '+profile.points));
}
function openMenu(which){
  if(pending&&screen==='loading')return;
  if(!menu){before=screen==='home'?'':screen;world?.pauseAudio();resetStick();}
  menu=which;bars();
  if(which==='home'){home();if(ready&&before&&!['loading','home','end'].includes(before))btn('返回当前场景',closeMenu,'subtle');}
  if(which==='wardrobe'){
    panel('甄芙  /  衣柜','职业装','西装、白色内衬和套裙已穿戴。');
    for(const [name,label,detail] of [['pumps','黑色浅口高跟鞋','所有对手防御 −5%'],['stockings','黑色长筒丝袜','所有对手攻速 +3% · 甄芙防御 +7%']]){
      const row=el('div','item'),a=el('div','',label);a.append(el('span','',detail));row.append(a);$('content').append(row);
      const b=btn(profile.clothes[name]?'已穿戴':'穿戴',async()=>{
        if(battle&&!battle.outcome){notify('本场已经开始，结算后可以换装');return;}
        const c={...profile.clothes,[name]:!profile.clothes[name]};await world.clothesTo(c);profile.clothes=c;persist();openMenu('wardrobe');
      },profile.clothes[name]?'current':'',row);b.setAttribute('aria-pressed',String(profile.clothes[name]));
    }
    btn('返回',()=>openMenu('home'),'primary');
  }
  if(which==='library'){
    const types={level:'剧情',module:'对局模块',motion:'动作'};
    panel('内容管理','关卡与动作','可同时选择关卡、模块和动作文件。引用文件按文件名匹配。');
    const tabs=el('div','row');$('content').append(tabs);for(const [k,t] of Object.entries(types))btn(t,()=>{selection=k;openMenu('library');},selection===k?'current':'subtle',tabs);
    for(const r of files.values()){
      if(r.kind!==selection&&!(selection==='motion'&&r.kind==='glb'))continue;
      const missing=deps(r);const detail=missing.length?'缺少 '+missing.join('、'):(r.date?'已导入':'内置')+' · '+r.name;
      card(r.title,detail,()=>r.kind==='level'?launch(r):r.kind==='module'?moduleInfo(r):preview(r));
    }
    btn('导入文件',()=>$('files').click(),'primary');btn('返回手记',()=>openMenu('home'));
  }
  if(which==='map'){
    panel('HERO_13  /  城市 v'+world.index.version,'街区地图','点选街区可自由抵达。剧情会保留当前节点。');
    for(const place of world.index.landmarks||[])btn(place.name,()=>freeWalk(place.position,place.district),'subtle',$('content'));
    const grid=el('div','mapGrid');$('content').append(grid);
    for(let i=1;i<=18;i++){
      const samples=world.index.roadSamples[String(i)],b=btn(String(i).padStart(2,'0')+' '+districtNames[i-1],()=>freeWalk(i===7?startPos:samples[Math.floor(samples.length/2)],i),i===currentDistrict?'current':'',grid);if(!samples.length)b.disabled=true;
    }
    btn('返回手记',()=>openMenu('home'));
  }
  if(which==='paused'){panel('游戏已暂停','暂停','对局数值和动作进度已冻结。');btn('继续',closeMenu,'primary');btn('返回手记',()=>openMenu('home'));}
}
function closeMenu(){menu=null;if(!node&&screen!=='walk'&&screen!=='preview'){home();return;}world?.resumeAudio();render();bars();}
function moduleInfo(r){
  menu='module';const m=r.data;panel('对局模块',r.title,'参与者 · '+[m.lead,...m.opponents].map(a=>a.label).join('、'));
  $('content').append(el('div','minor',(m.goal==='first'?'任一对手先满即胜':'所有对手先满即胜')+' · 危险阈值 '+m.danger+'\n'+m.poses.map(p=>p.name+' · '+(p.file||'默认站位')).join('\n')));
  const missing=deps(r);if(missing.length)$('content').append(el('div','minor','待导入 · '+missing.join('、')));
  btn('返回',()=>openMenu('library'),'primary');
}
async function launch(r,resume=false){
  if(!r)return;validateRefs(r);await busy(r.title,async()=>{
    world.clearShow();world.mark(null);const run=resume&&profile.run?.key===keyOf(r)?profile.run:null;
    await world.travel(run?.position??r.data.spawn);currentDistrict=districtAt();level=r;battle=null;menu=null;before='';
    profile.run=run??{key:keyOf(r),node:r.data.start,position:r.data.spawn};
    await enter(profile.run.node);
  });
}
function districtAt(){const p=world.pos;let best=Infinity,idx=7;for(const t of world.index.tiles){if(t.district===18)continue;const [a,b]=t.bounds;const d=Math.hypot(Math.max(a[0]-p.x,0,p.x-b[0]),Math.max(a[2]-p.z,0,p.z-b[2]));if(d<best){best=d;idx=t.district;}}return idx;}
async function freeWalk(p=null,d=null){
  await busy('进入街区',async()=>{checkpoint();world.clearShow();world.mark(null);if(p)await world.travel(p);else world.resetCamera();currentDistrict=d??districtAt();level=null;node=null;battle=null;menu=null;before='';screen='walk';render();});
}
async function enter(id){
  if(!level||!Object.hasOwn(level.data.nodes,id))throw Error('剧情节点不存在');
  const token=++visit;visualRequest++;world.clearShow();world.mark(null);world.resetCamera();battle=null;visualPose=-1;
  profile.run.node=id;node=level.data.nodes[id];menu=null;poseIndex=0;checkpoint();
  if(node.kind==='walk'){screen='walk';world.mark(node.position);}
  if(node.kind==='dialogue')screen='dialogue';
  if(node.kind==='motion'){
    screen='loading';panel('动作','正在载入动作');bars();const r=resolve(node.file);
    const secs=await world.show(r,part(node.file));if(token!==visit)return;
    screen='film';motionTime=0;motionEnd=node.seconds??secs;
  }
  if(node.kind==='encounter'){config=node.module?resolve(node.module).data:node;screen=profile.run.result?'result':'setup';}
  if(node.kind==='end'){screen='end';profile.done[level.data.id]=true;profile.run=null;persist();}
  render();
}
function follow(id){return busy('',()=>enter(id));}
function render(){
  bars();if(menu)return;const c=$('content');
  if(screen==='walk'){$('panel').hidden=true;$('objective').textContent=node?node.label:'自由探索 · 左侧摇杆移动，拖动街景转向';return;}
  if(screen==='dialogue'){
    panel(level.title,node.speaker??'剧情',node.text);
    if(node.choices)for(const [i,v] of node.choices.entries())btn(v.label,()=>follow(v.next),i?'':'primary');else btn('继续',()=>follow(node.next),'primary');
  }else if(screen==='setup'){
    panel('对局准备',node.label,[config.lead,...config.opponents].map(a=>a.label).join('、')+'\n'+(config.goal==='first'?'任一对手先满即胜。':'全员对手先满即胜。')+'选择起始姿势。');
    const row=el('div','row');c.append(row);config.poses.forEach((p,i)=>btn(p.name,()=>{poseIndex=i;render();},i===poseIndex?'current':'',row));
    btn('开始对局',startBattle,'primary');btn('衣柜',()=>openMenu('wardrobe'));
  }else if(screen==='battle'){$('panel').hidden=true;combatUI();}
  else if(screen==='result'){
    const delta=profile.run?.result.delta??0;panel('对局结算',outcomes[battle?.outcome??profile.run?.result.outcome],(profile.run?.result.outcome==='lose'?'甄芙先达到 100。':profile.run?.result.outcome==='great'?'双方同时达到判定点。':'对手先达到判定点。')+' 本场积分 '+(delta>=0?'+':'')+delta+'，当前 '+profile.points+'。');
    for(const a of profile.run.result.meters)c.append(el('div','minor',a.label+'  ·  '+a.value.toFixed(1)+' / 100'));
    const res=profile.run.result, target=res.outcome==='lose'?(node.lose??profile.run.node):res.outcome==='great'?(node.great??node.win):node.win;
    btn(res.outcome==='lose'?'重新开始':'继续剧情',()=>{delete profile.run.result;return follow(target);},'primary');
  }else if(screen==='film'||screen==='preview'){
    panel(screen==='preview'?'独立动作':'剧情动作',screen==='preview'?previewReturn:'动作播放','');
    btn(screen==='preview'?'结束预览':'跳过动作',()=>screen==='preview'?endPreview():follow(node.next),'subtle');
  }else if(screen==='end'){panel('章节结束',level.title,node.text);btn('返回手记',()=>{node=null;level=null;before='';home();},'primary');btn('自由探索',()=>freeWalk());}
}
async function startBattle(){await busy('准备参与角色',async()=>{
  acc=0;sfxPaused=false;battle=newDuel(config,profile.clothes,poseIndex);await visual(true);menu=null;screen='battle';combatRefs=null;render();
});}
async function visual(initial=false){
  const s=battle,index=s.pose,token=++visualRequest;visualPose=-1;
  const p=s.poses[index],r=p.file?resolve(p.file):null;
  const sec=await world.show(r,part(p.file),true,[config.lead,...config.opponents]);
  if(token!==visualRequest||s!==battle||sec===null)return;
  s.cycle=p.seconds??Math.max(sec,1);visualPose=index;world.syncCast(s.playhead,true,-1);
}
function finalize(){
  if(!battle.outcome||screen!=='battle')return;
  const delta=payout(battle,config.rewards);
  profile.points+=delta;profile.run.result={outcome:battle.outcome,delta,meters:[{label:config.lead.label,value:battle.self},...battle.rivals.map(r=>({label:r.label,value:r.value}))]};
  checkpoint();world.pauseAudio();screen='result';render();
}
function combatUI(){
  const s=battle;if(!s)return;
  if(combatRefs?.s!==s){
    const meters=$('meters'),controls=$('controls');meters.replaceChildren(el('h3','','高潮值  /  100'));controls.replaceChildren();
    const rows=[config.lead,...s.rivals].map((r,i)=>{
      const row=el(i?'button':'div','meter '+(i?'':'hero'));if(i)row.onclick=()=>{chooseTarget(s,i-1);combatUI();};
      const title=el('span','',r.label),v=el('b'),line=el('div','bar'),fill=el('i');line.append(fill);row.append(title,v,line);meters.append(row);return {row,v,fill};
    });
    const head=el('div','combatHead'),pose=el('span'),danger=el('small');head.append(pose,danger);controls.append(head);
    const speed=el('div','speed');controls.append(speed);const buttons={};
    const action=(parent,k,title)=>{buttons[k]=btn(title,()=>{act(s,k);if(s.outcome)finalize();else combatUI();},'',parent);};
    action(speed,'down','− 减慢');const pace=el('strong');speed.append(pace);action(speed,'up','加快 +');
    const moves=el('div','moves');controls.append(moves);
    for(const [k,v] of Object.entries(MOVES))action(moves,k,v.label);
    action(moves,'pose','切换姿势');
    const readout=el('div','readout'),timing=el('div','timing'),zone=el('span'),pin=el('i');timing.setAttribute('aria-label','精准动作时机');timing.append(zone,pin);controls.append(timing,readout);
    combatRefs={s,rows,pose,danger,buttons,pace,readout,zone,pin};
  }
  const v=combatRefs;
  [s.self,...s.rivals.map(r=>r.value)].forEach((n,i)=>{const z=v.rows[i];z.v.textContent=n.toFixed(1);z.fill.style.width=n+'%';if(i){z.row.classList.toggle('current',s.target===i-1);z.row.classList.toggle('done',s.rivals[i-1].done);z.row.disabled=s.rivals[i-1].done;}});
  v.pose.textContent=s.poses[s.pose].name;v.danger.textContent=inDanger(s)?'危险阶段':s.freeze>0?'停顿 '+s.freeze.toFixed(1)+' 秒':'进行中';
  v.pace.textContent=SPEEDS[s.speed];v.readout.textContent='体力 '+Math.round(s.stamina)+' · 敏感度 '+s.sensitivity.toFixed(2)+' · '+s.last;
  for(const [k,b] of Object.entries(v.buttons)){b.disabled=!canAct(s,k);if(MOVES[k])b.textContent=MOVES[k].label+(s.cd[k]>0?' '+Math.ceil(s.cd[k])+'s':k==='ease'?' ×'+s.requests:'');}
  v.zone.style.left=(.5-hitWindow(s))*100+'%';v.zone.style.width=hitWindow(s)*200+'%';v.pin.style.left=needle(s)*99+'%';
}
async function preview(r){
  await busy('打开动作',async()=>{checkpoint();world.clearShow();menu=null;previewReturn=r.title;screen='preview';motionTime=0;motionEnd=await world.show(r);render();});
}
function endPreview(){world.clearShow();world.resetCamera();screen='home';node=null;level=null;battle=null;before='';openMenu('library');}
async function addFiles(list){
  if(!list.length)return;
  const staged=[],unique=new Set();
  for(const f of list){const r=await readImport(f,inspectGlb);r.key=keyOf(r);r.date=Date.now();
    if(unique.has(r.key))throw Error('本次选择有重复的文件名或关卡 ID');unique.add(r.key);staged.push(r);}
  await writeBatch(staged);for(const r of staged)files.set(r.key,r);
  selection=staged.some(r=>r.kind==='level')?'level':staged[0].kind==='glb'?'motion':staged[0].kind;
  openMenu('library');notify('已导入 '+staged.length+' 个文件');
}
$('files').onchange=async e=>{const list=Array.from(e.target.files);e.target.value='';try{await addFiles(list);}catch(err){notify(err.message);}};
$('journal').onclick=()=>{if(!pending){if(menu==='home'&&before)closeMenu();else openMenu('home');}};
$('pause').onclick=()=>{if(!pending)openMenu('paused');};
window.citySuspend=()=>{if(ready&&!menu&&!pending&&['battle','film','preview','walk'].includes(screen))openMenu('paused');if(ready)checkpoint();resetStick();};
document.addEventListener('visibilitychange',()=>{if(document.hidden)window.citySuspend();});
window.cityBack=()=>{if(!ready||pending)return true;if(menu==='home'&&!before)return false;if(menu){if(menu==='paused'||menu==='home')closeMenu();else openMenu('home');}else openMenu('home');return true;};
window.addEventListener('keydown',e=>{if(e.code.startsWith('Arrow')||['KeyW','KeyS','KeyA','KeyD','ShiftLeft','ShiftRight'].includes(e.code)){e.preventDefault();pressed.add(e.code);}if(e.code==='Escape')window.cityBack();});
window.addEventListener('keyup',e=>pressed.delete(e.code));window.addEventListener('blur',resetStick);
const stickEl=$('stick');
function joy(e){const r=stickEl.getBoundingClientRect(),x=(e.clientX-r.left-r.width/2)/(r.width*.35),y=(e.clientY-r.top-r.height/2)/(r.height*.35),m=Math.max(1,Math.hypot(x,y));stick=[x/m,y/m];stickEl.firstElementChild.style.transform='translate('+stick[0]*r.width*.28+'px,'+stick[1]*r.height*.28+'px)';}
stickEl.onpointerdown=e=>{pointer=e.pointerId;stickEl.setPointerCapture(pointer);joy(e);};
stickEl.onpointermove=e=>{if(e.pointerId===pointer)joy(e);};stickEl.onpointerup=stickEl.onpointercancel=stickEl.onlostpointercapture=resetStick;
let last=0,lastUI=0,acc=0,walkingMs=0,showPending=false,sfxPaused=false;
function loop(ms){
  requestAnimationFrame(loop);if(!ready||document.hidden||ms-last<(menu?160:30))return;
  const dt=last?Math.min(1,(ms-last)/1000):0;last=ms;
  if(!menu&&!pending){
    if(screen==='walk'){
      const key=k=>Number(pressed.has(k));const x=stick[0]+key('KeyD')+key('ArrowRight')-key('KeyA')-key('ArrowLeft'),y=stick[1]+key('KeyS')+key('ArrowDown')-key('KeyW')-key('ArrowUp');
      world.move(x,y,dt,Math.hypot(...stick)>.79||!!(key('ShiftLeft')+key('ShiftRight')));
      walkingMs+=dt;if(walkingMs>3){walkingMs=0;currentDistrict=districtAt();bars();checkpoint();}
      if(node?.kind==='walk'){
        const dist=Math.hypot(node.position[0]-world.pos.x,node.position[2]-world.pos.z);$('objective').textContent=node.label+'  ·  '+Math.ceil(dist)+' 米';
        if(dist<=node.radius)follow(node.next);
      }
    }else if(screen==='battle'){
      if(visualPose!==battle.pose){if(!showPending){showPending=true;visual().catch(e=>{notify(e.message);menu='error';panel('动作载入失败','动作不可用',e.message);btn('返回手记',()=>openMenu('home'));bars();}).finally(()=>showPending=false);}}
      else{
        const old=battle.playhead;acc+=dt;
        while(acc>=1/60&&!battle.outcome&&visualPose===battle.pose){advance(battle,1/60);acc-=1/60;}
        if(battle.freeze>0){if(!sfxPaused){world.pauseAudio();sfxPaused=true;}}else{if(sfxPaused)sfxPaused=false;world.syncCast(battle.playhead,false,old);}
        if(battle.outcome)finalize();else if(ms-lastUI>90){combatUI();lastUI=ms;}
      }
    }else if(screen==='film'||screen==='preview'){
      world.tickCast(dt);motionTime+=dt;if(motionTime>=motionEnd){if(screen==='film')follow(node.next);else endPreview();}
    }
  }
  world.draw();
}
async function start(){
  for(const name of ['district07.level.json','first-meeting.level.json','arrival.action.json','city-duo-opponents.module.json','cast-three.sese.json']){
    const value=await (await fetch('./examples/'+name)).blob(),r=await readImport(new File([value],name),inspectGlb);r.key=keyOf(r);files.set(r.key,r);built.add(r.key);
  }
  for(const r of await readAll())files.set(r.key,r);
  world=new CityWorld($('world'),notify);await world.init(profile.clothes,startPos,t=>$('copy').textContent=t);
  ready=true;screen='home';before='';home();requestAnimationFrame(loop);
}
start().catch(e=>{console.error(e);panel('启动失败','城市未能打开',e.message);btn('重新载入',()=>location.reload(),'primary');});
