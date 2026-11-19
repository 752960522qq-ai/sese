"""Extract the showroom's graphite SUV and pivot its four wheels for the playable car."""
import argparse
import json
import struct
import zipfile
from pathlib import Path
import numpy as np
from prepare_city import accessor

def build(source, target):
    with zipfile.ZipFile(source) as archive:
        raw = archive.read('districts/07_main_north_east_center.glb')
    size = struct.unpack_from('<I', raw, 12)[0]
    city = json.loads(raw[20:20+size])
    buf = memoryview(raw)[28+size:]
    donor = next(n for n in city['nodes'] if 'SUV · Carbon graphite' in n.get('name',''))
    source_mesh = city['meshes'][donor['mesh']]
    doc = dict(asset={'version':'2.0','generator':'sese / hero13 showroom'}, scene=0,
               scenes=[{'nodes':[0]}],nodes=[{'name':'DealerSUV','children':[]}], meshes=[],
               buffers=[],bufferViews=[],accessors=[],materials=[])
    output = bytearray()
    def add(array, original, target_type):
        array=np.ascontiguousarray(array)
        output.extend(bytes((-len(output))%4))
        offset=len(output)
        output.extend(array.tobytes())
        view=len(doc['bufferViews'])
        doc['bufferViews'].append(dict(buffer=0, byteOffset=offset, byteLength=array.nbytes, target=target_type))
        meta={k:original[k] for k in ('componentType','type','normalized') if k in original}
        meta.update(bufferView=view,count=len(array))
        if 'min' in original or 'max' in original:
            meta.update(min=array.min(axis=0).reshape(-1).tolist(),max=array.max(axis=0).reshape(-1).tolist())
        doc['accessors'].append(meta)
        return len(doc['accessors'])-1
    doc.update(images=[], textures=[], samplers=[], extensionsUsed=['KHR_materials_clearcoat'])
    texture_ids = {}
    def texture(i):
        if i not in texture_ids:
            t=city['textures'][i]
            image=city['images'][t['source']]
            v=city['bufferViews'][image['bufferView']]
            start=v.get('byteOffset',0)
            output.extend(bytes((-len(output))%4))
            offset=len(output)
            output.extend(buf[start:start+v['byteLength']])
            doc['images'].append({'name':image.get('name',''), 'mimeType':image['mimeType'], 'bufferView':len(doc['bufferViews'])})
            doc['bufferViews'].append({'buffer':0,'byteOffset':offset,'byteLength':v['byteLength']})
            entry={'source':len(doc['images'])-1}
            if 'sampler' in t:
                sampler=city['samplers'][t['sampler']]
                if sampler not in doc['samplers']: doc['samplers'].append(sampler)
                entry['sampler']=doc['samplers'].index(sampler)
            texture_ids[i]=len(doc['textures'])
            doc['textures'].append(entry)
        return texture_ids[i]
    body = []
    def node(name, primitives, pivot=None):
        mesh=len(doc['meshes'])
        doc['meshes'].append({'name':name, 'primitives':primitives})
        info={'name':name,'mesh':mesh}
        if pivot is not None: info['translation']=pivot.tolist()
        doc['nodes'][0]['children'].append(len(doc['nodes']))
        doc['nodes'].append(info)
    for p in source_mesh['primitives']:
        material=city['materials'][p['material']]
        for key, prop in material.get('pbrMetallicRoughness',{}).items():
            if key.endswith('Texture'): prop['index']=texture(prop['index'])
        mid=len(doc['materials'])
        doc['materials'].append(material)
        indices=accessor(city,buf,p['indices']).reshape(-1,3)
        positions=accessor(city,buf,p['attributes']['POSITION'])
        wheels='tires' in material['name'].lower()
        grouped=[]
        if wheels:
            centers=positions[indices].mean(axis=1)
            for side,x in [('left',1),('right',-1)]:
                for axle,z in [('front',1),('rear',-1)]:
                    grouped.append(('wheel_'+axle+'_'+side,indices[(centers[:,0]*x>0)&(centers[:,2]*z>0)]))
        else: grouped=[('body',indices)]
        for name,faces in grouped:
            used,remap=np.unique(faces,return_inverse=True)
            assert len(used)>0
            partpos=positions[used]
            pivot=(partpos.max(axis=0)+partpos.min(axis=0))/2 if wheels else None
            attrs={}
            for key,i in p['attributes'].items():
                a=accessor(city,buf,i)[used]
                if key=='POSITION' and wheels:a=a-pivot
                attrs[key]=add(a,city['accessors'][i],34962)
            idx=add(remap.reshape(-1,1).astype('<u2' if len(used)<65536 else '<u4'),dict(componentType=5123 if len(used)<65536 else 5125,type='SCALAR'),34963)
            result=dict(attributes=attrs,indices=idx,material=mid)
            if wheels:node(name,[result],pivot)
            else:body.append(result)
    node('body',body)
    if len(doc['nodes'])!=6: raise ValueError('Expected four independent showroom wheels')
    doc['buffers']=[{'byteLength':len(output)}]
    record=json.dumps(doc,separators=(',',':'),ensure_ascii=False).encode()
    record+=b' '*((-len(record))%4)
    output.extend(bytes((-len(output))%4))
    target.parent.mkdir(parents=True,exist_ok=True)
    target.write_bytes(struct.pack('<4sIII4s',b'glTF',2,28+len(record)+len(output),len(record),b'JSON')+record+struct.pack('<I4s',len(output),b'BIN\0')+output)

if __name__=='__main__':
    p=argparse.ArgumentParser()
    p.add_argument('district_zip',type=Path)
    p.add_argument('target_glb',type=Path)
    a=p.parse_args()
    build(a.district_zip,a.target_glb)
