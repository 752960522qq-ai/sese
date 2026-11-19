"""Install both fitted Leon GLBs, retaining original mesh, weights, animation and shared images."""
import argparse
import hashlib
import json
import posixpath
from pathlib import Path
from prepare_assets import ASSETS, split_model, write_json

def install(base, suit):
    root = ASSETS / 'models'
    index = ASSETS / 'catalog.json'
    catalog = json.loads(index.read_text()) if index.exists() else {}
    textures = {}
    for name, path in [('leon', base), ('leonSuit', suit)]:
        catalog[name] = split_model(path, name, fitted=True)
        folder = root / name
        doc = json.loads((folder / 'actor.gltf').read_text())
        for image in doc['images']:
            tex = folder / image['uri']
            digest = hashlib.sha256(tex.read_bytes()).digest()
            if digest in textures:
                image['uri'] = posixpath.relpath(textures[digest], folder)
            else:
                textures[digest] = str(tex)
        write_json(folder / 'actor.gltf', doc)
        kept = {i['uri'] for i in doc['images']} | {b['uri'] for b in doc['buffers']}
        for old in [*folder.glob('texture-*'), folder/'controls.bin']:
            if old.is_file() and old.name not in kept:
                old.unlink()
    write_json(index, catalog)

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('base', type=Path)
    parser.add_argument('suit', type=Path)
    args = parser.parse_args()
    install(args.base, args.suit)
