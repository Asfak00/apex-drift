import * as THREE from 'three';

// Spectators. A capsule with a ball on top reads as a bollard, not a person,
// so each figure is built from the parts a person actually has — two legs, a
// torso, two arms hung from the shoulders, a head and hair — in instanced
// meshes that all share one animation clock.
//
// The motion runs in the vertex shader: every figure carries a phase, and the
// shader bobs the body and swings the arms from that phase. Nothing is written
// per frame except two uniforms, so a full grandstand costs no more CPU than
// an empty one.

const UP = new THREE.Vector3(0, 1, 0);

const SKIN = [0xf0c9a4, 0xe0ab80, 0xc68a5e, 0xa06a42, 0x7a4b2c, 0x51331e];
const HAIR = [0x1a1512, 0x2e2018, 0x4a3524, 0x6b4a2a, 0x8c6c3f, 0xb9b3ad, 0x3a3f4a];
const TROUSER = [0x232a38, 0x2f3a4e, 0x3c3f45, 0x4a4438, 0x1d2330, 0x5a5f68];

// Body parts, each authored in metres about the pivot the animation needs:
// everything but the arms pivots at the figure's feet, the arms at the
// shoulder so they can be swung without shearing.
// A spectator is never closer than the far side of a barrier, so the segment
// counts are the fewest that still read as a body rather than as a crate. The
// crowd is thousands of figures: every segment is paid for thousands of times.
function parts(detail = 1) {
  const ring = (n) => Math.max(4, Math.round(n * detail));
  const leg = new THREE.CapsuleGeometry(0.072, 0.44, 2, ring(6));
  leg.translate(0, 0.42, 0);
  const shoe = new THREE.BoxGeometry(0.098, 0.062, 0.21);
  shoe.translate(0, 0.031, 0.026);
  // Shoulders sit above the chest, so the torso is two stacked sections rather
  // than one sausage: a waist that narrows and a chest that does not.
  const torso = new THREE.CapsuleGeometry(0.152, 0.34, 3, ring(8));
  torso.scale(1, 1, 0.72);
  torso.translate(0, 1.07, 0);
  const shoulders = new THREE.CapsuleGeometry(0.078, 0.30, 2, ring(6));
  shoulders.rotateZ(Math.PI / 2);
  shoulders.scale(1, 1, 0.8);
  shoulders.translate(0, 1.33, 0);
  // Shoulder at the origin, the arm hanging below it.
  const arm = new THREE.CapsuleGeometry(0.05, 0.36, 2, ring(5));
  arm.translate(0, -0.22, 0);
  const hand = new THREE.SphereGeometry(0.056, ring(6), ring(4));
  hand.scale(0.8, 1.1, 0.85);
  hand.translate(0, -0.45, 0);
  const neck = new THREE.CylinderGeometry(0.05, 0.062, 0.1, ring(6));
  neck.translate(0, 1.43, 0);
  const head = new THREE.SphereGeometry(0.103, ring(9), ring(7));
  head.scale(0.93, 1.13, 0.99);
  head.translate(0, 1.56, 0);
  const hair = new THREE.SphereGeometry(0.108, ring(9), ring(5), 0, Math.PI * 2, 0, Math.PI * 0.64);
  hair.scale(1, 1.06, 1.03);
  hair.translate(0, 1.565, 0);
  const cap = new THREE.SphereGeometry(0.112, ring(8), ring(4), 0, Math.PI * 2, 0, Math.PI * 0.5);
  cap.scale(1, 0.82, 1);
  cap.translate(0, 1.582, 0);
  const peak = new THREE.BoxGeometry(0.17, 0.018, 0.1);
  peak.translate(0, 1.572, 0.12);
  return { leg, shoe, torso, shoulders, arm, hand, neck, head, hair, cap, peak };
}

// One material family, patched once. `swing` selects the arm behaviour; every
// other part only bobs.
function livingMaterial(base, uniforms, swing) {
  const mat = base;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.time;
    shader.uniforms.uCheer = uniforms.cheer;
    // The normal has to be turned in `beginnormal_vertex`: by the time
    // `begin_vertex` runs, three has already built the world normal from it.
    const spin = swing
      ? `
        // Not everyone throws both arms up: a third of the crowd claps in
        // front of them instead, which is what a stand actually looks like.
        float style = fract(aPhase * 3.97);
        float reach = style < 0.34 ? 1.15 : 2.05 + 0.34 * sin(ph * 2.1);
        sw = -uCheer * reach - (1.0 - uCheer) * 0.12 * sin(ph);
        cs = cos(sw); sn = sin(sw);
        objectNormal.yz = vec2(objectNormal.y * cs - objectNormal.z * sn,
                               objectNormal.y * sn + objectNormal.z * cs);`
      : '';
    const move = swing
      ? `
        transformed.yz = vec2(transformed.y * cs - transformed.z * sn,
                              transformed.y * sn + transformed.z * cs);
        transformed.y += bob;`
      : `
        transformed.y += bob;
        transformed.x += bob * 0.35;
        // A body leans into what it is watching rather than standing to
        // attention, and leans further when there is something to shout at.
        transformed.z += transformed.y * uCheer * 0.035 * (0.5 + fract(aPhase * 5.13));`;
    shader.vertexShader = `
      attribute float aPhase;
      uniform float uTime;
      uniform float uCheer;
      float ph;
      float bob;
      float sw;
      float cs;
      float sn;
    ` + shader.vertexShader
      .replace('#include <beginnormal_vertex>', `
        #include <beginnormal_vertex>
        // A crowd is not a chorus line: each figure keeps its own tempo as
        // well as its own phase, so no two are ever quite in step.
        float rate = 1.75 + fract(aPhase * 7.31) * 1.1;
        ph = uTime * rate + aPhase * 6.28318;
        bob = sin(ph) * (0.02 + uCheer * 0.07);
        ${spin}`)
      .replace('#include <begin_vertex>', `
        #include <begin_vertex>
        ${move}`);
  };
  // Patched shaders are cached by this key, so each variant needs its own.
  mat.customProgramCacheKey = () => (swing ? 'crowd-arm' : 'crowd-body');
  return mat;
}

// How many of each part a figure carries. Two legs, one torso, and so on: the
// slot a figure owns in each mesh is its index times this.
const PER = {
  legs: 2, shoes: 2, torso: 1, shoulders: 1, arms: 2, hands: 2,
  neck: 1, head: 1, hair: 1, caps: 1, peaks: 1,
};

// Parts worn by only some of the crowd get their own running count, so a hat
// costs nothing for the people not wearing one.
const OPTIONAL = new Set(['caps', 'peaks']);

export class Crowd {
  constructor(capacity, detail = 1) {
    this.capacity = capacity;
    this.uniforms = { time: { value: 0 }, cheer: { value: 0.25 } };
    this.group = new THREE.Group();
    this.group.name = 'crowd';
    this.n = 0;
    this.hats = 0;

    const geo = parts(detail);
    const skin = () => livingMaterial(
      new THREE.MeshStandardMaterial({ roughness: 0.78 }), this.uniforms, false);
    const cloth = () => livingMaterial(
      new THREE.MeshStandardMaterial({ roughness: 0.94 }), this.uniforms, false);
    // Hands hang off the shoulder like the arms do, so they take the same
    // swing; anything else would leave them behind when the arms go up.
    const swung = () => livingMaterial(
      new THREE.MeshStandardMaterial({ roughness: 0.78 }), this.uniforms, true);
    const hats = Math.max(8, Math.ceil(capacity * 0.34));

    this.meshes = {
      legs: new THREE.InstancedMesh(geo.leg, cloth(), capacity * 2),
      shoes: new THREE.InstancedMesh(geo.shoe, cloth(), capacity * 2),
      torso: new THREE.InstancedMesh(geo.torso, cloth(), capacity),
      shoulders: new THREE.InstancedMesh(geo.shoulders, cloth(), capacity),
      arms: new THREE.InstancedMesh(geo.arm, swung(), capacity * 2),
      hands: new THREE.InstancedMesh(geo.hand, swung(), capacity * 2),
      neck: new THREE.InstancedMesh(geo.neck, skin(), capacity),
      head: new THREE.InstancedMesh(geo.head, skin(), capacity),
      hair: new THREE.InstancedMesh(geo.hair, cloth(), capacity),
      caps: new THREE.InstancedMesh(geo.cap, cloth(), hats),
      peaks: new THREE.InstancedMesh(geo.peak, cloth(), hats),
    };

    // Every part carries the phase of the figure it belongs to.
    this.phases = {};
    for (const [key, mesh] of Object.entries(this.meshes)) {
      const slots = mesh.count;
      const attr = new THREE.InstancedBufferAttribute(new Float32Array(slots), 1);
      mesh.geometry.setAttribute('aPhase', attr);
      this.phases[key] = attr;
      // Thousands of figures behind a barrier are not worth a second shadow
      // pass: the stand they stand in casts the shadow that matters. Taking
      // that shadow is nearly free, and it is what sits them under the roof
      // instead of lighting them as if it were not there.
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      this.group.add(mesh);
    }

    this.m = new THREE.Matrix4();
    this.q = new THREE.Quaternion();
    this.scaleV = new THREE.Vector3();
    this.tint = new THREE.Color();
    this.offset = new THREE.Vector3();
  }

  get full() { return this.n >= this.capacity; }

  #place(key, slot, at, yaw, scale, local) {
    if (slot >= this.meshes[key].instanceMatrix.count) return;
    this.q.setFromAxisAngle(UP, yaw);
    this.offset.copy(local).multiplyScalar(scale).applyQuaternion(this.q).add(at);
    this.scaleV.setScalar(scale);
    this.m.compose(this.offset, this.q, this.scaleV);
    this.meshes[key].setMatrixAt(slot, this.m);
    this.phases[key].array[slot] = this.phase;
  }

  // One spectator standing at `at`, facing `yaw`.
  add(at, yaw) {
    if (this.full) return false;
    const i = this.n;
    const scale = 0.88 + Math.random() * 0.24;
    this.phase = Math.random();
    const skin = SKIN[(Math.random() * SKIN.length) | 0];
    const shirt = new THREE.Color().setHSL(Math.random(), 0.42 + Math.random() * 0.4,
      0.34 + Math.random() * 0.34);
    const trouser = TROUSER[(Math.random() * TROUSER.length) | 0];
    const hairHex = HAIR[(Math.random() * HAIR.length) | 0];
    // Short sleeves show skin; long sleeves match the shirt.
    const bare = Math.random() < 0.55;
    const sleeve = bare ? new THREE.Color(skin) : shirt;
    const wearsHat = Math.random() < 0.3 && this.hats < this.meshes.caps.instanceMatrix.count;
    const zero = new THREE.Vector3(0, 0, 0);

    for (const [k, side] of [[0, -1], [1, 1]]) {
      const slot = i * 2 + k;
      const stance = side * (0.082 + Math.random() * 0.022);
      this.#place('legs', slot, at, yaw, scale, new THREE.Vector3(stance, 0, 0));
      this.meshes.legs.setColorAt(slot, this.tint.setHex(trouser));
      this.#place('shoes', slot, at, yaw, scale, new THREE.Vector3(stance, 0, 0));
      this.meshes.shoes.setColorAt(slot, this.tint.setHex(0x16191f));
      this.#place('arms', slot, at, yaw, scale, new THREE.Vector3(side * 0.2, 1.32, 0));
      this.meshes.arms.setColorAt(slot, sleeve);
      this.#place('hands', slot, at, yaw, scale, new THREE.Vector3(side * 0.2, 1.32, 0));
      this.meshes.hands.setColorAt(slot, this.tint.setHex(skin));
    }
    this.#place('torso', i, at, yaw, scale, zero);
    this.meshes.torso.setColorAt(i, shirt);
    this.#place('shoulders', i, at, yaw, scale, zero);
    this.meshes.shoulders.setColorAt(i, shirt);
    this.#place('neck', i, at, yaw, scale, zero);
    this.meshes.neck.setColorAt(i, this.tint.setHex(skin));
    this.#place('head', i, at, yaw, scale, zero);
    this.meshes.head.setColorAt(i, this.tint.setHex(skin));
    this.#place('hair', i, at, yaw, scale, zero);
    this.meshes.hair.setColorAt(i, this.tint.setHex(hairHex));
    if (wearsHat) {
      const cap = new THREE.Color().setHSL(Math.random(), 0.5, 0.42);
      this.#place('caps', this.hats, at, yaw, scale, zero);
      this.meshes.caps.setColorAt(this.hats, cap);
      this.#place('peaks', this.hats, at, yaw, scale, zero);
      this.meshes.peaks.setColorAt(this.hats, cap);
      this.hats += 1;
    }

    this.n += 1;
    return true;
  }

  // Call once the last spectator is placed.
  finish() {
    for (const [key, mesh] of Object.entries(this.meshes)) {
      mesh.count = OPTIONAL.has(key) ? this.hats : this.n * PER[key];
      mesh.instanceMatrix.needsUpdate = true;
      this.phases[key].needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    return this.group;
  }

  // `cheer` 0..1: idle shuffling at the bottom, arms up at the top.
  update(dt, cheer) {
    this.uniforms.time.value += dt;
    const want = Math.max(0, Math.min(1, cheer));
    const u = this.uniforms.cheer;
    u.value += (want - u.value) * Math.min(1, dt * 2.2);
  }
}
