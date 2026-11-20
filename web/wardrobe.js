import * as T from './vendor/three.module.min.js';

import {fitHosiery,disposeHosiery} from './hosiery.js';

let wardrobe;
const variants = new WeakMap();

async function source() {
  if (!wardrobe) {
    const folder = './models/zhenfu/';
    wardrobe = Promise.all(['wardrobe.json', 'coverage.bin'].map(async file => {
      const r = await fetch(folder + file);
      if (!r.ok) throw Error('无法加载甄芙职业装');
      return file.endsWith('.json') ? r.json() : new Uint8Array(await r.arrayBuffer());
    })).catch(e => { wardrobe = null; throw e; });
  }
  return wardrobe;
}

function maskedGeometry(original, mask, flags) {
  const geometry = new T.BufferGeometry();
  for (const [key, attr] of Object.entries(original.attributes)) geometry.setAttribute(key, attr);
  geometry.morphAttributes = original.morphAttributes;
  geometry.morphTargetsRelative = original.morphTargetsRelative;
  geometry.boundingBox = original.boundingBox;
  geometry.boundingSphere = original.boundingSphere;
  const index = original.index, keep = [];
  for (let i = 0; i < mask.length; i++) {
    if (!(mask[i] & flags)) keep.push(index.getX(3*i), index.getX(3*i+1), index.getX(3*i+2));
  }
  geometry.setIndex(new T.BufferAttribute(new index.array.constructor(keep), 1));
  return geometry;
}

export async function applyWardrobe(actor, flags) {
  if (actor.type !== 'zhenfu') return;
  const [manifest, bytes] = await source();
  const bits = Object.fromEntries(manifest.items.map(item => [item.key, item.bit]));
  // Keep the original sheer and welt textures on their source materials for the fitted skin.
  let sheer,band;
  actor.model.traverse(mesh=>{
    if(mesh.isSkinnedMesh && mesh.userData.gameWear==='stockings'){
      if(mesh.material.name==='sheer')sheer=mesh.material;
      if(mesh.material.name==='sheerBand')band=mesh.material;
    }
  });
  const fitted=manifest.fitRevision==='skirt-knit-2' && !!sheer && !!band;
  actor.model.traverse(mesh => {
    if (!mesh.isSkinnedMesh) return;
    const tag = mesh.userData;
    if(fitted && mesh.geometry.hasAttribute('_hosiery'))
      fitHosiery(actor,mesh,sheer,band,Boolean(flags & bits.stockings));
    if (tag.gameWear) {
      mesh.visible = Boolean(flags & bits[tag.gameWear]);
      if (tag.gameWear === 'stockings') {
        const alternate = flags & bits.pumps ? '_Flat_' : '_Heel_';
        mesh.visible = !fitted && mesh.visible && !tag.wearPart.includes(alternate);
      }
    }
    if (!tag.gameBody) return;
    let v = variants.get(mesh);
    if (!v) {
      const original = mesh.geometry;
      const info = manifest.bodyMasks.find(m => m.mesh === tag.bodyMaskGroup && m.triangles*3 === original.index.count);
      if (!info) throw Error('身体分段与服装覆盖范围不匹配');
      v = { original, mask: bytes.subarray(info.at, info.at+info.triangles), options: new Map([[0, original]]) };
      variants.set(mesh, v);
    }
    if (!v.options.has(flags)) v.options.set(flags, maskedGeometry(v.original, v.mask, flags));
    mesh.geometry = v.options.get(flags);
  });
  actor.model.position.y = flags & bits.pumps ? manifest.shoeLiftMetres : 0;
  actor.revision++;
}

export function disposeWardrobe(actor) {
  disposeHosiery(actor);
  actor.model.traverse(mesh => {
    const v = variants.get(mesh);
    if (!v) return;
    mesh.geometry = v.original;
    for (const [flags, g] of v.options) if (flags) {
      // Only the filtered indices belong to this view. Shared morph/vertex buffers remain in the rig.
      for (const name of Object.keys(g.attributes)) g.deleteAttribute(name);
      g.morphAttributes = {};
      g.dispose();
    }
    variants.delete(mesh);
  });
}
