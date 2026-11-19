import { basename, fileKey, makeRecord, blobFor } from './project.js';
import { inspectGlb } from './glb.js';

const MiB = 1024 * 1024;
const zipTools = () => import('../vendor/fflate.module.js');
const supported = (n) => /\.(json|glb)$/i.test(n);
function checkSize(name, size) {
  const limit = /\.glb$/i.test(name) ? 96 : 24;
  if (size > limit * MiB) throw Error(name + ' 超过主游戏的 ' + limit + ' MiB 限制');
}
export async function readFiles(inputs) {
  const records = new Map();
  async function read(name, file) {
    name = basename(name);
    const key = fileKey(name);
    if (records.has(key)) throw Error('本次导入有重名文件 ' + name);
    checkSize(name, file.size);
    let record;
    try {
      if (/\.glb$/i.test(name)) {
        const { clips } = await inspectGlb(file);
        record = { name, kind: 'glb', blob: file, clips };
      } else record = makeRecord(name, JSON.parse((await file.text()).replace(/^\uFEFF/, '')));
    } catch (e) {
      throw Error(name + ' · ' + e.message);
    }
    records.set(key, record);
  }
  for (const file of inputs) {
    if (/\.zip$/i.test(file.name)) {
      if (file.size > 384 * MiB) throw Error('模板 ZIP 超过 384 MiB，请分批导入文件');
      const { unzipSync } = await zipTools();
      let total = 0;
      const names = new Set();
      const extracted = unzipSync(new Uint8Array(await file.arrayBuffer()), {
        filter: (info) => {
          const path = info.name.split('/');
          if (!supported(path.at(-1)) || path.some((p) => p.startsWith('.') || p === '__MACOSX'))
            return false;
          const key = fileKey(basename(path.at(-1)));
          if (names.has(key)) throw Error('模板中有重名文件 ' + path.at(-1));
          names.add(key);
          checkSize(path.at(-1), info.originalSize);
          total += info.originalSize;
          if (total > 384 * MiB) throw Error('模板展开后超过 384 MiB，请分批导入');
          return true;
        }
      });
      for (const [path, bytes] of Object.entries(extracted)) {
        const name = path.split('/').at(-1);
        await read(name, new File([bytes], name));
      }
    } else if (supported(file.name)) await read(file.name, file);
    else throw Error('请选择模板 ZIP、JSON 或骨骼动作 GLB');
  }
  if (!records.size) throw Error('没有找到剧情、模块或动作文件');
  return [...records.values()];
}
function download(name, blob) {
  const url = URL.createObjectURL(blob),
    a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
async function archive(records) {
  const { zipSync } = await zipTools(),
    entries = Object.create(null);
  for (const r of records) entries[r.name] = new Uint8Array(await blobFor(r).arrayBuffer());
  return new Blob([zipSync(entries, { level: 1 })], { type: 'application/zip' });
}
let pending;
window.storyExportResult = (success, message) => {
  if (!pending) return;
  const { resolve, reject } = pending;
  pending = null;
  if (success) resolve(message);
  else reject(Error(message));
};
async function nativeWrite(native, mode, title, files) {
  if (pending || !native.begin(mode, title)) throw Error('文件选择器正在使用');
  try {
    for (const { name, blob } of files) {
      if (!native.openFile(name, blob.size)) throw Error('无法准备 ' + name);
      for (let i = 0; i < blob.size; i += 49152) {
        const bytes = new Uint8Array(await blob.slice(i, i + 49152).arrayBuffer());
        let value = '';
        for (let j = 0; j < bytes.length; j += 4096)
          value += String.fromCharCode(...bytes.subarray(j, j + 4096));
        if (!native.append(btoa(value))) throw Error('写入失败 ' + name);
      }
      if (!native.closeFile()) throw Error('长度校验失败 ' + name);
    }
    return await new Promise((resolve, reject) => {
      pending = { resolve, reject };
      if (!native.choose()) {
        pending = null;
        reject(Error('无法打开系统文件选择器'));
      }
    });
  } catch (e) {
    native.cancel();
    throw e;
  }
}
export async function exportFiles(records, mode, title) {
  const native = window.SeseStoryFiles;
  if (native && mode === 'folder')
    return nativeWrite(
      native,
      mode,
      title,
      records.map((r) => ({ name: r.name, blob: blobFor(r) }))
    );
  const single = mode === 'single',
    name = single ? records[0].name : title + '.zip';
  const blob = single ? blobFor(records[0]) : await archive(records);
  if (native) return nativeWrite(native, 'single', name, [{ name, blob }]);
  download(name, blob);
  return single ? '已导出 ' + name : '已导出 ZIP。解压后，在主游戏中一起选择里面的文件。';
}
