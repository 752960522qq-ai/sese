import * as T from './vendor/three.module.min.js';

const clamp=T.MathUtils.clamp;
const wheelBase=2.94, tyreRadius=.41, radians=Math.PI/180;
export class ShowroomCar {
  constructor(world){this.world=world;this.pos=new T.Vector3();this.active=false;this.occupied=false;this.yaw=0;this.speed=0;}
  async park(position,heading,saved){
    if(!this.model){
      const gltf=await this.world.loader.loadAsync('./vehicles/dealer-suv.glb');
      this.model=gltf.scene;
      this.wheels=[];
      this.model.traverse(n=>{if(n.name.startsWith('wheel_'))this.wheels.push(n);});
      this.world.scene.add(this.model);
    }
    this.active=true;this.occupied=false;this.speed=0;this.steer=0;this.roll=0;
    this.pos.fromArray(saved?.position??position);
    this.yaw=(saved?.heading??heading)*radians;
    this.pos.y=this.world.grounds(this.pos.x,this.pos.z,this.pos.y,1.2)??this.pos.y;
    this.model.visible=true;this.pose();
    if(saved?.occupied)this.board();
  }
  save(){return {position:this.pos.toArray(),heading:this.yaw/radians,occupied:this.occupied};}
  hide(){this.active=false;this.occupied=false;this.speed=0;if(this.model)this.model.visible=false;this.world.controls.enableRotate=true;}
  distance(){return Math.hypot(this.world.pos.x-this.pos.x,this.world.pos.z-this.pos.z);}
  board(){
    if(!this.active)return;
    this.occupied=true;this.world.pos.copy(this.pos);this.world.hero.root.visible=false;this.world.shadow.visible=false;
    if(this.world.companion)this.world.companion.root.visible=false;
    this.world.controls.enableRotate=false;this.chase(1);
  }
  exit(){
    const w=this.world;
    for(const side of [1,-1]){
      const dx=Math.cos(this.yaw)*1.85*side,dz=-Math.sin(this.yaw)*1.85*side;
      const x=this.pos.x+dx,z=this.pos.z+dz,h=w.grounds(x,z,this.pos.y,.7);
      if(h===null||Math.abs(h-this.pos.y)>.72||w.blocked(dx,dz,this.pos))continue;
      this.occupied=false;this.speed=0;w.pos.set(x,h,z);w.hero.root.visible=true;w.shadow.visible=true;w.controls.enableRotate=true;
      w.hero.state.p=w.pos.toArray();w.walkYaw=w.hero.state.yaw=this.yaw/radians;w.hero.walk('Idle',0);
      w.shadow.position.set(x,h+.03,z);w.resetCamera();return true;
    }
    return false;
  }
  pose(){
    this.model.position.copy(this.pos);this.model.rotation.y=this.yaw;
    for(const wheel of this.wheels){wheel.rotation.order='YXZ';wheel.rotation.y=wheel.name.includes('front')?this.steer:0;wheel.rotation.x=this.roll;}
  }
  chase(blend){
    const w=this.world,dx=Math.sin(this.yaw),dz=Math.cos(this.yaw);
    w.camera.position.lerp(new T.Vector3(this.pos.x-dx*7.7,this.pos.y+3.65,this.pos.z-dz*7.7),blend);
    w.controls.target.lerp(new T.Vector3(this.pos.x+dx*1.6,this.pos.y+1.12,this.pos.z+dz*1.6),blend);w.controls.update();
  }
  drive(pedal,turn,dt){
    if(!this.occupied)return;
    const w=this.world;
    dt=Math.min(dt,.32);
    const steps=Math.max(1,Math.ceil(dt/.09)),h=dt/steps;
    for(let i=0;i<steps;i++){
      const coast=pedal?0:2.6*h;
      this.speed=Math.sign(this.speed)*Math.max(0,Math.abs(this.speed)-coast);
      const thrust=pedal>0?(this.speed<0?12:5.5):pedal<0?(this.speed>.35?-12:-3.1):0;
      this.speed=clamp(this.speed+thrust*h,-4.5,17);
      this.steer+=(turn*.53-this.steer)*Math.min(1,h*8);
      const travel=this.speed*h,yaw=this.yaw+travel*Math.tan(this.steer)/wheelBase;
      const dx=Math.sin(yaw)*travel,dz=Math.cos(yaw)*travel;
      if(Math.abs(travel)<.0001)continue;
      const floor=w.grounds(this.pos.x+dx,this.pos.z+dz,this.pos.y,.69);
      const sign=Math.sign(travel),sn=Math.sin(yaw),cs=Math.cos(yaw);
      const hit=floor===null||Math.abs(floor-this.pos.y)>.57||[-.86,.86].some(side=>{
        const origin=new T.Vector3(this.pos.x+sn*2.12*sign+cs*side,this.pos.y,this.pos.z+cs*2.12*sign-sn*side);
        return w.blocked(dx,dz,origin,.34);
      });
      if(hit){this.speed=0;break;}
      this.yaw=yaw;this.pos.set(this.pos.x+dx,floor,this.pos.z+dz);this.roll+=travel/tyreRadius;
    }
    this.pose();w.pos.copy(this.pos);this.chase(1-Math.exp(-dt*8));
    if(w.updateHotel?.()||w.lastLoad.distanceTo(w.pos)>16)w.stream().catch(e=>w.notify(e.message));
  }
}
