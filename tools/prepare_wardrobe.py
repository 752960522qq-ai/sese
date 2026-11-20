"""Bind the R19 office wardrobe to the existing body skeleton. Keep one copy of each original image."""
import argparse
import copy
import hashlib
import json
import struct
import zipfile
from pathlib import Path

from prepare_assets import image_size
import numpy as np
from fit_officewear import OfficeFit, values, add_attribute


def original_image(data, folder, stem):
    mime = 'image/png' if data.startswith(b'\x89PNG') else 'image/jpeg'
    name = stem + ('.png' if mime == 'image/png' else '.jpg')
    (folder / name).write_bytes(data)
    return {'uri':name, 'extras':{'studioSize':image_size(data, mime)}}

def append_wearables(doc,folder,wardrobe,write_image,simplify=None):
    names={n.get('name'):i for i,n in enumerate(doc['nodes'])}
    base_arm=names['Armature']
    body=doc['skins'][0]
    joint_by_name={doc['nodes'][j]['name']:j for j in body['joints']}
    manifest=json.loads(wardrobe.read('wardrobe.json'))
    fit=OfficeFit(doc,folder,wardrobe,manifest)
    mask=np.frombuffer(wardrobe.read('coverage.bin'),dtype='u1').copy()
    fit.retain_thighs(mask,manifest)
    manifest['fitRevision']='skirt-knit-3'
    manifest['skirtProbes']=fit.skirt_probes()
    (folder/'coverage.bin').write_bytes(mask.tobytes())
    (folder/'wardrobe.json').write_text(json.dumps(manifest,ensure_ascii=False))
    for idx in {r['mesh'] for r in manifest['bodyMasks']}:
        doc['meshes'][idx].setdefault('extras',{}).update(gameBody=True,bodyMaskGroup=idx)
    doc.setdefault('extras',{})['wardrobeRevision']=manifest['revision']
    binary=bytearray()
    doc['buffers'].append({'uri':'clothing.bin','byteLength':0})
    buffer_number=len(doc['buffers'])-1
    fit.add_leg_knit(binary)
    fit.fit_interior(binary)
    image_cache={}
    for item in manifest['items']:
        data=wardrobe.read(item['asset']);n=struct.unpack_from('<I',data,12)[0]
        src=json.loads(data[20:20+n]);blob=memoryview(data)[28+n:]
        for field in ('extensionsUsed','extensionsRequired'):
            for extension in src.get(field,[]):
                if extension not in doc.setdefault(field,[]):doc[field].append(extension)
        clothing_names=[src['nodes'][j]['name'] for j in src['skins'][0]['joints']]
        if len(clothing_names)!=118 or not all(n in joint_by_name for n in clothing_names):
            raise ValueError('服装骨架不匹配')
        clothing_joints=[joint_by_name[n] for n in clothing_names]
        accs={};views={};texs={};mats={}
        def add_view(data,meta):
            while len(binary)%4:binary.append(0)
            v=dict(meta,buffer=buffer_number,byteOffset=len(binary),byteLength=len(data));doc['bufferViews'].append(v)
            binary.extend(data);return len(doc['bufferViews'])-1
        def view(i):
            if i not in views:
                v=src['bufferViews'][i];start=v.get('byteOffset',0)
                views[i]=add_view(blob[start:start+v['byteLength']],v)
            return views[i]
        def acc(i):
            if i not in accs:
                a=copy.deepcopy(src['accessors'][i])
                if 'bufferView' in a:a['bufferView']=view(a['bufferView'])
                if 'sparse' in a:
                    for key in ('indices','values'):a['sparse'][key]['bufferView']=view(a['sparse'][key]['bufferView'])
                accs[i]=len(doc['accessors']);doc['accessors'].append(a)
            return accs[i]
        def tex(i):
            if i not in texs:
                im=src['images'][src['textures'][i]['source']];v=src['bufferViews'][im['bufferView']]
                offset=v.get('byteOffset',0);raw=bytes(blob[offset:offset+v['byteLength']]);h=hashlib.sha256(raw).hexdigest()[:20]
                if h not in image_cache:
                    image_cache[h]=len(doc['images']);doc['images'].append(write_image(raw,folder,'wear-'+h))
                texture={'source':image_cache[h]}
                if 'sampler' in src['textures'][i]:
                    sampler=src['samplers'][src['textures'][i]['sampler']]
                    samplers=doc.setdefault('samplers',[])
                    if sampler not in samplers:samplers.append(sampler)
                    texture['sampler']=samplers.index(sampler)
                texs[i]=len(doc['textures']);doc['textures'].append(texture)
            return texs[i]
        def material(i):
            if i not in mats:
                m=copy.deepcopy(src['materials'][i])
                def visit(o):
                    if not isinstance(o,dict):return
                    for k,v in o.items():
                        if k.endswith('Texture') and isinstance(v,dict) and 'index' in v:v['index']=tex(v['index'])
                        else:visit(v)
                visit(m);mats[i]=len(doc['materials']);doc['materials'].append(m)
            return mats[i]
        cloth_skin={'inverseBindMatrices':acc(src['skins'][0]['inverseBindMatrices']),'joints':clothing_joints}
        skin_id=len(doc['skins']);doc['skins'].append(cloth_skin)
        for mi,m in enumerate(src['meshes']):
            name=m['name'];prims=[]
            for prim in m['primitives']:
                attrs={k:acc(v) for k,v in prim['attributes'].items() if item['key']!='skirt' or k not in ('JOINTS_0','WEIGHTS_0')}
                pos=values(src,[blob],prim['attributes']['POSITION'])
                if item['key']=='skirt':
                    joints,weights=fit.skirt_weights(pos,clothing_names)
                    attrs['JOINTS_0']=add_attribute(doc,binary,joints,'VEC4',5123)
                    attrs['WEIGHTS_0']=add_attribute(doc,binary,weights,'VEC4',5126)
                if name=='Raised_Foot_Graft':
                    side='Left' if np.mean(pos[:,0])>0 else 'Right'
                    attrs['_HOSIERY']=add_attribute(doc,binary,fit.knit_coords(pos,side,True),'VEC4',5126)
                # Long decimated faces at the hem cut across the moving thigh.
                # Retain the skirt panels and their trim as one matching topology.
                if simplify is None or item['key']=='skirt':
                    ii=acc(prim['indices'])
                else:
                    tri, count=simplify(src,blob,prim)
                    short=count<65536
                    vi=add_view(tri.astype('<u2' if short else '<u4').tobytes(),{'target':34963})
                    ii=len(doc['accessors'])
                    doc['accessors'].append({'bufferView':vi,'componentType':5123 if short else 5125,
                                             'count':len(tri),'type':'SCALAR'})
                pr={'attributes':attrs,'indices':ii,'material':material(prim['material'])}
                if 'targets' in prim and item['key']!='stockings':pr['targets']=[{k:acc(v) for k,v in target.items()} for target in prim['targets']]
                prims.append(pr)
            mesh={'name':name,'primitives':prims,'extras':dict(m.get('extras',{}),gameWear=item['key'],wearPart=name)}
            if 'weights' in m and item['key']!='stockings':mesh['weights']=m['weights']
            elif item['key']=='stockings':mesh['extras'].pop('targetNames',None)
            mesh_id=len(doc['meshes']);doc['meshes'].append(mesh)
            node_id=len(doc['nodes']);doc['nodes'].append({'name':name,'mesh':mesh_id,'skin':skin_id})
            # All items share the body's armature. Keep one copy of each flat/raised foot.
            doc['nodes'][base_arm].setdefault('children',[]).append(node_id)
    (folder/'clothing.bin').write_bytes(binary);doc['buffers'][-1]['byteLength']=len(binary)


if __name__=='__main__':
    ap=argparse.ArgumentParser()
    ap.add_argument('wardrobe',type=Path);ap.add_argument('model',type=Path)
    args=ap.parse_args()
    actor=json.loads((args.model/'actor.gltf').read_text())
    with zipfile.ZipFile(args.wardrobe) as z:append_wearables(actor,args.model,z,original_image)
    (args.model/'dressed.gltf').write_text(json.dumps(actor,ensure_ascii=False,separators=(',',':')))
