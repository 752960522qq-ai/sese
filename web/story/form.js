import {
  kinds,
  fileKey,
  resolveFile,
  freshModule,
  unique,
  exits,
  renameNode,
  insertNode,
  unlinkNode,
  roles,
  renameRole,
  makeRecord
} from './project.js';
import { encounter } from './runtime-format.js';

export function el(tag, cls, txt) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt !== undefined) e.textContent = txt;
  return e;
}
function section(parent) {
  const f = el('section', 'storysection');
  parent.append(f);
  return f;
}
function details(parent, title, open = false) {
  const f = el('details');
  f.open = open;
  f.append(el('summary', '', title));
  parent.append(f);
  return f;
}
function group(parent, cls = 'storygrid') {
  const d = el('div', cls);
  parent.append(d);
  return d;
}
function caption(parent, text) {
  parent.append(el('h3', '', text));
}
function input(parent, title, value, update, options = {}) {
  const l = el('label', 'storyfield');
  l.append(el('span', '', title));
  let f;
  if (options.values) {
    f = el('select');
    for (const entry of options.values) {
      const [v, label] = Array.isArray(entry) ? entry : [entry, entry];
      f.add(new Option(label, v));
    }
    if (value != null && value !== '' && ![...f.options].some((o) => o.value === value))
      f.add(new Option(value + '（缺少文件）', value));
  } else if (options.textarea) {
    f = el('textarea');
    f.rows = options.rows || 3;
  } else {
    f = el('input');
    f.type = options.number ? 'number' : 'text';
    if (options.number) f.step = options.step || 'any';
  }
  if (options.min !== undefined) f.min = options.min;
  if (options.max !== undefined) f.max = options.max;
  f.setAttribute('aria-label', title);
  f.value = value ?? '';
  if (update)
    f.addEventListener(options.values || options.commit ? 'change' : 'input', () => {
      try {
        update(options.number ? (f.value === '' ? undefined : Number(f.value)) : f.value);
      } catch (e) {
        f.value = value ?? '';
        options.fail?.(e.message);
      }
    });
  l.append(f);
  parent.append(l);
  return f;
}
export function renderForm(parent, c) {
  parent.replaceChildren();
  const { level, ui, files } = c,
    L = level.doc;
  const ids = Object.keys(L.nodes),
    node = L.nodes[ui.node];
  function button(p, label, fn, primary = false) {
    const b = el('button', primary ? 'primary' : '', label);
    b.type = 'button';
    b.onclick = () => c.run(fn);
    p.append(b);
    return b;
  }
  const changed = (r = level, draw = false) => {
    c.change(r);
    if (draw) c.draw();
  };
  function prop(p, r, obj, k, label, opt = {}) {
    return input(
      p,
      label,
      obj[k],
      (v) => {
        if (v === undefined || (v === '' && opt.optional)) delete obj[k];
        else obj[k] = v;
        changed(r, !!opt.draw);
      },
      { ...opt, fail: c.message }
    );
  }
  function vector(p, r, obj, k, label) {
    const row = group(p);
    ['X', 'Y', 'Z'].forEach((axis, i) =>
      input(
        row,
        label + ' ' + axis,
        obj[k][i],
        (v) => {
          obj[k][i] = v ?? null;
          changed(r);
        },
        { number: true }
      )
    );
  }
  function json(p, r) {
    const d = details(p, '编辑文件 JSON');
    const f = input(d, '文件内容', JSON.stringify(r.doc, null, 2), null, {
      textarea: true,
      rows: 9
    });
    button(d, '应用 JSON 修改', () => {
      const next = makeRecord(r.name, JSON.parse(f.value));
      if (next.kind !== r.kind) throw Error('文档类型与原文件不一致');
      c.put(next);
      if (r === level && !Object.hasOwn(next.doc.nodes, ui.node)) ui.node = next.doc.start;
      c.draw();
      c.message('已应用 ' + r.name);
    });
  }
  function targets(p, obj, k, label, blank) {
    const opt = ids.map((id) => [id, kinds[L.nodes[id].kind] + ' · ' + id]);
    if (blank) opt.unshift(['', blank]);
    return prop(p, level, obj, k, label, { values: opt, optional: !!blank });
  }
  function motions(p, r, owner, mod, poseIndex) {
    const opts = [['', mod ? '使用默认站位' : '选择动作文件']];
    for (const rec of files.values()) {
      if (['action', 'cast'].includes(rec.kind))
        opts.push([rec.name, (rec.doc.name || rec.name) + ' · ' + rec.name]);
      if (rec.kind === 'glb')
        for (const clip of rec.clips)
          opts.push([rec.name + '#' + clip.name, rec.name + ' / ' + clip.name]);
    }
    prop(p, r, owner, 'file', '关联动作', { values: opts, optional: !!mod, draw: true });
    const spec = { record: r, owner, mod, poseIndex };
    let kind = 'cast';
    if (!mod) {
      const matched = resolveFile(files, owner.file);
      kind = matched?.kind === 'cast' ? 'cast' : 'action';
      input(p, '写入动作范围', kind, (v) => (kind = v), {
        values: [
          ['action', '当前角色'],
          ['cast', '舞台全体演员']
        ]
      });
    }
    const row = group(p, 'storybuttons');
    button(row, mod ? '按演员表编排' : '在舞台编排', () => c.enter({ ...spec, kind }));
    button(row, mod ? '绑定当前舞台搭配' : '写入当前舞台动作', () => c.capture({ ...spec, kind }));
    if (owner.file) {
      const rec = resolveFile(files, owner.file);
      if (rec) button(row, '单独导出此动作', () => c.exportOne(rec));
    }
  }
  function editModule(p, r, m) {
    const prefs = section(p);
    if (r.kind === 'module') {
      prop(prefs, r, m, 'title', '模块标题');
      prop(prefs, r, m, 'id', '模块 ID');
    }
    const grid = group(prefs);
    prop(grid, r, m, 'goal', '多人胜利条件', {
      values: [
        ['first', '任一对手先满'],
        ['all', '全部对手先满']
      ]
    });
    prop(grid, r, m, 'danger', '危险阈值', { number: true, min: 80, max: 90 });
    prop(grid, r, m, 'background', '非当前目标倍率', { number: true, min: 0, max: 1 });
    const cast = section(p);
    caption(cast, '演员与独立数值');
    const list = roles(m);
    for (let i = 0; i < list.length; i++) {
      const role = list[i],
        d = details(cast, (i ? '对手 ' + i : '玩家') + ' · ' + role.label);
      const row = group(d);
      prop(row, r, role, 'label', '角色名称');
      input(
        row,
        '角色 ID',
        role.id,
        (v) => {
          renameRole(m, role, v);
          changed(r, true);
        },
        { commit: true, fail: c.message }
      );
      if (i)
        prop(row, r, role, 'model', '角色模型', {
          values: [
            ['leon', '里昂'],
            ['leonSuit', '西装里昂'],
            ['zhenfu', '甄芙']
          ]
        });
      for (const [k, l, lo, hi] of [
        ['start', '初始值', 0, 99.99],
        ['stamina', '体力', 0, 100],
        ['sensitivity', '敏感度', 0.1, 5],
        ['attack', '攻速', 0.1, 5],
        ['defense', '防御', 0.1, 5],
        ['gain', '增长率', 0, 20]
      ])
        prop(row, r, role, k, l, { number: true, min: lo, max: hi });
      if (i && m.opponents.length > 1)
        button(d, '移除此对手', async () => {
          if (!(await c.confirm('移除 ' + role.label, '该演员的倍率和数值事件也会移除。'))) return;
          m.opponents.splice(i - 1, 1);
          for (const pose of m.poses) {
            if (pose.multipliers) delete pose.multipliers[role.id];
            for (const event of pose.events || []) delete event.delta[role.id];
          }
          changed(r, true);
        });
    }
    if (m.opponents.length < 15)
      button(cast, '添加对手', () => {
        const id = unique('guest', (v) => roles(m).some((a) => a.id === v));
        m.opponents.push({
          id,
          label: '对手 ' + (m.opponents.length + 1),
          model: 'leon',
          start: 0,
          stamina: 100,
          sensitivity: 1,
          attack: 1,
          defense: 1,
          gain: 1.1
        });
        changed(r, true);
      });
    const poses = section(p);
    caption(poses, '姿势与动作');
    const i = Math.max(0, Math.min(ui.pose || 0, m.poses.length - 1)),
      pose = m.poses[i];
    input(
      poses,
      '当前姿势',
      String(i),
      (v) => {
        ui.pose = Number(v);
        c.change();
        c.draw();
      },
      { values: m.poses.map((s, j) => [String(j), s.name]) }
    );
    const row = group(poses);
    prop(row, r, pose, 'name', '姿势名称');
    prop(row, r, pose, 'self', '玩家增长倍率', { number: true, min: 0.1, max: 5 });
    prop(row, r, pose, 'other', '对手增长倍率', { number: true, min: 0.1, max: 5 });
    prop(row, r, pose, 'seconds', '循环秒数', {
      number: true,
      min: 0.1,
      max: 3600,
      optional: true
    });
    motions(poses, r, pose, m, i);
    const buttons = group(poses, 'storybuttons');
    if (m.poses.length < 12)
      button(buttons, '新增姿势', () => {
        m.poses.push({ name: '新姿势', self: 1, other: 1 });
        ui.pose = m.poses.length - 1;
        changed(r, true);
      });
    if (m.poses.length > 1)
      button(buttons, '移除此姿势', async () => {
        if (!(await c.confirm('移除姿势', pose.name))) return;
        m.poses.splice(i, 1);
        ui.pose = Math.max(i - 1, 0);
        changed(r, true);
      });
    const events = details(poses, '每人倍率与定时事件');
    const multipliers = group(events);
    for (const a of list)
      input(
        multipliers,
        a.label + ' 倍率',
        pose.multipliers?.[a.id] ?? 1,
        (v) => {
          pose.multipliers ??= {};
          if (v === undefined) delete pose.multipliers[a.id];
          else pose.multipliers[a.id] = v;
          changed(r);
        },
        { number: true, min: 0, max: 10 }
      );
    for (const [idx, event] of (pose.events || []).entries()) {
      const g = group(events);
      prop(g, r, event, 'at', '触发秒数 ' + (idx + 1), {
        number: true,
        min: 0.001,
        max: pose.seconds || 3600
      });
      for (const a of list)
        prop(g, r, event.delta, a.id, a.label + ' 增量', {
          number: true,
          min: 0,
          max: 100,
          optional: true
        });
      button(g, '移除事件 ' + (idx + 1), () => {
        pose.events.splice(idx, 1);
        if (!pose.events.length) delete pose.events;
        changed(r, true);
      });
    }
    button(events, '添加定时事件', () => {
      const last = (pose.events || []).at(-1)?.at || 0;
      pose.seconds ??= 6;
      if (last >= pose.seconds) throw Error('请先延长循环秒数');
      const at = Math.min(pose.seconds, last + 1);
      (pose.events ??= []).push({ at, delta: { [m.lead.id]: 0 } });
      changed(r, true);
    });
    const rewards = details(p, '结算奖励');
    const rg = group(rewards);
    for (const [k, l] of [
      ['win', '胜利'],
      ['great', '大胜'],
      ['lose', '失败']
    ])
      prop(rg, r, m.rewards, k, l + '积分', { number: true, step: '1' });
    if (r.kind === 'module') json(p, r);
  }
  function graphTools() {
    const tools = details(parent, '插入或删除节点'),
      links = exits(node);
    let edge = 0;
    if (links.length > 1)
      input(tools, '插入到分支', '0', (v) => (edge = Number(v)), {
        values: links.map((e, i) => [String(i), e.label + ' → ' + e.owner[e.key]])
      });
    let type = 'dialogue';
    input(tools, '新节点类型', type, (v) => (type = v), { values: Object.entries(kinds) });
    button(tools, node.kind === 'end' ? '在本结尾前插入' : '插入下一节点', () => {
      const id = insertNode(L, ui.node, type, edge);
      if (type === 'encounter') encounter(L.nodes[id]);
      ui.node = id;
      ui.pose = 0;
      changed(level, true);
    });
    const other = ids.filter((id) => id !== ui.node);
    if (other.length) {
      const row = group(tools);
      let replacement = other.includes(links[0]?.owner[links[0]?.key])
        ? links[0].owner[links[0].key]
        : other[0];
      input(row, '删除后接到', replacement, (v) => (replacement = v), { values: other });
      button(row, '删除此节点', async () => {
        if (!(await c.confirm('删除节点 ' + ui.node, '已有分支将接到 ' + replacement + '。')))
          return;
        unlinkNode(L, ui.node, replacement);
        ui.node = replacement;
        changed(level, true);
      });
    }
  }
  if (ui.view === 'settings') {
    parent.append(el('h2', '', '关卡设置'));
    const settings = section(parent);
    prop(settings, level, L, 'title', '关卡标题');
    prop(settings, level, L, 'id', '关卡 ID');
    targets(settings, L, 'start', '起始节点');
    vector(settings, level, L, 'spawn', '出生点');
    const s = section(parent);
    caption(s, '导出');
    const buttons = group(s, 'storybuttons');
    button(buttons, '单独导出关卡 JSON', () => c.exportOne(level));
    button(buttons, '导出模板 ZIP', () => c.exportLevel('zip'));
    json(parent, level);
    return;
  }
  if (!node) return;
  parent.append(el('h2', '', kinds[node.kind]));
  const f = section(parent);
  input(
    f,
    '节点 ID',
    ui.node,
    (v) => {
      renameNode(L, ui.node, v);
      ui.node = v;
      changed(level, true);
    },
    { commit: true, fail: c.message }
  );
  if (node.kind === 'dialogue') {
    prop(f, level, node, 'speaker', '说话人', { optional: true });
    input(f,'现场陈总',node.companion?'1':'0',v=>{node.companion=v==='1';changed();},{values:[['0','不出场'],['1','出场'] ]});
    prop(f, level, node, 'text', '对白内容', { textarea: true });
    if (node.choices) {
      for (const [i, ch] of node.choices.entries()) {
        const row = group(f);
        prop(row, level, ch, 'label', '选项 ' + (i + 1));
        targets(row, ch, 'next', '选项 ' + (i + 1) + ' 跳转');
        button(row, '移除选项 ' + (i + 1), () => {
          node.choices.splice(i, 1);
          if (!node.choices.length) {
            delete node.choices;
            node.next = ch.next;
          }
          changed(level, true);
        });
      }
    } else targets(f, node, 'next', '下一节点');
    if ((node.choices?.length || 0) < 8)
      button(f, '添加对白选项', () => {
        if (!node.choices) {
          node.choices = [{ label: '继续', next: node.next }];
          delete node.next;
        }
        node.choices.push({ label: '另一个选择', next: node.choices[0].next });
        changed(level, true);
      });
  } else if (['drive','phone','interact','scene','slot'].includes(node.kind)) {
    prop(f,level,node,'label','任务标题');
    if (node.kind === 'drive') {
      vector(f,level,node,'car','车辆起点');
      prop(f,level,node,'heading','车头朝向（度，向东为 90）',{number:true});
      prop(f,level,node,'passenger','同行乘客',{optional:true});
      node.route.forEach((p,i)=>{
        const g=section(f);
        caption(g,'路标 '+(i+1));
        prop(g,level,p,'label','路标说明');
        vector(g,level,p,'position','路标坐标');
        prop(g,level,p,'radius','路标半径（米）',{number:true,min:.5,max:100});
        if(node.route.length>1)button(g,'移除此路标',()=>{node.route.splice(i,1);changed(level,true);});
      });
      button(f,'增加路标',()=>{node.route.push({label:'下一路标',position:[...node.route.at(-1).position],radius:5});changed(level,true);});
    } else if (node.kind === 'phone') {
      prop(f,level,node,'contact','联系人');
      node.messages.forEach((m,i)=>{
        const g=section(f);
        caption(g,'消息 '+(i+1));
        prop(g,level,m,'from','发信人');
        prop(g,level,m,'text','消息内容',{textarea:true});
        if(node.messages.length>1)button(g,'移除这条消息',()=>{node.messages.splice(i,1);changed(level,true);});
      });
      button(f,'增加消息',()=>{node.messages.push({from:node.contact,text:'输入消息'});changed(level,true);});
    } else if (node.kind === 'interact' || node.kind === 'scene') {
      vector(f,level,node,'position','场景坐标');
      prop(f,level,node,'verb','操作按钮');
      prop(f,level,node,'text','场景文字',{textarea:true});
      if(node.kind === 'scene')
        prop(f,level,node,'timeOfDay','时段',{values:[['morning','上午'],['afternoon','下午'],['dusk','黄昏'],['night','夜间']]});
      else {
        prop(f,level,node,'radius','交互半径（米）',{number:true,min:.5,max:100});
        node.fields.forEach((row,i)=>{
          const g=group(f);
          prop(g,level,row,'label','栏目名');
          prop(g,level,row,'value','栏目内容');
          button(g,'移除栏目',()=>{node.fields.splice(i,1);changed(level,true);});
        });
        button(f,'增加栏目',()=>{node.fields.push({label:'栏目',value:'内容'});changed(level,true);});
      }
    } else {
      prop(f,level,node,'module','接口模块文件名',{commit:true,draw:true});
      prop(f,level,node,'file','备用动作文件名',{optional:true,commit:true,draw:true});
      f.append(el('p','','主游戏优先打开同名模块。只提供备用动作时会直接播放。接口留空时可继续剧情。'));
      const mod=resolveFile(files,node.module);
      if (mod?.kind==='module') editModule(parent,mod,mod.doc);
      else button(f,'创建接口模块',()=>{
        const m=freshModule(ui.node);
        m.title=node.label;
        if(L.id==='tomorrow.chapter01' && ui.node==='hotel_slot')
          Object.assign(m.opponents[0],{label:'陈总',model:'leonSuit'});
        c.put(makeRecord(node.module,m));
        ui.pose=0;
        changed(level,true);
      },true);
    }
    targets(f,node,'next','下一节点');
  } else if (node.kind === 'walk') {
    prop(f, level, node, 'label', '目标说明');
    vector(f, level, node, 'position', '目的地');
    prop(f, level, node, 'radius', '触发半径（米）', { number: true, min: 0.5, max: 100 });
    targets(f, node, 'next', '下一节点');
  } else if (node.kind === 'motion') {
    motions(f, level, node);
    prop(f, level, node, 'seconds', '播放秒数', {
      number: true,
      min: 0.1,
      max: 3600,
      optional: true
    });
    targets(f, node, 'next', '下一节点');
  } else if (node.kind === 'end') prop(f, level, node, 'text', '结尾内容', { textarea: true });
  else if (node.kind === 'encounter') {
    prop(f, level, node, 'label', '对局名称');
    const row = group(f);
    targets(row, node, 'win', '胜利后跳转');
    targets(row, node, 'great', '大胜后跳转', '沿用胜利分支');
    targets(row, node, 'lose', '失败后跳转', '重试本场');
    const modules = [
      ['', '关卡内嵌模块'],
      ...[...files.values()]
        .filter((r) => r.kind === 'module')
        .map((r) => [r.name, r.doc.title + ' · ' + r.name])
    ];
    input(
      f,
      '对局模块',
      node.module || '',
      (v) => {
        if (v) node.module = v;
        else {
          delete node.module;
          encounter(node);
        }
        ui.pose = 0;
        changed(level, true);
      },
      { values: modules, fail: c.message }
    );
    button(f, '新建独立模块', () => {
      const id = unique('module', (v) => files.has(fileKey(v + '.module.json')));
      const rec = makeRecord(id + '.module.json', freshModule(id));
      c.put(rec);
      node.module = rec.name;
      ui.pose = 0;
      changed(level, true);
    });
    const mod = node.module ? resolveFile(files, node.module) : level;
    if (mod && (!node.module || mod.kind === 'module'))
      editModule(parent, mod, node.module ? mod.doc : node);
    else parent.append(el('p', '', '请导入所引用的模块文件，或选择一个已有模块。'));
  }
  graphTools();
}
