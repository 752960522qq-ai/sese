"""Prepare an offline asset tree from the two original GLBs; image and accessor bytes are never re-encoded."""
import argparse
import hashlib
import json
import shutil
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'app/src/main/assets'
MODELS = {'zhenfu': ('49c253efed7016261810b26290b8a176287f42166a1cb2e9cb6f4e7113353f1e', 43),
          'leon': ('b879152eaf27a9c9eb90618c8bfd2e52954194bc396c41c6e01c4f208ec5af4a', 7)}

def write_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')

def image_size(data, mime):
    if mime == 'image/png':
        return list(struct.unpack_from('>II', data, 16))
    pos = 2
    while pos < len(data):
        if data[pos] != 255:
            pos += 1
            continue
        marker = data[pos + 1]
        pos += 2
        if marker in (0xc0, 0xc1, 0xc2):
            height, width = struct.unpack_from('>HH', data, pos + 3)
            return [width, height]
        if marker != 0xff:
            pos += struct.unpack_from('>H', data, pos)[0]
    raise ValueError('Invalid image size')

def split_model(path, name, *, fitted=False):
    original = path.read_bytes()
    digest = hashlib.sha256(original).hexdigest()
    if not fitted and digest != MODELS[name][0]:
        raise ValueError(f'{name}: expected the published master GLB {digest}')
    magic, version, total, size, tag = struct.unpack_from('<4sIII4s', original)
    if (magic, version, total, tag) != (b'glTF', 2, len(original), b'JSON'):
        raise ValueError('Invalid GLB')
    doc = json.loads(original[20:20+size])
    binary = memoryview(original)[28+size:]
    assert len(doc['buffers']) == 1
    if fitted:
        required = {'Idle', 'Walk', 'Run'}
        if name == 'leon':
            required.update(('08','09','10','11','12','16','17'))
        if not required.issubset(a['name'] for a in doc['animations']):
            raise ValueError(f'{name}: missing fitted animations')
    elif len(doc['animations']) != MODELS[name][1]:
        raise ValueError(f'{name}: unexpected master clip count')
    folder = ASSETS / 'models' / name
    folder.mkdir(parents=True, exist_ok=True)
    views = doc['bufferViews']
    images = {i['bufferView'] for i in doc['images']}
    used = {a['bufferView'] for a in doc['accessors'] if 'bufferView' in a}
    for a in doc['accessors']:
        for k in ['indices', 'values']:
            if k in a.get('sparse', {}):
                used.add(a['sparse'][k]['bufferView'])
    assert images.isdisjoint(used)
    def raw(view):
        start = view.get('byteOffset', 0)
        return binary[start:start + view['byteLength']]
    for i, img in enumerate(doc['images']):
        ext = {'image/png': 'png', 'image/jpeg': 'jpg'}[img['mimeType']]
        img['uri'] = f'texture-{i}.{ext}'
        data = raw(views[img.pop('bufferView')])
        img.setdefault('extras', {})['studioSize'] = image_size(data, img['mimeType'])
        (folder / img['uri']).write_bytes(data)
    indices = {}
    new_views = []
    with (folder / 'rig.bin').open('wb') as output:
        for i, view in enumerate(views):
            if i in images:
                continue
            indices[i] = len(new_views)
            output.write(b'\0' * ((-output.tell()) % 4))
            offset = output.tell()
            output.write(raw(view))
            new_views.append(dict(view, byteOffset=offset))
        doc['buffers'] = [{'uri': 'rig.bin', 'byteLength': output.tell()}]
    for a in doc['accessors']:
        if 'bufferView' in a:
            a['bufferView'] = indices[a['bufferView']]
        for value in a.get('sparse', {}).values():
            if isinstance(value, dict) and 'bufferView' in value:
                value['bufferView'] = indices[value['bufferView']]
    doc['bufferViews'] = new_views
    write_json(folder / 'actor.gltf', doc)
    return {'sha256': digest, 'clips': [a['name'] for a in doc['animations']]}

def vendor(directory):
    dest = ASSETS / 'vendor'
    dest.mkdir(exist_ok=True)
    # Accept either the upstream npm package or its flat, previously vendored distribution.
    upstream = (directory / 'build').is_dir()
    runtime = directory / 'build' if upstream else directory
    addons = directory / 'examples/jsm' if upstream else directory / 'addons'
    shutil.copy2(runtime / 'three.module.min.js', dest)
    if (runtime / 'three.core.min.js').is_file():
        shutil.copy2(runtime / 'three.core.min.js', dest)
    shutil.copy2(directory / 'LICENSE', dest)
    for src, target in [('loaders/GLTFLoader.js','loaders'), ('utils/BufferGeometryUtils.js','utils'), ('controls/OrbitControls.js','controls')]:
        out = dest / target / Path(src).name
        out.parent.mkdir(exist_ok=True)
        out.write_text((addons / src).read_text().replace("from 'three'", "from '../three.module.min.js'"))
    if not (dest / 'three.module.min.js').read_bytes():
        raise ValueError('Three.js is missing')

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--zhenfu', type=Path, required=True)
    ap.add_argument('--leon', type=Path, required=True)
    ap.add_argument('--vendor', type=Path, default=ROOT / 'node_modules/three')
    opts = ap.parse_args()
    ASSETS.mkdir(parents=True, exist_ok=True)
    catalog = {name: split_model(getattr(opts, name), name) for name in MODELS}
    vendor(opts.vendor)
    shutil.copytree(ROOT / 'web', ASSETS, dirs_exist_ok=True)
    write_json(ASSETS / 'catalog.json', catalog)
    print('Packaged clips:', {name: len(data['clips']) for name, data in catalog.items()})
