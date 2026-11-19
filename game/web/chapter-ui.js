const byId=id=>document.getElementById(id);
const gap=(pos,target)=>Math.hypot(pos.x-target[0],pos.z-target[2]);
export function chapterUI(ctx) {
  const {world,info,panel,btn,el,follow,checkpoint,notify,resolve,part,startModule,startMotion,resetInput}=ctx;
  const car=world.car, keys=new Set();
  const bar=byId('chapterHUD'),action=byId('contextAction'),controls=byId('driving'),dial=byId('driveSpeed');
  let command=null;
  for(const input of controls.querySelectorAll('button')){
    const code=input.dataset.control;
    input.onpointerdown=e=>{e.preventDefault();input.setPointerCapture(e.pointerId);keys.add(code);input.classList.add('held');};
    input.onpointercancel=input.onpointerup=input.onlostpointercapture=()=>{keys.delete(code);input.classList.remove('held');};
  }
  action.onclick=()=>{if(command)Promise.resolve(command()).catch(e=>notify(e.message));};
  function clearInput(){keys.clear();for(const b of controls.querySelectorAll('.held'))b.classList.remove('held');}
  const objective=byId('objective');
  function toward(target){
    const a=world.controls.getAzimuthalAngle(),dx=target[0]-world.pos.x,dz=target[2]-world.pos.z;
    const above=-dx*Math.sin(a)-dz*Math.cos(a),right=dx*Math.cos(a)-dz*Math.sin(a);
    objective.dataset.nav='true';
    objective.style.setProperty('--bearing',Math.atan2(right,above)+'rad');
  }
  function hide(){delete objective.dataset.nav;bar.hidden=true;controls.hidden=true;dial.hidden=true;action.hidden=true;command=null;clearInput();}
  function op(label,fn,disabled=false){action.hidden=!label;action.textContent=label||'';action.disabled=disabled;command=disabled?null:fn;}
  function tick(dt,pressed,stick){
    const {node:n,state:s}=info(),free=!n;
    const key=(...ids)=>ids.some(k=>keys.has(k)||pressed.has(k))?1:0;
    if(car.occupied)car.drive(key('gas','KeyW','ArrowUp')-key('brake','KeyS','ArrowDown'),key('left','KeyA','ArrowLeft')-key('right','KeyD','ArrowRight'),dt);
    else{
      const x=stick[0]+key('KeyD','ArrowRight')-key('KeyA','ArrowLeft'),y=stick[1]+key('KeyS','ArrowDown')-key('KeyW','ArrowUp');
      world.move(x,y,dt,Math.hypot(...stick)>.79||!!key('ShiftLeft','ShiftRight'));
    }
    if(n?.kind==='interact'){
      toward(n.position);
      const d=gap(world.pos,n.position);
      objective.textContent=n.label+' · '+Math.ceil(d)+' 米';
      bar.hidden=false;
      op(d<=n.radius?n.verb:null,()=>{s.open=true;checkpoint();ctx.screen('document');});
      return;
    }
    if((n?.kind!=='drive'&&!free)||!car.active){
      if(n?.kind==='walk')toward(n.position);else delete objective.dataset.nav;
      return;
    }
    bar.hidden=false;controls.hidden=!car.occupied;dial.hidden=!car.occupied;byId('stick').hidden=car.occupied;
    if(dial.hidden===false)dial.textContent=Math.round(Math.abs(car.speed)*3.6)+' km/h'+(car.speed<-.15?'  R':'');
    const index=s?.index??0,goal=n?.route[index],final=n&&index===n.route.length-1;
    if(!car.occupied){
      toward(car.pos.toArray());
      const d=car.distance();objective.textContent=(n?.label??'自由探索')+' · 展厅 SUV '+Math.ceil(d)+' 米';
      op(d<=5.5?'上车':null,()=>{resetInput();car.board();world.mark(goal?.position);checkpoint();tick(0,pressed,[0,0]);});
      return;
    }
    const d=goal?gap(car.pos,goal.position):Infinity;
    if(goal&&!final&&d<=goal.radius){s.index++;world.mark(n.route[s.index].position);checkpoint();}
    const g=n?.route[s?.index??0];
    if(g)toward(g.position);else delete objective.dataset.nav;
    objective.textContent=g?(s.index+1)+' / '+n.route.length+'  '+g.label+' · '+Math.ceil(gap(car.pos,g.position))+' 米':'自由驾驶';
    const parked=Math.abs(car.speed)<.8,arrived=final&&d<=goal.radius;
    op(arrived?(parked?'停车并下车':'刹停后下车'):'下车',()=>{
      if(!car.exit()){notify('车门旁空间不足，请挪车后下车');return;}
      resetInput();clearInput();checkpoint();
      if(arrived)return follow(n.next);
      world.mark(car.pos.toArray());tick(0,pressed,[0,0]);
    },!parked);
  }
  async function enter(n,s,resume){
    if(n.kind==='scene'){
      if(!resume)await world.travel(n.position);
      world.light(n.timeOfDay);return 'scene';
    }
    if(n.kind==='drive'){
      s.index=Math.min(s.index||0,n.route.length-1);
      await car.park(n.car,n.heading,s.car);
      if(n.passenger&&!car.occupied)await world.showCompanion();
      world.mark(car.occupied?n.route[s.index].position:car.pos.toArray());
      return 'walk';
    }
    if(n.kind==='interact'){world.mark(n.position);return s.open?'document':'walk';}
    if(n.kind==='phone')return 'phone';
    if(n.kind==='slot')return 'slot';
    return null;
  }
  function render(screen,n,s){
    if(screen==='scene'){
      panel('地点与时间',n.label,n.text);
      btn(n.verb,()=>follow(n.next),'primary');return true;
    }
    if(screen==='document'){
      panel('现场交互',n.verb,n.text);
      const dl=el('dl','orderFields');for(const row of n.fields)dl.append(el('dt','',row.label),el('dd','',row.value));byId('content').append(dl);
      btn('继续',()=>follow(n.next),'primary');return true;
    }
    if(screen==='phone'){
      panel('手机  /  私聊',n.contact,'');
      const count=s.read||0,thread=el('div','thread');
      for(const m of n.messages.slice(0,count)){
        const row=el('div',m.from===n.contact?'received':'sent');
        row.append(el('small','',m.from),el('p','',m.text));thread.append(row);
      }
      byId('content').append(thread);
      if(count<n.messages.length){
        const msg=n.messages[count];
        btn(msg.from===n.contact?'查看回复':'发送消息',()=>{s.read=count+1;checkpoint();ctx.redraw();},'primary');
      }else btn('收起手机',()=>follow(n.next),'primary');
      requestAnimationFrame(()=>{thread.scrollTop=thread.scrollHeight;});return true;
    }
    if(screen==='slot'){
      const mod=resolve(n.module),motion=n.file&&resolve(n.file);
      panel('章节接口',n.label,mod?'已找到自定义模块。':motion?'已找到备用动作。':'本段留给自定义内容。当前可以直接继续剧情。');
      if(mod)btn('进入自定义模块',()=>startModule(mod),'primary');
      else if(motion)btn('播放自定义动作',()=>startMotion(motion,part(n.file)),'primary');
      btn('继续至下一场',()=>follow(n.next),mod||motion?'subtle':'primary');
      btn('导入本段文件',()=>byId('files').click(),'subtle');
      return true;
    }
    return false;
  }
  return {tick,enter,render,hide,clearInput,activate:()=>{if(!action.hidden&&!action.disabled)action.click();}};
}
