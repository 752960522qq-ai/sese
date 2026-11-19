const TYPE = 'sese-pose-combination';
const LIMIT = 24 * 1024 * 1024;
const vector = (v, n) => Array.isArray(v) && v.length === n && v.every(Number.isFinite);
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

export function readCombination(text) {
  if (typeof text !== 'string' || text.length > LIMIT) throw Error('搭配文件超过 24 MB');
  let doc;
  try {
    doc = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (_) {
    throw Error('搭配文件无法读取，请选择有效的 JSON 文件');
  }
  if (doc?.type !== TYPE || doc.version !== 1 || !Array.isArray(doc.scene?.actors))
    throw Error('此文件不是支持的搭配文件');
  for (const actor of doc.scene.actors) {
    if (
      !object(actor) ||
      !object(actor.offsets) ||
      !Object.values(actor.offsets).every((v) => vector(v, 3)) ||
      !Array.isArray(actor.keys)
    )
      throw Error('搭配文件中的角色数据有误');
    let past = -1;
    for (const pose of actor.keys) {
      if (
        !object(pose) ||
        !Number.isFinite(pose.t) ||
        pose.t <= past ||
        pose.t < 0 ||
        !vector(pose.p, 3) ||
        !Number.isFinite(pose.yaw) ||
        !object(pose.joints) ||
        !object(pose.morph)
      )
        throw Error('搭配文件中的动作关键帧有误');
      past = pose.t;
      for (const bone of Object.values(pose.joints)) {
        if (
          !object(bone) ||
          Object.entries(bone).some(
            ([k, v]) => !['p', 'q', 's'].includes(k) || !vector(v, k === 'q' ? 4 : 3)
          )
        )
          throw Error('搭配文件中的骨骼记录有误');
      }
      if (
        !Object.values(pose.morph).every(
          (weights) => Array.isArray(weights) && weights.every(Number.isFinite)
        )
      )
        throw Error('搭配文件中的形变记录有误');
    }
  }
  return {
    name: typeof doc.name === 'string' ? doc.name.trim().slice(0, 40) : '',
    scene: doc.scene
  };
}

export function exportCombination(name, scene) {
  const text = JSON.stringify({ type: TYPE, version: 1, name, scene });
  if (new Blob([text]).size > LIMIT) throw Error('搭配文件超过 24 MB');
  const filename =
    (name.replace(/[\u0000-\u001f\\/:*?"<>|]/g, '_').trim() || '搭配') + '.sese.json';
  const native = window.SeseSceneFiles;
  if (native) {
    if (!native.beginExport(filename)) throw Error('文件选择器正在使用');
    for (let i = 0; i < text.length; ) {
      let end = Math.min(i + 32768, text.length);
      const last = text.charCodeAt(end - 1);
      if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
      if (!native.appendExport(text.slice(i, end))) throw Error('无法准备搭配文件');
      i = end;
    }
    native.commitExport();
    return false;
  }
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return true;
}

export async function readBrowserFile(file) {
  if (file.size > LIMIT) throw Error('搭配文件超过 24 MB');
  return file.text();
}
