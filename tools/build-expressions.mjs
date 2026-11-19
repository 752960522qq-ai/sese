import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Quaternion, Vector3 } from '../app/src/main/assets/vendor/three.module.min.js';
import { clips } from './expression-curves.mjs';

// Bake absolute local tracks with a neutral first frame. The same GLB is used by
// the additive player and can be opened as an animation library in a DCC.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const folder = resolve(root, 'app/src/main/assets/models/zhenfu');
const src = JSON.parse(readFileSync(resolve(folder, 'actor.gltf'), 'utf8'));
const buffers = src.buffers.map(buffer => readFileSync(resolve(folder, buffer.uri)));
const skin = src.skins[0],
  component = { SCALAR: 1, VEC3: 3, VEC4: 4, MAT4: 16 };
const local = (n, p) =>
  n[p] || (p === 'rotation' ? [0, 0, 0, 1] : p === 'scale' ? [1, 1, 1] : [0, 0, 0]);
function readFloats(index) {
  const a = src.accessors[index],
    view = src.bufferViews[a.bufferView],
    size = component[a.type];
  if (a.componentType !== 5126 || a.sparse || !size) throw Error('Expected dense float accessor');
  const at = (view.byteOffset || 0) + (a.byteOffset || 0),
    step = view.byteStride || size * 4;
  return Array.from({ length: a.count }, (_, i) =>
    Array.from({ length: size }, (_, j) => buffers[view.buffer].readFloatLE(at + i * step + 4 * j))
  );
}
const parts = [],
  views = [],
  accessors = [],
  cache = new Map();
let size = 0;
function accessor(kind, values, arity, componentType = 5126, bounds = false) {
  const bytes = Buffer.from(
    (componentType === 5126 ? new Float32Array(values) : new Uint8Array(values)).buffer
  );
  const hash = kind + ':' + componentType + ':' + bytes.toString('base64');
  if (cache.has(hash)) return cache.get(hash);
  const id = accessors.length;
  cache.set(hash, id);
  const v = { buffer: 0, byteOffset: size, byteLength: bytes.length };
  const item = {
    bufferView: views.length,
    componentType,
    count: values.length / arity,
    type: kind
  };
  if (bounds) {
    item.min = Array(arity).fill(Infinity);
    item.max = Array(arity).fill(-Infinity);
    values.forEach((x, i) => {
      const j = i % arity;
      item.min[j] = Math.min(item.min[j], Math.fround(x));
      item.max[j] = Math.max(item.max[j], Math.fround(x));
    });
  }
  views.push(v);
  accessors.push(item);
  parts.push(bytes);
  const padding = (4 - (bytes.length % 4)) % 4;
  if (padding) parts.push(Buffer.alloc(padding));
  size += bytes.length + padding;
  return id;
}

const keep = new Set(skin.joints),
  parents = new Map();
src.nodes.forEach((n, i) => n.children?.forEach((c) => parents.set(c, i)));
for (const child of skin.joints) {
  for (let i = child; parents.has(i); i = parents.get(i)) keep.add(parents.get(i));
}
const original = [...keep].sort((a, b) => a - b);
const remap = new Map(original.map((old, i) => [old, i]));
const nodes = original.map((i) => {
  const n = src.nodes[i],
    out = { name: n.name };
  for (const key of ['translation', 'rotation', 'scale', 'matrix']) if (n[key]) out[key] = n[key];
  const children = (n.children || []).filter((c) => keep.has(c)).map((c) => remap.get(c));
  if (children.length) out.children = children;
  return out;
});
const index = new Map(nodes.map((n, i) => [n.name, i]));
const id = (name) => {
  if (!index.has(name)) throw Error('Unbound R19 bone ' + name);
  return index.get(name);
};
const binding = nodes.length;
nodes.push({ name: 'AnimationLibrary_Binding', mesh: 0, skin: 0 });
nodes[id('Armature')].children.push(binding);
// A single zero-area triangle makes Blender and Godot import an actual skeleton.
const marker = {
  POSITION: accessor('VEC3', Array(9).fill(0), 3, 5126, true),
  JOINTS_0: accessor('VEC4', Array(12).fill(0), 4, 5121),
  WEIGHTS_0: accessor('VEC4', [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4)
};
const ibm = accessor('MAT4', readFloats(skin.inverseBindMatrices).flat(), 16);
function rotVector(q) {
  q.normalize();
  const sign = q.w < 0 ? -1 : 1,
    s = Math.hypot(q.x, q.y, q.z);
  const k = s < 1e-9 ? 2 * sign : ((2 * Math.atan2(s, sign * q.w)) / s) * sign;
  return [q.x * k, q.y * k, q.z * k];
}
const rules = new Map();
function rule(name, path, control, amount) {
  if (Math.hypot(...amount) < 0.000001) return;
  const key = name + '.' + path;
  if (!rules.has(key)) rules.set(key, { node: id(name), path, basis: [] });
  rules.get(key).basis.push([control, amount]);
}
for (const [reference, key, apex] of [
  ['Blink', 'lid', 0.29],
  ['Smile', 'smile', 0.78],
  ['BrowRaise', 'brow', 0.61],
  ['JawOpen', 'jaw', 0.72]
]) {
  const baseClip = src.animations.find((a) => a.name === reference);
  for (const channel of baseClip.channels) {
    const target = src.nodes[channel.target.node],
      name = target.name,
      path = channel.target.path;
    const samp = baseClip.samplers[channel.sampler],
      times = readFloats(samp.input).flat();
    const k = times.reduce(
      (best, t, i) => (Math.abs(t - apex) < Math.abs(times[best] - apex) ? i : best),
      0
    );
    const value = readFloats(samp.output)[k],
      rest = local(target, path);
    const vector =
      path === 'rotation'
        ? rotVector(
            new Quaternion().fromArray(rest).invert().multiply(new Quaternion().fromArray(value))
          )
        : value.map((v, i) => v - rest[i]);
    const side = name.match(/_([LR])$/)?.[1] || '';
    rule(name, path, key + (key === 'jaw' ? '' : side), vector);
  }
}
for (const [side, sgn, eye] of [
  ['L', 1, 'jointEyeLeft'],
  ['R', -1, 'jointEyeRight']
]) {
  rule('mouth_04_' + side, 'translation', 'round', [-sgn * 0.0027, -0.00055, 0.0023]);
  rule('mouth_04_' + side, 'translation', 'press', [-sgn * 0.00055, 0.0005, -0.0005]);
  for (const [name, dy] of [
    ['upperlip_top_01_', -0.0014],
    ['lowerlip_bottom_01_', 0.00165]
  ]) {
    rule(name + side, 'translation', 'press', [0, dy, -0.0004]);
    rule(name + side, 'translation', 'round', [-sgn * 0.00075, 0, 0.0015]);
  }
  for (const [part, k] of [
    ['00', 1],
    ['01', 0.65],
    ['03', 0.2]
  ]) {
    rule('eyebrow_bottom_' + part + '_' + side, 'translation', 'knit', [
      -sgn * 0.0023 * k,
      -0.00165 * k,
      0.00035 * k
    ]);
  }
  rule(eye, 'rotation', 'lookX', [0, Math.PI / 180, 0]);
  rule(eye, 'rotation', 'lookY', [-Math.PI / 180, 0, 0]);
}
for (const [name, dy] of [
  ['upperlip_top_M', -0.00155],
  ['lowerlip_bottom_M', 0.00195]
]) {
  rule(name, 'translation', 'press', [0, dy, -0.00045]);
  rule(name, 'translation', 'round', [0, 0, 0.0021]);
}

// Monotone cubic interpolation slows into a hold without overshooting a lid or lip.
function makeCurve(keys, end) {
  const pts = [[0, 0], ...keys, [end, 0]];
  if (pts.some(([t, v], i) => !Number.isFinite(v) || (i && t <= pts[i - 1][0])))
    throw Error('Invalid control times');
  const slopes = pts.slice(1).map(([t, v], i) => (v - pts[i][1]) / (t - pts[i][0]));
  const tangent = pts.map((p, i) => {
    if (!i || i === pts.length - 1 || slopes[i - 1] * slopes[i] <= 0) return 0;
    const left = p[0] - pts[i - 1][0],
      right = pts[i + 1][0] - p[0];
    const a = 2 * right + left,
      b = right + 2 * left;
    return (a + b) / (a / slopes[i - 1] + b / slopes[i]);
  });
  return (t) => {
    if (t <= 0 || t >= end) return 0;
    const i = pts.findIndex(([x]) => x >= t) - 1,
      h = pts[i + 1][0] - pts[i][0],
      u = (t - pts[i][0]) / h;
    return (
      (1 + 2 * u) * (1 - u) ** 2 * pts[i][1] +
      u * (1 - u) ** 2 * h * tangent[i] +
      u * u * (3 - 2 * u) * pts[i + 1][1] +
      u * u * (u - 1) * h * tangent[i + 1]
    );
  };
}
function valueAt(curves, key, t) {
  if (curves[key]) return curves[key](t);
  if (key === 'smile' && (curves.smileL || curves.smileR))
    return ((curves.smileL?.(t) || 0) + (curves.smileR?.(t) || 0)) / 2;
  return 0;
}
function simplify(times, values, tol) {
  const selected = new Set([0, times.length - 1]);
  function split(a, b) {
    let max = tol,
      pick = -1;
    for (let j = a + 1; j < b; j++) {
      const u = (times[j] - times[a]) / (times[b] - times[a]);
      const error = Math.hypot(
        ...values[j].map((v, k) => v - values[a][k] - (values[b][k] - values[a][k]) * u)
      );
      if (error > max) {
        max = error;
        pick = j;
      }
    }
    if (pick !== -1) {
      selected.add(pick);
      split(a, pick);
      split(pick, b);
    }
  }
  split(0, times.length - 1);
  return [...selected].sort((a, b) => a - b);
}
function bake(clip) {
  const { name, label, kind, duration, keys, reference } = clip;
  const curves = Object.fromEntries(
    Object.entries(keys).map(([key, points]) => [key, makeCurve(points, duration)])
  );
  const timeSet = new Set([
    0,
    duration,
    ...Object.values(keys)
      .flat()
      .map((p) => p[0])
  ]);
  for (let i = 1; i < duration * 30; i++) timeSet.add(Number((i / 30).toFixed(6)));
  const times = [...timeSet].sort((a, b) => a - b);
  const channels = [],
    samplers = [];
  function track(node, path, values) {
    const rest = local(nodes[node], path);
    if (values.every((v) => v.every((x, i) => Math.abs(x - rest[i]) < 1e-7))) return;
    const isRot = path === 'rotation',
      pick = simplify(times, values, isRot ? 0.00018 : path === 'scale' ? 0.000018 : 0.000005);
    channels.push({ sampler: samplers.length, target: { node, path } });
    samplers.push({
      input: accessor(
        'SCALAR',
        pick.map((i) => times[i]),
        1,
        5126,
        true
      ),
      output: accessor(
        isRot ? 'VEC4' : 'VEC3',
        pick.flatMap((i) => values[i]),
        isRot ? 4 : 3
      ),
      interpolation: 'LINEAR'
    });
  }
  if (kind === 'breath') {
    const chest = id('mixamorig:Spine2'),
      values = times.map((t) => 1 + 0.031 * curves.expand(t));
    track(
      chest,
      'scale',
      values.map((k) => local(nodes[chest], 'scale').map((v) => v * k))
    );
    for (const child of nodes[chest].children)
      for (const path of ['translation', 'scale'])
        track(
          child,
          path,
          values.map((k) => local(nodes[child], path).map((v) => v / k))
        );
  } else {
    for (const { node, path, basis } of rules.values()) {
      const values = times.map((t) => {
        const d = new Vector3();
        for (const [key, v] of basis) d.addScaledVector(new Vector3(...v), valueAt(curves, key, t));
        const rest = local(nodes[node], path);
        if (path === 'translation') return d.add(new Vector3(...rest)).toArray();
        const angle = d.length(),
          q = new Quaternion().fromArray(rest);
        if (angle > 1e-9)
          q.multiply(new Quaternion().setFromAxisAngle(d.divideScalar(angle), angle));
        return q.normalize().toArray();
      });
      track(node, path, values);
    }
  }
  if (!channels.length) throw Error('Empty expression ' + name);
  return {
    name,
    channels,
    samplers,
    extras: { label, kind, duration, ...(reference ? { reference } : {}) }
  };
}
const animations = clips.map(bake);
const lidTravel = Object.fromEntries(
  ['L', 'R'].map((side) => [side, rules.get('eyelid_02_' + side + '.translation').basis[0][1]])
);
const out = {
  asset: {
    version: '2.0',
    generator: 'Sese Pose Studio',
    extras: { rig: 'Zhenfu R19', lidTravel }
  },
  scene: 0,
  scenes: [{ nodes: original.filter((i) => !parents.has(i)).map((i) => remap.get(i)) }],
  nodes,
  skins: [
    { joints: skin.joints.map((i) => remap.get(i)), inverseBindMatrices: ibm, name: 'Armature' }
  ],
  meshes: [{ name: 'Library_Binding', primitives: [{ attributes: marker }] }],
  animations,
  accessors,
  bufferViews: views,
  buffers: [{ byteLength: size }]
};
const json = Buffer.from(JSON.stringify(out)),
  binary = Buffer.concat(parts);
const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20);
json.copy(padded);
const header = Buffer.alloc(20);
header.write('glTF');
header.writeUInt32LE(2, 4);
header.writeUInt32LE(28 + padded.length + binary.length, 8);
header.writeUInt32LE(padded.length, 12);
header.write('JSON', 16);
const binHeader = Buffer.alloc(8);
binHeader.writeUInt32LE(binary.length);
binHeader.write('BIN\0', 4);
writeFileSync(
  resolve(folder, 'expressions.glb'),
  Buffer.concat([header, padded, binHeader, binary])
);
console.log(
  'Expression library',
  animations.length,
  'clips,',
  binary.length,
  'bytes of tracks and bind data'
);
