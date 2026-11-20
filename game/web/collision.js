// Spatial cells reference triangles in the already-loaded city mesh. Hidden
// floors keep their physical surfaces without duplicating positions or indices.
export class CityCollision {
  constructor(buffer,meshes) {
    const header=new DataView(buffer);
    if(header.getUint32(0,false)!==0x434f4c32||header.getUint32(4,true)!==2)throw Error('碰撞区块格式无效');
    this.cell=new Float32Array(buffer,8,3);
    this.origin=new Int32Array(buffer,20,3);
    this.size=new Uint32Array(buffer,32,3);
    const count=header.getUint32(44,true),refs=header.getUint32(48,true);
    let offset=52,first=0;
    this.parts=[];
    for(let i=0;i<count;i++,offset+=8){
      const n=header.getUint32(offset,true),flags=header.getUint32(offset+4,true),g=meshes[i]?.geometry;
      if(!g?.index || g.index.count!==3*n || g.attributes.position.isInterleavedBufferAttribute)throw Error('地形与碰撞索引不匹配');
      this.parts.push({first,flags,vertices:g.attributes.position.array,index:g.index.array});
      first+=n;
    }
    this.slots=new Uint16Array(first);
    for(let i=1;i<count;i++)this.slots.fill(i,this.parts[i].first,this.parts[i+1]?.first??first);
    const [nx,ny,nz]=this.size;
    this.offsets=new Uint32Array(buffer,offset,nx*ny*nz+1);offset+=this.offsets.byteLength;
    this.refs=new Uint32Array(buffer,offset,refs);
    if(offset+this.refs.byteLength!==buffer.byteLength)throw Error('碰撞区块长度无效');
  }

  query(x,y,z,dx,dy,dz,far,walk) {
    const x2=x+dx*far,y2=y+dy*far,z2=z+dz*far;
    const [nx,ny,nz]=this.size,[cx,cy,cz]=this.cell,[ox,oy,oz]=this.origin;
    const x0=Math.max(0,Math.floor(Math.min(x,x2)/cx)-ox),x1=Math.min(nx-1,Math.floor(Math.max(x,x2)/cx)-ox);
    const y0=Math.max(0,Math.floor(Math.min(y,y2)/cy)-oy),y1=Math.min(ny-1,Math.floor(Math.max(y,y2)/cy)-oy);
    const z0=Math.max(0,Math.floor(Math.min(z,z2)/cz)-oz),z1=Math.min(nz-1,Math.floor(Math.max(z,z2)/cz)-oz);
    let closest=Infinity;
    for(let iz=z0;iz<=z1;iz++)for(let iy=y0;iy<=y1;iy++)for(let ix=x0;ix<=x1;ix++){
      const cell=(iz*ny+iy)*nx+ix;
      for(let r=this.offsets[cell];r<this.offsets[cell+1];r++){
        const id=this.refs[r],part=this.parts[this.slots[id]];
        if(Boolean(part.flags&1)!==walk)continue;
        const t=(id-part.first)*3,index=part.index,p=part.vertices,a=3*index[t],b=3*index[t+1],c=3*index[t+2];
        const ax=p[a],ay=p[a+1],az=p[a+2],bx=p[b],by=p[b+1],bz=p[b+2],cx=p[c],cy=p[c+1],cz=p[c+2];
        if(dy===0&&(y<Math.min(ay,by,cy)||y>Math.max(ay,by,cy)))continue;
        if(walk&&(x<Math.min(ax,bx,cx)||x>Math.max(ax,bx,cx)||z<Math.min(az,bz,cz)||z>Math.max(az,bz,cz)))continue;
        const ex=bx-ax,ey=by-ay,ez=bz-az,fx=cx-ax,fy=cy-ay,fz=cz-az;
        const px=dy*fz-dz*fy,py=dz*fx-dx*fz,pz=dx*fy-dy*fx,det=ex*px+ey*py+ez*pz;
        if(Math.abs(det)<1e-10||(!(part.flags&2)&&det<=0))continue;
        const sx=x-ax,sy=y-ay,sz=z-az,u=(sx*px+sy*py+sz*pz)/det;
        if(u<0||u>1)continue;
        const qx=sy*ez-sz*ey,qy=sz*ex-sx*ez,qz=sx*ey-sy*ex,v=(dx*qx+dy*qy+dz*qz)/det;
        if(v<0||u+v>1)continue;
        const hit=(fx*qx+fy*qy+fz*qz)/det;
        if(hit>=0&&hit<=far){if(!walk)return hit;closest=Math.min(closest,hit);}
      }
    }
    return closest;
  }
}
