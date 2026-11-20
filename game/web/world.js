import {ShowroomCar} from './vehicle.js';
import {ContactWorld,checkContactAnchors} from './contact-world.js';
import {CityCollision} from './collision.js';
import * as T from './vendor/three.module.min.js';
import {GLTFLoader} from './vendor/loaders/GLTFLoader.js';
import {OrbitControls} from './vendor/controls/OrbitControls.js';
import {Actor,fresh} from './rig.js';
import {SoundTrack,loadSoundBank} from './sounds.js';
import {glbClip} from './clip-file.js';
import {applyWardrobe,disposeWardrobe} from './wardrobe.js';

const radians=T.MathUtils.degToRad, point=new T.Vector3(), down=new T.Vector3(0,-1,0);
const sky=0xc3d6df;
function hotelFloor(p) {
  if(p.x<235||p.x>293||p.z< -730.5||p.z> -694.5||p.y<16.3||p.y>108)return 0;
  return floorAtHeight(p.y);
}
function floorAtHeight(y){return y>=101.8?23:y>=32.6?4:y>=27.45?3:y>=22.36?2:1;}
const near=(b,x,z)=>Math.hypot(Math.max(b[0][0]-x,0,x-b[1][0]),Math.max(b[0][2]-z,0,z-b[1][2]));
function dress(actor,clothes){
  return applyWardrobe(actor,7+(clothes.stockings?8:0)+(clothes.pumps?16:0));
}
function release(actor){disposeWardrobe(actor);actor.dispose();}
export class CityWorld{
  constructor(canvas,notify) {
    this.notify=notify;this.canvas=canvas;this.scene=new T.Scene();this.contacts=new ContactWorld(this.scene);
    this.scene.background=new T.Color(sky);this.scene.fog=new T.Fog(sky,92,245);
    this.renderer=new T.WebGLRenderer({canvas,antialias:true,powerPreference:'high-performance'});
    this.renderer.setPixelRatio(Math.min(1.35,window.devicePixelRatio||1));
    this.renderer.outputColorSpace=T.SRGBColorSpace;this.renderer.toneMapping=T.ACESFilmicToneMapping;this.renderer.toneMappingExposure=1.13;
    this.camera=new T.PerspectiveCamera(49,1,.08,560);
    this.controls=new OrbitControls(this.camera,canvas);this.controls.enablePan=false;this.controls.minDistance=2.1;this.controls.maxDistance=13;
    this.controls.minPolarAngle=.25;this.controls.maxPolarAngle=Math.PI*.50;this.controls.rotateSpeed=.65;
    this.fill=new T.HemisphereLight(0xfff3e9,0xa6b5bc,1.90);this.scene.add(this.fill);
    this.car=new ShowroomCar(this);
    const sun=new T.DirectionalLight(0xffedd6,2.3);this.sun=sun;sun.position.set(-75,125,70);this.scene.add(sun);
    this.hotelLevel=0;this.hotelStairs=false;this.exteriorFloor=1;this.tiles=new Map();this.loader=new GLTFLoader();this.ray=new T.Raycaster();this.pos=new T.Vector3();this.lastLoad=new T.Vector3(1e6,0,1e6);this.generation=0;this.showToken=0;
    this.group=new T.Group();this.scene.add(this.group);this.cast=[];this.stepTime=0;this.walking=true;
    const markerMaterial=new T.MeshBasicMaterial({color:0xf2be66,transparent:true,opacity:.9,side:T.DoubleSide,depthWrite:false});
    this.marker=new T.Mesh(new T.RingGeometry(.72,.84,48),markerMaterial);this.marker.rotation.x=-Math.PI/2;this.marker.visible=false;this.scene.add(this.marker);
    const shadowCanvas=document.createElement('canvas');shadowCanvas.width=shadowCanvas.height=64;const ctx=shadowCanvas.getContext('2d'),grad=ctx.createRadialGradient(32,32,0,32,32,31);
    grad.addColorStop(0,'rgba(10,19,23,.42)');grad.addColorStop(1,'rgba(10,19,23,0)');ctx.fillStyle=grad;ctx.fillRect(0,0,64,64);
    this.shadow=new T.Mesh(new T.PlaneGeometry(1.1,1.1),new T.MeshBasicMaterial({map:new T.CanvasTexture(shadowCanvas),transparent:true,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-1}));this.shadow.rotation.x=-Math.PI/2;this.scene.add(this.shadow);
    this.routeRing=new T.Mesh(new T.RingGeometry(.97,1,96),new T.MeshBasicMaterial({color:0xffc875,transparent:true,opacity:.72,side:T.DoubleSide,depthWrite:false}));
    this.routeRing.rotation.x=-Math.PI/2;this.routeRing.visible=false;this.scene.add(this.routeRing);
    new ResizeObserver(()=>this.resize()).observe(canvas);this.resize();
  }
  resize(){const w=this.canvas.clientWidth||1,h=this.canvas.clientHeight||1;this.renderer.setSize(w,h,false);this.camera.aspect=w/h;this.camera.updateProjectionMatrix();}
  async init(clothes,spawn,progress){
    this.clothes={...clothes};
    [this.index,this.bank]=await Promise.all([fetch('./city/index.json').then(r=>r.json()),loadSoundBank()]);
    this.lastWalk='';this.hero=await Actor.create(fresh('zhenfu','lead','甄芙'),progress);this.heroState={...this.hero.state};this.baseSource=this.hero.source;await dress(this.hero,this.clothes);this.scene.add(this.hero.root);
    await this.travel(spawn);this.hero.walk('Idle',0);
  }
  async loadTile(t){
    if(this.tiles.has(t.file))return this.tiles.get(t.file).promise;
    const obj={info:t,root:null,walk:[],solid:[]};this.tiles.set(t.file,obj);
    const index=t.collision ? fetch('./city/'+t.collision).then(r=>{
      if(!r.ok)throw Error('无法读取碰撞区块 '+t.file);
      return r.arrayBuffer();
    }) : Promise.resolve(null);
    obj.promise=Promise.all([this.loader.loadAsync('./city/'+t.file),index]).then(([g,collision])=>{
      if(this.tiles.get(t.file)!==obj)return;
      const colliders=[];obj.levels=[];obj.root=g.scene;this.scene.add(obj.root);obj.root.updateMatrixWorld(true);
      obj.root.traverse(m=>{
        if(!m.isMesh)return;
        if(m.userData.hotelLevel||m.userData.hotelShell)obj.levels.push(m);
        if(collision){if(m.userData.collisionSlot!==undefined)colliders[m.userData.collisionSlot]=m;return;}
        m.geometry.computeBoundingBox();m.geometry.computeBoundingSphere();
        const type=m.userData.surface||m.name.replace(/\d+$/,'');
        if(type==='walk')obj.walk.push(m);
        if(type==='solid')obj.solid.push(m);
      });
      if(collision)obj.collision=new CityCollision(collision,colliders);
      this.applyHotelVisibility(obj);
    }).catch(e=>{if(this.tiles.get(t.file)===obj)this.tiles.delete(t.file);throw e;});
    return obj.promise;
  }
  unload(obj){
    if(!obj.root)return;
    obj.root.removeFromParent();
    const mats=new Set(),textures=new Set();
    obj.root.traverse(n=>{if(n.isMesh){n.geometry.dispose();for(const m of [].concat(n.material)){mats.add(m);for(const v of Object.values(m))if(v?.isTexture)textures.add(v);}}});
    mats.forEach(m=>m.dispose());textures.forEach(t=>{t.dispose();t.source?.data?.close?.();});
    this.tiles.delete(obj.info.file);
  }
  applyHotelVisibility(tile) {
    const active=this.hotelLevel;
    for(const mesh of tile.levels||[]) {
      const floor=mesh.userData.hotelLevel,shell=mesh.userData.hotelShell;
      const adjacent=f=>active<=3 && f<=3 && Math.abs(f-active)===1;
      if(shell){
        const spans=active?shell.filter(([level])=>level===active||adjacent(level)):shell;
        mesh.visible=spans.length>0;
        if(mesh.visible){
          const first=spans[0][1],last=spans[spans.length-1];
          mesh.geometry.setDrawRange(first,last[1]+last[2]-first);
        }
      }else mesh.visible=active ? floor===active || (this.hotelStairs && adjacent(floor)) : floor===this.exteriorFloor;
    }
  }
  updateHotel() {
    const p=this.pos,level=hotelFloor(p),outside=floorAtHeight(p.y);
    // These bounds include both public stair flights and the view across each landing.
    const stairs=level>=1&&level<=3&&p.x>256&&p.x<272&&p.z> -730&&p.z< -713;
    if(level===this.hotelLevel&&stairs===this.hotelStairs&&outside===this.exteriorFloor)return false;
    this.hotelLevel=level;this.hotelStairs=stairs;this.exteriorFloor=outside;
    for(const t of this.tiles.values())this.applyHotelVisibility(t);
    return true;
  }
  async stream(force=false){
    const gen=++this.generation,x=this.pos.x,z=this.pos.z;
    this.lastLoad.copy(this.pos);
    const inside=!!this.hotelLevel, radius=inside?80:150;
    const wanted=this.index.tiles.map(t=>[near(t.bounds,x,z),t]).filter(([d,t])=>d<radius&&(!inside||t.district!==18)).sort((a,b)=>a[0]-b[0]||Number(a[1].district===18)-Number(b[1].district===18));
    for(const obj of this.tiles.values())if(obj.root&&(near(obj.info.bounds,x,z)>(inside?105:210)||(inside&&obj.info.district===18)))this.unload(obj);
    const central=wanted.filter(([d,t])=>d<4&&t.district!==18);
    if(force&&!central.length)throw Error('该出生点没有可步行的城市区块');
    if(force)await Promise.all(central.map(([,t])=>this.loadTile(t)));
    const rest=async()=>{
      for(const [,t] of wanted){if(this.generation!==gen)return;await this.loadTile(t);}
    };
    rest().catch(e=>this.notify('街区载入失败 · '+e.message));
  }
  grounds(x,z,reference,limit=2.4){
    this.ray.set(point.set(x,reference+limit,z),down);this.ray.far=limit+Math.max(4,limit);
    let best=-Infinity;
    for(const t of this.tiles.values()){
      if(!t.root||near(t.info.bounds,x,z)>.08)continue;
      if(t.collision){
        const dist=t.collision.query(x,reference+limit,z,0,-1,0,this.ray.far,true);
        if(Number.isFinite(dist))best=Math.max(best,reference+limit-dist);
        continue;
      }
      for(const m of t.walk){
        const b=m.geometry.boundingBox;if(x<b.min.x||x>b.max.x||z<b.min.z||z>b.max.z)continue;
        const hit=this.ray.intersectObject(m,false)[0];if(hit&&hit.point.y>best)best=hit.point.y;
      }
    }
    return Number.isFinite(best)?best:null;
  }
  blocked(dx,dz,origin=this.pos,clearance=.22) {
    const dist=Math.hypot(dx,dz);
    if(!dist)return false;
    this.ray.set(point.set(origin.x,origin.y+.85,origin.z),new T.Vector3(dx/dist,0,dz/dist));this.ray.far=dist+clearance;
    for(const t of this.tiles.values()){
      if(!t.root||near(t.info.bounds,origin.x,origin.z)>dist+clearance)continue;
      if(t.collision){
        if(Number.isFinite(t.collision.query(origin.x,origin.y+.85,origin.z,dx/dist,0,dz/dist,this.ray.far,false)))return true;
        continue;
      }
      for(const m of t.solid){const b=m.geometry.boundingBox;
        if(origin.x<b.min.x-dist-clearance||origin.x>b.max.x+dist+clearance||origin.z<b.min.z-dist-clearance||origin.z>b.max.z+dist+clearance)continue;
        if(this.ray.intersectObject(m,false).length)return true;
      }
    }
    return false;
  }
  async travel(p){
    const old=this.pos.clone();this.pos.fromArray(p);this.updateHotel();
    try{await this.stream(true);const floor=this.grounds(this.pos.x,this.pos.z,this.pos.y,.45)??this.grounds(this.pos.x,this.pos.z,this.pos.y,7);if(floor===null)throw Error('目的地不在可行走地面上');this.pos.y=floor;}
    catch(e){this.pos.copy(old);this.updateHotel();this.stream().catch(()=>{});throw e;}
    this.updateHotel();this.hero.state.p=this.pos.toArray();this.hero.state.yaw=180;this.walkYaw=180;this.hero.walk('Idle',0);
    this.resetCamera();this.shadow.position.copy(this.pos);this.shadow.position.y+=.03;
  }
  resetCamera(){
    const yaw=radians(this.hero?.state.yaw??180),p=this.pos;
    this.controls.target.set(p.x,p.y+1.02,p.z);
    this.camera.position.set(p.x-2.3*Math.sin(yaw),p.y+1.62,p.z-2.3*Math.cos(yaw));
    this.controls.update();
  }
  move(x,y,dt,fast){
    if(!this.hero||!this.walking)return;
    const mag=Math.min(1,Math.hypot(x,y));this.stepTime+=dt;
    let clip='Idle';
    if(mag>.09){
      const a=this.controls.getAzimuthalAngle(),d=(fast?3.9:1.65)*dt*mag/Math.hypot(x,y);
      const dx=(x*Math.cos(a)+y*Math.sin(a))*d,dz=(-x*Math.sin(a)+y*Math.cos(a))*d;
      const nx=this.pos.x+dx,nz=this.pos.z+dz,floor=this.grounds(nx,nz,this.pos.y,.62);
      if(floor!==null&&Math.abs(this.pos.y-floor)<.72&&!this.blocked(dx,dz)){
        const diff=new T.Vector3(dx,floor-this.pos.y,dz);this.pos.add(diff);this.camera.position.add(diff);this.controls.target.add(diff);
        this.hero.state.p=this.pos.toArray();clip=fast?'Run':'Walk';
      }
      const target=Math.atan2(dx,dz)*180/Math.PI;this.hero.state.yaw+=((target-this.hero.state.yaw+540)%360-180)*Math.min(1,dt*14);this.walkYaw=this.hero.state.yaw;
      if(this.updateHotel()||this.lastLoad.distanceTo(this.pos)>20)this.stream().catch(e=>this.notify(e.message));
    }
    this.hero.face?.advance(dt);this.hero.walk(clip,this.stepTime);
    this.shadow.position.copy(this.pos);this.shadow.position.y+=.028;
  }
  light(time='afternoon'){
    const tones={morning:[0xd2e1e9,0xffe7ba,2,2.3],afternoon:[0xc3d6df,0xffedd6,1.9,2.3],
      dusk:[0xba9f9b,0xffc28d,1.45,1.6],night:[0x394855,0xffd9b0,1.16,.95]};
    const [sky,tint,fill,sun]=tones[time]||tones.afternoon;
    this.scene.background.setHex(sky);this.scene.fog.color.setHex(sky);
    this.fill.intensity=fill;this.sun.color.setHex(tint);this.sun.intensity=sun;
  }
  async showCompanion(frameDialogue=true){
    if(!this.companion)this.companion=await Actor.create(fresh('leonSuit','chen','陈总'),()=>{});
    const a=this.companion;this.scene.add(a.root);
    let x=this.pos.x-1.1,z=this.pos.z-.8;
    const h=this.grounds(x,z,this.pos.y,.6);
    if(h===null){x=this.pos.x;z=this.pos.z-1;}
    a.state.p=[x,h??this.pos.y,z];a.state.yaw=Math.atan2(this.pos.x-x,this.pos.z-z)*180/Math.PI;
    a.root.visible=true;a.walk('Idle',0);
    if(!frameDialogue)return;
    this.hero.state.yaw=a.state.yaw+180;this.hero.walk('Idle',this.stepTime);
    this.controls.target.set((x+this.pos.x)/2,this.pos.y+1.12,(z+this.pos.z)/2);
    this.camera.position.copy(this.controls.target).add(new T.Vector3(.16,.63,3.25));this.controls.update();
  }
  async clothesTo(c){this.clothes={...c};await Promise.all([this.hero,...this.cast].filter(Boolean).map(a=>dress(a,c)));}
  clearShow(){
    this.hero?.softRim?.reset();
    this.car.hide();if(this.companion)this.companion.root.visible=false;
    this.showToken++;for(const a of this.cast)if(a!==this.hero)release(a);else a.sound?.pause();this.cast=[];this.group.clear();this.walking=true;
    if(this.hero){this.hero.source=this.baseSource;this.hero.state={...this.heroState,p:this.pos.toArray(),yaw:this.walkYaw??180};this.scene.add(this.hero.root);this.hero.face?.restore();this.hero.walk('Idle',this.stepTime);}
    if(this.hero){if(this.hero.face)this.hero.face=new this.hero.face.constructor(this.hero,this.hero.source.expressions);this.hero.root.visible=true;}this.shadow.visible=true;
  }
  async show(record,which,loop=false,roleList=null){
    const token=++this.showToken, prepared=[];
    const guess=record?.kind==='glb'?(record.clips.find(x=>x.name===which)||record.clips[0]):null;
    if(record?.kind==='glb'&&which&&!record.clips.some(x=>x.name===which))throw Error('GLB 动作不存在 '+which);
    let states;
    if(record?.kind==='motion')states=record.data.actors;
    else if(roleList)states=roleList.map((r,i)=>({...fresh(r.model,r.id,r.label,(i-(roleList.length-1)/2)*1.16),clip:'Idle',yaw:i%2?-22:22}));
    else if(guess)states=[fresh(guess.type,'lead',guess.type==='leonSuit'?'西装里昂':guess.type==='leon'?'里昂':'甄芙')];
    else states=[fresh('zhenfu','lead','甄芙')];
    if(roleList&&record?.kind==='motion'&&roleList.some(r=>!states.some(a=>a.id===r.id&&a.type===r.model)))throw Error('模块角色 ID 或模型与动作演员表不一致');
    try{
      for(const original of states){
        const s={...original};
        const reuse=loop&&roleList&&s.id===roleList[0].id&&s.type===this.hero.type;
        const a=reuse?this.hero:await Actor.create(s,()=>{});prepared.push(a);
        if(reuse)checkContactAnchors(a,s.contactBodies);
        if(reuse){a.sound?.pause();a.state={...s};a.face?.restore();if(a.face)a.face=new a.face.constructor(a,a.source.expressions);}
        else await dress(a,this.clothes);
        if(guess&&(!roleList||s.id===roleList.find(r=>r.model===guess.type)?.id)){
          const c=await glbClip(record,which,a);a.source={...a.source,clips:new Map(a.source.clips)};a.source.clips.set('@import',c);a.state.clip='@import';
        }else if(s.clip!=='@keys'&&s.clip!=='@rest'&&!a.source.clips.has(s.clip))throw Error('角色缺少片段 '+s.clip);
        a.sound=new SoundTrack(a.state,this.bank);a.state.time=0;a.state.dir=1;a.state.playing=a.duration>0;
        if(a.face){a.face.state.time=0;a.face.state.wait=a.face.state.delay;a.face.state.playing=!!a.face.clip;}
        a.apply();if(token!==this.showToken){prepared.filter(a=>a!==this.hero).forEach(release);return null;}
      }
      const cues=prepared.flatMap(a=>a.sound.state.cues.map(c=>c.id));
      if(cues.length){await this.bank.unlock();await this.bank.preload(cues);}
      if(token!==this.showToken){prepared.filter(a=>a!==this.hero).forEach(release);return null;}
    }catch(e){prepared.filter(a=>a!==this.hero).forEach(release);throw e;}
    this.hero?.softRim?.reset();
    this.cast.filter(a=>a!==this.hero).forEach(release);this.group.clear();this.cast=prepared;this.loopCast=loop;this.walking=false;
    this.hero.root.visible=prepared.includes(this.hero);this.shadow.visible=false;this.group.position.copy(this.pos);
    for(const a of prepared){this.group.add(a.root);if(a.sound.duration&&!loop)a.sound.start(this.bank.context.currentTime+.04,0);}
    const cam=record?.kind==='motion'?record.data.camera:null;
    if(cam){this.camera.position.fromArray(cam.p).add(this.pos);this.controls.target.fromArray(cam.target).add(this.pos);}
    else{this.camera.position.copy(this.pos).add(new T.Vector3(.3,1.82,4.8));this.controls.target.copy(this.pos).add(new T.Vector3(0,.98,0));}
    this.controls.update();
    return Math.max(.1,...prepared.map(a=>Math.max(a.duration,a.sound.duration,(a.face?.clip?.duration||0)+(a.face?.state.delay||0))));
  }
  syncCast(time,startSound=false,previous=-1){
    for(const a of this.cast){
      if(a.duration>0){const t=time*a.state.rate;a.state.time=a.state.clip==='@keys'?Math.min(t,a.duration):t%a.duration;}
      if(a.face?.clip){const f=a.face.state;const t=Math.max(0,time-f.delay);f.time=f.loop?t%a.face.clip.duration:Math.min(t,a.face.clip.duration);f.wait=Math.max(0,f.delay-time);}
      a.apply(a.state.clip==='@keys'?'once':'loop');
      if(a.sound?.duration){
        // Use module time for each cue, so speed changes affect subsequent cue timing.
        if(startSound)a.sound.pause();
        for(const cue of a.sound.state.cues){
          if((time>=previous?cue.at>previous&&cue.at<=time:cue.at>previous||cue.at<=time)&&this.bank.context){
            const node=this.bank.playBuffer(cue.id,cue.gain,this.bank.context.currentTime,0,n=>a.sound.nodes.delete(n));
            if(node)a.sound.nodes.add(node);
          }
        }
      }
    }
  }
  tickCast(dt,rate=1){
    for(const a of this.cast){
      const changed=a.face?.advance(dt*rate);a.sound.tick();
      if(this.loopCast&&!a.state.playing&&a.duration>0){a.state.time=0;a.state.dir=1;a.state.playing=true;}
      if(a.state.playing&&a.duration)a.transport(dt*rate);else if(changed)a.refreshExpression();
    }
  }
  pauseAudio(){for(const a of this.cast){a.resumeAudio=!!a.sound.run;a.sound?.pause();}}
  resumeAudio(){for(const a of this.cast)if(a.resumeAudio){a.resumeAudio=false;a.sound.play().catch(e=>this.notify(e.message));}}
  mark(p,radius=0){
    this.marker.visible=!!p;this.routeRing.visible=!!p&&radius>0;
    if(!p)return;
    const h=this.grounds(p[0],p[2],p[1],.55);
    this.marker.position.set(p[0],(h??p[1])+.10,p[2]);
    this.marker.scale.setScalar(radius?2.1:1);
    if(radius){this.routeRing.position.copy(this.marker.position);this.routeRing.scale.setScalar(radius);}
  }
  draw(){this.controls.update();this.renderer.render(this.scene,this.camera);}
}
