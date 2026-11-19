import * as T from './vendor/three.module.min.js';
import { GLTFLoader } from './vendor/loaders/GLTFLoader.js';

const limit = (x, low, high) => Math.max(low, Math.min(high, x));
const delta = new T.Vector3(),
  rotation = new T.Quaternion(),
  identity = new T.Quaternion();

export async function loadExpressions(path) {
  const gltf = await new GLTFLoader().loadAsync(path);
  const definitions = gltf.parser.json.animations;
  const clips = new Map(
    gltf.animations.map((clip, i) => {
      const meta = definitions[i].extras;
      const tracks = clip.tracks.map((track) => {
        const { nodeName, propertyName } = T.PropertyBinding.parseTrackName(track.name);
        return { nodeName, propertyName, sample: track.createInterpolant() };
      });
      return [clip.name, { ...meta, name: clip.name, duration: clip.duration, tracks }];
    })
  );
  return { clips, lidTravel: gltf.parser.json.asset.extras.lidTravel };
}

function initialPhase(id) {
  if (id === 'lead') return 0;
  // Different copies should not blink and inhale together.
  let hash = 0;
  for (const c of id) hash = (Math.imul(hash, 31) + c.charCodeAt(0)) >>> 0;
  return (hash % 13001) / 1000;
}
export class ExpressionLayer {
  constructor(actor, library) {
    this.library = library;
    this.targets = new Map();
    this.bound = new Map();
    for (const [name, clip] of library.clips) {
      const tracks = clip.tracks.map((track) => {
        const { nodeName, propertyName } = track;
        const node = actor.bones.get(nodeName);
        if (!node) throw Error('表情骨骼缺失 ' + nodeName);
        if (!this.targets.has(nodeName)) {
          this.targets.set(nodeName, {
            node,
            restP: node.position.clone(),
            restQ: node.quaternion.clone(),
            p: new T.Vector3(),
            q: new T.Quaternion(),
            s: new T.Vector3()
          });
        }
        return {
          ...track,
          target: this.targets.get(nodeName),
          lid: /^eyelid_/.test(nodeName) ? nodeName.slice(-1) : ''
        };
      });
      this.bound.set(name, tracks);
    }
    this.lids = {};
    for (const side of ['L', 'R']) {
      this.lids[side] = {
        target: this.targets.get('eyelid_02_' + side),
        travel: new T.Vector3(...library.lidTravel[side])
      };
    }
    this.chest = this.bound
      .get('Idle_Breath')
      .find((t) => t.propertyName === 'scale' && t.nodeName.endsWith('Spine2'));
    this.chestScale = this.chest.target.node.scale.x;
    this.branch = this.chest.target.node.children.filter((child) => child.isBone);
    this.jaw = this.targets.get('jaw_hinge');
    this.active = false;
    const raw = actor.state.expression || {};
    const known = library.clips.get(raw.clip);
    const clip = known && ['enjoy', 'other'].includes(known.kind) ? known : null;
    this.state = actor.state.expression = {
      clip: clip?.name || '',
      time: limit(Number.isFinite(raw.time) ? raw.time : 0, 0, clip?.duration || 0),
      strength: limit(Number.isFinite(raw.strength) ? raw.strength : 1, 0, 1),
      delay: limit(Number.isFinite(raw.delay) ? raw.delay : 0, 0, 3600),
      wait: limit(Number.isFinite(raw.wait) ? raw.wait : 0, 0, 3600),
      playing: Boolean(raw.playing && clip),
      loop: raw.loop !== false,
      blink: raw.blink !== false,
      breath: raw.breath !== false,
      idleTime: Number.isFinite(raw.idleTime)
        ? Math.max(0, raw.idleTime)
        : initialPhase(actor.state.id)
    };
  }
  get clip() {
    return this.library.clips.get(this.state.clip);
  }
  advance(dt) {
    if (dt <= 0) return false;
    const s = this.state,
      clip = this.clip;
    if (s.blink || s.breath) s.idleTime += dt;
    const playing = s.playing && !!clip;
    if (playing) {
      const wait = Math.min(dt, s.wait);
      s.wait -= wait;
      s.time += dt - wait;
      if (s.time >= clip.duration) {
        if (s.loop) s.time %= clip.duration;
        else {
          s.time = clip.duration;
          s.playing = false;
        }
      }
    }
    return s.blink || s.breath || playing;
  }
  restore() {
    if (!this.active) return;
    for (const { node, p, q, s } of this.targets.values()) {
      node.position.copy(p);
      node.quaternion.copy(q);
      node.scale.copy(s);
    }
    this.active = false;
  }
  openFraction(side) {
    const { target, travel } = this.lids[side];
    const closure =
      delta.subVectors(target.node.position, target.restP).dot(travel) / travel.lengthSq();
    return 1 - limit(closure, 0, 1);
  }
  applyFace(clip, time, strength) {
    const openL = this.openFraction('L'),
      openR = this.openFraction('R');
    const jaw = rotation.copy(this.jaw.restQ).invert().multiply(this.jaw.node.quaternion);
    const jawRoom = 1 - limit((2 * Math.atan2(jaw.x, jaw.w)) / 0.147, 0, 1);
    for (const { sample, propertyName, target, lid } of this.bound.get(clip.name)) {
      const room = lid === 'L' ? openL : lid === 'R' ? openR : target === this.jaw ? jawRoom : 1;
      const gain = strength * room;
      if (!gain) continue;
      const v = sample.evaluate(time);
      if (propertyName === 'position') {
        target.node.position.addScaledVector(delta.fromArray(v).sub(target.restP), gain);
      } else {
        rotation.copy(target.restQ).invert().multiply(deltaRotation.fromArray(v));
        target.node.quaternion
          .multiply(deltaRotation.copy(identity).slerp(rotation, gain))
          .normalize();
      }
    }
  }
  apply() {
    const s = this.state,
      clip = this.clip;
    if (!(clip && s.strength) && !s.blink && !s.breath) return;
    for (const target of this.targets.values()) {
      target.p.copy(target.node.position);
      target.q.copy(target.node.quaternion);
      target.s.copy(target.node.scale);
    }
    this.active = true;
    if (clip && s.strength) this.applyFace(clip, s.time, s.strength);
    if (s.blink) {
      const blink = this.library.clips.get('Idle_Blink');
      this.applyFace(blink, s.idleTime % blink.duration, 1);
    }
    if (s.breath) {
      const breath = this.library.clips.get('Idle_Breath');
      const k = this.chest.sample.evaluate(s.idleTime % breath.duration)[0] / this.chestScale;
      this.chest.target.node.scale.multiplyScalar(k);
      // Cancel the chest dilation in the animated child frames. A planted hand
      // and the head keep their world transforms even on a custom body pose.
      for (const child of this.branch) {
        child.position.divideScalar(k);
        child.scale.divideScalar(k);
      }
    }
  }
}
const deltaRotation = new T.Quaternion();
