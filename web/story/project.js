import { documentLevel, documentModule, actionScene } from './runtime-format.js';

export const kinds = {
  dialogue: '对白',
  walk: '步行目标',
  motion: '人物动作',
  encounter: '对局',
  end: '结尾'
};
export const copy = (value) => JSON.parse(JSON.stringify(value));
export const fileKey = (name) => name.normalize('NFC').toLowerCase();
export const identifier = (value) =>
  typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,90}$/.test(value);
export const defaultSpawn = [140.77, 16.7, -654];
export function basename(name) {
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    name.length > 180 ||
    /[\\/\u0000-\u001f<>:"|?*#]/.test(name) ||
    name === '.' ||
    name === '..'
  )
    throw Error('文件名含不支持的字符或过长');
  return name.normalize('NFC');
}
export const blobFor = (r) =>
  r.blob || new Blob([JSON.stringify(r.doc)], { type: 'application/json' });
export function makeRecord(name, doc) {
  name = basename(name);
  if (doc?.type === 'sese-story-level') {
    documentLevel(doc);
    return { name, kind: 'level', doc };
  }
  if (doc?.type === 'sese-encounter-module') {
    documentModule(doc);
    return { name, kind: 'module', doc };
  }
  actionScene(doc, name);
  return { name, kind: doc.type === 'sese-action' ? 'action' : 'cast', doc };
}
export function freshLevel(id) {
  return {
    type: 'sese-story-level',
    version: 1,
    id,
    title: '新剧情',
    city: 'hero13-v23',
    spawn: [...defaultSpawn],
    start: 'intro',
    nodes: {
      intro: { kind: 'dialogue', speaker: '甄芙', text: '我们到了。', next: 'end' },
      end: { kind: 'end', text: '本章结束。' }
    }
  };
}
export function freshModule(id) {
  const m = {
    type: 'sese-encounter-module',
    version: 1,
    id,
    title: '新对局',
    lead: { id: 'lead', label: '甄芙', model: 'zhenfu' },
    opponents: [{ id: 'partner', label: '里昂', model: 'leon' }],
    poses: [{ name: '起始位', self: 1, other: 1 }]
  };
  return documentModule(m).data;
}
export function unique(base, used) {
  let n = 1;
  while (used(base + n)) n++;
  return base + n;
}
export function exits(node) {
  if (node.kind === 'end') return [];
  if (node.choices) return node.choices.map((c) => ({ owner: c, key: 'next', label: c.label }));
  if (node.kind === 'encounter')
    return ['win', 'great', 'lose']
      .filter((k) => node[k])
      .map((k) => ({
        owner: node,
        key: k,
        label: { win: '胜利', great: '大胜', lose: '失败' }[k]
      }));
  return [{ owner: node, key: 'next', label: '下一节点' }];
}
export function redirect(level, from, to) {
  if (level.start === from) level.start = to;
  for (const node of Object.values(level.nodes))
    for (const e of exits(node)) if (e.owner[e.key] === from) e.owner[e.key] = to;
}
export function renameNode(level, old, id) {
  if (old === id) return;
  if (
    !identifier(id) ||
    Object.hasOwn(level.nodes, id) ||
    ['__proto__', 'constructor', 'prototype'].includes(id)
  )
    throw Error('节点 ID 无效或已存在');
  const nodes = Object.entries(level.nodes).map(([k, v]) => [k === old ? id : k, v]);
  level.nodes = Object.fromEntries(nodes);
  redirect(level, old, id);
}
export function insertNode(level, anchor, kind, edge = 0) {
  const id = unique(kind, (n) => Object.hasOwn(level.nodes, n)),
    nextEdge = exits(level.nodes[anchor])[edge];
  const next = nextEdge ? nextEdge.owner[nextEdge.key] : anchor;
  const defaults = {
    dialogue: { speaker: '甄芙', text: '输入对白', next },
    walk: { label: '前往目的地', position: [...level.spawn], radius: 3, next },
    motion: { file: '', next },
    encounter: { label: '新对局', win: next },
    end: { text: '本章结束。' }
  };
  if (!Object.hasOwn(defaults, kind)) throw Error('节点类型无效');
  if (nextEdge) nextEdge.owner[nextEdge.key] = id;
  else redirect(level, anchor, id);
  level.nodes[id] = { kind, ...defaults[kind] };
  return id;
}
export function unlinkNode(level, id, replacement) {
  if (id === replacement || !Object.hasOwn(level.nodes, replacement))
    throw Error('请选择一个不同的接续节点');
  redirect(level, id, replacement);
  delete level.nodes[id];
}
export const roles = (mod) => [mod.lead, ...mod.opponents];
export function renameRole(mod, actor, newId) {
  const old = actor.id;
  if (newId === old) return;
  if (
    !identifier(newId) ||
    ['__proto__', 'constructor', 'prototype'].includes(newId) ||
    roles(mod).some((r) => r.id === newId)
  )
    throw Error('演员 ID 无效或重复');
  actor.id = newId;
  for (const pose of mod.poses) {
    for (const values of [pose.multipliers, ...(pose.events || []).map((e) => e.delta)]) {
      if (values && Object.hasOwn(values, old)) {
        values[newId] = values[old];
        delete values[old];
      }
    }
  }
}
export function resolveFile(files, ref) {
  return files.get(fileKey((ref || '').split('#')[0]));
}
// Follow references in every node because the game's importer checks the full document.
export function gameFiles(files, root) {
  const found = new Map();
  function add(record) {
    const key = fileKey(record.name);
    if (found.has(key)) return;
    found.set(key, record);
    if (!record.blob && blobFor(record).size > 24 * 1024 * 1024)
      throw Error(record.name + ' 超过主游戏的 24 MiB 限制');
    if (record.kind === 'glb') return;
    const doc = copy(record.doc);
    if (record.kind === 'level') {
      documentLevel(doc);
      for (const [id, n] of Object.entries(doc.nodes)) {
        if (n.kind === 'motion') motion(n.file, id);
        if (n.kind === 'encounter') {
          if (n.module) {
            const r = resolveFile(files, n.module);
            if (r?.kind !== 'module') throw Error(id + ' 缺少对局模块 ' + n.module);
            add(r);
          } else checkPoses(n, id);
        }
      }
    } else if (record.kind === 'module') {
      documentModule(doc);
      checkPoses(doc, record.name);
    } else actionScene(doc, record.name);
  }
  function motion(ref, owner) {
    const r = resolveFile(files, ref);
    if (!r || !['glb', 'action', 'cast'].includes(r.kind))
      throw Error(owner + ' 缺少动作文件 ' + ref);
    if (
      ref.includes('#') &&
      (r.kind !== 'glb' || !r.clips.some((c) => c.name === ref.slice(ref.indexOf('#') + 1)))
    )
      throw Error(owner + ' 的片段名称无效 ' + ref);
    add(r);
    return r;
  }
  function checkPoses(mod, owner) {
    for (const p of mod.poses) {
      if (!p.file) continue;
      const r = motion(p.file, owner + ' / ' + p.name);
      if (r.kind === 'glb') {
        const clip = p.file.includes('#')
          ? r.clips.find((c) => c.name === p.file.split('#').slice(1).join('#'))
          : r.clips[0];
        if (!roles(mod).some((a) => a.model === clip.type))
          throw Error(p.name + ' 的 GLB 骨架与参与演员不符');
      } else {
        const states = actionScene(r.doc, r.name).data.actors;
        for (const role of roles(mod))
          if (!states.some((a) => a.id === role.id && a.type === role.model))
            throw Error(
              p.name + ' 的动作 ' + r.name + ' 缺少演员 ' + role.label + '（' + role.id + '）'
            );
      }
    }
  }
  add(root);
  return [...found.values()];
}
export function stageActor(type, id, label, x = 0) {
  return {
    type,
    id,
    label,
    p: [x, 0, 0],
    yaw: 0,
    clip: type === 'zhenfu' ? 'Idle' : '@rest',
    time: 0,
    dir: 1,
    playing: false,
    rate: 1,
    offsets: {},
    keys: []
  };
}
export function matchCast(states, list) {
  const used = new Set(),
    matches = new Map();
  // Reserve exact IDs first, including when multiple roles use the same rig.
  for (const r of list) {
    const exact = states.find((s) => !used.has(s) && s.id === r.id && s.type === r.model);
    if (exact) {
      matches.set(r, exact);
      used.add(exact);
    }
  }
  for (const r of list) {
    if (matches.has(r)) continue;
    const available = states.filter((s) => !used.has(s) && s.type === r.model);
    const s = available.find((s) => s.label === r.label) || available[0];
    if (s) {
      matches.set(r, s);
      used.add(s);
    }
  }
  return matches;
}
export function assignRoles(scene, mod) {
  const list = roles(mod),
    states = scene.actors,
    matches = matchCast(states, list);
  if (matches.size !== list.length)
    throw Error('舞台缺少所需模型。可用「按演员表编排」补齐，或修改模块中的演员表。');
  const mapped = new Map(list.map((r) => [matches.get(r), r]));
  const used = new Set(list.map((r) => r.id));
  const out = copy(scene);
  out.actors = states.map((s) => {
    const r = mapped.get(s);
    let id = r?.id || s.id;
    if (!r && used.has(id)) id = unique('extra', (v) => used.has(v));
    used.add(id);
    if (scene.selected === s.id) out.selected = id;
    return { ...copy(s), id, label: r?.label || s.label };
  });
  return out;
}
export function orderedStage(scene, mod) {
  const list = roles(mod),
    matches = matchCast(scene.actors, list);
  const actors = list.map((r, i) => {
    const existing = matches.get(r);
    if (!existing) return stageActor(r.model, r.id, r.label, (i - (list.length - 1) / 2) * 1.15);
    return { ...copy(existing), id: r.id, label: r.label };
  });
  return { ...copy(scene), actors, group: true, mode: 'pose', selected: mod.lead.id };
}
// The original studio reserves "lead" for the playable Zhenfu. Keep external IDs across the edit.
export function editableCast(scene, preferredLead) {
  const s = copy(scene),
    originalIds = Object.create(null),
    names = new Set(s.actors.map((a) => a.id));
  const lead =
    s.actors.find((a) => a.type === 'zhenfu' && a.id === (preferredLead ?? 'lead')) ||
    s.actors.find((a) => a.type === 'zhenfu');
  const chosen = s.selected;
  for (const a of s.actors) {
    const old = a.id;
    if (a === lead) a.id = 'lead';
    else if (a.id === 'lead') a.id = unique('studioActor', (v) => names.has(v));
    originalIds[a.id] = old;
    if (old === chosen) s.selected = a.id;
  }
  let helper = null;
  if (!lead) {
    helper = 'lead';
    s.actors.unshift(stageActor('zhenfu', 'lead', '甄芙（排练辅助）', -2));
  }
  s.format = 1;
  s.mode = 'pose';
  s.group = !helper && s.actors.length > 1;
  if (!s.actors.some((a) => a.id === s.selected))
    s.selected = s.actors.find((a) => a.id !== helper)?.id || 'lead';
  return { scene: s, originalIds, helper };
}
