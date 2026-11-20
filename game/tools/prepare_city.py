"""Bake the city packages and optional v24 district replacement in their original coordinates."""
import argparse
import ctypes as ct
import hashlib
import io
import json
import math
import re
import struct
import zipfile
from collections import defaultdict
from pathlib import Path
import numpy as np
from bake_collision import bake as bake_collision
from PIL import Image
from scipy.spatial.transform import Rotation

TILE = 144
DTYPES = {5120:'i1',5121:'u1',5122:'<i2',5123:'<u2',5125:'<u4',5126:'<f4'}
WIDTH = {'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4}

def accessor(doc, blob, idx):
    a = doc['accessors'][idx]
    view = doc['bufferViews'][a['bufferView']]
    dtype = np.dtype(DTYPES[a['componentType']])
    width = WIDTH[a['type']]
    base = view.get('byteOffset',0) + a.get('byteOffset',0)
    return np.ndarray((a['count'],width),dtype,blob,base,(view.get('byteStride',width*dtype.itemsize),dtype.itemsize))

def matrix(node):
    if 'matrix' in node:
        return np.array(node['matrix']).reshape((4,4),order='F')
    mat = np.eye(4)
    mat[:3,:3] = Rotation.from_quat(node.get('rotation',[0,0,0,1])).as_matrix() @ np.diag(node.get('scale',[1,1,1]))
    mat[:3,3] = node.get('translation',[0,0,0])
    return mat

class Simplifier:
    def __init__(self, path):
        lib = ct.CDLL(str(path.resolve()))
        ptr, sz = ct.c_void_p, ct.c_size_t
        self.exact, self.sloppy = lib.meshopt_simplify, lib.meshopt_simplifySloppy
        common = [ptr,ptr,sz,ptr,sz,sz,sz,ct.c_float]
        self.exact.argtypes, self.sloppy.argtypes = common+[ct.c_uint,ptr], common+[ptr]
        self.exact.restype = self.sloppy.restype = sz

    def run(self, inds, pos, target):
        inds = np.ascontiguousarray(inds.reshape(-1),dtype=np.uint32)
        if len(inds) <= target*3: return inds.reshape(-1,3)
        out = np.empty_like(inds)
        args = (out.ctypes.data,inds.ctypes.data,len(inds),pos.ctypes.data,len(pos),12,target*3)
        n = self.exact(*args,0.012,0,None)
        if n > target*6:
            proxy = np.empty_like(out)
            count = self.sloppy(proxy.ctypes.data,*args[1:],0.008,None)
            if count >= 36 and count<n:
                return proxy[:count].reshape(-1,3)
        return out[:n].reshape(-1,3)

def surface(name, district):
    low=name.lower()
    if district==6:
        if low.startswith(('lt • flooring |','lanting_site_low_coastal_platform','lanting_site_arrival_courtyard',
                           'lanting_site_main_stone_avenue','lanting_site_quiet_service_access',
                           'lanting_site_walk_at_coastal_road','lanting_pavement_and_promenade')):
            return 'walk'
        if low.startswith('lt • terrace |') and ('teak' in low or 'floor' in low or 'basalt' in low):
            return 'walk'
    if district==18 or 'water_surface' in low: return 'water'
    if district==7:
        if low.startswith(('d07_hotel24_', 'hotel parcel |', 'hotel arrival |', 'optional | street apron subbase', 'pedestrian crossing |', 'dropoff | granite setts')): return 'walk'
        if low.startswith('ps23_') and ('floor' in low or '_rug' in low): return 'walk'
        if any(label in low for label in ('structural slab with purpose-made', 'stone structural tread',
                'solid warm timber tread', 'stair | landing oak', 'stair | threshold plate',
                'stair | transverse turning landing', 'hot-dip galvanized grate', 'slab joint',
                'cut stone finished floor', 'step-free apron')): return 'walk'
    if district==17 and not any(v in low for v in ('rail','pier','support','cable','parapet')): return 'walk'
    if any(v in low for v in ('sculpted_terrain','ground_','road_kit','pavement','sidewalk','entrance_walk','landscape_grade','connector','driveway','ramp','roadway','bridge_deck','terrazzo slabs','forecourt |','parking |','floor |','slab |','curb_cut','road_mark','road_','access walk','site slab','floor datum','entry landing','graded_ground','pedestrian path','entry approach')):
        return 'walk'
    return 'solid'

HOTEL_LEVELS={'01_LOBBY_AND_DINING':1,'02_EVENTS_AND_MEETINGS':2,'03_CLUB_AND_WELLNESS':3,
              '04_to_22_TOWER_AND_TERRACES':4,'23_PRESIDENTIAL_LEVEL':23}

def hotel_level(name, parent):
    if name in HOTEL_LEVELS:return HOTEL_LEVELS[name]
    # Exterior shell, slabs, soffits and the roof must remain visible from the street.
    if parent>0 and (name.startswith(('H01_Canopy','H23_99_LiftOff_Roof','H04_','H23_01_Penthouse_Structure'))
                     or '_Plate_and_Soffit' in name or name.startswith(('H01_Envelope','H02_Envelope','H03_Envelope','H23_Envelope'))):
        return -parent
    return parent

def material_batches(entries):
    # Keep the exterior in one draw per material from the street, with contiguous
    # index ranges so interior views can still select neighbouring structural slabs.
    shells=defaultdict(dict)
    for (kind,material,level),parts in entries.items():
        if level<0:shells[kind,material][-level]=parts
        else:yield kind,material,parts,({'hotelLevel':level} if level else {})
    for (kind,material),floors in shells.items():
        parts=[];ranges=[];offset=0
        for level,batch in sorted(floors.items()):
            count=sum(len(part[3]) for part in batch)
            ranges.append([level,offset,count]);offset+=count
            parts.extend(batch)
        yield kind,material,parts,{'hotelShell':ranges}

class District:
    def __init__(self, raw, number, out, simplify):
        jlen=struct.unpack_from('<I',raw,12)[0]
        self.doc=json.loads(raw[20:20+jlen]); self.blob=memoryview(raw)[28+jlen:]
        self.num=number;self.out=out;self.simplify=simplify
        self.bins=defaultdict(lambda:defaultdict(list))
        self.mats={};self.images={};self.faces=0;self.anchors=[];self.landmarks=[]
    def material(self, number):
        if number in self.mats:return self.mats[number]
        src=self.doc.get('materials',[])[number] if number>=0 else {}
        p=src.get('pbrMetallicRoughness',{})
        out={'name':src.get('name','Stone'),'pbrMetallicRoughness':{'roughnessFactor':max(0.38,p.get('roughnessFactor',1)),'metallicFactor':min(0.45,p.get('metallicFactor',0)),'baseColorFactor':p.get('baseColorFactor',[1,1,1,1])},'doubleSided':src.get('doubleSided',False)}
        for k in ('alphaMode','alphaCutoff','emissiveFactor'):
            if k in src:out[k]=src[k]
        tex=None
        if 'baseColorTexture' in p:
            source=self.doc['textures'][p['baseColorTexture']['index']]['source']
            if source not in self.images:
                im=self.doc['images'][source];buf=self.doc['bufferViews'][im['bufferView']]
                start=buf.get('byteOffset',0);data=self.blob[start:start+buf['byteLength']]
                image=Image.open(io.BytesIO(data))
                # Keep the source transparency on vegetation, decals and glass.
                transparent='A' in image.mode and image.getextrema()[-1][0] < 245
                fmt='png' if transparent else 'jpg'
                key=hashlib.sha256(data).hexdigest()[:24]+'.'+fmt
                path=self.out/'tex'/key
                if not path.exists():
                    image.thumbnail((1024,1024),Image.Resampling.LANCZOS)
                    image.convert('RGBA' if transparent else 'RGB').save(path,quality=84,optimize=True)
                self.images[source]='tex/'+key
            tex=self.images[source]
        self.mats[number]=(out,tex)
        return out,tex
    def node(self, idx, parent, level=0):
        doc=self.doc;n=doc['nodes'][idx];m=parent@matrix(n)
        name=n.get('name','')
        if self.num==7:
            level=hotel_level(name,level)
        if self.num==6 and name in LANTING_MARKERS:
            self.landmarks.append({'name':LANTING_MARKERS[name],'district':6,
                                   'position':np.round(m[:3,3],4).tolist(),'marker':name})
        if 'mesh' in n:
            kind=surface(name,self.num)
            for prim in doc['meshes'][n['mesh']]['primitives']:
                if prim.get('mode',4)!=4:continue
                attrs=prim['attributes'];local=np.ascontiguousarray(accessor(doc,self.blob,attrs['POSITION']),dtype=np.float32)
                faces=accessor(doc,self.blob,prim['indices']).reshape(-1) if 'indices' in prim else np.arange(len(local))
                if not len(faces):continue
                before=len(faces)//3;self.faces+=before
                target=before
                if kind=='solid' and before>350:
                    target=max(260,min(5400,round(before*(0.26 if self.num==7 else 0.18))))
                if self.num==6 and name.startswith(('LT •','Lanting_')) and before>350:
                    target=max(target,min(before,max(6000,round(before*.60))))
                elif kind=='walk' and before>15000: target=max(4500,round(before*.53))
                tri=self.simplify.run(faces,local,target).astype(np.int64,copy=False)
                if not len(tri):continue
                pos=(local @ m[:3,:3].T+m[:3,3]).astype('f4')
                if np.linalg.det(m[:3,:3])<0:tri=tri[:,[0,2,1]]
                if 'NORMAL' in attrs:
                    norm=accessor(doc,self.blob,attrs['NORMAL'])@np.linalg.pinv(m[:3,:3])
                    norm/=np.maximum(1e-9,np.linalg.norm(norm,axis=1,keepdims=True))
                else:
                    norm=np.zeros_like(pos);norm[:,1]=1
                uv=accessor(doc,self.blob,attrs['TEXCOORD_0']) if 'TEXCOORD_0' in attrs else np.zeros((len(pos),2),'f4')
                mat=prim.get('material',-1)
                self.material(mat)
                centers=pos[tri].mean(axis=1)
                if kind=='walk' and ('road_kit' in name.lower() or self.num==17) and len(centers):
                    self.anchors.append(centers[len(centers)//2].tolist())
                coords=np.floor(centers[:,[0,2]]/TILE).astype(int)
                codes=(coords[:,0]+1000)*10000+coords[:,1]+1000
                for code in np.unique(codes):
                    use=tri[codes==code]
                    point_ids,ind=np.unique(use,return_inverse=True)
                    cell=(int(code//10000)-1000,int(code%10000)-1000)
                    self.bins[cell][(kind,mat,level)].append((pos[point_ids],norm[point_ids].astype('f4'),uv[point_ids].astype('f4'),ind.reshape(-1).astype('u4')))
        for c in n.get('children',[]):self.node(c,m,level)
    def tile(self, cell, entries):
        blob=bytearray();v=[];a=[];mats=[];tex=[];ims=[];nodes=[];meshes=[];material_ids={};bounds=[];total=0
        def attr(arr,typ,component,box=False):
            while len(blob)%4:blob.append(0)
            data=arr.tobytes();vid=len(v)
            v.append({'buffer':0,'byteOffset':len(blob),'byteLength':len(data)});blob.extend(data)
            entry={'bufferView':vid,'componentType':component,'count':len(arr),'type':typ}
            if box:entry.update(min=arr.min(axis=0).tolist(),max=arr.max(axis=0).tolist())
            a.append(entry);return len(a)-1
        collision_parts=[]
        for kind,midx,parts,hotel in material_batches(entries):
            p,n,uv,ii=zip(*parts);p=np.concatenate(p).astype('<f4');n=np.concatenate(n).astype('<f4');uv=np.concatenate(uv).astype('<f4')
            offsets=np.cumsum([0]+[len(x[0]) for x in parts[:-1]])
            idx=np.concatenate([indices+offset for indices,offset in zip(ii,offsets)])
            short=len(p)<65536;idx=idx.astype('<u2' if short else '<u4');total+=len(idx)//3
            bounds.extend([p.min(0),p.max(0)])
            if midx not in material_ids:
                material,uri=self.mats[midx];material=json.loads(json.dumps(material))
                if uri:
                    if uri not in ims:ims.append(uri);tex.append({'source':len(ims)-1})
                    material['pbrMetallicRoughness']['baseColorTexture']={'index':ims.index(uri)}
                material_ids[midx]=len(mats);mats.append(material)
            primitive={'attributes':{'POSITION':attr(p,'VEC3',5126,True),'NORMAL':attr(n,'VEC3',5126)},'indices':attr(idx,'SCALAR',5123 if short else 5125),'material':material_ids[midx]}
            if self.mats[midx][1]:primitive['attributes']['TEXCOORD_0']=attr(uv,'VEC2',5126)
            extra={'surface':kind,**hotel}
            nodes.append({'mesh':len(meshes),'name':kind+str(len(meshes)),'extras':extra})
            if self.num==7 and (1<=cell[0]<=2 and -6<=cell[1]<=-5) and kind in ('walk','solid'):
                flag=(1 if kind=='walk' else 0) | (2 if mats[material_ids[midx]].get('doubleSided') else 0)
                extra['collisionSlot']=len(collision_parts)
                collision_parts.append((p[idx.reshape(-1,3)],flag))
            meshes.append({'primitives':[primitive]})
        name=f'd{self.num:02d}_{cell[0]}_{cell[1]}'
        doc={'asset':{'version':'2.0'},'scene':0,'scenes':[{'nodes':list(range(len(nodes)))}],'nodes':nodes,'meshes':meshes,'materials':mats,'bufferViews':v,'accessors':a,'buffers':[{'byteLength':len(blob),'uri':name+'.bin'}]}
        if tex:doc.update(textures=tex,images=[{'uri':s} for s in ims])
        (self.out/(name+'.bin')).write_bytes(blob)
        (self.out/(name+'.gltf')).write_text(json.dumps(doc,separators=(',',':')))
        box=np.array(bounds)
        collision=bake_collision(self.out,name,collision_parts)
        return {**({'collision':collision} if collision else {}),'file':name+'.gltf','district':self.num,'bounds':[np.round(box.min(0),2).tolist(),np.round(box.max(0),2).tolist()],'triangles':total}
    def bake(self):
        for root in self.doc['scenes'][self.doc.get('scene',0)]['nodes']:self.node(root,np.eye(4))
        return [self.tile(cell,batch) for cell,batch in self.bins.items()]

LANTING_MARKERS={'LT_ENTRY_PUBLIC':'澜庭海景餐厅 · 正门','LT_GALLERY':'澜庭海景餐厅 · 大厅',
                 'LT_VIP_DOOR':'澜庭海景餐厅 · 包厢门口','LT_TERRACE_VIEW':'澜庭海景餐厅 · 露台'}

def city_inputs(folder, overlay):
    full=folder/'hero13_city_v26_manifest.json'
    expected={};replacement=None
    if full.exists():
        manifest=json.loads(full.read_bytes())
        if manifest['revision']!='v26':raise ValueError('城市基础清单版本不匹配')
        version=26
        expected={d['id']:dict(d) for d in manifest['districts']}
        paths=[folder/p['name'] for p in manifest['packs']]
        for path,pack in zip(paths,manifest['packs']):
            with path.open('rb') as stream:
                if hashlib.file_digest(stream,'sha256').hexdigest()!=pack['sha256']:
                    raise ValueError('城市分包校验不符 '+path.name)
    else:
        version=23
        paths=sorted(folder.glob('hero13_city_v23_*.zip'))
    if len(paths)!=3:raise ValueError('需要城市 A、B、C 三个完整分包')
    if overlay:
        with zipfile.ZipFile(overlay) as patch:
            if version==26:
                data=json.loads(patch.read('LanTing_D06_manifest.json'))
                row=data['archive_district']
                if data['replace_only_district']!=6 or row['v26_district_sha256']!=expected[6]['sha256']:
                    raise ValueError('澜庭补丁与基础第六区不匹配')
                replacement=6;version=27
                expected[6]={**row,'file':Path(row['file']).name}
            else:
                data=json.loads(patch.read('hero13_city_v24_full_manifest.json'))
                if data['changed_district_ids']!=[7]:raise ValueError('酒店补丁无效')
                expected={r['id']:r for r in data['districts']}
                replacement=7;version=24
        paths.append(overlay)
    if expected and sorted(expected)!=list(range(1,19)):raise ValueError('城市区块清单不完整')
    return paths,version,expected,replacement

def main():
    args=argparse.ArgumentParser()
    args.add_argument('zips',type=Path);args.add_argument('output',type=Path);args.add_argument('meshopt',type=Path)
    args.add_argument('--district-update',type=Path,help='Official v24 hotel or v27 LanTing overlay, for its matching base')
    p=args.parse_args();out=p.output
    out.mkdir(parents=True,exist_ok=True);(out/'tex').mkdir(exist_ok=True)
    simp=Simplifier(p.meshopt);tiles=[];anchors={};sources=[]
    paths,version,expected,replacement=city_inputs(p.zips,p.district_update)
    districts={};landmarks=[]
    for path in paths:
        with zipfile.ZipFile(path) as z:
            for entry in z.namelist():
                if entry.startswith('credits/') and not entry.endswith('/') and '..' not in Path(entry).parts:
                    dest=out/entry;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(z.read(entry))
                if not re.fullmatch(r'districts/\d\d_[^/]+\.glb',entry):continue
                district=int(Path(entry).name[:2])
                if path==p.district_update:
                    if district!=replacement or district not in districts:raise ValueError('替换区块编号不匹配')
                elif district in districts:raise ValueError('重复基础区块')
                districts[district]=(path,entry)
    if sorted(districts)!=list(range(1,19)):raise ValueError('缺少城市区块')
    for district,(path,entry) in sorted(districts.items()):
        with zipfile.ZipFile(path) as z: raw=z.read(entry)
        sha=hashlib.sha256(raw).hexdigest()
        if expected and (expected[district]['file']!=Path(entry).name or expected[district]['sha256']!=sha):
            raise ValueError('区块源文件与正式清单不一致 '+str(district))
        d=District(raw,district,out,simp);batch=d.bake()
        tiles.extend(batch);anchors[str(district)]=d.anchors;landmarks.extend(d.landmarks)
        total=sum(t['triangles'] for t in batch)
        sources.append({'district':district,'source':Path(entry).name,'sha256':sha,'sourceTriangles':d.faces,'mobileTriangles':total})
        print(district,len(batch),d.faces,total,flush=True)
        del d,raw
    index={'version':version,'tiles':tiles,'roadSamples':anchors,'sources':sources}
    if version>=24:
        index['landmarks']=[
            {'name':'云庭酒店 · 正门','district':7,'position':[264,16.78,-691.2]},
            {'name':'云庭酒店 · 总统套房','district':7,'position':[266,102.66,-711.0]}
        ]+landmarks
    if version==27 and {m['marker'] for m in landmarks}!=set(LANTING_MARKERS):
        raise ValueError('第六区缺少餐厅地标')
    (out/'index.json').write_text(json.dumps(index,ensure_ascii=False,separators=(',',':')))
if __name__=='__main__':main()
