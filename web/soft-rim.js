import * as T from './vendor/three.module.min.js';

const sectors = 32;
const tau = 2*Math.PI;
const names = ['Body_Skin_4K', 'Anatomy_Rim_and_Interior_4K'];
const smooth = T.MathUtils.smoothstep;
const pointKey = p => [p.x,p.y,p.z].map(v=>Math.round(v*1e5)).join(',');
const vec = () => new T.Vector3();

function surfaces(model){
  const pair = [];
  model.traverse(m=>{
    const n = names.indexOf(m.material?.name);
    if(m.isSkinnedMesh && n>=0)pair[n]=m;
  });
  return pair;
}

// Reuse the shipped, welded vertices. This also prepares existing fitted model
// caches without a separate mesh export or an additional skeleton.
export function prepareSoftRim(model){
  const meshes=surfaces(model);
  if(!meshes[0]||!meshes[1])return null;
  const pos=meshes.map(m=>m.geometry.attributes.position);
  const outer=new Map(), seen=new Set(), lip=[], p=vec(), center=vec();
  for(let i=0;i<pos[0].count;i++)outer.set(pointKey(p.fromBufferAttribute(pos[0],i)),i);
  for(let i=0;i<pos[1].count;i++){
    p.fromBufferAttribute(pos[1],i);
    const key=pointKey(p), index=outer.get(key);
    if(index===undefined||seen.has(key))continue;
    seen.add(key);lip.push({p:p.clone(),index,inside:i,uv:meshes[1].geometry.attributes.uv.getX(i)});center.add(p);
  }
  if(lip.length<8)return null;
  center.divideScalar(lip.length);
  // Fit the opening plane in the authored upright model (Y up).
  let xx=0,zz=0,xz=0,xy=0,yz=0;
  for(const entry of lip){
    p.subVectors(entry.p,center);
    xx+=p.x*p.x;zz+=p.z*p.z;xz+=p.x*p.z;xy+=p.x*p.y;yz+=p.y*p.z;
  }
  const det=xx*zz-xz*xz;
  if(det<1e-12)return null;
  const normal=new T.Vector3(-(xy*zz-yz*xz)/det,1,-(yz*xx-xy*xz)/det).normalize();
  const tubeCenter=vec();
  for(let i=0;i<pos[1].count;i++)tubeCenter.add(p.fromBufferAttribute(pos[1],i));
  if(normal.dot(tubeCenter.divideScalar(pos[1].count).sub(center))<0)normal.negate();
  const u=new T.Vector3(1,0,0).addScaledVector(normal,-normal.x).normalize();
  const v=vec().crossVectors(normal,u), relative=vec(), boundary=new Map();
  for(const entry of lip){
    relative.subVectors(entry.p,center);
    entry.u=relative.dot(u);entry.v=relative.dot(v);
    boundary.set(pointKey(entry.p),entry);
  }
  // The narrow channel can fold across its own centerline. Its unwrapped UV
  // identifies the same strand of tissue at every depth, even in those folds.
  const ordered=[...lip].sort((a,b)=>a.uv-b.uv), byColumn=new Map();
  let winding=0;
  ordered.forEach((a,i)=>{const b=ordered[(i+1)%ordered.length];winding+=a.u*b.v-a.v*b.u;});
  const sign=winding>=0?1:-1;
  let sx=0,sy=0;
  for(const b of lip){
    const phase=Math.atan2(b.v,b.u)-sign*tau*b.uv;
    sx+=Math.cos(phase);sy+=Math.sin(phase);
  }
  const phase=Math.atan2(sy,sx), wrap=a=>Math.atan2(Math.sin(a),Math.cos(a));
  for(const b of lip){
    const linear=phase+sign*tau*b.uv;
    b.angle=linear+.65*wrap(Math.atan2(b.v,b.u)-linear);
    byColumn.set(Math.round(((b.uv%1+1)%1)*1e5),b.angle);
  }
  const innerUv=meshes[1].geometry.attributes.uv;
  const rowKey=i=>Math.round(innerUv.getY(i)*1e5);
  const rowOrder=Array.from(new Set(Array.from({length:innerUv.count},(_,i)=>rowKey(i))));
  const lipUV=innerUv.getY(lip[0].inside);
  rowOrder.sort((a,b)=>Math.abs(a-1e5*lipUV)-Math.abs(b-1e5*lipUV));
  const rows=new Map(rowOrder.map((key,i)=>[key,i]));
  const rim=lip.map((b,i)=>{b.id=i;return {mesh:0,index:b.index,u:b.u,v:b.v,angle:b.angle,row:0,edge:i,weight:1};});
  const samples=[...rim], front=[], bands=rowOrder.map(()=>[]);
  meshes.forEach((mesh,part)=>{
    const field=new Float32Array(pos[part].count*4), unique=new Set(), frontCells=new Set();
    const picks=rowOrder.map(()=>new Map());
    for(let i=0;i<pos[part].count;i++){
      p.fromBufferAttribute(pos[part],i);relative.subVectors(p,center);
      if(!part && relative.lengthSq()>.068*.068){
        // Anterior skin can fold across the opening during deep hip flexion.
        // Only this nearby patch can receive the secondary contact response.
        const w=(1-smooth(relative.dot(v),-.080,-.045))*(1-smooth(relative.length(),.165,.200));
        if(w>0){
          field[4*i+2]=-w;
          const key=[p.x,p.y,p.z].map(q=>Math.round(q/.002)).join(',');
          if(!frontCells.has(key)){frontCells.add(key);front.push({mesh:part,index:i});}
        }
        continue;
      }
      let closest=lip[0],dsq=Infinity;
      if(!part)for(const b of lip){
        const d=b.p.distanceToSquared(p);
        if(d<dsq){dsq=d;closest=b;}
      }
      const distance=Math.sqrt(dsq),weight=part?1:1-smooth(distance,.005,.043);
      if(!weight)continue;
      const x=relative.dot(u),y=relative.dot(v),uv=part ? innerUv.getX(i) : 0;
      const angle=part ? (byColumn.get(Math.round(((uv%1+1)%1)*1e5))??(phase+sign*tau*uv)) :
        closest.angle+smooth(distance,.002,.022)*wrap(Math.atan2(y,x)-closest.angle);
      const row=part ? rows.get(rowKey(i)) : 0,edge=part ? -1 : closest.id;
      field.set([angle,edge,weight,row],4*i);
      const record={mesh:part,index:i,angle,edge,row,weight};
      if(part){
        // Uniform UV samples retain the shape of a whole cross-section after skinning.
        const arc=(uv%1+1)%1*56,k=Math.round(arc)%56,error=Math.abs(arc-Math.round(arc));
        if(!picks[row].has(k)||error<picks[row].get(k).error)picks[row].set(k,{record,error});
      }else if(distance<.003){
        const key=pointKey(p);
        if(!boundary.has(key)&&!unique.has(key)){samples.push(record);unique.add(key);}
      }
    }
    if(part)for(let i=1;i<picks.length;i++)for(const {record} of picks[i].values()){
      bands[i].push(record);samples.push(record);
    }
    mesh.geometry.setAttribute('_softrim',new T.BufferAttribute(field,4));
  });
  return {rim,samples,bands,front};
}

function withRimMaterial(original,uniforms,rowCount){
  const material=original.clone(), originalKey=original.customProgramCacheKey();
  material.customProgramCacheKey=()=>originalKey+'-soft-rim-'+rowCount;
  material.onBeforeCompile=(shader,renderer)=>{
    original.onBeforeCompile.call(material,shader,renderer);
    Object.assign(shader.uniforms,uniforms);
    shader.vertexShader=shader.vertexShader.replace('#include <common>',`
      #include <common>
      attribute vec4 _softrim;
      uniform bool softActive;
      uniform vec3 softOrigin,softU,softV;
      uniform highp sampler2D softField;
      uniform vec4 softGuard;
      varying vec3 vSoftDelta;
      vec4 cell(int row,int column){return texelFetch(softField,ivec2(column%32,row),0);}
      `).replace('#include <project_vertex>',`
      vSoftDelta=vec3(0.);
      if(softActive && _softrim.z>0.){
        int row=int(_softrim.w);
        float sector=mod(_softrim.x*5.09295817894,32.);
        int k=int(floor(sector));vec4 field=mix(cell(row,k),cell(row,k+1),fract(sector));
        float fade=_softrim.z*(1.-smoothstep(.031,.055,field.w))*smoothstep(0.,.006,field.x);
        if(fade>0.){
          vec3 wp=(modelMatrix*vec4(transformed,1.)).xyz-softOrigin;
          vec2 xy=vec2(dot(wp,softU),dot(wp,softV)),radial=xy-field.yz;
          vec2 ray=vec2(cos(_softrim.x),sin(_softrim.x));
          float margin=0.;
          if(_softrim.y>=0.){
            int e=int(_softrim.y);
            vec2 edge=cell(${rowCount}+e/32,e%32).xy;
            margin=max(0.,dot(xy-edge,ray));
          }
          // The fourth-power blend preserves the tissue outside the lip and
          // keeps neighbouring concentric folds in their original order.
          float base=max(0.,length(radial)-margin);
          float size=field.x+.00065*(1.-smoothstep(0.,.009,field.w))*smoothstep(0.,.005,field.x);
          vec2 squared=vec2(base*base,size*size);
          float radius=sqrt(sqrt(dot(squared,squared)))+margin;
          vec2 delta=(ray*radius-radial)*fade;
          vec3 shift=softU*delta.x+softV*delta.y;
          transformed+=inverse(mat3(modelMatrix))*shift;
          vSoftDelta=mat3(viewMatrix)*shift;
        }
      }else if(softActive && _softrim.z<0. && softGuard.x>0.){
        vec3 wp=(modelMatrix*vec4(transformed,1.)).xyz-softOrigin;
        float x=dot(wp,softU),y=dot(wp,softV),z=dot(wp,cross(softU,softV));
        float side=1.-smoothstep(0.,.019,abs(x)-softGuard.y);
        float depth=1.-smoothstep(0.,.019,max(-softGuard.z-z,z-softGuard.w));
        float contact=max(0.,y+softGuard.x);
        float fade=(1.-smoothstep(.025,.060,contact))*smoothstep(0.,.006,softGuard.x);
        vec3 shift=softV*(contact*_softrim.z*side*depth*fade);
        transformed+=inverse(mat3(modelMatrix))*shift;
        vSoftDelta=mat3(viewMatrix)*shift;
      }
      #include <project_vertex>`);
    shader.fragmentShader=shader.fragmentShader.replace('#include <common>',
      '#include <common>\nvarying vec3 vSoftDelta;')
      .replace('#include <normal_fragment_begin>',`#include <normal_fragment_begin>
        vec3 originalView=-vViewPosition-vSoftDelta;
        vec3 before=cross(dFdx(originalView),dFdy(originalView));
        vec3 after=cross(dFdx(-vViewPosition),dFdy(-vViewPosition));
        if(dot(vSoftDelta,vSoftDelta)>1.e-12 && length(before)>1.e-13 && length(after)>1.e-13){
          before=normalize(before);after=normalize(after);
          vec3 axis=cross(before,after);
          normal=normalize(normal+cross(axis,normal)+cross(axis,cross(axis,normal))/max(.001,1.+dot(before,after)));
        }`);
  };
  return material;
}

function segmentDistance(x,y,z,s){
  const t=s.lengthSq ? Math.max(0,Math.min(1,((x-s.x)*s.dx+(y-s.y)*s.dy+(z-s.z)*s.dz)/s.lengthSq)) : 0;
  const vx=x-s.x-t*s.dx,vy=y-s.y-t*s.dy,vz=z-s.z-t*s.dz;
  return vx*vx+vy*vy+vz*vz;
}

function segment(values){
  const [x,y,z,bx,by,bz,r]=values, dx=bx-x,dy=by-y,dz=bz-z;
  return {x,y,z,dx,dy,dz,lengthSq:dx*dx+dy*dy+dz*dz,r,r2:r*r};
}

// Test the segment from resting tissue to its current displaced point. This
// keeps a second prop from being passed through while the first contact releases.
function crossesReturnPath(p,dx,dy,s){
  const aa=dx*dx+dy*dy;
  if(aa<1e-12)return false;
  const x=p.x-s.x,y=p.y-s.y,z=p.z-s.z,cc=dx*x+dy*y;
  let t;
  if(s.lengthSq<1e-12)t=T.MathUtils.clamp(-cc/aa,0,1);
  else{
    const bb=dx*s.dx+dy*s.dy,ff=s.dx*x+s.dy*y+s.dz*z,denom=aa*s.lengthSq-bb*bb;
    t=denom>1e-16?T.MathUtils.clamp((bb*ff-cc*s.lengthSq)/denom,0,1):0;
    const u=(bb*t+ff)/s.lengthSq;
    if(u<0)t=T.MathUtils.clamp(-cc/aa,0,1);
    else if(u>1)t=T.MathUtils.clamp((bb-cc)/aa,0,1);
  }
  return segmentDistance(p.x+t*dx,p.y+t*dy,p.z,s)<s.r2;
}

function advanceSpring(values,velocities,i,goal,minimum,dt,decay){
  const omega=19,x=values[i]-goal,term=velocities[i]+omega*x;
  let value=goal+(x+term*dt)*decay,velocity=(velocities[i]-omega*term*dt)*decay;
  if(value<=minimum){value=minimum;velocity=Math.max(0,velocity);}
  if(value<.000008 && Math.abs(velocity)<.00012 && !minimum){value=0;velocity=0;}
  values[i]=value;velocities[i]=velocity;
}

export class SoftRim {
  constructor(actor,profile){
    this.actor=actor;
    this.meshes=surfaces(actor.model);
    this.origin=vec();
    this.u=vec();this.v=vec();this.n=vec();this.p=vec();this.tmp=vec();
    this.count=profile.bands.length;
    this.offset=new Float32Array(sectors*this.count);
    this.velocity=new Float32Array(this.offset.length);this.before=new Float32Array(this.offset.length);
    this.floor=new Float32Array(this.offset.length);
    // RGBA float texels hold radius, section center X/Y and posed depth.
    // The last few rows hold the actual outer seam used by surrounding skin.
    const height=this.count+Math.ceil(profile.rim.length/sectors);
    this.data=new Float32Array(sectors*height*4);
    this.texture=new T.DataTexture(this.data,sectors,height,T.RGBAFormat,T.FloatType);
    this.texture.minFilter=this.texture.magFilter=T.NearestFilter;
    this.guard=new Float32Array(4);this.guardFloor=new Float32Array(4);this.guardVelocity=new Float32Array(4);
    this.uniforms={softGuard:{value:this.guard},softOrigin:{value:this.origin},softU:{value:this.u},softV:{value:this.v},
      softField:{value:this.texture},softActive:{value:false}};
    this.history=new Map();this.owned=[];this.active=false;this.frameVersion=-1;
    this.rows=Array.from({length:this.count},()=>({x:0,y:0,min:0,max:0,depth:0}));
    this.probes=profile.samples.map(s=>({...s,point:vec(),rx:Math.cos(s.angle),ry:Math.sin(s.angle)}));
    this.front=profile.front.map(s=>({...s,point:vec()}));
    this.points=[...this.probes,...this.front];
    const refs=new Map(this.probes.map(s=>[s.mesh+':'+s.index,s]));
    const lookup=s=>refs.get(s.mesh+':'+s.index);
    for(const p of this.probes){
      const angle=(p.angle/tau%1+1)%1*sectors;
      p.column=Math.floor(angle)%sectors;p.fraction=angle-Math.floor(angle);
    }
    this.rim=profile.rim.map(lookup);
    this.bands=profile.bands.map(b=>b.map(lookup));this.bands[0]=this.rim;
    this.angles=Array.from({length:sectors},(_,i)=>[Math.cos(tau*i/sectors),Math.sin(tau*i/sectors)]);
    this.palette=this.meshes[0].skeleton.bones.map(()=>new T.Matrix4());
    this.flex=0;
    const sk=this.meshes[0].skeleton;
    this.flexBones=['mixamorigHips','mixamorigLeftUpLeg','mixamorigRightUpLeg']
      .map(name=>sk.bones.findIndex(b=>b.name===name));
    const needed=new Set(this.flexBones.filter(j=>j>=0));
    for(const s of this.points){
      const attr=this.meshes[s.mesh].geometry.attributes;
      for(let k=0;k<4;k++)if(attr.skinWeight.getComponent(s.index,k)>0)needed.add(attr.skinIndex.getComponent(s.index,k));
    }
    this.needed=Array.from(needed);
    this.transform=new T.Matrix4();this.versions=[-1,-1];
  }
  bindMaterials(){
    if(this.owned.length){for(const [mesh,,mat] of this.owned)mesh.material=mat;return;}
    for(const mesh of this.meshes){
      const base=mesh.material, fitted=withRimMaterial(base,this.uniforms,this.count);
      mesh.material=fitted;this.owned.push([mesh,base,fitted]);
    }
  }
  frame(version){
    if(version===this.frameVersion)return;
    this.frameVersion=version;
    this.actor.root.updateWorldMatrix(true,false);
    this.actor.root.updateMatrixWorld(true);
    const [outer,inner]=this.meshes,sk=outer.skeleton;
    let changed=false;
    for(const j of this.needed){
      this.transform.multiplyMatrices(sk.bones[j].matrixWorld,sk.boneInverses[j]).multiply(outer.bindMatrix);
      if(!this.palette[j].equals(this.transform)){this.palette[j].copy(this.transform);changed=true;}
    }
    this.meshes.forEach((mesh,i)=>{
      const version=mesh.geometry.attributes.position.version;
      if(version!==this.versions[i]){this.versions[i]=version;changed=true;}
    });
    if(!changed)return;
    const indices=this.flexBones;
    if(inner.geometry.hasAttribute('_innerfold') && indices.every(i=>i>=0)){
      const up=this.p.setFromMatrixColumn(this.palette[indices[0]],1).normalize();
      const projection=i=>up.dot(this.tmp.setFromMatrixColumn(this.palette[i],1).normalize());
      this.flex=smooth(-.5*(projection(indices[1])+projection(indices[2])),-.62,-.16);
    }
    // The exterior and inner primitives use the same glTF node, bind and palette.
    for(const sample of this.points){
      const attr=this.meshes[sample.mesh].geometry.attributes,i=sample.index;
      const p=this.p.fromBufferAttribute(attr.position,i);
      if(sample.mesh&&this.flex)p.addScaledVector(this.tmp.fromBufferAttribute(attr._innerfold,i),this.flex);
      sample.point.set(0,0,0);
      for(let k=0;k<4;k++){
        const w=attr.skinWeight.getComponent(i,k);
        if(w)sample.point.addScaledVector(this.tmp.copy(p).applyMatrix4(this.palette[attr.skinIndex.getComponent(i,k)]),w);
      }
    }
    const center=this.origin.set(0,0,0);
    for(const b of this.rim)center.add(b.point);
    center.divideScalar(this.rim.length);
    let uu=0,uv=0,vv=0;
    this.u.set(0,0,0);this.v.set(0,0,0);
    for(const b of this.rim){
      this.p.subVectors(b.point,center);this.u.addScaledVector(this.p,b.u);this.v.addScaledVector(this.p,b.v);
      uu+=b.u*b.u;uv+=b.u*b.v;vv+=b.v*b.v;
    }
    const sumU=this.tmp.copy(this.u);
    this.u.multiplyScalar(vv).addScaledVector(this.v,-uv).normalize();
    this.v.multiplyScalar(uu).addScaledVector(sumU,-uv);
    this.v.addScaledVector(this.u,-this.u.dot(this.v)).normalize();
    this.n.crossVectors(this.u,this.v).normalize();
    for(const s of this.points){
      const p=this.toLocal(s.point,this.p);s.x=p.x;s.y=p.y;s.z=p.z;
    }
    let depth=0;
    this.bands.forEach((band,i)=>{
      const row=this.rows[i];let x=0,y=0,z=0,low=Infinity,high=-Infinity;
      for(const p of band){
        x+=p.x;y+=p.y;z+=p.z;low=Math.min(low,p.z);high=Math.max(high,p.z);
      }
      row.x=x/band.length;row.y=y/band.length;row.min=low-.00025;row.max=high+.00025;
      row.depth=depth=Math.max(depth,z/band.length);
      for(let k=0;k<sectors;k++){
        const at=4*(sectors*i+k);
        this.data[at+1]=row.x;this.data[at+2]=row.y;this.data[at+3]=row.depth;
      }
    });
    for(const [i,p] of this.rim.entries()){
      const at=4*(this.count*sectors+i);this.data[at]=p.x;this.data[at+1]=p.y;
    }
    this.dataDirty=true;
  }
  toLocal(world,out){
    const dx=world.x-this.origin.x,dy=world.y-this.origin.y,dz=world.z-this.origin.z;
    return out.set(dx*this.u.x+dy*this.u.y+dz*this.u.z,dx*this.v.x+dy*this.v.y+dz*this.v.z,dx*this.n.x+dy*this.n.y+dz*this.n.z);
  }
  fromLocal(p,out){
    const {x,y,z}=p;
    return out.copy(this.origin).addScaledVector(this.u,x).addScaledVector(this.v,y).addScaledVector(this.n,z);
  }
  touches(p,s){
    const row=this.rows[p.row];
    if(row.depth>=.055)return false;
    const d=segmentDistance(p.x,p.y,p.z,s);
    if(d<(s.r+.0004)**2)return true;
    if(!this.active)return false;
    const i=p.row*sectors,k=p.column;
    const value=T.MathUtils.lerp(this.offset[i+k],this.offset[i+(k+1)%sectors],p.fraction);
    if(value<=0 || d>(s.r+2*value+.012)**2)return false;
    const x=p.x-row.x,y=p.y-row.y;
    const edge=this.rim[p.edge],margin=edge?Math.max(0,(p.x-edge.x)*p.rx+(p.y-edge.y)*p.ry):0;
    const size=value+.00065*(1-smooth(row.depth,0,.009))*smooth(value,0,.005);
    const base=Math.max(0,Math.hypot(x,y)-margin),radius=Math.sqrt(Math.hypot(size*size,base*base))+margin;
    const blend=p.weight*(1-smooth(row.depth,.031,.055))*smooth(value,0,.006);
    return crossesReturnPath(p,(p.rx*radius-x)*blend,(p.ry*radius-y)*blend,s);
  }
  contact(s){
    if(segmentDistance(0,0,0,s)>(.085+s.r)**2)return;
    // A collider which fits through free space must not move the surrounding skin.
    if(!this.probes.some(p=>this.touches(p,s)))return;
    // The anterior patch responds only to an object that also touches the cuff.
    if(this.front.some(p=>segmentDistance(p.x,p.y,p.z,s)<(s.r+.0005)**2)){
      const r=s.r+.001,g=this.guardFloor;
      g[0]=Math.max(g[0],r-Math.min(s.y,s.y+s.dy));
      g[1]=Math.max(g[1],r+Math.max(Math.abs(s.x),Math.abs(s.x+s.dx)));
      g[2]=Math.max(g[2],r-Math.min(s.z,s.z+s.dz));
      g[3]=Math.max(g[3],r+Math.max(s.z,s.z+s.dz));
    }
    // Approximate the capsule by overlapping spheres. Limit the swept length to
    // the neighbourhood of this receiver, including the radius of the end caps.
    const length=Math.sqrt(s.lengthSq), reach=.10+s.r;
    const along=length ? -(s.x*s.dx+s.y*s.dy+s.z*s.dz)/s.lengthSq : 0;
    const first=length?T.MathUtils.clamp(along-reach/length,0,1):0;
    const last=length?T.MathUtils.clamp(along+reach/length,0,1):0;
    const count=Math.ceil((last-first)*length/Math.max(.002,s.r*.28));
    const halfStep=count?(last-first)*length/(2*count):0;
    const padded=Math.hypot(s.r,halfStep)+.0008;
    for(let n=0;n<=count;n++){
      const t=count?first+(last-first)*n/count:first;
      const x=s.x+t*s.dx,y=s.y+t*s.dy,z=s.z+t*s.dz;
      for(let j=0;j<this.rows.length;j++){
        const row=this.rows[j];
        if(row.depth>=.055)break;
        const dz=Math.max(0,row.min-z,z-row.max);
        if(dz>=padded)continue;
        const dx=x-row.x,dy=y-row.y,limit=padded*padded-dz*dz-dx*dx-dy*dy,base=j*sectors;
        for(let k=0;k<sectors;k++){
          const dir=this.angles[k],dot=dx*dir[0]+dy*dir[1],det=limit+dot*dot;
          if(det<=0)continue;
          this.floor[base+k]=Math.max(this.floor[base+k],dot+Math.sqrt(det));
        }
      }
    }
  }
  relax(dt){
    // Unilateral contact prevents interpenetration. A critically damped spring
    // restores each sector, with a small amount of tension shared by neighbours.
    const decay=Math.exp(-19*dt),before=this.before;
    before.set(this.offset);
    let moving=false;
    for(let i=0;i<before.length;i++){
      const k=i%sectors,base=i-k;
      const goal=Math.max(this.floor[i],.22*(before[base+(k+sectors-1)%sectors]+before[base+(k+1)%sectors]));
      advanceSpring(this.offset,this.velocity,i,goal,this.floor[i],dt,decay);
      moving ||= this.offset[i]>0;
      if(this.data[i*4]!==this.offset[i]){this.data[i*4]=this.offset[i];this.dataDirty=true;}
    }
    for(let i=0;i<4;i++)
      advanceSpring(this.guard,this.guardVelocity,i,this.guardFloor[i],this.guardFloor[i],dt,decay);
    this.active=moving||this.guard[0]>0;this.uniforms.softActive.value=this.active;
  }
  step(shapes,dt){
    if(!this.active&&!shapes.length){this.history.clear();return false;}
    const previousActive=this.active, next=new Map(), paths=[];
    let steps=Math.max(1,Math.ceil(dt*90));
    for(const shape of shapes){
      const a=this.toLocal(shape.a,this.p),b=this.toLocal(shape.b,this.tmp);
      const now=[a.x,a.y,a.z,b.x,b.y,b.z,shape.r];
      let prev=this.history.get(shape.key)??now;
      const travel=Math.max(Math.hypot(now[0]-prev[0],now[1]-prev[1],now[2]-prev[2]),
                            Math.hypot(now[3]-prev[3],now[4]-prev[4],now[5]-prev[5]));
      // A scene teleport is a new contact, not a swept object across the map.
      if(travel>.35 || dt===0)prev=now;
      else steps=Math.max(steps,Math.ceil(travel/Math.max(.0015,.7*Math.min(now[6],prev[6]))));
      paths.push([prev,now]);next.set(shape.key,now);
    }
    steps=Math.min(64,steps);
    for(let n=1;n<=steps;n++){
      this.floor.fill(0);this.guardFloor.fill(0);
      for(const [a,b] of paths)this.contact(segment(b.map((v,j)=>T.MathUtils.lerp(a[j],v,n/steps))));
      this.relax(dt/steps);
    }
    this.history=next;
    if(this.active && this.dataDirty){this.texture.needsUpdate=true;this.dataDirty=false;}
    if(this.active&&!previousActive)this.bindMaterials();
    if(!this.active&&previousActive)for(const [mesh,base] of this.owned)mesh.material=base;
    return this.active||previousActive;
  }
  reset(){
    for(const [mesh,base] of this.owned)mesh.material=base;
    this.offset.fill(0);this.velocity.fill(0);this.floor.fill(0);this.history.clear();
    this.guard.fill(0);this.guardFloor.fill(0);this.guardVelocity.fill(0);
    this.active=false;this.uniforms.softActive.value=false;this.frameVersion=-1;
  }
  dispose(){
    this.reset();
    for(const [mesh,base,mat] of this.owned){mesh.material=base;mat.dispose();}
    this.owned.length=0;this.texture.dispose();
  }
}
