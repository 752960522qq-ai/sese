import * as T from './vendor/three.module.min.js';

// The leg rig has 85 corrective shapes, although only a few affect any one frame.
// Blend the active original deltas into a private vertex buffer before GPU skinning.
const sourceCache = new WeakMap(),
  deltaCache = new WeakMap();
function packed(attr) {
  if (
    attr.array instanceof Float32Array &&
    !attr.isInterleavedBufferAttribute &&
    !attr.normalized &&
    attr.itemSize === 3
  )
    return attr.array;
  const a = new Float32Array(attr.count * 3);
  for (let v = 0; v < attr.count; v++) {
    const k = 3 * v;
    a[k] = attr.getX(v);
    a[k + 1] = attr.getY(v);
    a[k + 2] = attr.getZ(v);
  }
  return a;
}
function relativeDelta(attr) {
  if (deltaCache.has(attr)) return deltaCache.get(attr);
  const data = packed(attr),
    indices = [];
  for (let k = 0; k < data.length; k += 3) if (data[k] || data[k + 1] || data[k + 2]) indices.push(k);
  const value = indices.length
    ? { data, indices: indices.length < data.length / 6 ? Int32Array.from(indices) : null }
    : null;
  deltaCache.set(attr, value);
  return value;
}
function channels(original) {
  if (sourceCache.has(original)) return sourceCache.get(original);
  const result = [];
  for (const key of ['position', 'normal']) {
    const targets = original.morphAttributes[key];
    if (!targets?.length) continue;
    const deltas = targets.map(relativeDelta);
    if (deltas.some(Boolean)) result.push({ key, base: packed(original.getAttribute(key)), deltas });
  }
  sourceCache.set(original, result);
  return result;
}
export function attachMorphs(mesh) {
  const original = mesh.geometry;
  if (!original?.morphTargetsRelative || !mesh.morphTargetInfluences?.length) return null;
  // Preserve any unsupported channel on Three's normal deformation path.
  if (Object.keys(original.morphAttributes).some((k) => !['position', 'normal'].includes(k)))
    return null;
  const data = channels(original),
    geo = new T.BufferGeometry();
  geo.name = original.name;
  geo.setIndex(original.index);
  for (const [name, attr] of Object.entries(original.attributes)) geo.setAttribute(name, attr);
  geo.groups = original.groups.map((g) => ({ ...g }));
  geo.setDrawRange(original.drawRange.start, original.drawRange.count);
  geo.boundingBox = original.boundingBox?.clone() || null;
  geo.boundingSphere = original.boundingSphere?.clone() || null;
  const blend = data.map((d) => {
    const output = new T.BufferAttribute(d.base.slice(), 3).setUsage(T.DynamicDrawUsage);
    geo.setAttribute(d.key, output);
    return { ...d, output };
  });
  mesh.geometry = geo;
  const previous = new Float64Array(mesh.morphTargetInfluences.length);
  previous.fill(NaN);
  return {
    update() {
      if (!blend.length) return;
      const weights = mesh.morphTargetInfluences;
      if (weights.every((w, i) => w === previous[i])) return;
      previous.set(weights);
      for (const part of blend) {
        const dst = part.output.array;
        dst.set(part.base);
        for (let i = 0; i < weights.length; i++) {
          const w = weights[i],
            d = part.deltas[i];
          if (!w || !d) continue;
          const raw = d.data;
          if (d.indices) {
            for (const k of d.indices) {
              dst[k] += w * raw[k];
              dst[k + 1] += w * raw[k + 1];
              dst[k + 2] += w * raw[k + 2];
            }
          } else for (let k = 0; k < dst.length; k++) dst[k] += w * raw[k];
        }
        part.output.needsUpdate = true;
      }
    },
    dispose() {
      for (const [k, v] of Object.entries(geo.attributes))
        if (original.getAttribute(k) === v) geo.deleteAttribute(k);
      geo.setIndex(null);
      geo.dispose();
    }
  };
}
