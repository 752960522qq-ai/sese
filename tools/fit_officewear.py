"""Fit skirt weights and map the original sheer knit onto the corrective leg surface."""
import json
import struct
import numpy as np
from scipy.spatial import cKDTree

WIDTH = {'SCALAR':1, 'VEC2':2, 'VEC3':3, 'VEC4':4}
DTYPE = {5120:'i1', 5121:'u1', 5122:'<i2', 5123:'<u2', 5125:'<u4', 5126:'<f4'}

def values(doc, buffers, index):
    a = doc['accessors'][index]
    v = doc['bufferViews'][a['bufferView']]
    t = np.dtype(DTYPE[a['componentType']])
    n = WIDTH[a['type']]
    return np.ndarray((a['count'],n),t,buffers[v['buffer']],v.get('byteOffset',0)+a.get('byteOffset',0),
                      (v.get('byteStride',n*t.itemsize),t.itemsize))

def garment(archive, name):
    raw = archive.read(name)
    size = struct.unpack_from('<I',raw,12)[0]
    return json.loads(raw[20:20+size]), [memoryview(raw)[28+size:]]

def smooth(low, high, val):
    t=np.clip((val-low)/(high-low),0,1)
    return t*t*(3-2*t)

def add_attribute(doc, binary, data, kind, component):
    data=np.ascontiguousarray(data,dtype=DTYPE[component])
    binary.extend(bytes((-len(binary))%4))
    offset=len(binary)
    binary.extend(data.tobytes())
    view=len(doc['bufferViews'])
    doc['bufferViews'].append(dict(buffer=len(doc['buffers'])-1,byteOffset=offset,byteLength=data.nbytes,target=34962))
    doc['accessors'].append(dict(bufferView=view,count=len(data),componentType=component,type=kind))
    return len(doc['accessors'])-1

class OfficeFit:
    def __init__(self, doc, folder, archive, manifest):
        self.doc=doc
        self.body=[(folder/b['uri']).read_bytes() for b in doc['buffers']]
        self.legs=next(m['primitives'] for m in doc['meshes'] if m['name']=='Original_Legs_CleanKnee')
        self.body_joints=[doc['nodes'][j]['name'] for j in doc['skins'][0]['joints']]
        stock,buf=garment(archive,next(i['asset'] for i in manifest['items'] if i['key']=='stockings'))
        self.samples={}
        for m in stock['meshes']:
            name=m['name']
            p=m['primitives'][0]['attributes']
            positions=values(stock,buf,p['POSITION']).copy()
            self.samples[name]=(positions,values(stock,buf,p['TEXCOORD_0']).copy())
        self.band={}
        for side in ('Left','Right'):
            m=next(m for m in stock['meshes'] if m['name']=='Stocking_Upper_'+side)
            band=values(stock,buf,m['primitives'][1]['attributes']['POSITION'])
            # The top edge varies around the thigh; sample it in the same polar frame as the ankle.
            pos,_=self.samples[m['name']]
            high=pos[pos[:,1]>.77]
            center=(high.min(0)+high.max(0))*.5
            theta=np.arctan2(band[:,2]-center[2],band[:,0]-center[0])
            angles=np.linspace(-np.pi,np.pi,64,endpoint=False)
            bounds=[]
            for ang in angles:
                diff=np.abs(np.angle(np.exp(1j*(theta-ang))))
                ys=band[diff<.115,1]
                if len(ys)<2:ys=band[np.argsort(diff)[:12],1]
                bounds.append([ys.min(),ys.max()])
            self.band[side]=(center,angles,np.array(bounds))
        self.leg_ids={side:[self.body_joints.index('mixamorig:'+side+part) for part in ('UpLeg','Leg')]
                      for side in ('Left','Right')}
        # The upper hip in this rig is driven mostly by the thigh. Sample the
        # actual graft, transition rings and pelvis, including spine and hip weights.
        donors=[]
        for mesh in doc['meshes']:
            for prim in mesh['primitives']:
                if doc['materials'][prim['material']]['name'] not in ('WholeLegs_Rebound_Skin_Matched','Body_Skin_4K'):
                    continue
                attr=prim['attributes']
                xyz=values(doc,self.body,attr['POSITION'])
                keep=(xyz[:,1]>.52)&(xyz[:,1]<1.20)&(np.abs(xyz[:,0])<.235)
                if keep.any():
                    donors.append(tuple(values(doc,self.body,attr[key])[keep] for key in ('POSITION','JOINTS_0','WEIGHTS_0')))
        pos,joints,weights=map(np.concatenate,zip(*donors))
        self.donor={}
        for side,sign in [('Left',1),('Right',-1)]:
            keep=sign*pos[:,0]>=0
            self.donor[side]=(cKDTree(pos[keep]),joints[keep],weights[keep])

    def retain_thighs(self, mask, manifest):
        bit=next(i['bit'] for i in manifest['items'] if i['key']=='skirt')
        for row in manifest['bodyMasks']:
            p=self.doc['meshes'][row['mesh']]['primitives'][row['primitive']]
            a=p['attributes']
            joints=values(self.doc,self.body,a['JOINTS_0'])
            weights=values(self.doc,self.body,a['WEIGHTS_0'])
            leg=np.sum(weights*np.isin(joints,self.leg_ids['Left']+self.leg_ids['Right']),axis=1)
            face=values(self.doc,self.body,p['indices']).reshape(-1,3)
            # Includes the separate upper-thigh transition primitives, right up to the pelvis seam.
            is_leg=p in self.legs or self.doc['materials'][p['material']]['name']=='WholeLegs_Rebound_Skin_Matched'
            keep=np.ones(len(face),dtype=bool) if is_leg else np.max(leg[face],axis=1)>.05
            mask[row['at']:row['at']+row['triangles']][keep]&=255^bit

    def knit_coords(self, pos, side, raised=False):
        names=['Stocking_Heel_'+side] if raised else ['Stocking_Flat_'+side,'Stocking_Upper_'+side]
        xyz,uv=zip(*(self.samples[n] for n in names))
        _,i=cKDTree(np.concatenate(xyz)).query(pos)
        center,angles,edge=self.band[side]
        a=np.arctan2(pos[:,2]-center[2],pos[:,0]-center[0])
        low=np.interp(a,angles,edge[:,0],period=2*np.pi)
        high=np.interp(a,angles,edge[:,1],period=2*np.pi)
        return np.column_stack((np.concatenate(uv)[i],high-pos[:,1],pos[:,1]-low))

    def add_leg_knit(self, binary):
        for p in self.legs:
            a=p['attributes'];pos=values(self.doc,self.body,a['POSITION'])
            side='Left' if np.mean(pos[:,0])>0 else 'Right'
            a['_HOSIERY']=add_attribute(self.doc,binary,self.knit_coords(pos,side),'VEC4',5126)

    def skirt_weights(self, pos, names):
        # Cloth between the thighs bridges both legs. Each outer panel follows
        # the same bones and hip transition as the skin immediately beneath it.
        to_garment=np.array([names.index(n) if n in names else -1 for n in self.body_joints])
        width=.024+.024*smooth(.8,1.05,pos[:,1])
        left=smooth(-width,width,pos[:,0])
        out=np.zeros((len(pos),len(names)),np.float64)
        rows=np.arange(len(pos))[:,None,None]
        for side,share,sign in [('Left',left,1),('Right',1-left,-1)]:
            tree,joints,weights=self.donor[side]
            sample=pos.copy()
            sample[:,0]=np.abs(pos[:,0])*sign
            dist,idx=tree.query(sample,k=8)
            mix=1/np.maximum(.002,dist)**2
            mix*=share[:,None]/mix.sum(axis=1)[:,None]
            joint=to_garment[joints[idx]]
            influence=weights[idx]*mix[:,:,None]
            if np.any((joint<0)&(influence>1.e-7)):
                raise ValueError('裙子权重引用了服装骨架以外的关节')
            np.add.at(out,(rows,joint),influence)
        ids=np.argsort(-out,axis=1,kind='stable')[:,:4]
        weights=np.take_along_axis(out,ids,axis=1)
        return ids,weights/weights.sum(axis=1)[:,None]
