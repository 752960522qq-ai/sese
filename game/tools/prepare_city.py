"""Bake the three hero_13 v23 ZIPs into mobile streaming tiles in original glTF coordinates."""
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
    if district==18 or 'water_surface' in low: return 'water'
    if district==17 and not any(v in low for v in ('rail','pier','support','cable','parapet')): return 'walk'
    if any(v in low for v in ('sculpted_terrain','ground_','road_kit','pavement','sidewalk','entrance_walk','landscape_grade','connector','driveway','ramp','roadway','bridge_deck','terrazzo slabs','forecourt |','parking |','floor |','slab |','curb_cut','road_mark','road_','access walk','site slab','floor datum','entry landing','graded_ground','pedestrian path','entry approach')):
        return 'walk'
    return 'solid'

class District:
    def __init__(self, raw, number, out, simplify):
        jlen=struct.unpack_from('<I',raw,12)[0]
        self.doc=json.loads(raw[20:20+jlen]); self.blob=memoryview(raw)[28+jlen:]
        self.num=number;self.out=out;self.simplify=simplify
        self.bins=defaultdict(lambda:defaultdict(list))
        self.mats={};self.images={};self.faces=0;self.anchors=[]
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
                    image.thumbnail((640,640),Image.Resampling.LANCZOS)
                    image.convert('RGBA' if transparent else 'RGB').save(path,quality=84,optimize=True)
                self.images[source]='tex/'+key
            tex=self.images[source]
        self.mats[number]=(out,tex)
        return out,tex
    def node(self, idx, parent):
        doc=self.doc;n=doc['nodes'][idx];m=parent@matrix(n)
        if 'mesh' in n:
            name=n.get('name','');kind=surface(name,self.num)
            for prim in doc['meshes'][n['mesh']]['primitives']:
                if prim.get('mode',4)!=4:continue
                attrs=prim['attributes'];local=np.ascontiguousarray(accessor(doc,self.blob,attrs['POSITION']),dtype=np.float32)
                faces=accessor(doc,self.blob,prim['indices']).reshape(-1) if 'indices' in prim else np.arange(len(local))
                if not len(faces):continue
                before=len(faces)//3;self.faces+=before
                target=before
                if kind=='solid' and before>350:
                    target=max(260,min(5400,round(before*(0.26 if self.num==7 else 0.18))))
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
                    self.bins[cell][(kind,mat)].append((pos[point_ids],norm[point_ids].astype('f4'),uv[point_ids].astype('f4'),ind.reshape(-1).astype('u4')))
        for c in n.get('children',[]):self.node(c,m)
    def tile(self, cell, entries):
        blob=bytearray();v=[];a=[];mats=[];tex=[];ims=[];nodes=[];meshes=[];material_ids={};bounds=[];total=0
        def attr(arr,typ,component,box=False):
            while len(blob)%4:blob.append(0)
            data=arr.tobytes();vid=len(v)
            v.append({'buffer':0,'byteOffset':len(blob),'byteLength':len(data)});blob.extend(data)
            entry={'bufferView':vid,'componentType':component,'count':len(arr),'type':typ}
            if box:entry.update(min=arr.min(axis=0).tolist(),max=arr.max(axis=0).tolist())
            a.append(entry);return len(a)-1
        for (kind,midx),parts in entries.items():
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
            nodes.append({'mesh':len(meshes),'name':kind+str(len(meshes)),'extras':{'surface':kind}})
            meshes.append({'primitives':[primitive]})
        name=f'd{self.num:02d}_{cell[0]}_{cell[1]}'
        doc={'asset':{'version':'2.0'},'scene':0,'scenes':[{'nodes':list(range(len(nodes)))}],'nodes':nodes,'meshes':meshes,'materials':mats,'bufferViews':v,'accessors':a,'buffers':[{'byteLength':len(blob),'uri':name+'.bin'}]}
        if tex:doc.update(textures=tex,images=[{'uri':s} for s in ims])
        (self.out/(name+'.bin')).write_bytes(blob)
        (self.out/(name+'.gltf')).write_text(json.dumps(doc,separators=(',',':')))
        box=np.array(bounds)
        return {'file':name+'.gltf','district':self.num,'bounds':[np.round(box.min(0),2).tolist(),np.round(box.max(0),2).tolist()],'triangles':total}
    def bake(self):
        for root in self.doc['scenes'][self.doc.get('scene',0)]['nodes']:self.node(root,np.eye(4))
        return [self.tile(cell,batch) for cell,batch in self.bins.items()]

def main():
    args=argparse.ArgumentParser()
    args.add_argument('zips',type=Path);args.add_argument('output',type=Path);args.add_argument('meshopt',type=Path)
    p=args.parse_args();out=p.output;out.mkdir(parents=True,exist_ok=True);(out/'tex').mkdir(exist_ok=True)
    simp=Simplifier(p.meshopt);tiles=[];anchors={};sources=[]
    paths=sorted(p.zips.glob('hero13_city_v23_*.zip'))
    if len(paths)!=3:raise ValueError('需要城市 A、B、C 三个包')
    for path in paths:
        with zipfile.ZipFile(path) as z:
            for entry in z.namelist():
                if entry.startswith('credits/') and not entry.endswith('/'):
                    dest=out/entry;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(z.read(entry))
            for name in z.namelist():
                if not re.fullmatch(r'districts/\d\d_[^/]+\.glb',name):continue
                raw=z.read(name);district=int(Path(name).name[:2]);d=District(raw,district,out,simp)
                batch=d.bake();tiles.extend(batch);anchors[str(district)]=d.anchors
                total=sum(t['triangles'] for t in batch)
                sources.append({'district':district,'source':Path(name).name,'sha256':hashlib.sha256(raw).hexdigest(),'sourceTriangles':d.faces,'mobileTriangles':total})
                print(district,len(batch),d.faces,total,flush=True)
                del d,raw
    if sorted(x['district'] for x in sources)!=list(range(1,19)):raise ValueError('缺少城市区块')
    (out/'index.json').write_text(json.dumps({'version':23,'tiles':tiles,'roadSamples':anchors,'sources':sources},separators=(',',':')))
if __name__=='__main__':main()
