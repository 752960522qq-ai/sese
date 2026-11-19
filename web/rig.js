import * as T from './vendor/three.module.min.js';
import { GLTFLoader } from './vendor/loaders/GLTFLoader.js';
import { useOriginalWeights } from './skin.js';
import { attachMorphs } from './morph.js';
import { disposeWardrobe } from './wardrobe.js';
import { loadExpressions, ExpressionLayer } from './expressions.js';

export const characterNames = { zhenfu: '甄芙', leon: '里昂' };
export const clipNames = {
  Idle: '待机',
  Walk: '行走',
  Run: '奔跑',
  APose: 'A 字姿势',
  Face_Test: '表情连播',
  Blink: '眨眼',
  BrowRaise: '抬眉',
  Smile: '微笑',
  JawOpen: '张嘴',
  '@rest': '绑定姿势',
  '@keys': '自编动作'
};
const aliases = [
  ['骨盆', 'Hips', 'COG'],
  ['阴茎根部', 'ZF_Penis_Root', 'Leon_Penis_Root'],
  ['阴茎中段', 'ZF_Penis_Mid', 'Leon_Penis_Mid'],
  ['阴茎前端', 'ZF_Penis_Tip', 'Leon_Penis_Tip'],
  ['腰部', 'Spine', 'spine_0'],
  ['胸部', 'Spine2', 'spine_2'],
  ['颈部', 'Neck', 'neck_0'],
  ['头部', 'Head', 'head'],
  ...['左', '右'].flatMap((side, i) => {
    const mix = i ? 'Right' : 'Left',
      re = i ? 'r_' : 'l_';
    return [
      ['肩', 'Shoulder', 'arm_clavicle'],
      ['上臂', 'Arm', 'arm_humerus'],
      ['前臂', 'ForeArm', 'arm_radius'],
      ['手腕', 'Hand', 'arm_wrist'],
      ['大腿', 'UpLeg', 'leg_femur'],
      ['小腿', 'Leg', 'leg_tibia'],
      ['脚踝', 'Foot', 'leg_ankle'],
      ['脚趾', 'ToeBase', 'leg_ball']
    ].map(([cn, m, r]) => [side + cn, mix + m, re + r]);
  })
];
const snapshots = new Map();
const q0 = new T.Quaternion(),
  q1 = new T.Quaternion(),
  euler = new T.Euler(),
  deg = T.MathUtils.degToRad;
const copy = (value) => JSON.parse(JSON.stringify(value));
const compact = (a) => a.map((x) => Number(x.toFixed(6)));
const changed = (a, b) => a.some((v, i) => Math.abs(v - b[i]) > 0.000004);
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export function sortedJoints(actor) {
  const ordered = [],
    used = new Set();
  for (const [label, z, l] of aliases) {
    const name = Array.from(actor.bones.keys()).find((n) =>
      actor.type === 'leon'
        ? n === l
        : n.toLowerCase().replace(/^mixamorig:?/, '') === z.toLowerCase()
    );
    if (name && !used.has(name)) {
      ordered.push([name, label]);
      used.add(name);
    }
  }
  return [
    ordered,
    Array.from(actor.bones.keys())
      .filter((k) => !used.has(k))
      .map((k) => [k, k])
  ];
}

// Load each original image once. Limit the decoded GPU copy and concurrent decodes on phones.
async function template(type, progress) {
  if (snapshots.has(type)) return snapshots.get(type);
  const request = (async () => {
    const base = './models/' + type + '/',
      res = await fetch(base + (type === 'zhenfu' ? 'dressed.gltf' : 'actor.gltf'));
    if (!res.ok) throw Error('无法读取角色模型');
    const spec = await res.json(),
      sizes = new Map(spec.images.map((i) => [i.uri, i.extras.studioSize]));
    const queue = [],
      errors = [];
    let working = 0,
      complete = 0;
    function pump() {
      while (working < 2 && queue.length) {
        working++;
        const job = queue.shift();
        job().finally(() => {
          working--;
          pump();
        });
      }
    }
    const maps = {
      isImageBitmapLoader: true,
      load(url, onLoad, _progress, onError) {
        queue.push(async () => {
          try {
            const result = await fetch(url);
            if (!result.ok) throw Error('贴图读取失败');
            const blob = await result.blob(),
              [w, h] = sizes.get(url.split('/').pop());
            const requested = Number(localStorage.getItem('pose.texture.limit')) || 1024;
            const limit = [1024, 2048, 4096].includes(requested) ? requested : 1024;
            const ratio = Math.min(1, limit / Math.max(w, h));
            const width = Math.max(1, Math.round(w * ratio)),
              height = Math.max(1, Math.round(h * ratio));
            let bitmap;
            try {
              bitmap = await createImageBitmap(blob, {
                resizeWidth: width,
                resizeHeight: height,
                resizeQuality: 'high',
                colorSpaceConversion: 'none',
                premultiplyAlpha: 'none'
              });
            } catch (_) {
              const url = URL.createObjectURL(blob);
              try {
                const img = new Image();
                await new Promise((ok, fail) => {
                  img.onload = ok;
                  img.onerror = fail;
                  img.src = url;
                });
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                canvas.getContext('2d').drawImage(img, 0, 0, width, height);
                bitmap = canvas;
              } finally {
                URL.revokeObjectURL(url);
              }
            }
            onLoad(bitmap);
            progress(characterNames[type] + ' · 纹理 ' + ++complete + ' / ' + sizes.size);
          } catch (e) {
            errors.push(e);
            onError(e);
          }
        });
        pump();
      }
    };
    const manager = new T.LoadingManager();
    manager.addHandler(/\.(png|jpg)$/i, maps);
    const gltf = await new GLTFLoader(manager).parseAsync(spec, base);
    if (errors.length) throw errors[0];
    if (type === 'leon') useOriginalWeights(gltf.scene);
    gltf.scene.traverse((n) => {
      if (n.isSkinnedMesh) n.frustumCulled = false;
    });
    const metadata = new Map(spec.animations.map((a) => [a.name, a.extras || {}]));
    const expressions = type === 'zhenfu' ? await loadExpressions(base + 'expressions.glb') : null;
    return {
      scene: gltf.scene,
      clips: new Map(gltf.animations.map((c) => [c.name, c])),
      metadata,
      expressions
    };
  })().catch((e) => {
    snapshots.delete(type);
    throw e;
  });
  snapshots.set(type, request);
  return request;
}
function independentRig(source) {
  const model = source.clone(true),
    paired = new Map();
  function pair(a, b) {
    paired.set(a, b);
    a.children.forEach((child, i) => pair(child, b.children[i]));
  }
  pair(source, model);
  for (const [original, cloned] of paired) {
    if (!original.isSkinnedMesh) continue;
    const skeleton = original.skeleton.clone();
    skeleton.bones = original.skeleton.bones.map((b) => paired.get(b));
    cloned.bind(skeleton, original.bindMatrix);
    cloned.frustumCulled = false;
  }
  return model;
}
export function fresh(type, id, label, x = 0) {
  return {
    type,
    id,
    label,
    p: [x, 0, 0],
    yaw: 0,
    clip: type === 'zhenfu' ? 'Idle' : '08',
    time: 0,
    dir: 1,
    playing: false,
    rate: 1,
    offsets: {},
    keys: []
  };
}
export class Actor {
  static async create(state, progress) {
    return new Actor(state, await template(state.type, progress));
  }
  constructor(state, source) {
    this.state = copy(state);
    this.type = state.type;
    this.source = source;
    this.model = independentRig(source.scene);
    this.root = new T.Group();
    this.root.add(this.model);
    this.mixer = new T.AnimationMixer(this.model);
    this.bones = new Map();
    this.rest = new Map();
    this.morph = [];
    this.restMorph = [];
    this.deformers = [];
    this.model.traverse((n) => {
      if (n.isBone) {
        this.bones.set(n.name, n);
        this.rest.set(n.name, {
          p: n.position.toArray(),
          q: n.quaternion.toArray(),
          s: n.scale.toArray()
        });
      }
      if (n.morphTargetInfluences?.length) {
        this.morph.push(n);
        this.restMorph.push(n.morphTargetInfluences.slice());
        const driver = attachMorphs(n);
        if (driver) this.deformers.push(driver);
      }
    });
    this.revision = 0;
    this.applied = [];
    this.action = null;
    this.activeName = '';
    this.lastMotion = null;
    this.face = source.expressions ? new ExpressionLayer(this, source.expressions) : null;
    this.apply();
  }
  get duration() {
    return this.state.clip === '@keys'
      ? this.state.keys.at(-1)?.t || 0
      : this.source.clips.get(this.state.clip)?.duration || 0;
  }
  get fps() {
    const meta = this.source.metadata.get(this.state.clip) || {};
    return Number(meta.fps || meta.sample_rate || meta.fps_assumption) || 30;
  }
  stopOffsets() {
    for (const [bone, previous] of this.applied) bone.quaternion.copy(previous);
    this.applied.length = 0;
  }
  restPose() {
    for (const [name, b] of this.bones) {
      const r = this.rest.get(name);
      b.position.fromArray(r.p);
      b.quaternion.fromArray(r.q);
      b.scale.fromArray(r.s);
    }
    this.morph.forEach((n, i) => {
      for (let j = 0; j < n.morphTargetInfluences.length; j++)
        n.morphTargetInfluences[j] = this.restMorph[i][j];
    });
  }
  setClip(name) {
    if (this.activeName === name) return;
    this.stopOffsets();
    if (this.action) this.action.stop();
    this.restPose();
    this.activeName = name;
    const clip = this.source.clips.get(name);
    this.action = clip ? this.mixer.clipAction(clip).reset().setLoop(T.LoopOnce, 1) : null;
    if (this.action) {
      this.action.clampWhenFinished = true;
      this.action.play();
      this.action.paused = true;
    }
  }
  transport(dt) {
    const s = this.state,
      d = this.duration;
    if (!s.playing || d <= 0) return;
    const meta = this.source.metadata.get(s.clip) || {},
      back =
        meta.loopMode === 'pingpong' ||
        (this.type === 'zhenfu' && /^\d{3}$/.test(s.clip) && !meta.loop && !meta.static_pose);
    const t = s.time + dt * s.rate * s.dir;
    if (t > d || t < 0) {
      if (back) {
        const phase = ((t % (2 * d)) + 2 * d) % (2 * d);
        s.time = phase > d ? 2 * d - phase : phase;
        s.dir = (phase > d ? -1 : 1) * s.dir;
      } else if (s.clip === '@keys' || meta.static_pose) {
        s.time = clamp(t, 0, d);
        s.playing = false;
      } else {
        s.time = ((t % d) + d) % d;
        s.dir = 1;
      }
    } else s.time = t;
    this.apply();
  }
  walk(clip, time) {
    this.revision++;
    this.face?.restore();
    this.stopOffsets();
    this.setClip(clip);
    if (this.action) {
      this.action.time = time % (this.action.getClip().duration || 1);
      this.mixer.update(0);
    }
    this.place();
    for (const driver of this.deformers) driver.update();
    this.face?.apply();
  }
  place() {
    this.root.position.fromArray(this.state.p);
    this.root.rotation.y = deg(this.state.yaw);
  }
  apply() {
    const s = this.state;
    this.revision++;
    this.face?.restore();
    this.stopOffsets();
    this.setClip(s.clip);
    this.place();
    if (s.clip === '@keys' && s.keys.length) this.sampleKeys();
    else if (this.action) {
      this.action.time = clamp(s.time, 0, this.action.getClip().duration);
      this.mixer.update(0);
    }
    for (const driver of this.deformers) driver.update();
    for (const [name, angles] of Object.entries(s.offsets)) {
      const b = this.bones.get(name);
      if (!b) continue;
      this.applied.push([b, b.quaternion.clone()]);
      b.quaternion.multiply(q0.setFromEuler(euler.set(...angles.map(deg), 'XYZ'))).normalize();
    }
    this.face?.apply();
  }
  refreshExpression() {
    if (!this.face) return;
    this.face.restore();
    this.face.apply();
    this.revision++;
  }
  capture() {
    // A reusable body key must remain independent of the live facial tracks.
    this.face?.restore();
    const joints = {},
      morph = {};
    for (const [name, b] of this.bones) {
      const r = this.rest.get(name),
        v = {};
      for (const [key, arr] of [
        ['p', b.position.toArray()],
        ['q', b.quaternion.toArray()],
        ['s', b.scale.toArray()]
      ]) {
        if (changed(arr, r[key])) v[key] = compact(arr);
      }
      if (Object.keys(v).length) joints[name] = v;
    }
    this.morph.forEach((n, i) => {
      if (changed(n.morphTargetInfluences, this.restMorph[i]))
        morph[i] = compact(n.morphTargetInfluences);
    });
    this.face?.apply();
    return {
      joints,
      morph,
      p: compact(this.root.position.toArray()),
      yaw: Number(T.MathUtils.radToDeg(this.root.rotation.y).toFixed(5))
    };
  }
  sampleKeys() {
    const s = this.state,
      keys = s.keys;
    let right = keys.findIndex((k) => k.t >= s.time);
    if (right < 0) right = keys.length - 1;
    const b = keys[right],
      a = keys[Math.max(0, right - 1)],
      f = b.t > a.t ? clamp((s.time - a.t) / (b.t - a.t), 0, 1) : 0;
    for (const [name, node] of this.bones) {
      const rest = this.rest.get(name),
        ak = a.joints[name] || {},
        bk = b.joints[name] || {};
      for (const [k, v] of [
        ['p', node.position],
        ['s', node.scale]
      ]) {
        const aa = ak[k] || rest[k],
          bb = bk[k] || rest[k];
        v.set(...aa.map((n, i) => n + (bb[i] - n) * f));
      }
      node.quaternion.copy(q0.fromArray(ak.q || rest.q).slerp(q1.fromArray(bk.q || rest.q), f));
    }
    this.morph.forEach((n, i) => {
      const av = a.morph[i] || this.restMorph[i],
        bv = b.morph[i] || this.restMorph[i];
      for (let j = 0; j < av.length; j++) n.morphTargetInfluences[j] = av[j] + (bv[j] - av[j]) * f;
    });
    const first = keys[0],
      delta = a.p.map((n, i) => n + (b.p[i] - n) * f - first.p[i]);
    const angle = deg(s.yaw - first.yaw),
      c = Math.cos(angle),
      sn = Math.sin(angle);
    this.root.position.set(
      s.p[0] + delta[0] * c + delta[2] * sn,
      s.p[1] + delta[1],
      s.p[2] - delta[0] * sn + delta[2] * c
    );
    const turn = ((b.yaw - a.yaw + 540) % 360) - 180;
    this.root.rotation.y = deg(s.yaw + a.yaw + turn * f - first.yaw);
  }
  dispose() {
    disposeWardrobe(this);
    this.sound?.pause();
    for (const driver of this.deformers) driver.dispose();
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.model);
    this.model.traverse((n) => {
      if (n.isSkinnedMesh) n.skeleton.dispose();
    });
    this.root.removeFromParent();
  }
}
