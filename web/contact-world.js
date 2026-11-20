import * as T from './vendor/three.module.min.js';

const zero=[0,0,0];
const isVec=a=>Array.isArray(a)&&a.length===3&&a.every(Number.isFinite);
const axisY=new T.Vector3(0,1,0);

export function actorContactBodies(actor){
  const authored=actor.state.contactBodies||[];
  const imported=actor.source.clips.get(actor.state.clip)?.userData?.contactBodies;
  if(!imported?.length)return authored;
  if(!authored.length)return imported;
  return [...authored,...imported.filter(p=>!authored.some(a=>a.id===p.id))];
}

export function checkContactAnchors(actor,bodies){
  for(const b of bodies||[]){
    if(b.anchor==='model'||(b.anchor==='rim'&&actor.softRim))continue;
    if(!actor.bones.has(T.PropertyBinding.sanitizeNodeName(b.anchor)))throw Error('角色缺少碰撞体锚点 '+b.anchor);
  }
}

export function contactTime(actor){
  return actor.contactClock??actor.state.time;
}

export function contactOffset(body,time,out){
  const keys=body.keys;
  if(!keys?.length)return out.fromArray(body.offset||zero);
  let lo=0,hi=keys.length-1;
  while(lo<hi){const mid=(lo+hi)>>1;if(keys[mid].t<time)lo=mid+1;else hi=mid;}
  const right=keys[lo],left=keys[Math.max(0,lo-1)];
  const f=right.t>left.t ? T.MathUtils.clamp((time-left.t)/(right.t-left.t),0,1) : 0;
  return out.set(...left.offset.map((v,k)=>v+(right.offset[k]-v)*f));
}

function inScene(node,scene){
  for(let p=node;p;p=p.parent){if(!p.visible)return false;if(p===scene)return true;}
  return false;
}

export class ContactWorld {
  constructor(scene){
    this.scene=scene;this.external=new Set();this.guides=new Map();this.serial=0;
    this.debugActor=null;this.debugBodyActor=null;this.p=new T.Vector3();this.ab=new T.Vector3();this.ap=new T.Vector3();this.previewMaterial=null;
  }
  // The caller owns the prop and its mesh. Endpoints are local to its Object3D.
  addCollider(node,{shape,a=zero,b,radius}){
    if(!node?.isObject3D||!['sphere','capsule'].includes(shape)||!isVec(a)||
      !(Number.isFinite(radius)&&radius>0)||(shape==='capsule'&&!isVec(b)))
      throw Error('碰撞体需要有效的形状、局部端点和半径');
    const entry={node,shape,radius,a:[...a],b:[...(shape==='capsule'?b:a)]};
    this.external.add(entry);
    return ()=>this.external.delete(entry);
  }
  shape(def,owner,bodyPart=false){
    const a=new T.Vector3().fromArray(def.a),b=new T.Vector3().fromArray(def.shape==='capsule'?def.b:def.a);
    let radius=def.radius;
    if(owner&&!bodyPart){
      const shift=contactOffset(def,contactTime(owner),this.p);
      a.add(shift);b.add(shift);
    }
    if(owner && def.anchor==='rim'){
      const rim=owner.softRim;
      if(!rim)return null;
      rim.frame(this.serial);
      rim.fromLocal(a,a);rim.fromLocal(b,b);
    }else{
      const node=owner ? (def.anchor==='model'?owner.model:owner.bones.get(T.PropertyBinding.sanitizeNodeName(def.anchor))) : def.node;
      if(!node)return null;
      node.updateWorldMatrix(true,false);
      a.applyMatrix4(node.matrixWorld);
      const end=bodyPart&&def.endAnchor?owner.bones.get(def.endAnchor):node;
      if(!end)return null;
      if(end!==node)end.updateWorldMatrix(true,false);
      b.applyMatrix4(end.matrixWorld);
      radius*=node.matrixWorld.getMaxScaleOnAxis();
    }
    return {key:owner?owner.root.uuid+(bodyPart?'/body/':'/prop/')+def.id:def,a,b,r:radius,bodyOwner:bodyPart?owner:null};
  }
  guide(shape){
    let g=this.guides.get(shape.key);
    const length=shape.a.distanceTo(shape.b);
    if(!g){
      this.previewMaterial??=new T.MeshBasicMaterial({color:0x80e5ef,wireframe:true,transparent:true,
        opacity:.65,depthTest:false,depthWrite:false});
      g=new T.Mesh(undefined,this.previewMaterial);g.renderOrder=20;this.scene.add(g);
      this.guides.set(shape.key,g);
    }
    if(Math.abs((g.userData.length??-1)-length)>.00005||Math.abs((g.userData.r??-1)-shape.r)>.00005){
      g.geometry.dispose();g.geometry=length>1e-6 ? new T.CapsuleGeometry(shape.r,length,4,12) : new T.SphereGeometry(shape.r,14,10);
      g.userData.length=length;g.userData.r=shape.r;
    }
    g.position.lerpVectors(shape.a,shape.b,.5);
    if(length>1e-6)g.quaternion.setFromUnitVectors(axisY,this.p.subVectors(shape.b,shape.a).normalize());
  }
  step(actors,dt){
    this.serial++;
    const list=Array.from(actors),shapes=[],guides=new Set();
    let dirty=false;
    const receivers=list.filter(actor=>actor.root.visible&&actor.softRim);
    for(const entry of this.external){
      if(inScene(entry.node,this.scene))shapes.push(this.shape(entry,null));
    }
    for(const actor of list){
      if(!actor.root.visible)continue;
      // An anatomical chain can contact another receiver. Ignore its owner's own
      // cuff, while keeping authored props able to interact with their host actor.
      if(actor===this.debugBodyActor||receivers.some(receiver=>receiver!==actor)){
        for(const def of actor.source.bodyColliders||[]){
          const shape=this.shape(def,actor,true);
          if(!shape)continue;
          shapes.push(shape);
          if(actor===this.debugBodyActor){this.guide(shape);guides.add(shape.key);dirty=true;}
        }
      }
      for(const def of actorContactBodies(actor)){
        if(def.enabled===false)continue;
        const shape=this.shape(def,actor);
        if(!shape)continue;
        shapes.push(shape);
        if(actor===this.debugActor){this.guide(shape);guides.add(shape.key);dirty=true;}
      }
    }
    for(const [key,g] of this.guides){
      if(guides.has(key))continue;
      g.removeFromParent();g.geometry.dispose();this.guides.delete(key);dirty=true;
    }
    for(const actor of list){
      const rim=actor.softRim;
      if(!rim)continue;
      if(!actor.root.visible){if(rim.active||rim.history.size)rim.reset();continue;}
      if(!shapes.length && !rim.active){rim.history.clear();continue;}
      const hip=actor.bones.get('mixamorigHips');
      if(hip)hip.getWorldPosition(this.p);
      const near=shapes.filter(s=>{
        if(s.bodyOwner===actor)return false;
        if(!hip)return true;
        this.ab.subVectors(s.b,s.a);this.ap.subVectors(this.p,s.a);
        const t=T.MathUtils.clamp(this.ap.dot(this.ab)/(this.ab.lengthSq()||1),0,1);
        // Include a plausible inter-frame sweep before the detailed query.
        return this.ap.addScaledVector(this.ab,-t).lengthSq()<(.55+s.r)**2;
      });
      if(!near.length && !rim.active){rim.history.clear();continue;}
      rim.frame(this.serial);
      if(rim.step(near,Math.max(0,Math.min(.15,dt))))dirty=true;
    }
    return dirty;
  }
}
