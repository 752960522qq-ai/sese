import * as T from './vendor/three.module.min.js';
import { Actor, fresh, characterNames, clipNames, sortedJoints, clamp } from './rig.js';
import { Stage } from './stage.js';
import * as db from './storage.js';

const $ = (id) => document.getElementById(id),
  copy = (value) => JSON.parse(JSON.stringify(value));
const actors = new Map(),
  keysHeld = new Set(),
  joy = { x: 0, y: 0 };
let stage,
  selected = 'lead',
  mode = 'walk',
  group = false,
  pane = 'motion',
  locked = false,
  walkClock = 0,
  lastGait = '',
  pointer = null,
  toastTimer,
  slotVersion = 0,
  lastFrame = 0,
  contextLost = false;
const chosen = () => actors.get(selected);
const uid = () =>
  globalThis.crypto?.randomUUID?.() ||
  'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
const all = () => Array.from(actors.values());
const visible = () => all().filter((a) => a.root.visible);
const option = (value, label) => new Option(label, value);
function notify(msg) {
  $('toast').textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('toast').textContent = ''), 2600);
}
function progress(msg) {
  $('loadHint').textContent = msg;
}
async function working(label, fn) {
  if (locked) return;
  locked = true;
  resetStick();
  document.body.classList.add('working');
  $('busy').hidden = false;
  progress(label);
  try {
    await fn();
  } catch (e) {
    console.error(e);
    notify(e.message || '操作未完成');
    if (!actors.size) {
      progress('打开失败 · ' + (e.message || '请重启应用'));
      return;
    }
  } finally {
    locked = false;
    document.body.classList.remove('working');
    if (actors.size) $('busy').hidden = true;
  }
}
function safely(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (e) {
      console.error(e);
      notify(e.message || '操作未完成');
    }
  };
}
function stopWalk() {
  const a = actors.get('lead');
  if (lastGait && a) {
    a.apply();
  }
  lastGait = '';
  walkClock = 0;
  resetStick();
}
function resetStick() {
  joy.x = joy.y = 0;
  pointer = null;
  keysHeld.clear();
  $('knob').style.transform = '';
}
function syncVisible() {
  for (const a of actors.values()) a.root.visible = group || a.state.id === selected;
  $('walk').setAttribute('aria-pressed', String(mode === 'walk'));
  $('pose').setAttribute('aria-pressed', String(mode === 'pose'));
  $('group').setAttribute('aria-pressed', String(group));
  $('stick').hidden = mode !== 'walk';
  $('walkGuide').hidden = mode !== 'walk';
  $('poseTools').hidden = mode === 'walk';
  $('sceneLabel').textContent = (group ? '多人' : '单人') + ' · ' + (chosen()?.state.label || '甄芙');
  $('count').textContent = (group ? actors.size : 1) + ' 人';
  $('remove').hidden = selected === 'lead';
}
function setMode(next) {
  if (locked || !actors.size) return;
  if (mode !== next) stopWalk();
  mode = next;
  if (next === 'walk') {
    selected = 'lead';
    walkClock = 0;
    lastGait = '';
  }
  syncAll();
  if (next === 'walk') stage.frame([chosen()]);
}
function setPane(which) {
  pane = which;
  document
    .querySelectorAll('[data-pane]')
    .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.pane === which)));
  for (const k of ['motion', 'transform', 'library']) $('pane-' + k).hidden = k !== which;
  if (which === 'library') refreshSlots().catch((e) => notify(e.message));
}
function panel(open) {
  $('panel').hidden = !open;
  $('togglePanel').textContent = open ? '收起面板' : '编辑面板';
  $('togglePanel').setAttribute('aria-expanded', String(open));
}
function reasonLabel(a, name) {
  if (clipNames[name]) return clipNames[name];
  const meta = a.source.metadata.get(name) || {};
  return meta.group ? name + ' · ' + meta.group + ' ' + (meta.label || '') : '动作 ' + name;
}
function syncAll() {
  const a = chosen();
  if (!a) return;
  syncVisible();
  $('actor').replaceChildren(...all().map((item) => option(item.state.id, item.state.label)));
  $('actor').value = selected;
  const tracks = [...a.source.clips.keys()].sort((x, y) => {
    const nx = /^\d+$/.test(x),
      ny = /^\d+$/.test(y);
    return nx && ny ? Number(x) - Number(y) : nx !== ny ? (nx ? 1 : -1) : 0;
  });
  if (!tracks.includes('APose')) tracks.unshift('@rest');
  if (a.state.keys.length) tracks.push('@keys');
  $('clip').replaceChildren(...tracks.map((k) => option(k, reasonLabel(a, k))));
  $('clip').value = a.state.clip;
  $('rate').value = String(a.state.rate);
  const old = $('joint').value,
    groups = sortedJoints(a);
  $('joint').replaceChildren();
  groups.forEach((members, i) => {
    const o = document.createElement('optgroup');
    o.label = i ? '全部其他关节' : '常用关节';
    o.append(...members.map(([name, label]) => option(name, label)));
    $('joint').append(o);
  });
  if (a.bones.has(old)) $('joint').value = old;
  else if (groups[0].length) $('joint').value = groups[0][0][0];
  readJoint();
  readPosition();
  readKeys();
  clockUI();
  if (pane === 'library') refreshSlots().catch((e) => notify(e.message));
}
function clockUI() {
  const a = chosen();
  if (!a) return;
  const d = a.duration,
    t = clamp(a.state.time, 0, d);
  $('time').max = String(d || 1);
  $('time').value = String(t);
  $('time').disabled = !d;
  $('timeText').textContent = t.toFixed(2) + ' / ' + d.toFixed(2) + ' s';
  $('play').textContent = a.state.playing ? '定格' : '播放';
  $('play').disabled = !d;
}
function selectClip(name) {
  const a = chosen();
  if (!a) return;
  a.state.clip = name;
  a.state.time = 0;
  a.state.dir = 1;
  a.state.playing = false;
  a.state.offsets = {};
  a.apply();
  syncAll();
}
function freeze() {
  const a = chosen();
  if (a) a.state.playing = false;
}
function seek(t) {
  const a = chosen();
  if (!a) return;
  freeze();
  a.state.time = clamp(t, 0, a.duration);
  a.state.dir = 1;
  a.apply();
  clockUI();
}
function play() {
  const a = chosen();
  if (!a || !a.duration) return;
  if (!a.state.playing && a.state.time >= a.duration - 1e-6) {
    a.state.time = 0;
    a.state.dir = 1;
  }
  a.state.playing = !a.state.playing;
  a.apply();
  clockUI();
}
function readJoint() {
  const vals = chosen()?.state.offsets[$('joint').value] || [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    $('rot' + i).value = vals[i];
    $('angle' + i).textContent = vals[i] + '°';
  }
}
function readPosition() {
  const s = chosen()?.state;
  if (!s) return;
  [s.p[0], s.p[1], s.p[2], s.yaw].forEach((v, i) => {
    if (document.activeElement !== $('pos' + i))
      $('pos' + i).value = i === 3 ? v.toFixed(1) : v.toFixed(2);
  });
}
function readKeys() {
  const n = chosen()?.state.keys.length || 0;
  $('keyCount').textContent = n + ' 个关键帧';
  $('removeKey').disabled = !n;
  $('previewKeys').disabled = !n;
}
function setPosition(index, value) {
  if (!Number.isFinite(value)) return;
  const a = chosen();
  if (!a) return;
  if (index === 3) a.state.yaw = ((((value + 180) % 360) + 360) % 360) - 180;
  else a.state.p[index] = clamp(value, -1000, 1000);
  if (mode === 'walk' && a.state.id === 'lead') a.place();
  else a.apply();
  $('pos' + index).value = index === 3 ? a.state.yaw.toFixed(1) : a.state.p[index].toFixed(2);
}
function controls() {
  for (let i = 0; i < 3; i++) {
    const row = document.createElement('div');
    row.className = 'axis';
    const label = document.createElement('label');
    label.htmlFor = 'rot' + i;
    label.textContent = 'XYZ'[i] + ' 轴';
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.id = label.htmlFor;
    slider.min = -180;
    slider.max = 180;
    slider.step = 1;
    const out = document.createElement('output');
    out.id = 'angle' + i;
    out.htmlFor = slider.id;
    row.append(label, slider, out);
    $('jointAxes').append(row);
    slider.oninput = () => {
      const a = chosen(),
        name = $('joint').value;
      if (!a || !name) return;
      freeze();
      const vals = a.state.offsets[name] || (a.state.offsets[name] = [0, 0, 0]);
      vals[i] = Number(slider.value);
      a.apply();
      readJoint();
      clockUI();
    };
  }
  for (const [i, name] of ['X · 米', 'Y · 米', 'Z · 米', '朝向 °'].entries()) {
    const row = document.createElement('div');
    row.className = 'position-axis';
    const label = document.createElement('label');
    label.htmlFor = 'pos' + i;
    label.textContent = name;
    const field = document.createElement('input');
    field.type = 'number';
    field.inputMode = 'decimal';
    field.step = 'any';
    field.id = label.htmlFor;
    function arrow(sign) {
      const btn = document.createElement('button');
      btn.textContent = sign > 0 ? '＋' : '−';
      btn.setAttribute('aria-label', (sign > 0 ? '增加' : '减少') + name);
      btn.onclick = () => {
        const s = chosen()?.state;
        if (!s) return;
        const v = i === 3 ? s.yaw : s.p[i];
        setPosition(i, v + sign * (i === 3 ? 5 : Number($('step').value)));
      };
      return btn;
    }
    field.onchange = () => {
      if (field.value.trim() && Number.isFinite(field.valueAsNumber))
        setPosition(i, field.valueAsNumber);
      else {
        field.blur();
        readPosition();
      }
    };
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') field.blur();
    });
    row.append(label, arrow(-1), field, arrow(1));
    $('worldAxes').append(row);
  }
}
async function add(type) {
  await working('正在添加' + characterNames[type], async () => {
    stopWalk();
    const names = new Set(all().map((a) => a.state.label));
    let label = characterNames[type],
      number = 1;
    while (names.has(label)) label = characterNames[type] + ' ' + ++number;
    const state = fresh(type, uid(), label);
    const prev = chosen();
    state.p = [(prev?.root.position.x || 0) + 0.9, 0, prev?.root.position.z || 0];
    const a = await Actor.create(state, progress);
    actors.set(state.id, a);
    stage.add(a);
    selected = state.id;
    mode = 'pose';
    group = true;
    setPane('motion');
    syncAll();
    stage.frame(visible());
  });
}
function chooseActor(id) {
  if (!actors.has(id)) return;
  stopWalk();
  selected = id;
  mode = 'pose';
  syncAll();
  if (!group) stage.frame([chosen()]);
}
function removeActor() {
  if (selected === 'lead' || !chosen()) return;
  const a = chosen();
  stage.remove(a);
  actors.delete(selected);
  selected = 'lead';
  if (actors.size === 1) group = false;
  syncAll();
  stage.frame(visible());
}
function sceneData() {
  return {
    format: 1,
    selected,
    mode,
    group,
    camera: stage.snapshot(),
    actors: all().map((a) => copy(a.state))
  };
}
function validState(s) {
  return (
    !!s &&
    Object.prototype.hasOwnProperty.call(characterNames, s.type) &&
    typeof s.id === 'string' &&
    typeof s.label === 'string' &&
    Array.isArray(s.p) &&
    s.p.length === 3 &&
    s.p.every(Number.isFinite) &&
    Number.isFinite(s.yaw) &&
    Array.isArray(s.keys) &&
    s.offsets &&
    typeof s.clip === 'string' &&
    Number.isFinite(s.time) &&
    Number.isFinite(s.rate)
  );
}
async function restoreScene(data) {
  if (
    data?.format !== 1 ||
    !Array.isArray(data.actors) ||
    !data.actors.every(validState) ||
    data.actors.filter((x) => x.id === 'lead' && x.type === 'zhenfu').length !== 1 ||
    new Set(data.actors.map((s) => s.id)).size !== data.actors.length
  )
    throw Error('场景版本或角色数据有误');
  const prepared = [];
  try {
    for (const state of data.actors) prepared.push(await Actor.create(state, progress));
  } catch (e) {
    prepared.forEach((a) => a.dispose());
    throw e;
  }
  for (const a of actors.values()) stage.remove(a);
  actors.clear();
  for (const a of prepared) {
    actors.set(a.state.id, a);
    stage.add(a);
  }
  group = Boolean(data.group);
  mode = data.mode === 'walk' ? 'walk' : 'pose';
  selected = mode === 'walk' ? 'lead' : actors.has(data.selected) ? data.selected : 'lead';
  lastGait = '';
  walkClock = 0;
  resetStick();
  syncAll();
  if (
    [data.camera?.p, data.camera?.target].every(
      (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite)
    )
  )
    stage.restore(data.camera);
  else stage.frame(visible());
}
async function refreshSlots() {
  const version = ++slotVersion,
    a = chosen();
  if (!a) return;
  const [scenes, actions] = await Promise.all([db.entries('scenes'), db.entries('actions')]);
  if (version !== slotVersion) return;
  function fill(id, items) {
    const el = $(id),
      old = el.value;
    el.replaceChildren(
      ...(items.length ? items.map((s) => option(s.id, s.name)) : [option('', '暂无存档')])
    );
    if (items.some((x) => x.id === old)) el.value = old;
    el.disabled = !items.length;
  }
  fill('savedScenes', scenes);
  fill(
    'savedActions',
    actions.filter((x) => x.data.type === a.type)
  );
  $('loadScene').disabled = !$('savedScenes').value;
  $('loadAction').disabled = !$('savedActions').value;
}
function saveName(prefix) {
  return (
    $('slotName').value.trim() ||
    prefix +
      ' ' +
      new Date().toLocaleString('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      })
  );
}
async function saveScene() {
  if (!chosen()) return;
  const name = saveName('场景');
  await db.put('scenes', name, name, sceneData());
  await refreshSlots();
  $('savedScenes').value = name;
  notify('已保存场景「' + name + '」');
}
async function saveAction() {
  const a = chosen();
  if (!a) return;
  const name = saveName(a.state.label),
    s = a.state;
  // Walking is transient. Save the visible skeleton for that mode as a one-key pose.
  const data =
    mode === 'walk'
      ? {
          type: a.type,
          clip: '@keys',
          keys: [{ ...a.capture(), t: 0 }],
          time: 0,
          dir: 1,
          rate: 1,
          playing: false,
          offsets: {}
        }
      : {
          type: a.type,
          clip: s.keys.length ? '@keys' : s.clip,
          keys: copy(s.keys),
          time: s.keys.length ? 0 : s.time,
          rate: s.rate,
          dir: s.keys.length ? 1 : s.dir,
          playing: s.keys.length ? false : s.playing,
          offsets: s.keys.length ? {} : copy(s.offsets)
        };
  const id = a.type + '|' + name;
  await db.put('actions', id, name, data);
  await refreshSlots();
  $('savedActions').value = id;
  notify('已保存角色动作「' + name + '」');
}
async function loadAction() {
  const id = $('savedActions').value,
    a = chosen();
  if (!id || !a) return;
  const data = await db.get('actions', id);
  if (data.type !== a.type) throw Error('请选择相同模型的角色');
  stopWalk();
  mode = 'pose';
  Object.assign(a.state, copy(data));
  a.apply();
  syncAll();
  setPane('motion');
  notify('角色动作已应用');
}
function record() {
  const a = chosen();
  if (!a) return;
  freeze();
  const keys = a.state.keys;
  const t = keys.length ? Number((keys.at(-1).t + Number($('spacing').value)).toFixed(4)) : 0;
  keys.push({ ...a.capture(), t });
  syncAll();
  notify('已记录第 ' + keys.length + ' 个关键帧');
}
function preview() {
  const a = chosen(),
    first = a?.state.keys[0];
  if (!first) return;
  a.state.p = [...first.p];
  a.state.yaw = first.yaw;
  selectClip('@keys');
  a.state.playing = a.duration > 0;
  clockUI();
}
function joystick() {
  const el = $('stick');
  function move(e) {
    const b = el.getBoundingClientRect(),
      r = b.width * 0.4;
    let x = (e.clientX - b.left - b.width / 2) / r,
      y = (e.clientY - b.top - b.height / 2) / r;
    const mag = Math.hypot(x, y);
    if (mag > 1) {
      x /= mag;
      y /= mag;
    }
    joy.x = x;
    joy.y = y;
    $('knob').style.transform = 'translate(' + x * r * 0.76 + 'px,' + y * r * 0.76 + 'px)';
  }
  el.onpointerdown = (e) => {
    if (locked || pointer !== null) return;
    e.preventDefault();
    pointer = e.pointerId;
    el.setPointerCapture(pointer);
    move(e);
  };
  el.onpointermove = (e) => {
    if (e.pointerId === pointer) move(e);
  };
  el.onpointercancel =
    el.onlostpointercapture =
    el.onpointerup =
      (e) => {
        if (e.pointerId === pointer) resetStick();
      };
  const directions = [
    'KeyW',
    'KeyA',
    'KeyS',
    'KeyD',
    'ArrowUp',
    'ArrowLeft',
    'ArrowDown',
    'ArrowRight',
    'ShiftLeft',
    'ShiftRight'
  ];
  window.addEventListener('keydown', (e) => {
    if (mode !== 'walk' || e.target.matches('input,select,textarea') || !directions.includes(e.code))
      return;
    e.preventDefault();
    keysHeld.add(e.code);
  });
  window.addEventListener('keyup', (e) => keysHeld.delete(e.code));
  window.addEventListener('blur', resetStick);
  document.addEventListener('visibilitychange', () => {
    resetStick();
    lastFrame = 0;
  });
}
function gait(a, dt) {
  let x = joy.x,
    y = joy.y;
  const down = (k) => keysHeld.has(k);
  x += Number(down('KeyD') || down('ArrowRight')) - Number(down('KeyA') || down('ArrowLeft'));
  y += Number(down('KeyS') || down('ArrowDown')) - Number(down('KeyW') || down('ArrowUp'));
  const mag = Math.hypot(x, y),
    amount = Math.min(1, mag);
  let clip = 'Idle';
  if (mag > 0.09) {
    const running = pointer !== null ? amount > 0.78 : down('ShiftLeft') || down('ShiftRight');
    clip = running ? 'Run' : 'Walk';
    const angle = stage.controls.getAzimuthalAngle(),
      speed = running ? 2.65 : 1.15;
    const d = (dt * speed * (pointer !== null ? amount : 1)) / mag;
    const dx = (x * Math.cos(angle) + y * Math.sin(angle)) * d,
      dz = (-x * Math.sin(angle) + y * Math.cos(angle)) * d;
    a.state.p[0] += dx;
    a.state.p[2] += dz;
    const yaw = T.MathUtils.radToDeg(Math.atan2(dx, dz)),
      diff = ((yaw - a.state.yaw + 540) % 360) - 180;
    a.state.yaw += diff * Math.min(1, dt * 13);
    stage.follow(dx, dz);
  }
  if (clip !== lastGait) {
    lastGait = clip;
    walkClock = 0;
  }
  walkClock += dt;
  a.walk(clip, walkClock);
}
function loop(ms) {
  requestAnimationFrame(loop);
  if (!stage || contextLost || document.hidden) {
    lastFrame = 0;
    return;
  }
  if (lastFrame && ms - lastFrame < 31) return;
  const active = chosen(),
    wasRunning = active?.state.playing;
  const dt = lastFrame ? Math.min(0.12, (ms - lastFrame) / 1000) : 0;
  lastFrame = ms;
  for (const a of actors.values()) {
    if (!a.root.visible) continue;
    if (mode === 'walk' && a.state.id === 'lead' && !locked) gait(a, dt);
    else if (!locked) a.transport(dt);
  }
  if (wasRunning && mode === 'pose' && pane === 'motion') clockUI();
  if (mode === 'walk' && pane === 'transform') readPosition();
  stage.draw(actors.values(), chosen(), mode === 'pose');
}
function bind() {
  controls();
  joystick();
  $('walk').onclick = () => setMode('walk');
  $('pose').onclick = $('editPose').onclick = () => {
    setMode('pose');
    setPane('motion');
  };
  $('group').onclick = () => {
    if (locked) return;
    if (!group && actors.size === 1) {
      add('leon');
      return;
    }
    group = !group;
    syncAll();
    stage.frame(visible());
  };
  $('openSaves').onclick = () => {
    panel(true);
    setPane('library');
  };
  $('togglePanel').onclick = () => panel($('panel').hidden);
  document.querySelectorAll('[data-pane]').forEach((b) => (b.onclick = () => setPane(b.dataset.pane)));
  document
    .querySelectorAll('[data-view]')
    .forEach(
      (b) =>
        (b.onclick = () =>
          stage.frame(b.dataset.view === 'fit' ? visible() : [chosen()].filter(Boolean), b.dataset.view))
    );
  $('actor').onchange = (e) => chooseActor(e.target.value);
  $('addZ').onclick = () => add('zhenfu');
  $('addL').onclick = () => add('leon');
  $('remove').onclick = removeActor;
  $('clip').onchange = (e) => selectClip(e.target.value);
  $('time').oninput = (e) => seek(Number(e.target.value));
  $('play').onclick = play;
  $('prev').onclick = () => seek(chosen().state.time - 1 / chosen().fps);
  $('next').onclick = () => seek(chosen().state.time + 1 / chosen().fps);
  $('rate').onchange = (e) => {
    if (chosen()) chosen().state.rate = Number(e.target.value);
  };
  $('joint').onchange = readJoint;
  $('jointReset').onclick = () => {
    const a = chosen();
    if (!a) return;
    delete a.state.offsets[$('joint').value];
    a.apply();
    readJoint();
  };
  $('focusActor').onclick = () => chosen() && stage.frame([chosen()]);
  $('record').onclick = record;
  $('previewKeys').onclick = preview;
  $('removeKey').onclick = () => {
    const a = chosen();
    if (!a?.state.keys.length) return;
    a.state.keys.pop();
    if (a.state.clip === '@keys') {
      if (!a.state.keys.length) selectClip(a.type === 'zhenfu' ? 'APose' : '@rest');
      else seek(Math.min(a.state.time, a.duration));
    }
    syncAll();
  };
  $('saveScene').onclick = safely(saveScene);
  $('saveAction').onclick = safely(saveAction);
  $('loadAction').onclick = safely(loadAction);
  $('loadScene').onclick = () =>
    working('正在恢复场景…', async () => {
      const data = await db.get('scenes', $('savedScenes').value);
      await restoreScene(data);
      notify('已恢复 ' + actors.size + ' 人的场景');
    });
  $('quality').value = localStorage.getItem('pose.texture.limit') || '1024';
  $('quality').onchange = safely(async (e) => {
    const quality = e.target.value;
    if (!['1024', '2048', '4096'].includes(quality) || !chosen()) return;
    await db.put('settings', 'resume', 'restart', {
      scene: sceneData(),
      from: localStorage.getItem('pose.texture.limit') || '1024',
      to: quality
    });
    location.reload();
  });
  window.studioBack = () => {
    if (pane !== 'motion' && !$('panel').hidden) {
      setPane('motion');
      return true;
    }
    if (!$('panel').hidden) {
      panel(false);
      return true;
    }
    return false;
  };
}
async function start() {
  bind();
  try {
    stage = new Stage($('world'));
  } catch (e) {
    progress('无法启动 3D 画面，请检查 Android System WebView 与 OpenGL ES 3 支持');
    console.error(e);
    return;
  }
  $('world').addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    contextLost = true;
    resetStick();
    $('busy').hidden = false;
    progress('正在恢复图形画面…');
  });
  $('world').addEventListener('webglcontextrestored', () => {
    contextLost = false;
    $('busy').hidden = true;
    lastFrame = 0;
  });
  requestAnimationFrame(loop);
  await working('正在加载甄芙…', async () => {
    const pending = await db.peek('settings', 'resume');
    if (pending) {
      // Clear before decoding so that an interrupted high-resolution load can fall back next launch.
      const previous = pending.from || '1024';
      await db.drop('settings', 'resume');
      localStorage.setItem('pose.texture.limit', pending.to);
      localStorage.setItem('pose.texture.rollback', previous);
      try {
        await restoreScene(pending.scene);
        localStorage.removeItem('pose.texture.rollback');
        $('quality').value = pending.to;
        return;
      } catch (e) {
        localStorage.setItem('pose.texture.limit', previous);
        throw e;
      }
    }
    const rollback = localStorage.getItem('pose.texture.rollback');
    if (rollback) {
      localStorage.setItem('pose.texture.limit', rollback);
      localStorage.removeItem('pose.texture.rollback');
      $('quality').value = rollback;
    }
    const a = await Actor.create(fresh('zhenfu', 'lead', '甄芙'), progress);
    actors.set('lead', a);
    stage.add(a);
    syncAll();
    stage.frame([a]);
  });
}
start();
