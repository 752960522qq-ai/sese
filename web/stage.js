import * as T from './vendor/three.module.min.js';
import { OrbitControls } from './vendor/controls/OrbitControls.js';
import { sortedJoints } from './rig.js';
const up = new T.Vector3(0, 1, 0),
  point = new T.Vector3();
export class Stage {
  constructor(canvas) {
    this.renderer = new T.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      alpha: false
    });
    this.renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1));
    this.renderer.outputColorSpace = T.SRGBColorSpace;
    this.renderer.toneMapping = T.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.16;
    this.scene = new T.Scene();
    this.scene.background = new T.Color(0x263a3c);
    this.scene.fog = new T.FogExp2(0x263a3c, 0.065);
    this.camera = new T.PerspectiveCamera(38, 1, 0.025, 140);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 0.92, 0);
    this.camera.position.set(1.15, 1.45, 3.4);
    this.controls.maxPolarAngle = Math.PI - 0.035;
    this.controls.minDistance = 0.18;
    this.controls.maxDistance = 33;
    this.dirty = true;
    this.stamp = '';
    this.controls.addEventListener('change', () => {
      this.dirty = true;
    });
    this.controls.rotateSpeed = 0.72;
    this.controls.panSpeed = 0.85;
    this.controls.zoomSpeed = 0.9;
    this.controls.update();
    this.scene.add(new T.HemisphereLight(0xfff3e8, 0x9aafa6, 1.7));
    for (const [color, intensity, pos] of [
      [0xffede0, 2.25, [3, 5, 4]],
      [0xd5f5ec, 1.35, [-3, 3, -3]]
    ]) {
      const light = new T.DirectionalLight(color, intensity);
      light.position.fromArray(pos);
      this.scene.add(light);
    }
    this.floor = new T.Mesh(
      new T.PlaneGeometry(200, 200),
      new T.MeshBasicMaterial({ color: 0x374c48, side: T.FrontSide })
    );
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.position.y = -0.018;
    this.scene.add(this.floor);
    this.grid = new T.GridHelper(120, 240, 0x647970, 0x4d645e);
    this.grid.position.y = -0.014;
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.4;
    this.scene.add(this.grid);
    const canvasTex = document.createElement('canvas');
    canvasTex.width = canvasTex.height = 100;
    const ctx = canvasTex.getContext('2d'),
      g = ctx.createRadialGradient(50, 50, 0, 50, 50, 49);
    g.addColorStop(0, 'rgba(9,18,18,.66)');
    g.addColorStop(0.46, 'rgba(9,18,18,.26)');
    g.addColorStop(1, 'rgba(9,18,18,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 100, 100);
    this.shadowMap = new T.CanvasTexture(canvasTex);
    this.ring = new T.Mesh(
      new T.RingGeometry(0.398, 0.407, 80),
      new T.MeshBasicMaterial({
        color: 0xc2dc9f,
        transparent: true,
        opacity: 0.75,
        side: T.DoubleSide,
        depthWrite: false
      })
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = -0.006;
    this.scene.add(this.ring);
    this.canvas = canvas;
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas.parentElement);
    this.resize();
  }
  add(actor) {
    this.scene.add(actor.root);
    const mat = new T.MeshBasicMaterial({
      map: this.shadowMap,
      transparent: true,
      depthWrite: false
    });
    actor.shadow = new T.Mesh(new T.PlaneGeometry(1.05, 1.05), mat);
    actor.shadow.rotation.x = -Math.PI / 2;
    actor.shadow.position.y = -0.01;
    this.scene.add(actor.shadow);
  }
  remove(actor) {
    actor.shadow.removeFromParent();
    actor.shadow.geometry.dispose();
    actor.shadow.material.dispose();
    actor.dispose();
  }
  resize() {
    this.dirty = true;
    const w = Math.max(1, this.canvas.clientWidth),
      h = Math.max(1, this.canvas.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
  draw(actors, selected, editing) {
    const list = Array.from(actors),
      stamp =
        list
          .filter((a) => a.root.visible)
          .map((a) => a.state.id + ':' + a.revision)
          .join('/') +
        '|' +
        (selected?.state.id || '') +
        '|' +
        editing;
    this.controls.update();
    if (!this.dirty && this.stamp === stamp) return;
    this.dirty = false;
    this.stamp = stamp;
    for (const a of list) {
      a.shadow.visible = a.root.visible;
      a.shadow.position.x = a.root.position.x;
      a.shadow.position.z = a.root.position.z;
      a.shadow.material.opacity = Math.max(0.22, 1 - Math.abs(a.root.position.y) * 0.65);
    }
    this.ring.visible = editing && !!selected;
    if (selected)
      this.ring.position.set(selected.root.position.x, -0.006, selected.root.position.z);
    this.renderer.render(this.scene, this.camera);
  }
  frame(list, view = 'fit') {
    if (!list.length) return;
    const box = new T.Box3();
    for (const a of list) {
      a.root.updateMatrixWorld(true);
      for (const [name, label] of sortedJoints(a)[0]) {
        a.bones.get(name).getWorldPosition(point);
        box.expandByPoint(point);
        if (label === '头部') box.expandByPoint(point.clone().addScaledVector(up, 0.21));
      }
      if (box.isEmpty()) box.expandByPoint(a.root.position);
    }
    box.expandByScalar(0.19);
    const center = box.getCenter(new T.Vector3());
    const dir = new T.Vector3(
      ...{ front: [0, 0.06, 1], side: [1, 0.08, 0], top: [0, 1, 0.002], fit: [0.43, 0.22, 1] }[view]
    ).normalize();
    const right = new T.Vector3().crossVectors(up, dir).normalize(),
      vert = new T.Vector3().crossVectors(dir, right).normalize(),
      tan = Math.tan(T.MathUtils.degToRad(this.camera.fov / 2));
    let distance = 0.7;
    for (const x of [box.min.x, box.max.x])
      for (const y of [box.min.y, box.max.y])
        for (const z of [box.min.z, box.max.z]) {
          const rel = new T.Vector3(x, y, z).sub(center),
            depth = rel.dot(dir);
          distance = Math.max(
            distance,
            depth + Math.abs(rel.dot(vert)) / (tan * 0.85),
            depth + Math.abs(rel.dot(right)) / (tan * this.camera.aspect * 0.9)
          );
        }
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dir, distance);
    this.controls.update();
  }
  follow(dx, dz) {
    this.camera.position.x += dx;
    this.camera.position.z += dz;
    this.controls.target.x += dx;
    this.controls.target.z += dz;
  }
  faceCloseup(actor) {
    const head = actor?.bones.get('head');
    if (!head) return;
    actor.root.updateMatrixWorld(true);
    const eyeL = actor.bones.get('jointEyeLeft').getWorldPosition(new T.Vector3());
    const eyeR = actor.bones.get('jointEyeRight').getWorldPosition(new T.Vector3());
    const chin = actor.bones.get('chin_M').getWorldPosition(new T.Vector3());
    const target = eyeL.lerp(eyeR, 0.5).lerp(chin, 0.24);
    const front = new T.Vector3(0.07, 0.035, 1)
      .applyQuaternion(head.getWorldQuaternion(new T.Quaternion()))
      .normalize();
    this.controls.target.copy(target);
    this.camera.position
      .copy(target)
      .addScaledVector(front, Math.max(0.43, 0.28 / this.camera.aspect));
    this.controls.update();
    this.dirty = true;
  }
  snapshot() {
    return { p: this.camera.position.toArray(), target: this.controls.target.toArray() };
  }
  restore(saved) {
    this.camera.position.fromArray(saved.p);
    this.controls.target.fromArray(saved.target);
    this.controls.update();
  }
}
