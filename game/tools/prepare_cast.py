"""Build a mobile cast from the Pose Studio 1.1 APK and the R19 office wardrobe ZIP."""
import argparse
import copy
import hashlib
import io
import json
import struct
import zipfile
from pathlib import Path
from PIL import Image
from prepare_city import Simplifier, accessor
import numpy as np

def image_file(data, folder, name, size=1024):
    im=Image.open(io.BytesIO(data))
    im.thumbnail((size,size), Image.Resampling.LANCZOS)
    alpha='A' in im.mode and im.getextrema()[-1][0]<255
    path=folder/(name+('.png' if alpha else '.jpg'))
    im.convert('RGBA' if alpha else 'RGB').save(path,quality=86,optimize=True)
    return {'uri':path.name,'extras':{'studioSize':list(im.size)}}

def append_wearables(doc,folder,wardrobe,simplifier):
    names={n.get('name'):i for i,n in enumerate(doc['nodes'])}
    base_arm=names['Armature']
    body=doc['skins'][0]
    base_bones=[doc['nodes'][j]['name'] for j in body['joints']]
    manifest=json.loads(wardrobe.read('wardrobe.json'))
    (folder/'coverage.bin').write_bytes(wardrobe.read('coverage.bin'))
    (folder/'wardrobe.json').write_text(json.dumps(manifest,ensure_ascii=False))
    for idx in (0,2):doc['meshes'][idx].setdefault('extras',{})['gameBody']=True
    binary=bytearray()
    doc['buffers'].append({'uri':'clothing.bin','byteLength':0})
    buffer_number=len(doc['buffers'])-1
    image_cache={}
    for item in manifest['items']:
        data=wardrobe.read(item['asset']);n=struct.unpack_from('<I',data,12)[0]
        src=json.loads(data[20:20+n]);blob=memoryview(data)[28+n:]
        if [src['nodes'][j]['name'] for j in src['skins'][0]['joints']]!=base_bones:raise ValueError('服装骨架不匹配')
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
                    image_cache[h]=len(doc['images']);doc['images'].append(image_file(raw,folder,'wear-'+h,768))
                texs[i]=len(doc['textures']);doc['textures'].append({'source':image_cache[h]})
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
        cloth_skin={'inverseBindMatrices':acc(src['skins'][0]['inverseBindMatrices']),'joints':body['joints']}
        skin_id=len(doc['skins']);doc['skins'].append(cloth_skin)
        for mi,m in enumerate(src['meshes']):
            name=m['name'];prims=[]
            for prim in m['primitives']:
                attrs={k:acc(v) for k,v in prim['attributes'].items()}
                pos=np.ascontiguousarray(accessor(src,blob,prim['attributes']['POSITION']),dtype='f4')
                inds=accessor(src,blob,prim['indices']).ravel()
                count=len(inds)//3
                tri=simplifier.run(inds,pos,max(180,round(count*.45))).ravel()
                dtype='<u2' if len(pos)<65536 else '<u4';vi=add_view(tri.astype(dtype).tobytes(),{'target':34963})
                ii=len(doc['accessors']);doc['accessors'].append({'bufferView':vi,'componentType':5123 if len(pos)<65536 else 5125,'count':len(tri),'type':'SCALAR'})
                pr={'attributes':attrs,'indices':ii,'material':material(prim['material'])}
                if 'targets' in prim:pr['targets']=[{k:acc(v) for k,v in target.items()} for target in prim['targets']]
                prims.append(pr)
            mesh={'name':name,'primitives':prims,'extras':dict(m.get('extras',{}),gameWear=item['key'],wearPart=name)}
            if 'weights' in m:mesh['weights']=m['weights']
            mesh_id=len(doc['meshes']);doc['meshes'].append(mesh)
            node_id=len(doc['nodes']);doc['nodes'].append({'name':name,'mesh':mesh_id,'skin':skin_id})
            # All items share the body's armature. Keep one copy of each flat/raised foot.
            doc['nodes'][base_arm].setdefault('children',[]).append(node_id)
    (folder/'clothing.bin').write_bytes(binary);doc['buffers'][-1]['byteLength']=len(binary)

def main():
    ap=argparse.ArgumentParser();ap.add_argument('studio',type=Path);ap.add_argument('wardrobe',type=Path);ap.add_argument('output',type=Path);ap.add_argument('meshopt',type=Path);args=ap.parse_args()
    root=args.output
    with zipfile.ZipFile(args.studio) as studio, zipfile.ZipFile(args.wardrobe) as wardrobe:
        for n in studio.namelist():
            if n.startswith(('assets/vendor/','assets/audio/')) and not n.endswith('/'):
                p=root/n[7:];p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(studio.read(n))
        for kind in ('zhenfu','leon'):
            sub=f'models/{kind}/';folder=root/sub;folder.mkdir(exist_ok=True,parents=True)
            doc=json.loads(studio.read('assets/'+sub+'actor.gltf'))
            for im in doc['images']:
                name=im['uri'];im.update(image_file(studio.read('assets/'+sub+name),folder,Path(name).stem))
            for b in doc['buffers']:(folder/b['uri']).write_bytes(studio.read('assets/'+sub+b['uri']))
            if kind=='zhenfu':
                (folder/'expressions.glb').write_bytes(studio.read('assets/'+sub+'expressions.glb'))
                append_wearables(doc,folder,wardrobe,Simplifier(args.meshopt))
            (folder/'actor.gltf').write_text(json.dumps(doc,ensure_ascii=False,separators=(',',':')))
if __name__=='__main__':main()
