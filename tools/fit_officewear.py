"""Fit skirt weights and map the original sheer knit onto the corrective leg surface."""
import json
import struct
import numpy as np
from scipy.spatial import cKDTree

WIDTH = {'SCALAR':1, 'VEC2':2, 'VEC3':3, 'VEC4':4}
DTYPE = {5120:'i1', 5121:'u1', 5122:'<i2', 5123:'<u2', 5125:'<u4', 5126:'<f4'}

def values(doc, buffers, index):
    a = doc['accessors'][index]
    dtype = np.dtype(DTYPE[a['componentType']])
    width = WIDTH[a['type']]
    if 'bufferView' in a:
        v = doc['bufferViews'][a['bufferView']]
        data = np.ndarray((a['count'], width), dtype, buffers[v['buffer']],
                          v.get('byteOffset', 0)+a.get('byteOffset', 0),
                          (v.get('byteStride', width*dtype.itemsize), dtype.itemsize))
    else:
        data = np.zeros((a['count'], width), dtype)
    sparse = a.get('sparse')
    if sparse:
        def read(part, storage_type, components):
            spec = sparse[part]
            view = doc['bufferViews'][spec['bufferView']]
            start = view.get('byteOffset', 0) + spec.get('byteOffset', 0)
            return np.frombuffer(buffers[view['buffer']], storage_type, sparse['count']*components, start)
        ids = read('indices', DTYPE[sparse['indices']['componentType']], 1)
        data = data.copy()
        data[ids] = read('values', dtype, width).reshape(-1, width)
    return data

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

def sparse_attribute(doc, binary, accessor, ids, data):
    # glTF sparse overlays let the rest of the original body keep its buffers.
    accessor = dict(accessor)
    index_type = 5123 if accessor['count']<65536 else 5125
    def view(array, component):
        packed = np.ascontiguousarray(array, dtype=DTYPE[component])
        binary.extend(bytes((-len(binary))%4))
        doc['bufferViews'].append(dict(buffer=len(doc['buffers'])-1, byteOffset=len(binary), byteLength=packed.nbytes))
        binary.extend(packed.tobytes())
        return len(doc['bufferViews'])-1
    accessor['sparse'] = dict(count=len(ids), indices=dict(bufferView=view(ids, index_type), componentType=index_type),
                              values=dict(bufferView=view(data, accessor['componentType'])))
    doc['accessors'].append(accessor)
    return len(doc['accessors'])-1

def write_morph(doc, binary, delta):
    delta = delta.astype('<f4')
    info = dict(type='VEC3', componentType=5126, count=len(delta), min=delta.min(0).tolist(), max=delta.max(0).tolist())
    ids = np.flatnonzero(np.any(delta!=0, axis=1))
    return sparse_attribute(doc, binary, info, ids, delta[ids])

def dense_weights(joints, weights, count):
    dense = np.zeros((len(joints), count))
    np.add.at(dense, (np.arange(len(joints))[:, None], joints), weights)
    return dense

def four_weights(dense):
    joints = np.argsort(-dense, axis=1, kind='stable')[:, :4]
    weights = np.take_along_axis(dense, joints, axis=1)
    return joints, weights/weights.sum(1)[:, None]

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

    def fit_interior(self, binary):
        exterior = next(p for m in self.doc['meshes'] for p in m['primitives']
                        if self.doc['materials'][p['material']]['name'] == 'Body_Skin_4K')
        inner = next(p for m in self.doc['meshes'] for p in m['primitives']
                     if self.doc['materials'][p['material']]['name'] == 'Anatomy_Rim_and_Interior_4K')
        attr = inner['attributes']
        points = values(self.doc, self.body, attr['POSITION'])
        skin = values(self.doc, self.body, exterior['attributes']['POSITION'])
        distance, match = cKDTree(skin).query(points)
        rim = distance < .00005
        if not rim.any():
            raise ValueError('内部网格与骨盆体表没有共用边缘')
        rim_tree = cKDTree(points[rim])
        depth, neighbours = rim_tree.query(points, k=6)
        nearest = depth[:, 0]
        blend_weights = 1/np.maximum(depth, .000001)**2
        blend_weights /= blend_weights.sum(1)[:, None]
        deep = smooth(0, .013, nearest)[:, None]
        # Both sides of the narrow lip share some of their neighbours' load.
        # At 16 mm the exterior is back to its original character weights.
        inner_blend = .5*(1-smooth(.004, .016, nearest))[:, None]
        outer_dist = rim_tree.query(skin)[0]
        near_ids = np.flatnonzero(outer_dist < .016)
        outer_blend = .5*(1-smooth(.004, .016, outer_dist[near_ids]))[:, None]
        count = len(self.body_joints)
        outer = exterior['attributes']
        dense = dense_weights(values(self.doc, self.body, attr['JOINTS_0']),
                              values(self.doc, self.body, attr['WEIGHTS_0']), count)
        shared = dense[rim].mean(axis=0)
        fitted = dense*(1-deep) + shared*deep
        joints, weights = four_weights(fitted*(1-inner_blend) + shared*inner_blend)
        attr['JOINTS_0'] = add_attribute(self.doc, binary, joints, 'VEC4', 5123)
        attr['WEIGHTS_0'] = add_attribute(self.doc, binary, weights, 'VEC4', 5126)
        local = dense_weights(values(self.doc, self.body, outer['JOINTS_0'])[near_ids],
                              values(self.doc, self.body, outer['WEIGHTS_0'])[near_ids], count)
        outer_j, outer_w = four_weights(local*(1-outer_blend) + shared*outer_blend)
        for key, data in [('JOINTS_0', outer_j), ('WEIGHTS_0', outer_w)]:
            base = self.doc['accessors'][outer[key]]
            if 'sparse' in base:
                full = values(self.doc, self.body, outer[key]).copy()
                full[near_ids] = data
                outer[key] = add_attribute(self.doc, binary, full, 'VEC4', base['componentType'])
            else:
                outer[key] = sparse_attribute(self.doc, binary, base, near_ids, data)
        # The four hip correctives move the surface lip by up to several mm.
        # Preserve that movement on both sides of the weld and taper it inside.
        taper = (1-smooth(.004, .026, nearest))[:, None]
        for outer_target, inner_target in zip(exterior.get('targets', []), inner.get('targets', [])):
            outer_delta = values(self.doc, self.body, outer_target['POSITION']).copy()
            rim_delta = outer_delta[match[rim]]
            if not np.any(rim_delta):
                continue
            mean = rim_delta.mean(0)
            delta = (rim_delta[neighbours]*blend_weights[:, :, None]).sum(1)*taper
            delta[rim] = rim_delta
            delta += values(self.doc, self.body, inner_target['POSITION'])*(1-taper)
            delta += (mean-delta)*inner_blend
            outer_delta[near_ids] += (mean-outer_delta[near_ids])*outer_blend
            outer_target['POSITION'] = write_morph(self.doc, binary, outer_delta)
            inner_target['POSITION'] = write_morph(self.doc, binary, delta)
        # Only the deep wall retracts on hip flexion. The welded border stays put.
        shift = (points[rim].mean(axis=0) - points) * (.60 * deep)
        attr['_INNERFOLD'] = add_attribute(self.doc, binary, shift, 'VEC3', 5126)

    def skirt_probes(self):
        # Sample the outside of both thighs and the pelvis, including the original
        # corrective shapes. Coincident vertices at the leg graft need one sample.
        groups, clouds = [], []
        for group, mesh in enumerate(self.doc['meshes']):
            for p in mesh['primitives']:
                if self.doc['materials'][p['material']]['name'] not in ('Body_Skin_4K', 'WholeLegs_Rebound_Skin_Matched'):
                    continue
                pos = values(self.doc, self.body, p['attributes']['POSITION'])
                used = np.unique(values(self.doc, self.body, p['indices']))
                ids = used[(pos[used, 1] > .53) & (pos[used, 1] < 1.15) & (np.abs(pos[used, 0]) < .226)]
                if len(ids):
                    groups.append((group, len(pos), ids))
                    clouds.append(pos[ids])
        _, selected = np.unique(np.rint(np.concatenate(clouds)/.022).astype('i4'), axis=0, return_index=True)
        rows = []
        offset = 0
        for group, count, ids in groups:
            kept = selected[(selected >= offset) & (selected < offset+len(ids))] - offset
            rows.append(dict(group=group, count=count, ids=ids[kept].tolist()))
            offset += len(ids)
        return rows

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
