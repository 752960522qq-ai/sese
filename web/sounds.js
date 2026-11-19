const MAX_CUES = 64;
const MAX_DELAY = 3600;
const LIMIT = (v, min, max) => Math.max(min, Math.min(max, v));
const number = (value, fallback) => (Number.isFinite(value) ? value : fallback);

export async function loadSoundBank() {
  const response = await fetch('./audio/cues.json');
  if (!response.ok) throw Error('无法读取声音素材');
  return new SoundBank(await response.json());
}

class SoundBank {
  constructor(list) {
    this.clips = new Map(list.map((c) => [c.id, c]));
    this.decoding = new Map();
    this.buffers = new Map();
    this.context = null;
    this.previewNode = null;
    this.previewVersion = 0;
  }
  async unlock() {
    if (!this.context) {
      const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!Context) throw Error('当前系统无法播放游戏音效');
      this.context = new Context();
      const limiter = this.context.createDynamicsCompressor();
      limiter.threshold.value = -3;
      limiter.knee.value = 3;
      limiter.ratio.value = 12;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.12;
      limiter.connect(this.context.destination);
      this.output = limiter;
    }
    if (this.context.state !== 'running') await this.context.resume();
  }
  async preload(ids) {
    await Promise.all([...new Set(ids)].map((id) => this.decode(id)));
  }
  async decode(id) {
    if (this.buffers.has(id)) return this.buffers.get(id);
    if (this.decoding.has(id)) return this.decoding.get(id);
    const clip = this.clips.get(id);
    if (!clip) throw Error('声音素材不可用');
    const request = (async () => {
      const response = await fetch('./audio/' + clip.path);
      if (!response.ok) throw Error('声音读取失败');
      const audio = await this.context.decodeAudioData(await response.arrayBuffer());
      this.buffers.set(id, audio);
      return audio;
    })().finally(() => this.decoding.delete(id));
    this.decoding.set(id, request);
    return request;
  }
  playBuffer(id, gain, when, skip, finished) {
    const buffer = this.buffers.get(id);
    if (!buffer || skip >= buffer.duration || !gain) return null;
    const context = this.context,
      source = context.createBufferSource(),
      level = context.createGain();
    source.buffer = buffer;
    level.gain.value = gain;
    source.connect(level);
    level.connect(this.output);
    source.onended = () => {
      source.disconnect();
      level.disconnect();
      finished(source);
    };
    source.start(when, skip);
    return source;
  }
  stopPreview() {
    this.previewVersion++;
    this.previewNode?.stop();
    this.previewNode = null;
  }
  async preview(id) {
    this.stopPreview();
    const version = this.previewVersion;
    await this.unlock();
    await this.decode(id);
    if (version !== this.previewVersion) return;
    this.previewNode = this.playBuffer(id, 1, this.context.currentTime, 0, (node) => {
      if (this.previewNode === node) this.previewNode = null;
    });
  }
}

export class SoundTrack {
  constructor(actorState, bank) {
    this.bank = bank;
    const saved = actorState.audio || {};
    const cues = Array.isArray(saved.cues)
      ? saved.cues.filter((c) => c && bank.clips.has(c.id))
      : [];
    this.state = actorState.audio = {
      time: 0,
      loop: saved.loop === true,
      cues: cues.slice(0, MAX_CUES).map((c) => ({
        id: c.id,
        at: LIMIT(number(c.at, 0), 0, MAX_DELAY),
        gain: LIMIT(number(c.gain, 1), 0, 1)
      }))
    };
    this.state.time = LIMIT(number(saved.time, 0), 0, this.duration);
    this.nodes = new Set();
    this.run = null;
    this.pending = 0;
  }
  get duration() {
    return this.state.cues.reduce(
      (end, c) => Math.max(end, c.at + this.bank.clips.get(c.id).duration),
      0
    );
  }
  get time() {
    if (!this.run) return this.state.time;
    const offset = Math.max(0, this.bank.context.currentTime - this.run.when) + this.run.from;
    return this.state.loop ? offset % this.run.length : Math.min(offset, this.run.length);
  }
  snapshot() {
    return {
      time: Number(this.time.toFixed(5)),
      loop: this.state.loop,
      cues: this.state.cues.map((c) => ({ ...c }))
    };
  }
  add(id) {
    if (!this.bank.clips.has(id)) return -1;
    if (this.state.cues.length >= MAX_CUES) throw Error('每个角色最多放置 64 条声音');
    this.pause();
    this.state.cues.push({ id, at: Math.min(this.state.time, MAX_DELAY), gain: 1 });
    return this.state.cues.length - 1;
  }
  update(index, change) {
    const cue = this.state.cues[index];
    if (!cue) return;
    this.pause();
    if (change === null) this.state.cues.splice(index, 1);
    else {
      cue.at = LIMIT(number(change.at, cue.at), 0, MAX_DELAY);
      cue.gain = LIMIT(number(change.gain, cue.gain), 0, 1);
    }
    this.state.time = Math.min(this.state.time, this.duration);
  }
  seek(t) {
    this.pause();
    this.state.time = LIMIT(number(t, 0), 0, this.duration);
  }
  pause() {
    this.pending++;
    this.state.time = this.time;
    this.run = null;
    for (const node of this.nodes) node.stop();
    this.nodes.clear();
  }
  schedule(when, from) {
    const now = this.bank.context.currentTime;
    for (const cue of this.state.cues) {
      const start = when + cue.at - from,
        begin = Math.max(now, when, start);
      const node = this.bank.playBuffer(cue.id, cue.gain, begin, begin - start, (finished) =>
        this.nodes.delete(finished)
      );
      if (node) this.nodes.add(node);
    }
  }
  start(when, position) {
    this.pause();
    const length = this.duration;
    if (!length) return;
    const from = position >= length - 0.0001 ? 0 : position;
    this.state.time = from;
    this.run = { when, from, length, next: when + length - from };
    this.schedule(when, from);
  }
  async play() {
    if (!this.duration) return;
    const version = ++this.pending;
    await this.bank.unlock();
    await this.bank.preload(this.state.cues.map((c) => c.id));
    if (version !== this.pending) return;
    this.start(this.bank.context.currentTime + 0.04, this.state.time);
  }
  tick() {
    if (!this.run) return;
    const now = this.bank.context.currentTime,
      run = this.run;
    if (!this.state.loop) {
      if (now >= run.next) this.pause();
      return;
    }
    if (run.next < now - run.length)
      run.next += Math.floor((now - run.next) / run.length) * run.length;
    if (run.next <= now + 0.22) {
      this.schedule(run.next, 0);
      run.next += run.length;
    }
  }
}
