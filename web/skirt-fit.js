import * as T from './vendor/three.module.min.js';

const levels=45, sides=32, columns=9;
const normals=new Float32Array(sides*2);
for(let n=0;n<sides;n++){
  const angle=2*Math.PI*n/sides;
  normals[2*n]=Math.cos(angle);
  normals[2*n+1]=Math.sin(angle);
}

// A skin-weighted centroid is linear in the joint transforms. Precompute the
// four mean points that define the skirt's frame without skinning every panel.
function centroid(geometry,ids,keep,boneCount){
  const pos=geometry.attributes.position, joints=geometry.attributes.skinIndex, weights=geometry.attributes.skinWeight;
  const moments=new Float64Array(boneCount*4);
  let count=0;
  for(const i of ids){
    const x=pos.getX(i),y=pos.getY(i),z=pos.getZ(i);
    if(!keep(x,y))continue;
    count++;
    for(let k=0;k<4;k++){
      const j=4*joints.getComponent(i,k),w=weights.getComponent(i,k);
      moments[j]+=x*w;moments[j+1]+=y*w;moments[j+2]+=z*w;moments[j+3]+=w;
    }
  }
  const points=[];
  for(let j=0;j<boneCount;j++){
    const offset=j*4;
    if(moments[offset+3]>0)points.push([j,...moments.slice(offset,offset+4).map(v=>v/count)]);
  }
  return points;
}

function moveCentroid(points,palette,out){
  out.set(0,0,0);
  for(const [j,x,y,z,w] of points){
    const m=palette[j].elements;
    out.x+=m[0]*x+m[4]*y+m[8]*z+m[12]*w;
    out.y+=m[1]*x+m[5]*y+m[9]*z+m[13]*w;
    out.z+=m[2]*x+m[6]*y+m[10]*z+m[14]*w;
  }
}

function makeSamples(mesh,ids){
  const {position,skinWeight,skinIndex}=mesh.geometry.attributes;
  const joints=new Uint16Array(4*ids.length),weights=new Float32Array(joints.length);
  ids.forEach((i,n)=>{
    for(let k=0;k<4;k++){
      joints[4*n+k]=skinIndex.getComponent(i,k);
      weights[4*n+k]=skinWeight.getComponent(i,k);
    }
  });
  return {position,ids,joints,weights};
}

function projectSamples(group,palette,origin,side,front,up,output,offset){
  const {position,ids,joints,weights}=group;
  for(let n=0;n<ids.length;n++){
    const i=ids[n],x=position.getX(i),y=position.getY(i),z=position.getZ(i);
    let px=-origin.x,py=-origin.y,pz=-origin.z;
    for(let k=0;k<4;k++){
      const at=n*4+k,w=weights[at];
      if(!w)continue;
      const m=palette[joints[at]].elements;
      px+=w*(m[0]*x+m[4]*y+m[8]*z+m[12]);
      py+=w*(m[1]*x+m[5]*y+m[9]*z+m[13]);
      pz+=w*(m[2]*x+m[6]*y+m[10]*z+m[14]);
    }
    output[offset++]=px*side.x+py*side.y+pz*side.z;
    output[offset++]=px*front.x+py*front.y+pz*front.z;
    output[offset++]=px*up.x+py*up.y+pz*up.z;
  }
  return offset;
}

const vertexFit=`
  #include <skinning_vertex>
  if(fitEnabled){
    vec3 localPoint=transformed-fitOrigin;
    vec2 planar=vec2(dot(localPoint,fitSide),dot(localPoint,fitFront));
    float height=dot(localPoint,fitUp);
    float level=clamp((height-fitRange.x)*fitRange.y,0.,44.);
    int lower=int(floor(level)), upper=min(lower+1,44);
    float fraction=fract(level);
    vec2 center=mix(texelFetch(fitSections,ivec2(8,lower),0).xy,
                    texelFetch(fitSections,ivec2(8,upper),0).xy,fraction);
    vec2 radial=planar-center;
    float restAngle=atan(position.z-0.005,position.x);
    float twist=atan(radial.y,radial.x)-restAngle;
    float angle=restAngle+clamp(atan(sin(twist),cos(twist)),-0.28,0.28);
    vec2 ray=vec2(cos(angle),sin(angle));
    // Give the front hip panel a little extra ease against the lower abdomen.
    float hipPanel=smoothstep(.85,.90,position.y)*(1.-smoothstep(.99,1.065,position.y));
    float clearance=fitGap+.005*hipPanel*smoothstep(.04,.10,position.z);
    float radius=10.;
    for(int group=0;group<8;group++){
      vec4 planes=mix(texelFetch(fitSections,ivec2(group,lower),0),
                      texelFetch(fitSections,ivec2(group,upper),0),fraction);
      for(int k=0;k<4;k++){
        vec2 normal=fitNormals[4*group+k];
        float facing=dot(ray,normal);
        if(facing>0.00001)radius=min(radius,(planes[k]-dot(center,normal)+clearance)/facing);
      }
    }
    planar=center+ray*max(length(radial),radius);
    transformed=fitOrigin+fitSide*planar.x+fitFront*planar.y+fitUp*height;
  }`;

function clothMaterial(original,fit){
  const m=original.clone();
  m.customProgramCacheKey=()=> 'sese-skirt-sections-v1';
  m.onBeforeCompile=shader=>{
    Object.assign(shader.uniforms,fit.uniforms,{
      fitGap:{value:.010 + (original.name === 'seam' ? .0015 : original.name === 'woolEdge' ? .0008 : 0)}
    });
    shader.vertexShader=shader.vertexShader.replace('#include <common>',`
      #include <common>
      uniform vec3 fitOrigin,fitSide,fitFront,fitUp;
      uniform vec2 fitRange,fitNormals[32];
      uniform sampler2D fitSections;
      uniform float fitGap;
      uniform bool fitEnabled;`).replace('#include <skinning_vertex>',vertexFit);
  };
  return m;
}

export function attachSkirtFit(actor,rows){
  if(actor.skirtFit||!rows?.length)return;
  const skirts=[], body=[];
  actor.model.traverse(mesh=>{
    if(!mesh.isSkinnedMesh)return;
    if(mesh.userData.gameWear==='skirt')skirts.push(mesh);
    if(mesh.userData.gameBody){
      const row=rows.find(r=>r.group===mesh.userData.bodyMaskGroup && r.count===mesh.geometry.attributes.position.count);
      if(row)body.push(makeSamples(mesh,row.ids));
    }
  });
  const main=skirts.find(mesh=>mesh.material.name==='wool');
  if(!main||body.length!==rows.length)return;
  const fit=new SkirtFit(main,body,actor);
  actor.skirtFit=fit;
  const variants=new Map();
  for(const mesh of skirts){
    const original=mesh.material;
    if(!variants.has(original))variants.set(original,clothMaterial(original,fit));
    fit.parts.push([mesh,original,mesh.onBeforeRender]);
    mesh.material=variants.get(original);
    const previous=mesh.onBeforeRender;
    mesh.onBeforeRender=function(renderer,scene,camera,geometry,material,group){
      previous.call(this,renderer,scene,camera,geometry,material,group);
      fit.update(actor.revision);
    };
  }
}

class SkirtFit {
  constructor(main,body,actor){
    this.actor=actor;
    this.main=main;this.body=body;this.revision=-1;this.parts=[];
    const geo=main.geometry,ids=[...new Set(geo.index.array)].sort((a,b)=>a-b);
    const p=geo.attributes.position,occupied=new Set(),shell=[];
    for(const i of ids){
      const key=[p.getX(i),p.getY(i),p.getZ(i)].map(n=>Math.round(n/.028)).join(',');
      if(!occupied.has(key)){occupied.add(key);shell.push(i);}
    }
    this.shell=makeSamples(main,shell);
    this.shellPoints=new Float32Array(3*shell.length);
    const samples=body.reduce((sum,g)=>sum+g.ids.length,0);
    this.bodyPoints=new Float32Array(3*samples);
    this.order=Int32Array.from({length:samples},(_,i)=>3*i);
    this.byHeight=(a,b)=>this.bodyPoints[a+2]-this.bodyPoints[b+2];
    this.palette=main.skeleton.bones.map(()=>new T.Matrix4());
    this.anchors=[(x,y)=>y<.65,(x,y)=>y>1.115,x=>x>.12,x=>x<-.12]
      .map(keep=>centroid(geo,ids,keep,this.palette.length));
    this.centers=this.anchors.map(()=>new T.Vector3());
    this.side=new T.Vector3();this.front=new T.Vector3();this.up=new T.Vector3();
    this.bounds=new Float32Array(columns*4*levels);
    this.texture=new T.DataTexture(this.bounds,columns,levels,T.RGBAFormat,T.FloatType);
    this.texture.minFilter=this.texture.magFilter=T.NearestFilter;
    this.texture.generateMipmaps=false;this.texture.needsUpdate=true;
    this.range=new T.Vector2();
    this.uniforms={fitEnabled:{value:true},fitOrigin:{value:this.centers[0]},fitSide:{value:this.side},fitFront:{value:this.front},
      fitUp:{value:this.up},fitSections:{value:this.texture},fitNormals:{value:normals},fitRange:{value:this.range}};
  }

  update(revision){
    if(revision===this.revision)return;
    this.revision=revision;
    // Standard idle and facial-only clips already clear the body. Keep their
    // authored silhouette and avoid the section pass in common hotel scenes.
    const actor=this.actor;
    const neutral=actor.source.neutralOutfitClips?.has(actor.action?.getClip()) &&
      !Object.values(actor.state.offsets).some(rotation=>rotation.some(angle=>angle!==0));
    this.uniforms.fitEnabled.value=!neutral;
    if(neutral)return;
    const main=this.main,sk=main.skeleton,mats=this.palette;
    for(let i=0;i<mats.length;i++)mats[i].multiplyMatrices(main.bindMatrixInverse,sk.bones[i].matrixWorld)
      .multiply(sk.boneInverses[i]).multiply(main.bindMatrix);
    const [origin,top,right,left]=this.centers;
    this.anchors.forEach((p,i)=>moveCentroid(p,mats,this.centers[i]));
    const {side,front,up}=this;
    up.subVectors(top,origin);
    if(up.lengthSq()<1e-10)up.set(0,1,0).transformDirection(mats[0]);
    if(up.lengthSq()<1e-10)up.set(0,1,0);
    up.normalize();
    side.subVectors(right,left);
    front.crossVectors(side,up);
    if(front.lengthSq()<1e-9){
      side.set(1,0,0).transformDirection(mats[0]);
      front.crossVectors(side,up);
      if(front.lengthSq()<1e-9){
        side.set(0,0,1);
        if(Math.abs(up.z)>.9)side.set(0,1,0);
        front.crossVectors(side,up);
      }
    }
    front.normalize();side.crossVectors(up,front).normalize();
    projectSamples(this.shell,mats,origin,side,front,up,this.shellPoints,0);
    let low=Infinity,high=-Infinity;
    for(let i=2;i<this.shellPoints.length;i+=3){
      const h=this.shellPoints[i];low=Math.min(low,h);high=Math.max(high,h);
    }
    low-=.045;high+=.045;
    this.range.set(low,(levels-1)/(high-low));
    const pos=this.bodyPoints,order=this.order;
    let offset=0;
    for(const group of this.body)offset=projectSamples(group,mats,origin,side,front,up,pos,offset);
    order.sort(this.byHeight);
    const out=this.bounds;
    let begin=0,end=0;
    for(let l=0;l<levels;l++){
      const h=low+l/this.range.y,at=l*columns*4;
      while(begin<order.length && pos[order[begin]+2]<h-.027)begin++;
      while(end<order.length && pos[order[end]+2]<=h+.027)end++;
      let a=begin,b=end;
      while(b-a<24 && (a>0||b<order.length)){
        if(a>0 && (b===order.length || h-pos[order[a-1]+2]<pos[order[b]+2]-h))a--;else b++;
      }
      out.fill(-Infinity,at,at+sides);
      for(let i=a;i<b;i++){
        const n=order[i],x=pos[n],y=pos[n+1];
        for(let k=0;k<sides;k++){
          const support=x*normals[2*k]+y*normals[2*k+1];
          if(support>out[at+k])out[at+k]=support;
        }
      }
      out[at+32]=(out[at]-out[at+16])*.5;
      out[at+33]=(out[at+8]-out[at+24])*.5;
    }
    this.texture.needsUpdate=true;
  }

  dispose(){
    const materials=new Set();
    for(const [mesh,original,render] of this.parts){
      materials.add(mesh.material);mesh.material=original;mesh.onBeforeRender=render;
    }
    for(const mat of materials)mat.dispose();
    this.texture.dispose();
  }
}
