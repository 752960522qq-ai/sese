"""Build a mobile cast from the updated offline Pose Studio APK and the office wardrobe source."""
import argparse
import io
import json
import sys
import zipfile
from pathlib import Path
from PIL import Image
from prepare_city import Simplifier, accessor
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'tools'))
from prepare_wardrobe import append_wearables

def image_file(data, folder, name, size=1024):
    im=Image.open(io.BytesIO(data))
    im.thumbnail((size,size), Image.Resampling.LANCZOS)
    alpha='A' in im.mode and im.getextrema()[-1][0]<255
    path=folder/(name+('.png' if alpha else '.jpg'))
    im.convert('RGBA' if alpha else 'RGB').save(path,quality=86,optimize=True)
    return {'uri':path.name,'extras':{'studioSize':list(im.size)}}

def append_mobile_clothes(doc,folder,wardrobe,simplifier):
    def mobile_image(data,folder,stem):
        return image_file(data,folder,stem,768)
    def mobile_indices(src,blob,prim):
        pos=np.ascontiguousarray(accessor(src,blob,prim['attributes']['POSITION']),dtype='f4')
        inds=accessor(src,blob,prim['indices']).ravel()
        tri=simplifier.run(inds,pos,max(180,round(len(inds)/3*.45))).ravel()
        return tri,len(pos)
    append_wearables(doc,folder,wardrobe,mobile_image,mobile_indices)

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
                append_mobile_clothes(doc,folder,wardrobe,Simplifier(args.meshopt))
            (folder/'actor.gltf').write_text(json.dumps(doc,ensure_ascii=False,separators=(',',':')))
if __name__=='__main__':main()
