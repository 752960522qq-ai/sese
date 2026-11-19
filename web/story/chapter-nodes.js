const string = (s, max=160) => typeof s==='string' && s.trim().length>0 && s.length<=max;
const vector = p => Array.isArray(p) && p.length===3 && p.every(Number.isFinite);
const area = p => p && vector(p.position) && Number.isFinite(p.radius) && p.radius>=.5 && p.radius<=100;
const file = n => string(n,180) && !/[\\/\x00-\x1f]/.test(n) && !['.','..'].includes(n);
const list = (a,max,test) => Array.isArray(a) && a.length>0 && a.length<=max && a.every(test);
export function chapterNode(node,link) {
  let valid;
  switch(node.kind) {
    case 'drive':
      valid=vector(node.car) && Number.isFinite(node.heading) && (!node.passenger || string(node.passenger,60)) &&
        list(node.route,64,p=>area(p)&&string(p.label));break;
    case 'phone':
      valid=string(node.contact,60) && list(node.messages,200,m=>m&&string(m.from,60)&&string(m.text,4000));break;
    case 'interact':
      valid=area(node) && string(node.verb) && string(node.text,4000) &&
        Array.isArray(node.fields)&&node.fields.length<=32&&node.fields.every(f=>f&&string(f.label)&&string(f.value,600));break;
    case 'scene':
      valid=vector(node.position)&&string(node.text,4000)&&string(node.verb)&&['morning','afternoon','dusk','night'].includes(node.timeOfDay);break;
    case 'slot':
      valid=file(node.module)&&(!node.file||file(node.file));break;
    default:return false;
  }
  if(!valid||!string(node.label))throw Error('剧情节点参数无效 · '+(node.label||node.kind));
  link(node.next);
  return true;
}
