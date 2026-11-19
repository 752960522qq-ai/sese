export const SPEEDS=['慢速','中速','快速','猛烈'];
export const PLAY_RATES=[.70,1,1.45,1.95];
export const MOVES={tighten:{label:'主动收缩',cooldown:9},wait:{label:'放松停顿',cooldown:13},focus:{label:'精准刺激',cooldown:7},ease:{label:'请求放慢',cooldown:7}};
export const BASE_POSES=[{name:'平衡位',self:1,other:1},{name:'主动位',self:1.16,other:1.32},{name:'守势位',self:.76,other:.83}];
export const clamp=(n,lo,hi)=>Math.max(lo,Math.min(hi,n));
const selfSpeed=[.66,1,1.52,2.15],otherSpeed=[.72,1,1.44,1.95];
export function newDuel(n,clothes,pose=0,random=Math.random){
  const rivals=n.opponents.map((r,i)=>({...r,value:r.start,done:false,pressure:1,aiAt:5+i*1.3+random()*2}));
  return {self:n.lead.start,stamina:n.lead.stamina,sensitivity:n.lead.sensitivity,lead:n.lead,rivals,target:0,
    goal:n.goal,background:n.background,speed:1,pose,poses:n.poses,threshold:n.danger,clothes:{...clothes},
    clock:0,playhead:0,cycle:n.poses[pose].seconds||0,eventIndex:0,freeze:0,surge:0,surgeTarget:0,lock:0,requests:2,
    cd:{tighten:0,wait:0,focus:0,ease:0},poseCd:0,outcome:null,used:0,hits:0,changed:0,last:'对局开始',random};
}
export const inDanger=s=>s.self>=s.threshold||s.rivals.some(r=>!r.done&&r.value>=s.threshold);
export const hitWindow=s=>inDanger(s)?.105:.2;
export const needle=s=>(Math.sin(s.clock*2.4)+1)/2;
export function chooseTarget(s,index){if(!s.outcome&&s.rivals[index]&&!s.rivals[index].done)s.target=index;}
export function setPose(s,index){s.pose=index;s.playhead=0;s.eventIndex=0;s.cycle=s.poses[index].seconds||0;s.poseCd=2;}
const epsilon=1e-8;
// Resolve fractional crossing times. Earlier finishers can leave an all-opponents round in the same step.
export function gain(s,selfDelta,deltas){
  if(s.outcome)return;
  const times=s.rivals.map((r,i)=>!r.done&&deltas[i]>0?(100-r.value)/deltas[i]:Infinity);
  const active=times.filter((_,i)=>!s.rivals[i].done);
  const selfAt=selfDelta>0?(100-s.self)/selfDelta:Infinity;
  const finishAt=s.goal==='all'?Math.max(...active):Math.min(...active);
  const stop=Math.min(1,selfAt,finishAt);
  s.self=clamp(s.self+selfDelta*stop,0,100);
  s.rivals.forEach((r,i)=>{
    if(r.done)return;
    r.value=clamp(r.value+(deltas[i]||0)*stop,0,100);
    if(times[i]<=stop+epsilon){r.value=100;r.done=true;}
  });
  if(Math.min(selfAt,finishAt)<=1+epsilon){
    s.outcome=Math.abs(selfAt-finishAt)<=epsilon?'great':selfAt<finishAt?'lose':'win';
    if(s.outcome!=='win')s.self=100;
  }
  if(!s.outcome&&s.rivals[s.target].done)s.target=s.rivals.findIndex(r=>!r.done);
}
export function canAct(s,k){
  if(s.outcome||s.freeze>0)return false;
  if(k==='pose')return !inDanger(s)&&s.lock<=0&&s.poseCd<=0&&s.poses.length>1;
  if(k==='up'||k==='down')return s.lock<=0&&(k==='up'?s.speed<3:s.speed>0);
  if(!MOVES[k]||s.cd[k]>0)return false;
  if(k==='ease')return s.requests>0;
  if(k==='tighten')return s.stamina>=12&&s.lock<=0&&!inDanger(s);
  if(k==='focus')return s.stamina>=9&&s.lock<=0;
  return true;
}
export function act(s,k,index){
  if(!canAct(s,k))return false;
  if(k==='up'||k==='down'){s.speed+=k==='up'?1:-1;s.last='当前 · '+SPEEDS[s.speed];s.changed++;return true;}
  if(k==='pose'){
    const next=Number.isInteger(index)&&s.poses[index]?index:(s.pose+1)%s.poses.length;
    setPose(s,next);s.changed++;s.last='换至'+s.poses[next].name;return true;
  }
  s.cd[k]=MOVES[k].cooldown;s.used++;s.last=MOVES[k].label;
  if(k==='tighten'){s.stamina-=12;s.surge=3;s.surgeTarget=s.target;}
  if(k==='wait')s.freeze=2.5;
  if(k==='focus'){
    s.stamina-=9;const hit=Math.abs(needle(s)-.5)<=hitWindow(s);
    if(hit)s.hits++;
    s.last=hit?'命中 · '+s.rivals[s.target].label:'时机偏离 · 己方反弹';
    gain(s,hit?1.2:5.5,s.rivals.map((r,i)=>i===s.target?(hit?9:1)/(r.defense*(s.clothes.pumps?.95:1)):0));
  }
  if(k==='ease'){s.speed=Math.max(0,s.speed-1);s.sensitivity=Math.max(.1,s.sensitivity-.09);s.requests--;s.lock=0;}
  return true;
}
function react(s,r,i){
  const roll=s.random();
  if(i===s.target){
    if((roll<.4||s.speed===0)&&s.speed<3){s.speed++;s.last=r.label+'加快了一档';}
    else if(roll<.73&&!inDanger(s)&&s.poses.length>1){
      setPose(s,(s.pose+1+Math.floor(s.random()*(s.poses.length-1)))%s.poses.length);s.last=r.label+'换至'+s.poses[s.pose].name;
    }else{s.lock=1.6;s.last=r.label+'暂时掌握节奏';}
  }
  r.pressure=.88+roll*.32;r.aiAt=s.clock+6+s.random()*4-(s.changed>2?.8:0);
}
function continuous(s,dt){
  const p=s.poses[s.pose],v=s.speed,cl=s.clothes;
  let attack=0,weight=0;
  const surge=Math.min(s.surge,dt);s.surge-=surge;
  const deltas=s.rivals.map((r,i)=>{
    if(r.done)return 0;
    const w=i===s.target?1:s.background;
    attack+=r.attack*r.pressure*w;weight+=w;
    const defense=r.defense*(cl.pumps?.95:1);
    return (dt*r.gain*otherSpeed[v]*p.other*(p.multipliers?.[r.id]??1)*r.sensitivity*(1+(100-r.stamina)*.004)*w+(s.surgeTarget===i?surge*2.4:0))/defense;
  });
  const own=s.lead.gain*selfSpeed[v]*p.self*s.sensitivity*(1+(100-s.stamina)*.004)*attack/Math.max(weight,.001)*(cl.stockings?1.03:1)/(s.lead.defense*(cl.stockings?1.07:1));
  gain(s,dt*own+surge*.75,deltas);
  s.stamina=clamp(s.stamina+dt*[1.2,.38,-.42,-.92][v],0,100);
  for(const r of s.rivals)if(!r.done)r.stamina=clamp(r.stamina+dt*[.78,.10,-.55,-1][v],0,100);
}
export function advance(s,dt){
  if(s.outcome||dt<=0)return;
  if(s.freeze>0){const stop=Math.min(s.freeze,dt);s.freeze-=stop;dt-=stop;if(dt<epsilon)return;}
  const events=s.poses[s.pose].events||[],rate=PLAY_RATES[s.speed];
  let left=dt;
  while(left>epsilon&&!s.outcome){
    const nextEvent=events[s.eventIndex]?.at??Infinity,end=s.cycle>0?s.cycle:Infinity;
    const boundary=Math.min(nextEvent,end),step=Math.min(left,Math.max(0,boundary-s.playhead)/rate);
    if(step>0){continuous(s,step);s.playhead+=step*rate;left-=step;}
    if(s.outcome)break;
    if(nextEvent<=s.playhead+epsilon&&nextEvent<=end){
      const e=events[s.eventIndex++].delta;
      gain(s,e[s.lead.id]||0,s.rivals.map(r=>e[r.id]||0));
    } else if(end<=s.playhead+epsilon){s.playhead=0;s.eventIndex=0;}
    else break;
  }
  s.clock+=dt;s.poseCd=Math.max(0,s.poseCd-dt);s.lock=Math.max(0,s.lock-dt);
  for(const k in s.cd)s.cd[k]=Math.max(0,s.cd[k]-dt);
  if(!s.outcome)for(const [i,r] of s.rivals.entries())if(!r.done&&s.clock>=r.aiAt)react(s,r,i);
}
export function payout(s,r){return s.outcome==='lose'?r.lose:r[s.outcome]+Math.min(8,s.hits*2+s.changed);}
