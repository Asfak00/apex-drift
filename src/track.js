import * as THREE from 'three';
import { PALETTE, TRACKS, PIT } from './config.js';
import { sampleCentreline } from './layout.js';
import { Crowd } from './crowd.js';

const UP = new THREE.Vector3(0, 1, 0);

export const BARRIER_OFFSET = 2.6; // centreline of the barrier, beyond the road edge
export const BARRIER_DEPTH = 0.6;  // barrier thickness
const SAMPLES = 900;            // centreline resolution
const GROUND_Y = -7.5;          // far-field terrain, below the lowest banking
const CHECKPOINTS = 24;

export class Track {
  constructor(spec = TRACKS.apex) {
    this.spec = spec;
    this.roadHalf = spec.roadHalf;
    // Inner face of the barrier. Anything solid stops its own half-width short.
    // A circuit with no barriers has no wall to stop against: running wide is
    // then a matter of losing time on the dirt, not of hitting something.
    this.barriers = spec.barriers ?? 'armco';
    this.wallFace = this.barriers === 'none'
      ? Infinity
      : this.roadHalf + BARRIER_OFFSET - BARRIER_DEPTH / 2;
    this.surfaceGrip = spec.grip;

    // The pit lane is a second ribbon outside the barrier line on one side of
    // the start/finish straight. Everything that asks "is this drivable" or
    // "where is the wall" asks the track, so the lane is one description here
    // rather than a special case in the car.
    this.pit = {
      ...PIT,
      side: 1,
      centre: this.roadHalf + PIT.gap,
      inner: this.roadHalf + PIT.gap - PIT.half,
      outer: this.roadHalf + PIT.gap + PIT.half,
      span: ((PIT.exit - PIT.entry) + 1) % 1,
    };
    this.pitWallFace = this.pit.outer + 0.9 - BARRIER_DEPTH / 2;
    this.bank = spec.bank;
    this.baseColors = { road: spec.road, ground: spec.ground, hills: spec.hills };

    // Two ways to describe a circuit, one sample table out of both: control
    // points get smoothed into a racing loop, a segment script keeps its
    // straights straight and its corners at a true radius.
    const line = sampleCentreline(spec, SAMPLES);
    if (line.closure && !line.closure.closed) {
      console.warn(`circuit "${spec.name}" does not close: ${line.closure.gap.toFixed(1)}m gap`);
    }
    this.points = line.points;
    this.tangents = line.tangents;
    for (let i = 0; i < SAMPLES; i++) this.points[i].y = this.bankHeight(i / SAMPLES);
    this.junctions = line.junctions.map((j) => ({ ...j, t: this.#nearestT(j.position) }));

    this.cumulative = [0];
    for (let i = 1; i < SAMPLES; i++) {
      this.cumulative.push(this.cumulative[i - 1] + this.points[i].distanceTo(this.points[i - 1]));
    }
    this.length = this.cumulative[SAMPLES - 1] + this.points[0].distanceTo(this.points[SAMPLES - 1]);

    this.checkpoints = Array.from({ length: CHECKPOINTS }, (_, i) => i / CHECKPOINTS);
    // Anything a car must not drive through, as a circle on the ground plane,
    // bucketed into a coarse grid so a lookup is a handful of cells rather than
    // a sweep of the whole circuit.
    this.solids = [];
    this.solidGrid = new Map();

    this.group = new THREE.Group();
    this.group.name = 'track';
    this.#buildRoad();
    if (spec.kerbs) this.#buildKerbs();
    if (this.junctions.length) this.#buildJunctions();
    this.#buildBarriers();
    this.#buildStartLine();
    this.#buildPitLane();
    this.#buildScenery();
  }

  #nearestT(position) {
    let best = 0, bestDist = Infinity;
    for (let i = 0; i < SAMPLES; i++) {
      const d = this.points[i].distanceToSquared(position);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    return best / SAMPLES;
  }

  // Gentle elevation so the circuit is not a flat disc.
  bankHeight(t) {
    const [a, b] = this.bank;
    return Math.sin(t * Math.PI * 4) * a + Math.sin(t * Math.PI * 6 + 1.2) * b;
  }

  frameAt(t) {
    const i = Math.floor(((t % 1) + 1) % 1 * SAMPLES) % SAMPLES;
    const pos = this.points[i];
    const tan = this.tangents[i];
    const side = new THREE.Vector3().crossVectors(UP, tan).normalize();
    return { pos, tan, side, index: i };
  }

  // Nearest-centreline projection: returns progress t, signed lateral offset,
  // and the heading of the road there. Used by physics, AI and standings.
  project(pos, hint = null) {
    let best = -1, bestDist = Infinity;
    const scan = (from, to) => {
      for (let k = from; k < to; k++) {
        const i = ((k % SAMPLES) + SAMPLES) % SAMPLES;
        const d = this.points[i].distanceToSquared(pos);
        if (d < bestDist) { bestDist = d; best = i; }
      }
    };
    // Local scan around a hint index is the common case; full scan is the fallback.
    if (hint !== null) scan(hint - 40, hint + 40);
    if (best < 0 || bestDist > 3600) { bestDist = Infinity; scan(0, SAMPLES); }

    const frame = this.frameAt(best / SAMPLES);
    const delta = new THREE.Vector3().subVectors(pos, frame.pos);
    return {
      t: best / SAMPLES,
      index: best,
      lateral: delta.dot(frame.side),
      height: frame.pos.y,
      tangent: frame.tan,
      side: frame.side,
      onRoad: Math.abs(delta.dot(frame.side)) <= this.roadHalf,
    };
  }

  // How far into the pit lane's t-span a point is, 0 at the entry and 1 at the
  // rejoin, or null when the point is nowhere near it.
  pitPhase(t) {
    const d = ((t - this.pit.entry) % 1 + 1) % 1;
    return d <= this.pit.span ? d / this.pit.span : null;
  }

  // The barrier a car resting against this side of the road would touch. Over
  // the pit lane there is no barrier on the pit side: the wall is the far side
  // of the lane instead. The swap is tapered so the wall never jumps sideways
  // under a car that is already leaning on it.
  wallLimit(t, sign) {
    if (this.barriers === 'none') return Infinity;
    if (sign !== this.pit.side) return this.wallFace;
    const phase = this.pitPhase(t);
    if (phase === null) return this.wallFace;
    const taper = Math.min(1, phase / 0.12, (1 - phase) / 0.12);
    return this.wallFace + (this.pitWallFace - this.wallFace) * Math.max(0, taper);
  }

  // Sealed surface: the circuit itself, plus the pit lane where there is one.
  drivable(t, lateral) {
    if (Math.abs(lateral) <= this.roadHalf + 1.2) return true;
    return this.inPitLane(t, lateral);
  }

  inPitLane(t, lateral) {
    if (this.pitPhase(t) === null) return false;
    const across = lateral * this.pit.side;
    // Past the edge of the circuit, not merely on that half of it: a car
    // hugging the pit-side kerb is still racing, and must not be limited.
    return across > this.roadHalf + 0.6 && across < this.pit.outer + 1;
  }

  // Stopped on the box, ready to be worked on. Measured in metres, not in
  // fractions of a lap, or the box would be a different size on every circuit.
  inPitBox(t, lateral) {
    if (!this.inPitLane(t, lateral)) return false;
    const d = Math.abs(((t - this.pit.box) + 1.5) % 1 - 0.5) * this.length;
    return d < 9;
  }

  // Grid slot: staggered behind the start line, alternating sides.
  gridSlot(i) {
    const t = (1 - (i * 0.006) - 0.004) % 1;
    const f = this.frameAt(t);
    const lateral = (i % 2 === 0 ? -1 : 1) * 3.6;
    return {
      position: f.pos.clone().addScaledVector(f.side, lateral).setY(f.pos.y + 0.05),
      heading: Math.atan2(f.tan.x, f.tan.z),
      t,
    };
  }

  // A flat colour reads as plastic. A cheap noise field broken up by faint
  // streaks along the driving line gives the surface something to catch light on.
  #surfaceTexture() {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const c = canvas.getContext('2d');
    const coarse = this.spec.surface === 'dirt';

    c.fillStyle = '#808080';
    c.fillRect(0, 0, size, size);
    const image = c.getImageData(0, 0, size, size);
    const d = image.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (Math.random() - 0.5) * (coarse ? 150 : 74);
      d[i] = d[i + 1] = d[i + 2] = Math.max(0, Math.min(255, 128 + n));
    }
    c.putImageData(image, 0, 0);

    c.globalAlpha = coarse ? 0.3 : 0.16;
    for (let i = 0; i < 26; i++) {
      c.fillStyle = Math.random() < 0.5 ? '#ffffff' : '#000000';
      c.fillRect(Math.random() * size, 0, 1 + Math.random() * 3, size);
    }
    c.globalAlpha = 1;

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(2, 1);
    tex.anisotropy = 8;
    return tex;
  }

  #buildRoad() {
    const pos = [], idx = [], uv = [];
    for (let i = 0; i <= SAMPLES; i++) {
      const f = this.frameAt((i % SAMPLES) / SAMPLES);
      const l = f.pos.clone().addScaledVector(f.side, -this.roadHalf);
      const r = f.pos.clone().addScaledVector(f.side, this.roadHalf);
      pos.push(l.x, l.y + 0.05, l.z, r.x, r.y + 0.05, r.z);
      const u = (i / SAMPLES) * 140;
      uv.push(0, u, 1, u);
      if (i < SAMPLES) {
        const s = i * 2;
        idx.push(s, s + 2, s + 1, s + 1, s + 2, s + 3);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();

    const dirt = this.spec.surface === 'dirt';
    const grain = this.#surfaceTexture();
    this.roadMaterial = new THREE.MeshStandardMaterial({
      color: this.spec.road,
      roughness: dirt ? 1 : 0.92,
      metalness: dirt ? 0 : 0.02,
      roughnessMap: grain,
      bumpMap: grain,
      bumpScale: dirt ? 0.5 : 0.16,
    });
    this.road = new THREE.Mesh(g, this.roadMaterial);
    this.road.receiveShadow = true;
    this.group.add(this.road);

    // Dashed centre line, drawn as its own thin ribbon of quads.
    const lp = [], li = [];
    let quad = 0;
    for (let i = 0; i < SAMPLES; i += 6) {
      const f0 = this.frameAt(i / SAMPLES);
      const f1 = this.frameAt(((i + 3) % SAMPLES) / SAMPLES);
      const w = 0.22;
      const a = f0.pos.clone().addScaledVector(f0.side, -w);
      const b = f0.pos.clone().addScaledVector(f0.side, w);
      const c = f1.pos.clone().addScaledVector(f1.side, w);
      const d = f1.pos.clone().addScaledVector(f1.side, -w);
      for (const v of [a, b, c, d]) lp.push(v.x, v.y + 0.09, v.z);
      const s = quad * 4;
      li.push(s, s + 1, s + 2, s, s + 2, s + 3);
      quad++;
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
    lg.setIndex(li);
    lg.computeVertexNormals();
    this.group.add(new THREE.Mesh(lg, new THREE.MeshStandardMaterial({
      color: 0xd8e2f0, roughness: 0.6, emissive: 0x223044, emissiveIntensity: 0.35,
    })));
  }

  #buildKerbs() {
    // Alternating red/white blocks hugging both edges.
    const matA = new THREE.MeshStandardMaterial({ color: PALETTE.kerbA, roughness: 0.55 });
    const matB = new THREE.MeshStandardMaterial({ color: PALETTE.kerbB, roughness: 0.55 });
    const geo = new THREE.BoxGeometry(1.5, 0.22, 3.0);
    const step = 5;
    const count = Math.floor(SAMPLES / step) * 2;
    const meshA = new THREE.InstancedMesh(geo, matA, count);
    const meshB = new THREE.InstancedMesh(geo, matB, count);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1);
    let ia = 0, ib = 0, flip = 0;
    for (let i = 0; i < SAMPLES; i += step) {
      const f = this.frameAt(i / SAMPLES);
      const yaw = Math.atan2(f.tan.x, f.tan.z);
      for (const sgn of [-1, 1]) {
        const p = f.pos.clone().addScaledVector(f.side, sgn * (this.roadHalf + 0.8)).setY(f.pos.y + 0.11);
        q.setFromAxisAngle(UP, yaw);
        m.compose(p, q, s);
        if (flip % 2 === 0) meshA.setMatrixAt(ia++, m); else meshB.setMatrixAt(ib++, m);
      }
      flip++;
    }
    meshA.count = ia; meshB.count = ib;
    meshA.instanceMatrix.needsUpdate = meshB.instanceMatrix.needsUpdate = true;
    this.group.add(meshA, meshB);
  }

  // Each circuit is edged in its own way, and one of them is edged in nothing.
  #buildBarriers() {
    const style = this.barriers;
    if (style === 'none' || style === 'fence') return;

    const look = {
      armco: {
        geo: new THREE.BoxGeometry(BARRIER_DEPTH, 1.5, 4.2), step: 7, y: 0.75,
        mat: new THREE.MeshStandardMaterial({
          color: 0x1b2230, roughness: 0.5, metalness: 0.35,
          emissive: 0x0d2f45, emissiveIntensity: 0.6,
        }),
      },
      concrete: {
        geo: new THREE.BoxGeometry(0.9, 1.15, 3.0), step: 5, y: 0.6,
        mat: new THREE.MeshStandardMaterial({
          color: 0x9aa0a8, roughness: 0.95, metalness: 0.02,
          emissive: 0x2a2f36, emissiveIntensity: 0.25,
        }),
      },
      pillars: {
        geo: new THREE.CylinderGeometry(0.22, 0.28, 1.05, 8), step: 9, y: 0.55,
        mat: new THREE.MeshStandardMaterial({
          color: 0x2b313b, roughness: 0.55, metalness: 0.4,
          emissive: 0xffc94d, emissiveIntensity: 0.5,
        }),
      },
    }[style] ?? null;
    if (!look) return;

    this.barrierMaterial = look.mat;
    const slots = Math.ceil(SAMPLES / look.step) * 2;
    const mesh = new THREE.InstancedMesh(look.geo, look.mat, slots);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
    let n = 0;
    for (let i = 0; i < SAMPLES; i += look.step) {
      const t = i / SAMPLES;
      const f = this.frameAt(t);
      const yaw = Math.atan2(f.tan.x, f.tan.z);
      const open = this.pitPhase(t) !== null;
      for (const sgn of [-1, 1]) {
        // No barrier where the pit lane leaves the circuit, or a car could
        // never reach the lane the rules tell it to take.
        if (open && sgn === this.pit.side) continue;
        const p = f.pos.clone()
          .addScaledVector(f.side, sgn * (this.roadHalf + BARRIER_OFFSET))
          .setY(f.pos.y + look.y);
        q.setFromAxisAngle(UP, yaw);
        m.compose(p, q, one);
        mesh.setMatrixAt(n++, m);
      }
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  #buildStartLine() {
    const f = this.frameAt(0);
    const cols = 16;
    const geo = new THREE.BoxGeometry((this.roadHalf * 2) / cols, 0.02, 1.1);
    const dark = new THREE.MeshStandardMaterial({ color: 0x11151d });
    const light = new THREE.MeshStandardMaterial({ color: 0xf2f6fb });
    const yaw = Math.atan2(f.tan.x, f.tan.z);
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < cols; c++) {
        const mesh = new THREE.Mesh(geo, (r + c) % 2 ? light : dark);
        const off = -this.roadHalf + (c + 0.5) * (this.roadHalf * 2 / cols);
        mesh.position.copy(f.pos).addScaledVector(f.side, off)
          .addScaledVector(f.tan, r * 1.1).setY(f.pos.y + 0.07);
        mesh.rotation.y = yaw;
        this.group.add(mesh);
      }
    }
    // Gantry over the line.
    const post = new THREE.BoxGeometry(0.7, 9, 0.7);
    const beam = new THREE.BoxGeometry(this.roadHalf * 2 + 6, 1.1, 1.0);
    const steel = new THREE.MeshStandardMaterial({ color: 0x2a3446, metalness: 0.6, roughness: 0.4 });
    for (const sgn of [-1, 1]) {
      const p = new THREE.Mesh(post, steel);
      p.position.copy(f.pos).addScaledVector(f.side, sgn * (this.roadHalf + 3)).setY(f.pos.y + 4.5);
      p.rotation.y = yaw;
      this.group.add(p);
    }
    const b = new THREE.Mesh(beam, steel);
    b.position.copy(f.pos).setY(f.pos.y + 9.3);
    b.rotation.y = yaw;
    this.group.add(b);
    this.gantry = b;
  }


  // The pit lane: a sealed apron outside the barrier line, a wall along its far
  // edge, a working box, and the garages behind it. It is built from the same
  // frames the road is, so it follows whatever the circuit does there.
  #buildPitLane() {
    const pit = this.pit;
    const side = pit.side;
    const STEPS = 90;
    const at = (k) => ((pit.entry + pit.span * (k / STEPS)) % 1 + 1) % 1;

    const pos = [], idx = [], uv = [];
    for (let k = 0; k <= STEPS; k++) {
      const f = this.frameAt(at(k));
      const phase = k / STEPS;
      // The mouth and the exit taper in, so the lane reads as a road that
      // peels off rather than a slab that appears.
      const taper = Math.min(1, phase / 0.1, (1 - phase) / 0.1);
      const inner = f.pos.clone().addScaledVector(f.side, side * (this.roadHalf + 0.2));
      const outer = f.pos.clone()
        .addScaledVector(f.side, side * (this.roadHalf + 0.2 + (pit.outer - this.roadHalf) * taper));
      pos.push(inner.x, inner.y + 0.055, inner.z, outer.x, outer.y + 0.055, outer.z);
      uv.push(0, phase * 60, 1, phase * 60);
      if (k < STEPS) {
        const v = k * 2;
        idx.push(v, v + 2, v + 1, v + 1, v + 2, v + 3);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    this.pitMaterial = new THREE.MeshStandardMaterial({
      color: 0x33373f, roughness: 0.9, metalness: 0.03,
    });
    const lane = new THREE.Mesh(g, this.pitMaterial);
    lane.receiveShadow = true;
    this.group.add(lane);

    // A white line down the middle of the lane, and the box painted on it.
    const paint = new THREE.MeshStandardMaterial({
      color: 0xe6edf6, roughness: 0.65, emissive: 0x27303c, emissiveIntensity: 0.4,
    });
    const boxPaint = new THREE.MeshStandardMaterial({
      color: 0x4de3b0, roughness: 0.6, emissive: 0x0d5f45, emissiveIntensity: 1.1,
    });
    const strip = new THREE.BoxGeometry(0.18, 0.02, 2.4);
    for (let k = 2; k < STEPS - 2; k += 2) {
      const t = at(k);
      const f = this.frameAt(t);
      const mark = new THREE.Mesh(strip, paint);
      mark.position.copy(f.pos)
        .addScaledVector(f.side, side * (pit.inner - 0.4)).setY(f.pos.y + 0.075);
      mark.rotation.y = Math.atan2(f.tan.x, f.tan.z);
      this.group.add(mark);
    }
    const boxFrame = this.frameAt(pit.box);
    const boxYaw = Math.atan2(boxFrame.tan.x, boxFrame.tan.z);
    const box = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.02, 6.4), boxPaint);
    box.position.copy(boxFrame.pos)
      .addScaledVector(boxFrame.side, side * pit.centre).setY(boxFrame.pos.y + 0.08);
    box.rotation.y = boxYaw;
    this.group.add(box);
    this.pitBoxPoint = box.position.clone();

    // The wall along the outside, and the garages standing behind it.
    const wallMat = new THREE.MeshStandardMaterial({
      color: 0x9aa0a8, roughness: 0.92, emissive: 0x2a2f36, emissiveIntensity: 0.3,
    });
    const wallGeo = new THREE.BoxGeometry(0.9, 1.15, 3.2);
    const wall = new THREE.InstancedMesh(wallGeo, wallMat, STEPS + 2);
    const garageMat = new THREE.MeshStandardMaterial({
      color: 0x1b2230, roughness: 0.8, metalness: 0.2,
      emissive: 0x2b3a52, emissiveIntensity: 0.5,
    });
    const garageGeo = new THREE.BoxGeometry(6.4, 4.2, 7.0);
    const garages = new THREE.InstancedMesh(garageGeo, garageMat, 14);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
    let wn = 0, gn = 0;
    for (let k = 0; k <= STEPS; k++) {
      const t = at(k);
      const f = this.frameAt(t);
      const yaw = Math.atan2(f.tan.x, f.tan.z);
      q.setFromAxisAngle(UP, yaw);
      const p = f.pos.clone()
        .addScaledVector(f.side, side * (pit.outer + 0.9)).setY(f.pos.y + 0.6);
      m.compose(p, q, one);
      wall.setMatrixAt(wn++, m);
      if (k % 7 === 3 && gn < 14) {
        const gp = f.pos.clone()
          .addScaledVector(f.side, side * (pit.outer + 6.4)).setY(f.pos.y + 2.1);
        m.compose(gp, q, one);
        garages.setMatrixAt(gn++, m);
      }
    }
    wall.count = wn;
    garages.count = gn;
    wall.instanceMatrix.needsUpdate = true;
    garages.instanceMatrix.needsUpdate = true;
    wall.castShadow = garages.castShadow = true;
    this.pitGarageMaterial = garageMat;
    this.group.add(wall, garages);
  }

  // The circuit banks up to +/-5m, so a flat plane would bury its low sections.
  // The apron is a wide ribbon that carries the terrain along the track height
  // and blends down to the far-field plane.
  #buildApron() {
    const HALF = 52, DROP = 0.35;
    const pos = [], idx = [];
    for (let i = 0; i <= SAMPLES; i++) {
      const f = this.frameAt((i % SAMPLES) / SAMPLES);
      const l = f.pos.clone().addScaledVector(f.side, -HALF);
      const r = f.pos.clone().addScaledVector(f.side, HALF);
      // Outer edge sags toward the far-field plane height.
      pos.push(l.x, GROUND_Y + (l.y - GROUND_Y) * 0.25, l.z,
               f.pos.x, f.pos.y - DROP, f.pos.z,
               r.x, GROUND_Y + (r.y - GROUND_Y) * 0.25, r.z);
      if (i < SAMPLES) {
        const s = i * 3;
        idx.push(s, s + 3, s + 1, s + 1, s + 3, s + 4);
        idx.push(s + 1, s + 4, s + 2, s + 2, s + 4, s + 5);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const apron = new THREE.Mesh(g, this.groundMaterial);
    apron.receiveShadow = true;
    this.group.add(apron);
  }

  // Ground plus low-poly hills and trackside markers, all instanced.
  #buildScenery() {
    // The verges get the same grain treatment as the road so the whole scene
    // catches light the same way.
    const verge = this.#surfaceTexture();
    verge.repeat.set(60, 60);
    this.groundMaterial = new THREE.MeshStandardMaterial({
      color: this.spec.ground, roughness: 1, roughnessMap: verge, bumpMap: verge, bumpScale: 0.4,
    });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(3000, 3000, 1, 1), this.groundMaterial);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = GROUND_Y;
    ground.receiveShadow = true;
    this.group.add(ground);
    this.#buildApron();

    const hillGeo = new THREE.ConeGeometry(1, 1, 5);
    this.hillMaterial = new THREE.MeshStandardMaterial({ color: this.spec.hills, roughness: 1, flatShading: true });
    const hillBudget = this.spec.scenery === 'town' ? 60 : 260;
    const hills = new THREE.InstancedMesh(hillGeo, this.hillMaterial, hillBudget);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    let n = 0;
    for (let i = 0; i < 900 && n < hillBudget; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 330 + Math.random() * 720;
      const p = new THREE.Vector3(Math.cos(a) * r, GROUND_Y, Math.sin(a) * r);
      if (this.project(p).lateral === 0) continue;
      const near = this.project(p);
      const clear = this.spec.scenery === 'town' ? 300 : 60;
      if (Math.abs(near.lateral) < clear) continue;   // keep hills off the circuit
      const h = 18 + Math.random() * 70;
      s.set(h * (0.7 + Math.random()), h, h * (0.7 + Math.random()));
      q.setFromAxisAngle(UP, Math.random() * Math.PI);
      m.compose(p.setY(GROUND_Y + h / 2), q, s);
      this.addSolid(p.x, GROUND_Y, p.z, h * 0.75, h);
      hills.setMatrixAt(n++, m);
    }
    hills.count = n;
    hills.instanceMatrix.needsUpdate = true;
    this.group.add(hills);

    // Marker pylons every few samples, emissive so they read at night.
    this.pylonMaterial = new THREE.MeshStandardMaterial({
      color: 0x101828, emissive: 0x4de3b0, emissiveIntensity: 1.4, roughness: 0.4,
    });
    const pyGeo = new THREE.CylinderGeometry(0.18, 0.3, 2.2, 6);
    if (this.spec.scenery === 'town') this.#buildTown();
    else if (this.spec.scenery === 'village') this.#buildVillage();
    this.#buildLife();

    const pylons = new THREE.InstancedMesh(pyGeo, this.pylonMaterial, Math.ceil(SAMPLES / 22) * 2);
    let pn = 0;
    for (let i = 0; i < SAMPLES; i += 22) {
      const pt = i / SAMPLES;
      const f = this.frameAt(pt);
      const lane = this.pitPhase(pt) !== null;
      for (const sgn of [-1, 1]) {
        // The markers sit where the pit lane is. Anything standing in the lane
        // is something a car being waved into it has to drive through.
        if (lane && sgn === this.pit.side) continue;
        const p = f.pos.clone().addScaledVector(f.side, sgn * (this.roadHalf + 5.2)).setY(f.pos.y + 1.1);
        m.compose(p, new THREE.Quaternion(), new THREE.Vector3(1, 1, 1));
        pylons.setMatrixAt(pn++, m);
      }
    }
    pylons.count = pn;
    pylons.instanceMatrix.needsUpdate = true;
    this.group.add(pylons);
  }

  // Side roads at the marked junctions. They are scenery, not drivable routes:
  // the circuit is still the loop, these give it somewhere to have come from.
  #buildJunctions() {
    const mat = new THREE.MeshStandardMaterial({
      color: this.spec.road, roughness: 0.94, metalness: 0.02,
    });
    const line = new THREE.MeshStandardMaterial({ color: 0xd8e2f0, roughness: 0.7 });
    const reach = 38;
    for (const j of this.junctions) {
      const f = this.frameAt(j.t);
      const yaw = Math.atan2(f.tan.x, f.tan.z);
      for (const side of j.sides) {
        const arm = new THREE.Mesh(
          new THREE.BoxGeometry(reach, 0.12, this.roadHalf * 1.7), mat);
        arm.position.copy(f.pos)
          .addScaledVector(f.side, side * (this.roadHalf + reach / 2 - 0.5))
          .setY(f.pos.y + 0.045);
        arm.rotation.y = yaw;
        arm.receiveShadow = true;
        this.group.add(arm);

        // Stop line where the side road meets the circuit.
        const stop = new THREE.Mesh(
          new THREE.BoxGeometry(0.5, 0.06, this.roadHalf * 1.5), line);
        stop.position.copy(f.pos)
          .addScaledVector(f.side, side * (this.roadHalf + 1.4))
          .setY(f.pos.y + 0.12);
        stop.rotation.y = yaw;
        this.group.add(stop);
      }
    }
  }

  #isNearJunction(t, window = 0.03) {
    return this.junctions.some((j) => {
      const d = Math.abs(((t - j.t) + 1.5) % 1 - 0.5);
      return d < window;
    });
  }

  // Facades with lit windows, raised pavements and street lamps. Buildings are
  // one instanced mesh tinted per instance so a street is one draw call.
  #buildTown() {
    const pave = new THREE.MeshStandardMaterial({ color: 0x6c727c, roughness: 0.95 });
    for (const side of [-1, 1]) {
      const strip = [];
      const idx = [];
      for (let i = 0; i <= SAMPLES; i++) {
        const f = this.frameAt((i % SAMPLES) / SAMPLES);
        const inner = f.pos.clone().addScaledVector(f.side, side * (this.roadHalf + 0.1));
        const outer = f.pos.clone().addScaledVector(f.side, side * (this.roadHalf + 4.2));
        strip.push(inner.x, inner.y + 0.16, inner.z, outer.x, outer.y + 0.2, outer.z);
        if (i < SAMPLES) {
          const k = i * 2;
          idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(strip, 3));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, pave);
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }

    const windows = this.#windowTexture();
    this.buildingMaterial = new THREE.MeshStandardMaterial({
      roughness: 0.82, metalness: 0.05,
      emissiveMap: windows, emissive: 0xffffff, emissiveIntensity: 0,
    });
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const count = 220;
    const mesh = new THREE.InstancedMesh(geo, this.buildingMaterial, count);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    const tint = new THREE.Color();
    let n = 0;
    for (let i = 0; i < SAMPLES && n < count; i += 11) {
      const t = i / SAMPLES;
      if (this.#isNearJunction(t, 0.045)) continue;
      const f = this.frameAt(t);
      const yaw = Math.atan2(f.tan.x, f.tan.z);
      for (const side of [-1, 1]) {
        if (n >= count) break;
        const depth = 12 + Math.random() * 12;
        const width = 14 + Math.random() * 16;
        const height = 9 + Math.random() * 26;
        const away = this.roadHalf + 5 + depth / 2;
        const at = f.pos.clone().addScaledVector(f.side, side * away).setY(f.pos.y + height / 2 - 0.4);
        q.setFromAxisAngle(UP, yaw);
        sc.set(depth, height, width);
        m.compose(at, q, sc);
        mesh.setMatrixAt(n, m);
        tint.setHSL(0.08 + Math.random() * 0.06, 0.12 + Math.random() * 0.14,
          0.26 + Math.random() * 0.24);
        mesh.setColorAt(n, tint);
        this.addSolid(at.x, at.y, at.z, Math.max(depth, width) * 0.46, height);
        n += 1;
      }
    }
    mesh.count = n;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.group.add(mesh);
    this.#buildLamps(26);
  }

  // A grid of windows, most of them dark. Only lit at night, via the material's
  // emissive intensity, which the environment sets.
  #windowTexture() {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const c = canvas.getContext('2d');
    c.fillStyle = '#000000';
    c.fillRect(0, 0, size, size);
    const cols = 6, rows = 8;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (Math.random() < 0.45) continue;
        c.fillStyle = Math.random() < 0.25 ? '#ffd9a0' : '#ffeccb';
        c.fillRect(
          (x + 0.28) * (size / cols), (y + 0.24) * (size / rows),
          (size / cols) * 0.44, (size / rows) * 0.4,
        );
      }
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  #buildLamps(spacing) {
    const post = new THREE.CylinderGeometry(0.14, 0.2, 7, 6);
    const postMat = new THREE.MeshStandardMaterial({ color: 0x2b313b, metalness: 0.6, roughness: 0.5 });
    this.lampMaterial = new THREE.MeshStandardMaterial({
      color: 0x20242c, emissive: 0xffe6b0, emissiveIntensity: 0.4, roughness: 0.4,
    });
    const head = new THREE.BoxGeometry(1.5, 0.3, 0.6);
    const step = Math.max(6, Math.round(spacing / (this.length / SAMPLES)));
    const slots = Math.ceil(SAMPLES / step);
    const posts = new THREE.InstancedMesh(post, postMat, slots);
    const heads = new THREE.InstancedMesh(head, this.lampMaterial, slots);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
    let n = 0;
    for (let i = 0; i < SAMPLES && n < slots; i += step) {
      const f = this.frameAt(i / SAMPLES);
      const side = n % 2 === 0 ? -1 : 1;
      const yaw = Math.atan2(f.tan.x, f.tan.z);
      q.setFromAxisAngle(UP, yaw);
      const base = f.pos.clone().addScaledVector(f.side, side * (this.roadHalf + 2.6));
      m.compose(base.clone().setY(f.pos.y + 3.5), q, one);
      this.addSolid(base.x, f.pos.y, base.z, 0.3, 7);
      posts.setMatrixAt(n, m);
      m.compose(base.clone().addScaledVector(f.side, -side * 0.7).setY(f.pos.y + 7.1), q, one);
      heads.setMatrixAt(n, m);
      n += 1;
    }
    posts.count = heads.count = n;
    posts.instanceMatrix.needsUpdate = heads.instanceMatrix.needsUpdate = true;
    this.group.add(posts, heads);
  }

  // Fences, hedges and trees: the lane needs edges, not architecture.
  #buildVillage() {
    const postMat = new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 0.95 });
    const railMat = new THREE.MeshStandardMaterial({ color: 0x6b5540, roughness: 0.95 });
    const postGeo = new THREE.BoxGeometry(0.16, 1.3, 0.16);
    const railGeo = new THREE.BoxGeometry(0.1, 0.14, 4.4);
    const slots = Math.ceil(SAMPLES / 4) * 2;
    const posts = new THREE.InstancedMesh(postGeo, postMat, slots);
    const rails = new THREE.InstancedMesh(railGeo, railMat, slots);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
    let n = 0;
    for (let i = 0; i < SAMPLES && n < slots - 2; i += 4) {
      const t = i / SAMPLES;
      if (this.#isNearJunction(t, 0.02)) continue;
      const f = this.frameAt(t);
      const yaw = Math.atan2(f.tan.x, f.tan.z);
      q.setFromAxisAngle(UP, yaw);
      for (const side of [-1, 1]) {
        const at = f.pos.clone().addScaledVector(f.side, side * (this.roadHalf + 3.4));
        m.compose(at.clone().setY(f.pos.y + 0.65), q, one);
        posts.setMatrixAt(n, m);
        m.compose(at.clone().setY(f.pos.y + 0.95), q, one);
        rails.setMatrixAt(n, m);
        n += 1;
      }
    }
    posts.count = rails.count = n;
    posts.instanceMatrix.needsUpdate = rails.instanceMatrix.needsUpdate = true;
    this.group.add(posts, rails);

    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3626, roughness: 1 });
    const leafMat = new THREE.MeshStandardMaterial({ color: 0x3f6b33, roughness: 1, flatShading: true });
    this.hillMaterial = this.hillMaterial ?? leafMat;
    const trunkGeo = new THREE.CylinderGeometry(0.34, 0.5, 3.4, 6);
    const leafGeo = new THREE.IcosahedronGeometry(2.6, 0);
    const treeCount = 150;
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, treeCount);
    const leaves = new THREE.InstancedMesh(leafGeo, leafMat, treeCount);
    let tn = 0;
    for (let i = 0; i < SAMPLES && tn < treeCount; i += 7) {
      const f = this.frameAt(i / SAMPLES);
      for (const side of [-1, 1]) {
        if (tn >= treeCount || Math.random() < 0.45) continue;
        const away = this.roadHalf + 8 + Math.random() * 26;
        const jitter = (Math.random() - 0.5) * 8;
        const at = f.pos.clone().addScaledVector(f.side, side * away).addScaledVector(f.tan, jitter);
        const scale = 0.8 + Math.random() * 0.9;
        m.compose(at.clone().setY(f.pos.y + 1.7 * scale), new THREE.Quaternion(),
          new THREE.Vector3(scale, scale, scale));
        trunks.setMatrixAt(tn, m);
        m.compose(at.clone().setY(f.pos.y + 4.4 * scale), new THREE.Quaternion(),
          new THREE.Vector3(scale, scale * 0.85, scale));
        leaves.setMatrixAt(tn, m);
        this.addSolid(at.x, f.pos.y, at.z, 0.55 * scale, 5 * scale);
        tn += 1;
      }
    }
    trunks.count = leaves.count = tn;
    trunks.instanceMatrix.needsUpdate = leaves.instanceMatrix.needsUpdate = true;
    trunks.castShadow = leaves.castShadow = true;
    this.group.add(trunks, leaves);
  }

  static SOLID_CELL = 24;

  #solidKey(x, z) {
    const c = Track.SOLID_CELL;
    return `${Math.floor(x / c)},${Math.floor(z / c)}`;
  }

  addSolid(x, y, z, radius, height = 3) {
    const solid = { x, y, z, radius, height };
    this.solids.push(solid);
    const c = Track.SOLID_CELL;
    // Register in every cell the circle touches, so a lookup never misses one.
    for (let gx = Math.floor((x - radius) / c); gx <= Math.floor((x + radius) / c); gx++) {
      for (let gz = Math.floor((z - radius) / c); gz <= Math.floor((z + radius) / c); gz++) {
        const key = `${gx},${gz}`;
        if (!this.solidGrid.has(key)) this.solidGrid.set(key, []);
        this.solidGrid.get(key).push(solid);
      }
    }
  }

  // The solids that could touch a circle at (x, z) of the given radius.
  solidsNear(x, z, radius) {
    const c = Track.SOLID_CELL;
    const found = [];
    for (let gx = Math.floor((x - radius) / c); gx <= Math.floor((x + radius) / c); gx++) {
      for (let gz = Math.floor((z - radius) / c); gz <= Math.floor((z + radius) / c); gz++) {
        const bucket = this.solidGrid.get(`${gx},${gz}`);
        if (bucket) found.push(...bucket);
      }
    }
    return found;
  }

  // How sharply the circuit turns at t, used to find the corners people would
  // actually stand at.
  #curvatureAt(t, arc = 40) {
    const a = this.frameAt(t);
    const b = this.frameAt(t + arc / this.length);
    const turn = Math.atan2(b.tan.x, b.tan.z) - Math.atan2(a.tan.x, a.tan.z);
    return Math.abs(Math.atan2(Math.sin(turn), Math.cos(turn)));
  }

  // Spectators, livestock and water. Circuits are places, and places have
  // things in them that are not track.
  #buildLife() {
    const scenery = this.spec.scenery ?? 'hills';
    const density = this.spec.crowd ?? 0.25;
    const coarse = matchMedia('(pointer: coarse)').matches;
    // A stadium holds a stadium's worth of people; a country lane holds a few
    // families on a bank. One dial, scaled down on a phone.
    const capacity = Math.round(
      (scenery === 'stadium' ? 5600 : 620) * density * (coarse ? 0.3 : 1));
    // A phone draws the same people with fewer triangles each rather than
    // fewer people: a thin crowd reads as an empty circuit, a coarse one does
    // not read as anything at all from the car.
    this.crowd = new Crowd(Math.max(48, capacity), coarse ? 0.6 : 1);

    // The galleries are filled first, then whatever is left goes on the ground
    // behind the barriers — a stadium has people standing at the fence as well
    // as sitting in the stands.
    const seated = Math.round(capacity * (scenery === 'stadium' ? 0.7 : 1));
    for (const [from, length] of this.spec.stands ?? []) {
      this.#buildStands(from, length, seated);
    }
    this.#buildTrackside(scenery);
    this.group.add(this.crowd.finish());

    if (scenery === 'stadium') this.#buildFloodlights();
    if (scenery === 'village') this.#buildLivestock();
    if (scenery === 'village' || scenery === 'hills') this.#buildWater();
  }

  // The people who are not in a stand: standing on the banks at the corners,
  // or on the pavement in a town.
  #buildTrackside(scenery) {
    const town = scenery === 'town';
    if (scenery === 'stadium') { this.#buildGroundCrowd(); return; }

    for (let i = 0; i < SAMPLES && !this.crowd.full; i += 5) {
      const t = i / SAMPLES;
      // On a circuit people gather where the cars are slowest; in a town they
      // are simply on the pavement.
      const bend = this.#curvatureAt(t);
      if (!town && bend < 0.09) continue;
      if (town && i % 15 !== 0) continue;
      if (this.junctions.length && this.#isNearJunction(t, 0.015)) continue;

      const f = this.frameAt(t);
      const yaw = Math.atan2(f.tan.x, f.tan.z);
      const group = town ? 1 : 2 + Math.floor(Math.random() * 3);
      for (let k = 0; k < group && !this.crowd.full; k++) {
        const side = Math.random() < 0.5 ? -1 : 1;
        // Never on the pit lane side of the pit straight, and always outside
        // whatever edges the circuit.
        if (side === this.pit.side && this.pitPhase(t) !== null) continue;
        const away = town
          ? this.roadHalf + BARRIER_OFFSET + 1.6 + Math.random() * 2.4
          : this.roadHalf + BARRIER_OFFSET + 2.2 + Math.random() * 6;
        const along = (Math.random() - 0.5) * 7;
        const at = f.pos.clone()
          .addScaledVector(f.side, side * away)
          .addScaledVector(f.tan, along)
          .setY(f.pos.y);
        // Spectators watch the cars, so they face the road they are beside.
        this.crowd.add(at, yaw + (side * Math.PI) / 2 + (Math.random() - 0.5) * 0.5);
      }
    }
  }

  // The people packed against the fence at ground level, in front of the
  // stands and all the way round. They stand in rows, closest first, because
  // that is how a crowd fills a space it is allowed to stand in.
  #buildGroundCrowd() {
    const base = this.roadHalf + BARRIER_OFFSET + 0.9;
    const step = 22;
    for (let pass = 0; pass < 4 && !this.crowd.full; pass++) {
      for (let i = 0; i < SAMPLES && !this.crowd.full; i += 3) {
        const t = i / SAMPLES;
        const f = this.frameAt(t);
        const yaw = Math.atan2(f.tan.x, f.tan.z);
        for (const side of [-1, 1]) {
          if (side === this.pit.side && this.pitPhase(t) !== null) continue;
          if (Math.random() > 0.55) continue;
          const away = base + pass * 0.62 + Math.random() * 0.3;
          const along = (Math.random() - 0.5) * (this.length / SAMPLES) * step * 0.12;
          const at = f.pos.clone()
            .addScaledVector(f.side, side * away)
            .addScaledVector(f.tan, along)
            .setY(f.pos.y);
          // Everyone at the fence is watching the road beside them.
          this.crowd.add(at, yaw - (side * Math.PI) / 2 + (Math.random() - 0.5) * 0.3);
        }
      }
    }
  }

  // A tiered gallery along one span of the circuit: treads and risers as a
  // single stepped ribbon, a roof over the back of it, and people on the steps.
  // `from` and `length` are fractions of a lap; a length of 1 rings the loop.
  #buildStands(from, length, budget = this.crowd.capacity) {
    const TIERS = 12, TREAD = 0.95, RISE = 0.62;
    const base = this.roadHalf + BARRIER_OFFSET + 3.8;
    const depth = TIERS * TREAD;
    const top = TIERS * RISE;
    const closed = length >= 0.999;
    const arc = this.length * length;
    const steps = Math.max(12, Math.round(arc / 6));

    // Cross-section of the terracing, as (out, up) pairs from the front edge.
    const profile = [[0, 0]];
    for (let k = 0; k < TIERS; k++) {
      profile.push([k * TREAD, (k + 1) * RISE], [(k + 1) * TREAD, (k + 1) * RISE]);
    }
    profile.push([depth, 0]);            // back wall drops to the ground

    // The two banks are mirrored, so one of them is wound the other way round.
    // Both faces are drawn rather than winding each side separately: a stand is
    // seen from inside as well as out.
    const concrete = new THREE.MeshStandardMaterial({
      color: 0x6f7883, roughness: 0.95, metalness: 0.02, side: THREE.DoubleSide,
    });
    const steel = new THREE.MeshStandardMaterial({
      color: 0x28303c, roughness: 0.45, metalness: 0.7,
      emissive: 0x18324a, emissiveIntensity: 0.5, side: THREE.DoubleSide,
    });

    // Both sides of the road, except where the pit lane owns the verge.
    for (const side of [-1, 1]) {
      const pos = [], idx = [], roofPos = [], roofIdx = [];
      const rows = profile.length;
      let ring = 0;
      const postAt = [];

      for (let k = 0; k <= steps; k++) {
        const t = ((from + length * (k / steps)) % 1 + 1) % 1;
        if (side === this.pit.side && this.pitPhase(t) !== null) {
          ring = 0;                       // break the ribbon over the pit lane
          continue;
        }
        const f = this.frameAt(t);
        for (const [out, up] of profile) {
          const v = f.pos.clone().addScaledVector(f.side, side * (base + out));
          pos.push(v.x, f.pos.y + up, v.z);
        }
        const r = new THREE.Vector3();
        r.copy(f.pos).addScaledVector(f.side, side * (base + depth * 0.15));
        roofPos.push(r.x, f.pos.y + top + 4.4, r.z);
        r.copy(f.pos).addScaledVector(f.side, side * (base + depth + 1.2));
        roofPos.push(r.x, f.pos.y + top + 5.2, r.z);
        if (k % 8 === 0) {
          postAt.push([f.pos.clone().addScaledVector(f.side, side * (base + depth + 1.0)),
            f.pos.y, Math.atan2(f.tan.x, f.tan.z), top + 5.2]);
        }

        const rings = pos.length / 3 / rows;
        if (ring > 0) {
          const a = (rings - 2) * rows, b = (rings - 1) * rows;
          for (let j = 0; j < rows - 1; j++) {
            idx.push(a + j, b + j, a + j + 1, a + j + 1, b + j, b + j + 1);
          }
          const rq = roofPos.length / 3 - 4;
          roofIdx.push(rq, rq + 2, rq + 1, rq + 1, rq + 2, rq + 3);
        }
        ring += 1;
      }
      if (closed && pos.length === 0) continue;

      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      const bank = new THREE.Mesh(g, concrete);
      bank.receiveShadow = true;
      bank.castShadow = true;
      this.group.add(bank);

      const rg = new THREE.BufferGeometry();
      rg.setAttribute('position', new THREE.Float32BufferAttribute(roofPos, 3));
      rg.setIndex(roofIdx);
      rg.computeVertexNormals();
      const roof = new THREE.Mesh(rg, steel);
      roof.castShadow = true;
      this.group.add(roof);

      const postGeo = new THREE.BoxGeometry(0.5, 1, 0.5);
      const posts = new THREE.InstancedMesh(postGeo, steel, postAt.length);
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sv = new THREE.Vector3();
      postAt.forEach(([at, y, yaw, height], i) => {
        q.setFromAxisAngle(UP, yaw);
        sv.set(1, height, 1);
        m.compose(at.setY(y + height / 2), q, sv);
        posts.setMatrixAt(i, m);
      });
      posts.instanceMatrix.needsUpdate = true;
      this.group.add(posts);

      this.#seatCrowd(from, length, steps, side, base, TIERS, TREAD, RISE, budget);
    }
  }

  // People on the terracing. The seats outnumber the figures the scene can
  // afford, so each slot is filled at the odds that spends the budget evenly
  // over the whole gallery instead of packing the first corner.
  #seatCrowd(from, length, steps, side, base, tiers, tread, rise, budget) {
    const perRow = Math.max(1, Math.round((this.length * length) / steps / 0.78));
    const slots = steps * tiers * perRow;
    const left = Math.max(0, budget - this.crowd.n);
    const chance = slots > 0 ? left / slots : 0;

    for (let k = 0; k < steps && !this.crowd.full; k++) {
      const t = ((from + length * (k / steps)) % 1 + 1) % 1;
      if (side === this.pit.side && this.pitPhase(t) !== null) continue;
      const f = this.frameAt(t);
      const yaw = Math.atan2(f.tan.x, f.tan.z);
      // Facing the track: the road is on the inboard side of the stand.
      const facing = yaw - (side * Math.PI) / 2;
      for (let row = 0; row < tiers; row++) {
        for (let c = 0; c < perRow; c++) {
          if (Math.random() > chance || this.crowd.n >= budget) continue;
          const along = ((c + 0.5) / perRow - 0.5) * (this.length * length / steps);
          const out = base + row * tread + 0.34 + Math.random() * 0.24;
          const at = f.pos.clone()
            .addScaledVector(f.side, side * out)
            .addScaledVector(f.tan, along)
            .setY(f.pos.y + (row + 1) * rise);
          if (!this.crowd.add(at, facing + (Math.random() - 0.5) * 0.35)) return;
        }
      }
    }
  }

  // Four masts of lights over an arena, so it reads as a stadium at any hour.
  #buildFloodlights() {
    const mast = new THREE.CylinderGeometry(0.5, 0.85, 34, 8);
    const steel = new THREE.MeshStandardMaterial({
      color: 0x2a3140, roughness: 0.5, metalness: 0.7,
    });
    this.floodMaterial = new THREE.MeshStandardMaterial({
      color: 0x0d1220, emissive: 0xfff4d8, emissiveIntensity: 2.6, roughness: 0.3,
    });
    const rigGeo = new THREE.BoxGeometry(9, 3.4, 1.2);
    for (let i = 0; i < 6; i++) {
      const f = this.frameAt(i / 6);
      const side = i % 2 === 0 ? -1 : 1;
      const at = f.pos.clone().addScaledVector(f.side, side * (this.roadHalf + 34));
      const pole = new THREE.Mesh(mast, steel);
      pole.position.copy(at).setY(f.pos.y + 17);
      this.group.add(pole);
      const rig = new THREE.Mesh(rigGeo, this.floodMaterial);
      rig.position.copy(at).setY(f.pos.y + 35);
      rig.rotation.y = Math.atan2(f.tan.x, f.tan.z) + (side * Math.PI) / 2;
      this.group.add(rig);
      this.addSolid(at.x, f.pos.y, at.z, 1.2, 34);
    }
  }

  // Cattle and sheep, grazing well back from the lane.
  #buildLivestock() {
    const herd = 34;
    const bodyGeo = new THREE.BoxGeometry(0.85, 0.82, 1.75);
    const headGeo = new THREE.BoxGeometry(0.44, 0.44, 0.5);
    const legGeo = new THREE.BoxGeometry(0.16, 0.7, 0.16);
    const hide = new THREE.MeshStandardMaterial({ roughness: 0.95 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x2c2723, roughness: 0.95 });
    const bodies = new THREE.InstancedMesh(bodyGeo, hide, herd);
    const heads = new THREE.InstancedMesh(headGeo, hide, herd);
    const legs = new THREE.InstancedMesh(legGeo, dark, herd * 4);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
    const tint = new THREE.Color();
    let n = 0, l = 0;

    for (let i = 0; i < SAMPLES && n < herd; i += 13) {
      const f = this.frameAt(i / SAMPLES);
      const side = Math.random() < 0.5 ? -1 : 1;
      const away = this.roadHalf + 22 + Math.random() * 40;
      const at = f.pos.clone()
        .addScaledVector(f.side, side * away)
        .addScaledVector(f.tan, (Math.random() - 0.5) * 22);
      const facing = Math.random() * Math.PI * 2;
      q.setFromAxisAngle(UP, facing);
      const ground = f.pos.y - 0.25;

      m.compose(at.clone().setY(ground + 1.05), q, one);
      bodies.setMatrixAt(n, m);
      tint.setHSL(0.08, 0.05 + Math.random() * 0.3, 0.3 + Math.random() * 0.55);
      bodies.setColorAt(n, tint);
      m.compose(
        at.clone().addScaledVector(new THREE.Vector3(Math.sin(facing), 0, Math.cos(facing)), 1.05)
          .setY(ground + 1.12), q, one);
      heads.setMatrixAt(n, m);
      for (const [dx, dz] of [[-0.3, 0.6], [0.3, 0.6], [-0.3, -0.6], [0.3, -0.6]]) {
        const leg = at.clone()
          .addScaledVector(new THREE.Vector3(Math.cos(facing), 0, -Math.sin(facing)), dx)
          .addScaledVector(new THREE.Vector3(Math.sin(facing), 0, Math.cos(facing)), dz);
        m.compose(leg.setY(ground + 0.35), q, one);
        legs.setMatrixAt(l++, m);
      }
      n += 1;
    }
    bodies.count = heads.count = n;
    legs.count = l;
    bodies.instanceMatrix.needsUpdate = true;
    heads.instanceMatrix.needsUpdate = true;
    legs.instanceMatrix.needsUpdate = true;
    if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true;
    bodies.castShadow = true;
    this.group.add(bodies, heads, legs);
  }

  // A river winding through the outfield, kept clear of the circuit.
  #buildWater() {
    const anchor = this.frameAt(0.34);
    const dir = new THREE.Vector3().crossVectors(UP, anchor.tan).normalize();
    const start = anchor.pos.clone().addScaledVector(dir, 130);
    const along = anchor.tan.clone();

    const pos = [], idx = [];
    const spans = 40, width = 13;
    for (let i = 0; i <= spans; i++) {
      const k = i / spans;
      const centre = start.clone()
        .addScaledVector(along, (k - 0.5) * 900)
        .addScaledVector(dir, Math.sin(k * 7.2) * 46);
      const side = dir.clone().multiplyScalar(width * (0.7 + Math.sin(k * 4.1) * 0.3));
      const a = centre.clone().sub(side);
      const b = centre.clone().add(side);
      pos.push(a.x, GROUND_Y + 0.6, a.z, b.x, GROUND_Y + 0.6, b.z);
      if (i < spans) {
        const v = i * 2;
        idx.push(v, v + 2, v + 1, v + 1, v + 2, v + 3);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    this.waterMaterial = new THREE.MeshStandardMaterial({
      color: 0x2f6f8f, roughness: 0.12, metalness: 0.5,
      transparent: true, opacity: 0.82,
    });
    this.group.add(new THREE.Mesh(geo, this.waterMaterial));
  }

  // The crowd is the only thing on a circuit that moves on its own.
  update(dt, cheer = 0.25) {
    this.crowd?.update(dt, cheer);
  }

  // Minimap needs a flat polyline in track space.
  outline(step = 12) {
    const pts = [];
    for (let i = 0; i < SAMPLES; i += step) pts.push([this.points[i].x, this.points[i].z]);
    return pts;
  }

  bounds() {
    const b = new THREE.Box3().setFromPoints(this.points);
    return { min: b.min, max: b.max };
  }
}

// Circuits are swapped at runtime, so a track must give its GPU memory back.
Track.prototype.dispose = function dispose(scene) {
  scene.remove(this.group);
  this.group.traverse((node) => {
    node.geometry?.dispose();
    const mat = node.material;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat?.dispose();
  });
};
