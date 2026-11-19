import {
  copy,
  editableCast,
  fileKey,
  freshLevel,
  gameFiles,
  kinds,
  makeRecord,
  orderedStage,
  assignRoles,
  resolveFile,
  unique
} from './project.js';
import { actionScene } from './runtime-format.js';
import { loadDraft, saveDraft } from './store.js';
import { readFiles, exportFiles } from './transfer.js';
import { el, renderForm } from './form.js';

const templates = [
  'first-meeting.level.json',
  'district07.level.json',
  'city-duo-opponents.module.json',
  'arrival.action.json',
  'cast-three.sese.json'
];
const $ = (id) => document.getElementById(id);
export function mountStory(stage) {
  const files = new Map(),
    dirty = new Map();
  const desk = $('storyDesk'),
    messageBox = $('storyMessage'),
    panel = $('storyForm'),
    dialog = $('storyDialog');
  const ui = { level: 'first-meeting.level.json', node: 'cue', pose: 0, view: 'node' };
  let started = null,
    binding = null,
    saving = Promise.resolve(),
    timer,
    busy = false,
    needsSave = false,
    loaded = false,
    formKey = '';
  const current = () => files.get(fileKey(ui.level));
  const message = (t) => {
    messageBox.textContent = t || '';
  };
  const error = (e) => {
    const m = e?.message || String(e);
    if (desk.hidden) stage.notify(m);
    else message(m);
  };
  async function run(fn) {
    if (busy) return;
    busy = true;
    desk.setAttribute('aria-busy', 'true');
    try {
      await fn();
    } catch (e) {
      error(e);
    } finally {
      busy = false;
      desk.removeAttribute('aria-busy');
    }
  }
  function confirm(title, body) {
    dialog.querySelector('h2').textContent = title;
    dialog.querySelector('p').textContent = body;
    dialog.returnValue = 'cancel';
    dialog.showModal();
    return new Promise((ok) =>
      dialog.addEventListener('close', () => ok(dialog.returnValue === 'ok'), { once: true })
    );
  }
  function change(record) {
    if (record) dirty.set(fileKey(record.name), record);
    needsSave = true;
    $('draftState').textContent = '正在保存';
    clearTimeout(timer);
    timer = setTimeout(() => flush().catch(error), 220);
    if (record === current()) {
      const opt = $('storyLevel').selectedOptions[0];
      if (opt && opt.value === record.name) opt.textContent = record.doc.title;
      const b = $('storyNodes').querySelector('[aria-current="true"]');
      const n = record.doc.nodes[ui.node];
      if (b && n) b.lastChild.textContent = shortNode(n);
    }
  }
  function flush() {
    clearTimeout(timer);
    if (!needsSave) return saving;
    const items = [...dirty.values()],
      state = { ...ui };
    dirty.clear();
    needsSave = false;
    const write = saving.catch(() => {}).then(() => saveDraft(items, state));
    saving = write;
    write.then(
      () => {
        if (write === saving && !needsSave) $('draftState').textContent = '已保存';
      },
      () => {
        for (const item of items) {
          const id = fileKey(item.name);
          if (files.get(id) === item && !dirty.has(id)) dirty.set(id, item);
        }
        needsSave = true;
        $('draftState').textContent = '保存失败';
      }
    );
    return write;
  }
  function put(r) {
    files.set(fileKey(r.name), r);
    change(r);
  }
  async function init() {
    if (started) return started;
    started = (async () => {
      const draft = await loadDraft();
      for (const r of draft.files) files.set(fileKey(r.name), r);
      if (draft.ui) Object.assign(ui, draft.ui);
      if (!files.size) {
        const records = await Promise.all(
          templates.map(async (name) => {
            const res = await fetch('./story/templates/' + name);
            if (!res.ok) throw Error('无法载入模板 ' + name);
            return makeRecord(name, await res.json());
          })
        );
        records.forEach(put);
        await flush();
      }
      if (!current() || current().kind !== 'level')
        ui.level = [...files.values()].find((r) => r.kind === 'level').name;
      if (!current().doc.nodes[ui.node]) ui.node = current().doc.start;
      loaded = true;
    })().catch((e) => {
      started = null;
      throw e;
    });
    return started;
  }
  function shortNode(n) {
    return (n.text || n.label || n.file || '').slice(0, 55);
  }
  function draw() {
    const root = current();
    if (!root) return;
    const L = root.doc;
    if (!Object.hasOwn(L.nodes, ui.node)) ui.node = L.start;
    const levels = [...files.values()].filter((r) => r.kind === 'level');
    $('storyLevel').replaceChildren(...levels.map((r) => new Option(r.doc.title, r.name)));
    $('storyLevel').value = root.name;
    $('storyNodes').replaceChildren(
      ...Object.entries(L.nodes).map(([id, node]) => {
        const b = el('button');
        b.type = 'button';
        b.dataset.node = id;
        b.setAttribute('aria-current', String(id === ui.node && ui.view === 'node'));
        b.append(el('span', '', kinds[node.kind] + ' · ' + id), el('small', '', shortNode(node)));
        b.onclick = () => {
          if (busy) return;
          ui.node = id;
          ui.pose = 0;
          ui.view = 'node';
          change();
          draw();
          panel.scrollTop = 0;
          message('');
        };
        return b;
      })
    );
    $('levelSettings').setAttribute('aria-pressed', String(ui.view === 'settings'));
    const key = JSON.stringify([ui.level, ui.view, ui.node, ui.pose]);
    const opened = new Set(
      key === formKey
        ? [...panel.querySelectorAll('details[open] > summary')].map((s) => s.textContent)
        : []
    );
    formKey = key;
    renderForm(panel, {
      files,
      level: root,
      ui,
      change,
      draw,
      put,
      message,
      confirm,
      run,
      enter,
      capture,
      exportOne,
      exportLevel
    });
    for (const summary of panel.querySelectorAll('details > summary'))
      if (opened.has(summary.textContent)) summary.parentElement.open = true;
  }
  async function open() {
    if (binding) {
      await finish();
      return;
    }
    if (stage.ready()) stage.pause();
    desk.hidden = false;
    await init();
    draw();
    $('draftState').textContent = needsSave ? '正在保存' : '已保存';
  }
  async function close() {
    await flush();
    desk.hidden = true;
    message('');
  }
  async function imports(list) {
    const records = await readFiles(list);
    const conflicts = [];
    for (const r of records) {
      const old = files.get(fileKey(r.name));
      if (!old) continue;
      if (old.blob || r.blob || JSON.stringify(old.doc) !== JSON.stringify(r.doc))
        conflicts.push(r.name);
    }
    if (
      conflicts.length &&
      !(await confirm(
        '替换同名文件',
        conflicts.slice(0, 5).join('、') + '。已有草稿将使用此次导入的内容。'
      ))
    )
      return;
    // Commit the entire batch before exposing any imported file in the editor.
    await flush();
    const level = records.find((r) => r.kind === 'level');
    const next = level
      ? { level: level.name, node: level.doc.start, pose: 0, view: 'node' }
      : { ...ui };
    await saveDraft(records, next);
    for (const r of records) files.set(fileKey(r.name), r);
    Object.assign(ui, next);
    draw();
    panel.scrollTop = 0;
    message('已导入 ' + records.length + ' 个文件');
  }
  async function exportOne(r) {
    if (r.kind === 'module' || r.kind === 'level') makeRecord(r.name, copy(r.doc));
    await flush();
    message(await exportFiles([r], 'single', r.name));
  }
  async function exportLevel(mode) {
    const level = current(),
      records = gameFiles(files, level);
    await flush();
    const name = level.doc.id.slice(0, 80) + '-游戏文件';
    message(await exportFiles(records, mode, name));
  }
  async function enter(spec) {
    if (!stage.ready()) throw Error('请等待人物舞台加载完成');
    const target = resolveFile(files, spec.owner.file),
      snap = stage.snapshot();
    if (target?.kind === 'glb')
      throw Error(
        '骨骼 GLB 可直接绑定。要制作新的关键帧，请先取消关联或使用「写入当前舞台动作」。'
      );
    let scene;
    if (target && ['action', 'cast'].includes(target.kind))
      scene = copy(actionScene(target.doc, target.name).data);
    else if (spec.mod) scene = snap;
    else if (spec.kind === 'action')
      scene = { ...snap, actors: [snap.actors.find((a) => a.id === snap.selected)], group: false };
    else scene = snap;
    if (spec.mod) scene = orderedStage(scene, spec.mod);
    else if (spec.kind === 'cast' && target?.kind === 'action')
      scene = { ...snap, actors: snap.actors };
    const edit = editableCast(scene, spec.mod?.lead.id);
    await flush();
    await stage.restore(edit.scene);
    binding = { spec, originalIds: edit.originalIds, helper: edit.helper };
    $('binding').querySelector('span').textContent = current().doc.title + ' · ' + ui.node;
    $('openStory').textContent = '写回剧情';
    $('binding').hidden = false;
    desk.hidden = true;
    stage.notify('编排完成后点「写回剧情」');
  }
  function createMotion(spec, source) {
    let scene = source;
    if (binding) {
      const map = binding.originalIds,
        helper = binding.helper;
      scene = {
        ...scene,
        selected: map[scene.selected] || scene.selected,
        actors: scene.actors
          .filter((a) => a.id !== helper)
          .map((a) => ({ ...a, id: map[a.id] || a.id }))
      };
    }
    if (spec.mod) scene = assignRoles(scene, spec.mod);
    const solo = !spec.mod && spec.kind === 'action';
    const actor = scene.actors.find((a) => a.id === scene.selected) || scene.actors[0];
    if (!actor) throw Error('请先在舞台添加演员');
    const title = spec.mod ? spec.owner.name : (solo ? actor.label + ' · ' : '舞台 · ') + ui.node;
    const suffix = solo ? '.action.json' : '.sese.json';
    const prefix = (
      current().doc.id +
      '-' +
      ui.node +
      (spec.mod ? '-p' + (spec.poseIndex + 1) : '')
    )
      .slice(0, 110)
      .replace(/[^a-zA-Z0-9._-]/g, '_');
    const id = unique(prefix + '-', (v) => files.has(fileKey(v + suffix)));
    const doc = solo
      ? { type: 'sese-action', version: 1, name: title, actor }
      : { type: 'sese-pose-combination', version: 1, name: title, scene };
    return makeRecord(id + suffix, doc);
  }
  async function capture(spec) {
    if (!stage.ready()) throw Error('请等待人物舞台加载完成');
    await flush();
    const record = createMotion(spec, stage.snapshot());
    const previous = spec.owner.file;
    spec.owner.file = record.name;
    try {
      await saveDraft([record, spec.record], { ...ui });
    } catch (e) {
      if (previous === undefined) delete spec.owner.file;
      else spec.owner.file = previous;
      throw e;
    }
    files.set(fileKey(record.name), record);
    draw();
    message('已绑定 ' + record.name);
  }
  function unbind() {
    binding = null;
    $('binding').hidden = true;
    $('openStory').textContent = '剧情制作';
  }
  async function finish() {
    if (!binding) return;
    await capture(binding.spec);
    unbind();
    desk.hidden = false;
  }
  async function cancelBinding() {
    if (!binding) return;
    unbind();
    desk.hidden = false;
    draw();
    message('已返回剧情，舞台上的编排仍可使用。');
  }
  $('openStory').onclick = () => run(open);
  $('closeStory').onclick = () => run(close);
  $('writeMotion').onclick = () => run(finish);
  $('leaveMotion').onclick = () => run(cancelBinding);
  $('storyLevel').onchange = () => {
    if (busy) return;
    ui.level = $('storyLevel').value;
    ui.node = current().doc.start;
    ui.pose = 0;
    ui.view = 'node';
    change();
    draw();
    panel.scrollTop = 0;
    message('');
  };
  $('levelSettings').onclick = () => {
    if (busy) return;
    ui.view = 'settings';
    change();
    draw();
    panel.scrollTop = 0;
  };
  $('newLevel').onclick = () =>
    run(async () => {
      const id = unique('chapter', (v) => files.has(fileKey(v + '.level.json')));
      const record = makeRecord(id + '.level.json', freshLevel(id));
      Object.assign(ui, { level: record.name, node: record.doc.start, pose: 0, view: 'settings' });
      put(record);
      draw();
      panel.scrollTop = 0;
      message('已新建 ' + record.name);
    });
  $('importStory').onclick = () => {
    if (!busy) $('storyFiles').click();
  };
  $('storyFiles').onchange = (e) => {
    const list = Array.from(e.target.files);
    e.target.value = '';
    if (list.length) run(() => imports(list));
  };
  $('exportStory').onclick = () => run(() => exportLevel('folder'));
  $('launchCity').hidden = !window.SeseStoryFiles;
  $('launchCity').onclick = () => {
    if (!window.SeseStoryFiles.launchGame()) message('请先安装《甄芙 · 城市篇》');
  };
  $('exportGameAction').onclick = () =>
    run(async () => {
      if (!stage.ready()) return;
      const snap = stage.snapshot(),
        actor = snap.actors.find((a) => a.id === snap.selected);
      const name = $('slotName').value.trim() || actor.label + '动作';
      const filename =
        (name.replace(/[\\/:*?"<>|#\u0000-\u001f]/g, '_').slice(0, 100) || '动作') + '.action.json';
      const record = makeRecord(filename, { type: 'sese-action', version: 1, name, actor });
      stage.notify(await exportFiles([record], 'single', filename));
    });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && loaded) flush().catch(error);
  });
  window.storyFlush = () => {
    if (loaded) flush().catch(error);
  };
  return {
    back() {
      if (dialog.open) {
        dialog.close('cancel');
        return true;
      }
      if (busy) return true;
      if (!desk.hidden) {
        run(close);
        return true;
      }
      if (binding) {
        run(cancelBinding);
        return true;
      }
      return false;
    }
  };
}
