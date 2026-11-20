import * as T from './vendor/three.module.min.js';
import {contactOffset,contactTime} from './contact-world.js';

const id='studio-rim-prop';
const get=k=>document.getElementById(k);
const current=a=>a?.state.contactBodies?.find(b=>b.id===id&&b.anchor==='rim');

function addKey(body,time,offset){
  body.keys??=[];
  const t=Math.max(0,Number(time.toFixed(4))), key={t,offset:[...offset]};
  const index=body.keys.findIndex(k=>Math.abs(k.t-t)<.0001);
  if(index>=0)body.keys[index]=key;
  else {body.keys.push(key);body.keys.sort((a,b)=>a.t-b.t);}
}

export function contactEditor(chosen,context,clock){
  const pos=new T.Vector3();
  function sync(){
    const a=chosen(),stage=context();
    if(!a||!stage)return;
    const body=current(a), enabled=!!(body&&body.enabled!==false);
    get('rimTools').hidden=!a.softRim;
    get('rimShape').value=enabled?body.shape:'off';
    get('rimControls').hidden=!enabled;
    stage.contacts.debugActor=enabled && get('rimGuide').checked && get('rimTools').open && !get('poseTools').hidden && !get('pane-motion').hidden ? a : null;
    if(!enabled)return;
    contactOffset(body,contactTime(a),pos);
    for(const [field,n] of [['rimDepth',pos.z*1000],['rimSide',pos.x*1000],['rimSize',body.radius*2000]]){
      get(field).value=String(n);get(field+'Value').value=String(Math.round(n))+' mm';
    }
    get('rimKeyCount').value=(body.keys?.length||0)+' 个位置点';
    get('rimClear').disabled=!body.keys?.length;
  }
  get('rimTools').ontoggle=sync;
  get('rimGuide').onchange=sync;
  get('rimShape').onchange=()=>{
    const a=chosen(),shape=get('rimShape').value;
    if(!a?.softRim)return;
    let body=current(a);
    if(!body && shape!=='off'){
      body={id,anchor:'rim',shape,radius:.013,a:[0,0,0],offset:[0,0,-.055]};
      (a.state.contactBodies??=[]).push(body);
    }
    if(body){
      body.enabled=shape!=='off';
      if(body.enabled){
        body.shape=shape;body.a=[0,0,shape==='capsule'?-.012:0];
        if(shape==='capsule')body.b=[0,0,.012];else delete body.b;
      }
    }
    a.revision++;clock();
  };
  for(const field of ['rimDepth','rimSide','rimSize']){
    get(field).oninput=()=>{
      const a=chosen(),body=current(a);if(!body)return;
      a.state.playing=false;
      const t=contactTime(a),n=Number(get(field).value);
      if(field==='rimSize')body.radius=n/2000;
      else{
        const offset=contactOffset(body,t,pos).toArray();
        offset[field==='rimDepth'?2:0]=n/1000;
        if(body.keys?.length)addKey(body,t,offset);else body.offset=offset;
      }
      a.revision++;clock();
    };
  }
  get('rimKey').onclick=()=>{
    const a=chosen(),body=current(a);if(!body)return;
    a.state.playing=false;
    const now=contactTime(a),field=get('rimAt');
    if(!field.reportValidity())return;
    const t=field.value===''?now:field.valueAsNumber;
    if(!Number.isFinite(t))return;
    addKey(body,t,contactOffset(body,now,pos).toArray());
    if(t!==now){a.state.time=t;a.state.dir=1;a.softRim.reset();a.apply();}
    field.value='';clock();
  };
  get('rimClear').onclick=()=>{
    const a=chosen(),body=current(a);if(!body)return;
    a.state.playing=false;
    body.offset=contactOffset(body,contactTime(a),pos).toArray();delete body.keys;clock();
  };
  return sync;
}
