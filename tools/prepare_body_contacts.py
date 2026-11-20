"""Fit bone-local capsule colliders to the three prepared character variants."""
import argparse
import json
from pathlib import Path

import numpy as np
from scipy.spatial.transform import Rotation

PARTS = ('Root', 'Mid', 'Tip')
# Radii and distal lengths measured on the bound source meshes, in local metres.
FIT = {'zhenfu': ('ZF', (.023, .023, .019), .0388),
       'leon': ('Leon', (.027, .0235, .021), .0483)}


def write_doc(path, doc):
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(doc, ensure_ascii=False, separators=(',', ':')))
    temp.replace(path)


def proxy_rig(folder, doc, base):
    """The suit uses a different pelvis and has no exposed body mesh beneath its trousers."""
    names = ['Leon_Penis_' + p for p in PARTS]
    skin = doc['skins'][0]
    by_name = {n.get('name'): i for i, n in enumerate(doc['nodes'])}
    if all(n in by_name for n in names):
        if not all(by_name[n] in skin['joints'] for n in names):
            raise ValueError('碰撞骨链没有完整接入西装骨架')
        return
    if any(n in by_name for n in names):
        raise ValueError('西装骨架含不完整的碰撞骨链')
    parent = next(i for i in skin['joints'] if 'Bip01_Pelvis' in doc['nodes'][i]['name'])
    acc = doc['accessors'][skin['inverseBindMatrices']]
    view = doc['bufferViews'][acc['bufferView']]
    buf = (folder / doc['buffers'][view['buffer']]['uri']).read_bytes()
    matrices = np.ndarray((acc['count'], 16), dtype='<f4', buffer=buf,
                          offset=view.get('byteOffset', 0)+acc.get('byteOffset', 0),
                          strides=(view.get('byteStride', 64), 4))
    rows = list(matrices)
    inverse = matrices[skin['joints'].index(parent)].reshape(4, 4, order='F').copy()
    source = {n.get('name'): n for n in base['nodes']}
    for name in names:
        n = {k: source[name][k] for k in ('name', 'translation', 'rotation')}
        local = np.eye(4)
        local[:3, :3] = Rotation.from_quat(n['rotation']).as_matrix()
        local[:3, 3] = n['translation']
        inverse = np.linalg.solve(local, inverse)
        rows.append(inverse.flatten(order='F'))
        i = len(doc['nodes'])
        doc['nodes'][parent].setdefault('children', []).append(i)
        doc['nodes'].append(n)
        skin['joints'].append(i)
        parent = i
    data = np.asarray(rows, dtype='<f4').tobytes()
    name = 'body-contact-bind.bin'
    (folder / name).write_bytes(data)
    doc['bufferViews'].append({'buffer': len(doc['buffers']), 'byteLength': len(data)})
    doc['buffers'].append({'uri': name, 'byteLength': len(data)})
    doc['accessors'].append({'bufferView': len(doc['bufferViews'])-1, 'componentType': 5126,
                             'type': 'MAT4', 'count': len(rows)})
    skin['inverseBindMatrices'] = len(doc['accessors'])-1


def prepare(root):
    nude = json.loads((root/'leon'/'actor.gltf').read_bytes())
    for character in ('zhenfu', 'leon', 'leonSuit'):
        folder = root/character
        files = [folder/'actor.gltf']
        if character=='zhenfu' and (folder/'dressed.gltf').is_file():
            files.append(folder/'dressed.gltf')
        prefix, radii, distal = FIT['leon' if character=='leonSuit' else character]
        names = [prefix+'_Penis_'+p for p in PARTS]
        for path in files:
            doc = json.loads(path.read_bytes())
            if character=='leonSuit':
                proxy_rig(folder, doc, nude)
            nodes = {doc['nodes'][j]['name']:doc['nodes'][j] for j in doc['skins'][0]['joints']}
            bodies = []
            for i, name in enumerate(names):
                if name not in nodes:
                    raise ValueError('缺少碰撞骨骼 '+name)
                r = radii[i]
                body = {'id':'anatomy-'+PARTS[i].lower(), 'shape':'capsule','anchor':name,
                        'a':[0,0,r if i==0 else 0], 'b':[0,0,0], 'radius':r}
                if i<2:
                    body['endAnchor'] = names[i+1]
                else:
                    body['b'][2] = round(distal-r,5)
                bodies.append(body)
            extras = doc['asset'].setdefault('extras', {})
            if extras.get('seseBodyColliders') != bodies:
                extras['seseBodyColliders'] = bodies
                write_doc(path, doc)
            print(character, path.name, len(bodies), 'capsules')


if __name__=='__main__':
    cli=argparse.ArgumentParser()
    cli.add_argument('models', type=Path)
    prepare(cli.parse_args().models)
