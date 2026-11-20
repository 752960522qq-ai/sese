import * as T from './vendor/three.module.min.js';
import { GLTFLoader } from './vendor/loaders/GLTFLoader.js';

const names=['主岛西南','主岛南部西段','主岛南部东段','主岛东南','主岛西北','主岛北部西段','主岛北部东段','主岛东北',
  '西岛西南','西岛东南','西岛西北','西岛东北','东岛西南','东岛东南','东岛西北','东岛东北','公共桥梁'];
const sky=0xc3d6df;
const distance=(bounds,x,z)=>Math.hypot(Math.max(bounds[0][0]-x,0,x-bounds[1][0]),Math.max(bounds[0][2]-z,0,z-bounds[1][2]));

function dispose(group){
  const materials=new Set(),textures=new Set();
  group.removeFromParent();
  group.traverse(m=>{
    if(!m.isMesh)return;
    m.geometry.dispose();
    for(const material of [].concat(m.material))materials.add(material);
  });
  for(const material of materials){
    for(const value of Object.values(material))if(value?.isTexture)textures.add(value);
    material.dispose();
  }
  for(const texture of textures)texture.dispose();
}

export class CityBackdrop {
  constructor(stage){
    this.stage=stage;this.loader=new GLTFLoader();this.id='';this.group=null;this.revision=0;
    this.roomColor=stage.scene.background;this.roomFog=stage.scene.fog;
    this.cityColor=new T.Color(sky);this.cityFog=new T.Fog(sky,63,138);
  }
  read(){
    return this.request??=fetch('./city/index.json').then(r=>{
      if(!r.ok)throw Error('城市资源读取失败');
      return r.json();
    }).then(index=>{
      const places=new Map();
      for(const [i,row] of (index.landmarks||[]).entries()){
        const id=row.marker||'landmark-'+i;
        places.set(id,{...row,level:row.district===7&&row.position[1]>90?23:0});
      }
      for(const [id,pts] of Object.entries(index.roadSamples)){
        if(pts.length)places.set('district-'+id,{name:names[Number(id)-1],position:pts[Math.floor(pts.length/2)],level:0});
      }
      return {index,places};
    }).catch(error=>{this.request=null;throw error;});
  }
  async place(id){
    const token=++this.revision;
    if(id===this.id)return;
    let next=null;
    if(id){
      const {index,places}=await this.read(),place=places.get(id);
      if(!place)throw Error('找不到排练地点');
      const [x,y,z]=place.position;
      const tiles=index.tiles.map(t=>[distance(t.bounds,x,z),t]).filter(([r])=>r<100)
        .sort((a,b)=>a[0]-b[0]).slice(0,18);
      next=new T.Group();
      try{
        for(const [,tile] of tiles){
          if(token!==this.revision)break;
          const {scene}=await this.loader.loadAsync('./city/'+tile.file);
          next.add(scene);
          scene.traverse(m=>{
            if(!m.isMesh)return;
            const {hotelLevel,hotelShell}=m.userData;
            if(hotelLevel)m.visible=place.level?hotelLevel===place.level:hotelLevel===1;
            if(place.level&&hotelShell){
              const range=hotelShell.find(([level])=>level===place.level);
              m.visible=!!range;
              if(range)m.geometry.setDrawRange(range[1],range[2]);
            }
          });
        }
        if(token!==this.revision){dispose(next);return;}
        next.updateMatrixWorld(true);
        const ray=new T.Raycaster(new T.Vector3(x,y+.45,z),new T.Vector3(0,-1,0),0,1.6),floors=[];
        next.traverse(m=>{if(m.isMesh&&m.visible&&m.userData.surface==='walk')floors.push(m);});
        const ground=ray.intersectObjects(floors,false)[0]?.point.y??y;
        next.position.set(-x,-ground,-z);
      }catch(error){dispose(next);throw error;}
    }
    if(this.group)dispose(this.group);
    this.id=id;this.group=next;
    if(next)this.stage.scene.add(next);
    this.stage.floor.visible=this.stage.grid.visible=!next;
    this.stage.scene.background=next?this.cityColor:this.roomColor;
    this.stage.scene.fog=next?this.cityFog:this.roomFog;
    this.stage.dirty=true;
  }
}
