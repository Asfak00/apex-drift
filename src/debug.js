import * as THREE from 'three';

// Development view, toggled with F3. Everything that used to need a guess —
// where the road surface is, how much room the terrain thinks it has, what the
// collision circles actually cover, where the shadow camera is pointing — is
// drawn here rather than reasoned about. It is built the first time it is asked
// for and costs nothing while it is off.
export class DebugView {
  constructor(scene, { renderer, camera, sun } = {}) {
    this.scene = scene;
    this.renderer = renderer;
    this.camera = camera;
    this.sun = sun;
    this.group = new THREE.Group();
    this.group.name = 'debug';
    this.group.visible = false;
    scene.add(this.group);
    this.readout = document.getElementById('debug');
    this.built = null;
  }

  get on() { return this.group.visible; }

  toggle(track) {
    this.group.visible = !this.group.visible;
    if (this.group.visible) this.build(track);
    if (this.readout) this.readout.hidden = !this.group.visible;
    return this.group.visible;
  }

  // Rebuilt whenever the circuit changes, not per frame.
  build(track) {
    if (!track || this.built === track) return;
    this.built = track;
    this.group.clear();
    this.#centreline(track);
    this.#edges(track);
    this.#solids(track);
    this.#shadowCamera();
  }

  // The line every measurement in the game is taken from.
  #centreline(track) {
    const pts = track.points.map((p) => p.clone().setY(p.y + 0.2));
    pts.push(pts[0].clone());
    this.group.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0x00ffcc }),
    ));
  }

  // Road edges in white, and the outer limit of the verge in amber: where the
  // amber line pinches in is where the circuit is coming back on itself.
  #edges(track) {
    const road = [[], []];
    const verge = [[], []];
    const n = track.points.length;
    for (let i = 0; i <= n; i++) {
      const k = i % n;
      const f = track.frameAt(k / n);
      [-1, 1].forEach((sign, s) => {
        road[s].push(f.pos.clone().addScaledVector(f.side, sign * track.roadHalf).setY(f.pos.y + 0.16));
        const room = track.verge(k, sign);
        verge[s].push(f.pos.clone()
          .addScaledVector(f.side, sign * (track.roadHalf + room))
          .setY(track.terrainY(f.pos.y, track.roadHalf + room, room) + 0.16));
      });
    }
    for (const line of road) {
      this.group.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(line),
        new THREE.LineBasicMaterial({ color: 0xffffff }),
      ));
    }
    for (const line of verge) {
      this.group.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(line),
        new THREE.LineBasicMaterial({ color: 0xffb020 }),
      ));
    }
  }

  // Every collision circle the track registered, at the height and radius the
  // physics uses — not at the size of the mesh that suggested it.
  #solids(track) {
    if (!track.solids.length) return;
    const geo = new THREE.CylinderGeometry(1, 1, 1, 12, 1, true);
    const mesh = new THREE.InstancedMesh(
      geo,
      new THREE.MeshBasicMaterial({ color: 0xff3a3f, wireframe: true, transparent: true, opacity: 0.55 }),
      track.solids.length,
    );
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    track.solids.forEach((solid, i) => {
      s.set(solid.radius, Math.max(0.5, solid.height), solid.radius);
      m.compose(new THREE.Vector3(solid.x, solid.y + solid.height / 2, solid.z), q, s);
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    this.group.add(mesh);
  }

  #shadowCamera() {
    if (!this.sun?.shadow?.camera) return;
    this.group.add(new THREE.CameraHelper(this.sun.shadow.camera));
  }

  // Numbers that only mean anything live: what the renderer is spending, where
  // the car is, and what the ground under it is doing.
  update(track, car, state = {}) {
    if (!this.group.visible || !this.readout) return;
    const info = this.renderer?.info;
    const p = track.project(car.position, car.hintIndex);
    const room = track.verge(p.index, Math.sign(p.lateral) || 1);
    const surface = track.terrainY(p.height, Math.abs(p.lateral), room);
    const r = state.render;
    const rows = [
      ['fps', state.fps?.toFixed(0) ?? '-'],
      ...(r ? [
        ['frame ms avg', r.avg.toFixed(2)],
        ['frame ms 1%', r.low.toFixed(2)],
        ['gpu ms', r.gpuMs === null ? 'n/a' : r.gpuMs.toFixed(2)],
        ['tier', r.tier],
        ['pixel ratio', r.pixelRatio],
        ['msaa', String(r.msaa)],
        ['post passes', `${r.passes}: ${r.active}`],
        ['shadow map', String(this.sun?.shadow?.mapSize.x ?? '-')],
        ['gpu', r.gpu.slice(0, 40)],
      ] : []),
      ...(state.condition ? (() => {
        const c = state.condition;
        const bin = Math.min(127, Math.floor(p.t * 128));
        return [
          ['track temp', `${c.temperature.toFixed(1)} C`],
          ['wetness', c.wetness.toFixed(3)],
          ['standing water', c.standingWater.toFixed(3)],
          ['dust', c.dust.toFixed(3)],
          ['rubber here', c.rubber[bin].toFixed(3)],
          ['line here', c.line[bin].toFixed(2)],
          ['debris here', c.debris[bin].toFixed(2)],
          ['evolution', c.evolution.toFixed(3)],
          ['road grip', c.gripFor(car).toFixed(3)],
        ];
      })() : []),
      ['draw calls', info?.render.calls ?? '-'],
      ['triangles', info?.render.triangles?.toLocaleString() ?? '-'],
      ['programs', info?.programs?.length ?? '-'],
      ['textures', info?.memory.textures ?? '-'],
      ['geometries', info?.memory.geometries ?? '-'],
      ['car xyz', [car.position.x, car.position.y, car.position.z]
        .map((v) => v.toFixed(1)).join(' ')],
      ['car y over road', (car.position.y - (p.height + 0.05)).toFixed(3)],
      ['lap t', p.t.toFixed(4)],
      ['lateral', `${p.lateral.toFixed(2)} of ${track.roadHalf}`],
      ['on road', String(car.onRoad)],
      ['verge here', `${room.toFixed(1)} m`],
      ['ground here', surface.toFixed(2)],
      ['road y', (p.height + 0.05).toFixed(2)],
      ['far field y', track.groundY.toFixed(2)],
      ['cam xyz', [this.camera.position.x, this.camera.position.y, this.camera.position.z]
        .map((v) => v.toFixed(1)).join(' ')],
      ['cam fov', this.camera.fov.toFixed(1)],
      ['slide', (car.slide ?? 0).toFixed(2)],
      ...(car.tyres?.temps ? [
        ['tyre C FL FR', car.tyres.temps.slice(0, 2).map((t) => t.toFixed(0)).join(' ')],
        ['tyre C RL RR', car.tyres.temps.slice(2).map((t) => t.toFixed(0)).join(' ')],
        ['tyre psi', [0, 1, 2, 3].map((k) => car.tyres.pressure(k).toFixed(1)).join(' ')],
        ['tyre window', car.tyres.spec.window.join('-')],
        ['axle grip F R', [0, 1].map((a) => car.tyres.axleGrip(a, car.leftShare).toFixed(3))
          .join(' ')],
        ['left load', (car.leftShare ?? 0.5).toFixed(2)],
      ] : []),
      ...(car.brakes ? [
        ['brake C F R', car.brakes.temps.map((t) => t.toFixed(0)).join(' ')],
        ['brake eff', car.brakes.efficiency.toFixed(3)],
      ] : []),
      ['sideslip', (car.sideslip ?? 0).toFixed(2)],
    ];
    this.readout.textContent = rows.map(([k, v]) => `${k.padEnd(16)}${v}`).join('\n');
  }
}
