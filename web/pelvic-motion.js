import * as T from './vendor/three.module.min.js';

const axis=new T.Vector3(1,0,0);
const jointNames=['ZF_Penis_Root','ZF_Penis_Mid','ZF_Penis_Tip'];
// Local X bends each segment up/down. The tip follows the body later than the root.
const delays=[0,.045,.095,.16,.23];
const limits=[9,7,5].map(T.MathUtils.degToRad);
const clampTime=T.MathUtils.clamp, modulo=T.MathUtils.euclideanModulo;

function keyInterval(keys,t){
  let lo=0,hi=keys.length-1;
  while(lo<hi){
    const mid=(lo+hi)>>1;
    if(keys[mid].t<t)lo=mid+1;else hi=mid;
  }
  const a=keys[Math.max(0,lo-1)],b=keys[lo];
  return [a,b,b.t>a.t?clampTime((t-a.t)/(b.t-a.t),0,1):0];
}

export function createPelvicMotion(actor){
  if(actor.type!=='zhenfu')return null;
  const chain=jointNames.map(name=>actor.bones.get(name));
  const hip=actor.bones.get('mixamorigHips'),chest=actor.bones.get('mixamorigSpine2');
  if(!hip||!chest||chain.some(b=>!b))return null;
  return new PelvicMotion(actor,chain,hip,chest);
}

class PelvicMotion {
  constructor(actor,joints,hip,chest){
    this.joints=joints;
    this.authored=new Map();
    this.base=joints.map(()=>new T.Quaternion());
    this.support=new T.Group();
    this.copies=new Map();
    // A small private hierarchy lets a seek or reverse playback sample the same
    // body motion without touching the actor's mixer, current pose or saved keys.
    const ancestors=[];
    for(let b=chest;b&&b!==actor.model;b=b.parent)ancestors.unshift(b);
    let parent=this.support;
    for(const original of ancestors){
      const node=new T.Object3D();
      node.position.copy(original.position);node.quaternion.copy(original.quaternion);node.scale.copy(original.scale);
      parent.add(node);parent=node;
      this.copies.set(original.name,{node,rest:{p:node.position.toArray(),q:node.quaternion.toArray(),s:node.scale.toArray()}});
    }
    this.hip=this.copies.get(hip.name).node;
    this.chest=this.copies.get(chest.name).node;
    actor.model.updateWorldMatrix(true,true);
    this.anchor=hip.worldToLocal(joints[1].getWorldPosition(new T.Vector3()));
    this.support.updateMatrixWorld(true);
    const inverse=this.hip.getWorldQuaternion(new T.Quaternion()).invert();
    this.axes=[new T.Vector3(0,1,0),new T.Vector3(0,0,1),new T.Vector3(1,0,0)].map(v=>v.applyQuaternion(inverse));
    this.direction=new T.Vector3();
    this.samples=delays.map(()=>new T.Vector3());
    this.delta=new T.Vector3();this.cycle=new T.Vector3();this.start=new T.Vector3();
    this.v=new T.Vector3();this.q=new T.Quaternion();
    this.trackSource=undefined;this.tracks=[];this.explicit=new Set();
  }
  restore(){
    for(const [bone,q] of this.authored)bone.quaternion.copy(q);
    this.authored.clear();
  }
  bind(clip){
    if(this.trackSource===clip)return;
    this.trackSource=clip;this.tracks=[];this.explicit.clear();
    for(const {node,rest} of this.copies.values()){
      node.position.fromArray(rest.p);node.quaternion.fromArray(rest.q);node.scale.fromArray(rest.s);
    }
    for(const track of clip?.tracks??[]){
      const {nodeName,propertyName}=T.PropertyBinding.parseTrackName(track.name);
      if(jointNames.includes(nodeName)&&propertyName==='quaternion')this.explicit.add(nodeName);
      const target=this.copies.get(nodeName)?.node;
      if(target && ['position','quaternion','scale'].includes(propertyName))
        this.tracks.push([target[propertyName],track.createInterpolant()]);
    }
  }
  sample(t,keys,out,direction=false){
    let turn=0;
    if(keys){
      const [a,b,f]=keyInterval(keys,t);
      for(const [name,{node,rest}] of this.copies){
        const left=a.joints[name]||{},right=b.joints[name]||{};
        node.position.fromArray(left.p||rest.p).lerp(this.v.fromArray(right.p||rest.p),f);
        node.quaternion.fromArray(left.q||rest.q).slerp(this.q.fromArray(right.q||rest.q),f);
        node.scale.fromArray(left.s||rest.s).lerp(this.v.fromArray(right.s||rest.s),f);
      }
      turn=T.MathUtils.degToRad(a.yaw+(((b.yaw-a.yaw+540)%360)-180)*f-keys[0].yaw);
      this.support.rotation.y=turn;
      this.support.position.fromArray(a.p).lerp(this.v.fromArray(b.p),f).sub(this.v.fromArray(keys[0].p));
      this.v.set(0,1,0);this.support.position.applyAxisAngle(this.v,-T.MathUtils.degToRad(keys[0].yaw));
    }else{
      for(const [target,interpolant] of this.tracks)target.fromArray(interpolant.evaluate(t));
      this.support.rotation.y=0;this.support.position.set(0,0,0);
    }
    this.support.updateMatrixWorld(true);
    out.copy(this.anchor).applyMatrix4(this.hip.matrixWorld).lerp(this.v.setFromMatrixPosition(this.chest.matrixWorld),.22);
    if(direction){
      this.hip.getWorldQuaternion(this.q);
      this.direction.copy(this.axes[0]).addScaledVector(this.axes[1],.42).addScaledVector(this.axes[2],.18).applyQuaternion(this.q);
    }
  }
  apply(clip,keys,t,mode,dir=1,offsets=null){
    const duration=keys?.at(-1)?.t??clip?.duration;
    if(!(duration>0))return;
    this.bind(clip);
    if(!keys&&!this.tracks.length)return;
    const samples=this.samples;
    t=clampTime(t,0,duration);
    this.sample(t,keys,samples[0],true);
    let cycleReady=false;
    for(let i=1;i<delays.length;i++){
      const raw=t-delays[i]*(mode==='reflect'?dir:1);
      let phase=clampTime(raw,0,duration),cycles=0;
      if(mode==='reflect'){
        const v=modulo(raw,2*duration);
        phase=v>duration?2*duration-v:v;
      }else if(mode==='loop'&&(raw<0||raw>duration)){
        cycles=Math.floor(raw/duration);phase=modulo(raw,duration);
        if(!cycleReady){
          this.sample(0,keys,this.start);this.sample(duration,keys,this.cycle);
          this.cycle.sub(this.start);cycleReady=true;
        }
      }
      this.sample(phase,keys,samples[i]);
      if(cycles)samples[i].addScaledVector(this.cycle,cycles);
    }
    const interval=keys?keyInterval(keys,t):null;
    for(let i=0;i<this.joints.length;i++){
      const joint=this.joints[i],name=joint.name;
      if(this.explicit.has(name)||offsets?.[name]?.some(v=>v!==0)||
         (interval&&(interval[0].joints[name]?.q||interval[1].joints[name]?.q)))continue;
      const lag=this.delta.subVectors(samples[0],samples[i+1]).dot(this.direction);
      const previous=this.delta.subVectors(samples[i+1],samples[i+2]).dot(this.direction);
      const angle=limits[i]*Math.tanh((lag-.45*previous)/.038);
      if(Math.abs(angle)<1e-6)continue;
      this.authored.set(joint,this.base[i].copy(joint.quaternion));
      joint.quaternion.multiply(this.q.setFromAxisAngle(axis,angle)).normalize();
    }
  }
}

// This tube is part of the body rig. Its authored rest depth is preserved until
// the thighs fold towards the pelvis, including in user-authored poses.
export function fitPelvicInterior(mesh){
  if(!mesh.geometry.hasAttribute('_innerfold'))return;
  const indices=['mixamorigHips','mixamorigLeftUpLeg','mixamorigRightUpLeg'].map(
    name=>mesh.skeleton.bones.findIndex(b=>b.name===name));
  if(indices.includes(-1))return;
  const material=mesh.material;
  material.customProgramCacheKey=()=> 'sese-inner-fold-'+indices.join('-');
  material.onBeforeCompile=shader=>{
    shader.vertexShader=shader.vertexShader
      .replace('#include <common>','#include <common>\nattribute vec3 _innerfold;')
      .replace('#include <skinning_vertex>',`
        vec3 pelvisUp=normalize(getBoneMatrix(${indices[0]}.0)[1].xyz);
        vec3 leftDown=-normalize(getBoneMatrix(${indices[1]}.0)[1].xyz);
        vec3 rightDown=-normalize(getBoneMatrix(${indices[2]}.0)[1].xyz);
        float flex=dot(pelvisUp,(leftDown+rightDown)*0.5);
        transformed+=_innerfold*smoothstep(-0.62,-0.16,flex);
        #include <skinning_vertex>`);
  };
}
