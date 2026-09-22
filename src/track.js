import * as THREE from 'three';
import { PALETTE, TRACKS, PIT, ROAD_SURFACE, PAINT_LIFT } from './config.js';
import { sampleCentreline } from './layout.js';
import { Crowd } from './crowd.js';
import { roadMaps, terrainMaps, windowTexture, kerbTexture } from './textures.js';

const UP = new THREE.Vector3(0, 1, 0);

export const BARRIER_OFFSET = 2.6; // centreline of the barrier, beyond the road edge
export const BARRIER_DEPTH = 0.6;  // barrier thickness
const SAMPLES = 900;            // centreline resolution
const CHECKPOINTS = 24;

// Terrain shape. The far field sits FAR_DROP below the lowest point of the
// circuit — a plane at a fixed depth cuts through a banked lap and hides the
// road. The verge drops EDGE_DROP at the road edge and falls to the far field
// over however much room this part of the lap has beside it, never more than
// VERGE_MAX. SKIRT_RINGS are the fractions of that room the skirt is built at.
const FAR_DROP = 1.4;
const EDGE_DROP = 0.16;
const VERGE_MAX = 52;
const SKIRT_RINGS = [0.22, 0.55, 1];
const SAMPLE_CELL = 20;         // centreline lookup grid, metres

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

    // Terrain height and every piece of trackside furniture are placed from
    // these two measurements, so nothing lands on a part of the lap that
    // belongs to another section of it.
    this.#measureElevation();
    this.#measureVerges();

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

  // Lowest and highest the driving surface gets, and the far-field height
  // taken from the lowest of them.
  #measureElevation() {
    let lo = Infinity, hi = -Infinity;
    for (const p of this.points) { lo = Math.min(lo, p.y); hi = Math.max(hi, p.y); }
    this.minRoadY = lo;
    this.maxRoadY = hi;
    this.groundY = lo - FAR_DROP;

    // Centreline samples bucketed by cell, so asking how far a point is from
    // the road costs a handful of cells rather than a sweep of the lap.
    this.sampleGrid = new Map();
    for (let i = 0; i < SAMPLES; i++) {
      const p = this.points[i];
      const key = `${Math.floor(p.x / SAMPLE_CELL)},${Math.floor(p.z / SAMPLE_CELL)}`;
      if (!this.sampleGrid.has(key)) this.sampleGrid.set(key, []);
      this.sampleGrid.get(key).push(i);
    }
  }

  // Distance from a point to the nearest part of the centreline, anywhere on
  // the lap. Searched a ring of cells at a time and stopped as soon as no
  // farther ring could beat what has been found.
  roadDistance(x, z, limit = VERGE_MAX + 8) {
    const gx = Math.floor(x / SAMPLE_CELL), gz = Math.floor(z / SAMPLE_CELL);
    const rings = Math.ceil(limit / SAMPLE_CELL) + 1;
    let best = Infinity;
    for (let r = 0; r <= rings; r++) {
      if (r > 0 && best <= (r - 1) * SAMPLE_CELL) break;
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const bucket = this.sampleGrid.get(`${gx + dx},${gz + dz}`);
          if (!bucket) continue;
          for (const i of bucket) {
            const p = this.points[i];
            const d = Math.hypot(p.x - x, p.z - z);
            if (d < best) best = d;
          }
        }
      }
    }
    return best;
  }

  // How much room there is outboard of each road edge before the circuit comes
  // back round on itself. Marched outward from the edge until the nearest road
  // is something other than the section being measured: on the inside of a
  // corner that is the far side of the same corner, which is exactly where the
  // terrain used to climb over the track.
  #measureVerges() {
    this.verges = new Float32Array(SAMPLES * 2);
    const probe = new THREE.Vector3();
    const stop = this.roadHalf + 2.5;
    for (let i = 0; i < SAMPLES; i++) {
      const f = this.frameAt(i / SAMPLES);
      for (let s = 0; s < 2; s++) {
        const sign = s === 0 ? -1 : 1;
        let reach = 2;
        for (let out = 3; out <= VERGE_MAX; out += 2) {
          probe.copy(f.pos).addScaledVector(f.side, sign * (this.roadHalf + out));
          if (this.roadDistance(probe.x, probe.z) < stop) break;
          reach = out;
        }
        this.verges[i * 2 + s] = Math.max(1.5, reach - 2);
      }
    }
  }

  // A sample step that puts one instance every `metres` of circuit. Fixed
  // sample steps space furniture out differently on every circuit, which is
  // what leaves gaps between barrier rails on a long lap.
  stepFor(metres) {
    return Math.max(1, Math.round(metres / (this.length / SAMPLES)));
  }

  // Room beside the road at a sample index, on the given side.
  verge(index, sign) {
    const i = ((index % SAMPLES) + SAMPLES) % SAMPLES;
    return this.verges[i * 2 + (sign < 0 ? 0 : 1)];
  }

  // Ground height beside the road: flush with the surface at the edge, falling
  // away to the far field over the room this part of the lap has. Everything
  // that stands beside the track is placed on this, so nothing floats and
  // nothing rises through the asphalt.
  terrainY(roadY, dist, room) {
    if (dist <= this.roadHalf) return roadY + ROAD_SURFACE;
    const edge = roadY + ROAD_SURFACE - EDGE_DROP;
    const k = Math.min(1, (dist - this.roadHalf) / Math.max(6, room));
    return edge + (this.groundY - edge) * (k * k * (3 - 2 * k));
  }

  // Terrain height at a lap fraction and a signed distance across the road.
  groundAt(t, lateral) {
    const f = this.frameAt(t);
    const room = this.verge(Math.round(((t % 1) + 1) % 1 * SAMPLES), Math.sign(lateral) || 1);
    return this.terrainY(f.pos.y, Math.abs(lateral), room);
  }

  // True when a point is far enough from every part of the circuit to put
  // something solid there.
  clearOfRoad(x, z, margin = 6) {
    const need = this.roadHalf + margin;
    // The search has to reach as far as the answer needs: a shorter sweep
    // reports "nothing near" for a road that is merely beyond the sweep.
    return this.roadDistance(x, z, need + 8) > need;
  }

  frameAt(t) {
    // A frame is asked for by everything from the AI to the scenery builder.
    // One bad number upstream must not take the frame down with it.
    const lap = Number.isFinite(t) ? t : 0;
    const i = Math.floor(((lap % 1) + 1) % 1 * SAMPLES) % SAMPLES;
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

  #buildRoad() {
    const surface = roadMaps(this.spec.surface);
    this.surfaceTile = surface.tile;
    const pos = [], idx = [], uv = [];
    for (let i = 0; i <= SAMPLES; i++) {
      const k = i % SAMPLES;
      const f = this.frameAt(k / SAMPLES);
      const l = f.pos.clone().addScaledVector(f.side, -this.roadHalf);
      const r = f.pos.clone().addScaledVector(f.side, this.roadHalf);
      pos.push(l.x, l.y + ROAD_SURFACE, l.z, r.x, r.y + ROAD_SURFACE, r.z);
      // UVs in metres over the tile size, so the chippings are the size of
      // chippings on a wide circuit and on a narrow one alike.
      const v = (i === SAMPLES ? this.length : this.cumulative[k]) / surface.tile;
      const u = (this.roadHalf * 2) / surface.tile;
      uv.push(0, v, u, v);
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
    this.roadMaterial = new THREE.MeshStandardMaterial({
      color: this.spec.road,
      map: surface.map,
      roughnessMap: surface.roughnessMap,
      normalMap: surface.normalMap,
      normalScale: new THREE.Vector2(dirt ? 1.1 : 0.7, dirt ? 1.1 : 0.7),
      roughness: dirt ? 1 : 0.94,
      metalness: dirt ? 0 : 0.04,
    });
    this.road = new THREE.Mesh(g, this.roadMaterial);
    this.road.receiveShadow = true;
    this.group.add(this.road);
    if (!dirt) this.#buildEdgeLines();

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
      for (const v of [a, b, c, d]) lp.push(v.x, v.y + ROAD_SURFACE + PAINT_LIFT, v.z);
      const s = quad * 4;
      li.push(s, s + 1, s + 2, s, s + 2, s + 3);
      quad++;
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
    lg.setIndex(li);
    lg.computeVertexNormals();
    // Paint sits a centimetre above the asphalt and is pulled toward the
    // camera in depth as well: a millimetre of physical offset is inside the
    // depth buffer's precision at 2km of range, and would flicker without it.
    this.group.add(new THREE.Mesh(lg, new THREE.MeshStandardMaterial({
      color: 0xd8e2f0, roughness: 0.6, emissive: 0x223044, emissiveIntensity: 0.35,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    })));
  }

  // A solid white line just inside each road edge, and a thin ribbon of grime
  // outside it. The edge of a racing surface is the thing a driver aims at, so
  // it is drawn rather than left to the change in material.
  #buildEdgeLines() {
    const pos = [], idx = [];
    const inset = this.roadHalf - 0.55, half = 0.14;
    let quad = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const f0 = this.frameAt(i / SAMPLES);
      const f1 = this.frameAt(((i + 1) % SAMPLES) / SAMPLES);
      for (const sgn of [-1, 1]) {
        const a = f0.pos.clone().addScaledVector(f0.side, sgn * (inset - half));
        const b = f0.pos.clone().addScaledVector(f0.side, sgn * (inset + half));
        const c = f1.pos.clone().addScaledVector(f1.side, sgn * (inset + half));
        const d = f1.pos.clone().addScaledVector(f1.side, sgn * (inset - half));
        for (const v of [a, b, c, d]) pos.push(v.x, v.y + ROAD_SURFACE + PAINT_LIFT, v.z);
        const k = quad * 4;
        idx.push(k, k + 1, k + 2, k, k + 2, k + 3);
        quad += 1;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    this.edgeMaterial = new THREE.MeshStandardMaterial({
      color: 0xdfe6ef, roughness: 0.72, metalness: 0.02,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    this.group.add(new THREE.Mesh(g, this.edgeMaterial));
  }

  // One racing kerb block: wider at the base than at the top, with the inboard
  // edge ramped so a wheel climbs it instead of hitting a wall.
  static kerbGeometry(width = 1.5, height = 0.13, length = 3.0) {
    const w = width / 2, l = length / 2;
    const profile = [
      [-w, 0], [-w + 0.18, height], [w - 0.06, height], [w, 0],
    ];
    const pos = [], idx = [];
    for (const [x, y] of profile) { pos.push(x, y, -l); }
    for (const [x, y] of profile) { pos.push(x, y, l); }
    const n = profile.length;
    for (let i = 0; i < n - 1; i++) {
      idx.push(i, i + 1, n + i, i + 1, n + i + 1, n + i);      // top and side faces
    }
    idx.push(0, n, n + n - 1, 0, n + n - 1, n - 1);            // base
    idx.push(0, n - 1, 1, 1, n - 1, 2);                        // end caps
    idx.push(n, n + 1, n + n - 1, n + 1, n + 2, n + n - 1);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  #buildKerbs() {
    // Alternating red/white blocks hugging both edges.
    // Paint on a kerb is walked on by tyres all weekend: it is never uniform,
    // and never as glossy as fresh paint. Each block is tinted a little away
    // from its base colour and a little different in height.
    const kerbMat = (color) => new THREE.MeshStandardMaterial({
      color, roughness: 0.68, metalness: 0.02,
    });
    const matA = kerbMat(PALETTE.kerbA);
    const matB = kerbMat(PALETTE.kerbB);
    this.kerbMaterials = [matA, matB];
    const BLOCK = 3.0;
    const geo = Track.kerbGeometry(1.5, 0.13, BLOCK);
    const step = this.stepFor(BLOCK * 0.98);
    const count = Math.ceil(SAMPLES / step) * 2 + 4;
    const meshA = new THREE.InstancedMesh(geo, matA, count);
    const meshB = new THREE.InstancedMesh(geo, matB, count);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    const tint = new THREE.Color();
    let ia = 0, ib = 0, flip = 0;
    for (let i = 0; i < SAMPLES; i += step) {
      const f = this.frameAt(i / SAMPLES);
      const yaw = Math.atan2(f.tan.x, f.tan.z);
      for (const sgn of [-1, 1]) {
        // A kerb needs its own width of verge. Where a street loop comes back
        // alongside itself there is none, and the blocks would be painted
        // across the neighbouring racing surface.
        if (this.verge(i, sgn) < 1.6) continue;
        const p = f.pos.clone().addScaledVector(f.side, sgn * (this.roadHalf + 0.72))
          .setY(f.pos.y + ROAD_SURFACE - 0.01);
        q.setFromAxisAngle(UP, yaw + (sgn > 0 ? Math.PI : 0));
        s.set(1, 0.85 + Math.random() * 0.3, 1);
        m.compose(p, q, s);
        const wear = 0.82 + Math.random() * 0.24;
        tint.setScalar(wear);
        if (flip % 2 === 0) { meshA.setColorAt(ia, tint); meshA.setMatrixAt(ia++, m); }
        else { meshB.setColorAt(ib, tint); meshB.setMatrixAt(ib++, m); }
      }
      flip++;
    }
    meshA.count = ia; meshB.count = ib;
    meshA.instanceMatrix.needsUpdate = meshB.instanceMatrix.needsUpdate = true;
    if (meshA.instanceColor) meshA.instanceColor.needsUpdate = true;
    if (meshB.instanceColor) meshB.instanceColor.needsUpdate = true;
    meshA.receiveShadow = meshB.receiveShadow = true;
    meshA.castShadow = meshB.castShadow = true;
    this.group.add(meshA, meshB);
  }

  // Each circuit is edged in its own way. Armco is a steel rail on posts with a
  // reflector every few metres; a street circuit is edged in concrete; a lane
  // is edged in wire. All of it is instanced, and all of it stands on the
  // verge, so a barrier follows the circuit's elevation instead of hovering.
  #buildBarriers() {
    const style = this.barriers;
    if (style === 'none') return;
    this.#buildBarrierLine(style);
    if (style !== 'none' && style !== 'fence') this.#buildTyreStacks();
    this.#buildSignage();
  }

  // Where a barrier can stand on this side of the circuit at this point of the
  // lap: false over the pit lane mouth and wherever the lap comes back round
  // through the space the barrier would occupy.
  #barrierRoom(t, index, sgn) {
    if (this.pitPhase(t) !== null && sgn === this.pit.side) return false;
    return this.verge(index, sgn) >= BARRIER_OFFSET + BARRIER_DEPTH;
  }

  #buildBarrierLine(style) {
    const offset = this.roadHalf + BARRIER_OFFSET;
    const steel = new THREE.MeshStandardMaterial({
      color: 0x9fa7b4, roughness: 0.42, metalness: 0.78,
    });
    const postMat = new THREE.MeshStandardMaterial({
      color: 0x6c7480, roughness: 0.5, metalness: 0.65,
    });
    // The reflectors and the lit strips on a concrete wall are what make a
    // barrier readable at night, so they are emissive and the environment
    // turns them up when the lights come on.
    this.barrierMaterial = new THREE.MeshStandardMaterial({
      color: 0x14202c, roughness: 0.35, metalness: 0.2,
      emissive: 0x54d8ff, emissiveIntensity: 0.6,
    });

    const parts = {
      armco: {
        span: 4.1,
        pieces: [
          // Corrugated rail, approximated by two offset beams.
          { geo: new THREE.BoxGeometry(BARRIER_DEPTH * 0.45, 0.30, 4.1), mat: steel, y: 0.78, out: 0 },
          { geo: new THREE.BoxGeometry(BARRIER_DEPTH * 0.7, 0.12, 4.1), mat: steel, y: 0.63, out: 0.04 },
          { geo: new THREE.BoxGeometry(0.16, 0.9, 0.16), mat: postMat, y: 0.45, out: 0.16 },
          { geo: new THREE.BoxGeometry(0.06, 0.1, 0.22), mat: this.barrierMaterial, y: 0.9, out: -0.22, every: 2 },
        ],
      },
      concrete: {
        span: 3.0,
        pieces: [
          { geo: Track.jerseyGeometry(0.92, 1.1, 3.0), mat: new THREE.MeshStandardMaterial({
            color: 0xa8aeb6, roughness: 0.93, metalness: 0.02 }), y: 0, out: 0 },
          { geo: new THREE.BoxGeometry(0.1, 0.12, 1.2), mat: this.barrierMaterial, y: 0.82, out: -0.46, every: 2 },
        ],
      },
      pillars: {
        span: 5.0,
        pieces: [
          { geo: new THREE.CylinderGeometry(0.2, 0.26, 1.05, 8), mat: new THREE.MeshStandardMaterial({
            color: 0x2b313b, roughness: 0.55, metalness: 0.4 }), y: 0.52, out: 0 },
          { geo: new THREE.BoxGeometry(0.28, 0.14, 0.28), mat: this.barrierMaterial, y: 1.08, out: 0 },
        ],
      },
      fence: {
        span: 3.0,
        pieces: [
          { geo: new THREE.BoxGeometry(0.1, 1.5, 0.1), mat: postMat, y: 0.75, out: 0 },
          { geo: new THREE.BoxGeometry(0.03, 1.25, 3.0), mat: new THREE.MeshStandardMaterial({
            color: 0xb9c2cc, roughness: 0.6, metalness: 0.5,
            transparent: true, opacity: 0.32, side: THREE.DoubleSide, depthWrite: false,
          }), y: 0.8, out: 0 },
        ],
      },
    }[style];
    if (!parts) return;
    // Rails butt up against each other, so the spacing is the rail length.
    parts.step = this.stepFor(parts.span * 0.98);

    const slots = Math.ceil(SAMPLES / parts.step) * 2 + 4;
    const meshes = parts.pieces.map((p) => {
      const mesh = new THREE.InstancedMesh(p.geo, p.mat, slots);
      mesh.castShadow = !p.mat.transparent;
      mesh.receiveShadow = !p.mat.transparent;
      mesh.count = 0;
      return mesh;
    });
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
    let tick = 0;
    for (let i = 0; i < SAMPLES; i += parts.step) {
      const t = i / SAMPLES;
      const f = this.frameAt(t);
      const yaw = Math.atan2(f.tan.x, f.tan.z);
      q.setFromAxisAngle(UP, yaw);
      for (const sgn of [-1, 1]) {
        if (!this.#barrierRoom(t, i, sgn)) continue;
        const foot = this.terrainY(f.pos.y, offset, this.verge(i, sgn));
        parts.pieces.forEach((piece, k) => {
          if (piece.every && tick % piece.every !== 0) return;
          const p = f.pos.clone()
            .addScaledVector(f.side, sgn * (offset + piece.out * sgn))
            .setY(foot + piece.y);
          m.compose(p, q, one);
          meshes[k].setMatrixAt(meshes[k].count++, m);
        });
      }
      tick += 1;
    }
    for (const mesh of meshes) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.count > 0) this.group.add(mesh);
    }
  }

  // Cross-section of a Jersey barrier: wide foot, sloped face, narrow top.
  static jerseyGeometry(width = 0.92, height = 1.1, length = 3.0) {
    const w = width / 2, l = length / 2;
    const profile = [
      [-w, 0], [-w, 0.18], [-w * 0.42, 0.62], [-w * 0.32, height],
      [w * 0.32, height], [w * 0.42, 0.62], [w, 0.18], [w, 0],
    ];
    const pos = [], idx = [];
    for (const [x, y] of profile) pos.push(x, y, -l);
    for (const [x, y] of profile) pos.push(x, y, l);
    const n = profile.length;
    for (let i = 0; i < n - 1; i++) idx.push(i, n + i, i + 1, i + 1, n + i, n + i + 1);
    idx.push(0, n - 1, n, n, n - 1, n + n - 1);                 // base
    for (let i = 1; i < n - 2; i++) {
      idx.push(0, i + 1, i);                                     // near cap
      idx.push(n, n + i, n + i + 1);                             // far cap
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  // Stacks of old tyres on the outside of the slow corners, where a circuit
  // puts something soft in front of something hard.
  #buildTyreStacks() {
    const ring = new THREE.CylinderGeometry(0.42, 0.42, 0.26, 10);
    const rubber = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.93 });
    const cap = new THREE.MeshStandardMaterial({ color: 0xd8dde4, roughness: 0.7 });
    const stacks = new THREE.InstancedMesh(ring, rubber, 420);
    const caps = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.44, 0.44, 0.06, 10), cap, 90);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
    let n = 0, c = 0;
    const step = this.stepFor(9);
    for (let i = 0; i < SAMPLES && n < 400; i += step) {
      const t = i / SAMPLES;
      if (this.#curvatureAt(t) < 0.12) continue;                 // only the corners
      const f = this.frameAt(t);
      const yaw = Math.atan2(f.tan.x, f.tan.z);
      q.setFromAxisAngle(UP, yaw);
      for (const sgn of [-1, 1]) {
        if (!this.#barrierRoom(t, i, sgn)) continue;
        const room = this.verge(i, sgn);
        if (room < BARRIER_OFFSET + 2.4) continue;
        const out = this.roadHalf + BARRIER_OFFSET + 1.1;
        const foot = this.terrainY(f.pos.y, out, room);
        const high = 3 + Math.floor(Math.random() * 2);
        for (let k = 0; k < high && n < 400; k++) {
          const p = f.pos.clone().addScaledVector(f.side, sgn * out).setY(foot + 0.13 + k * 0.26);
          m.compose(p, q, one);
          stacks.setMatrixAt(n++, m);
        }
        if (c < 90) {
          const p = f.pos.clone().addScaledVector(f.side, sgn * out).setY(foot + 0.03 + high * 0.26);
          m.compose(p, q, one);
          caps.setMatrixAt(c++, m);
        }
      }
    }
    stacks.count = n;
    caps.count = c;
    stacks.instanceMatrix.needsUpdate = caps.instanceMatrix.needsUpdate = true;
    stacks.castShadow = true;
    if (n) this.group.add(stacks, caps);
  }

  // Distance boards and corner numbers on the outside of the circuit: the
  // furniture that tells a driver where on the lap they are.
  #buildSignage() {
    const post = new THREE.BoxGeometry(0.12, 2.2, 0.12);
    const board = new THREE.BoxGeometry(0.08, 0.9, 1.4);
    const postMat = new THREE.MeshStandardMaterial({ color: 0x3a4250, roughness: 0.6, metalness: 0.4 });
    this.signMaterial = new THREE.MeshStandardMaterial({
      color: 0x0e1420, roughness: 0.5, metalness: 0.1,
      emissive: 0xffc94d, emissiveIntensity: 0.35,
    });
    const step = this.stepFor(90);
    const slots = Math.ceil(SAMPLES / step) * 2 + 4;
    const posts = new THREE.InstancedMesh(post, postMat, slots);
    const boards = new THREE.InstancedMesh(board, this.signMaterial, slots);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
    let n = 0;
    for (let i = 0; i < SAMPLES; i += step) {
      const t = i / SAMPLES;
      const f = this.frameAt(t);
      const sgn = (i / step) % 2 === 0 ? -1 : 1;
      const room = this.verge(i, sgn);
      if (room < BARRIER_OFFSET + 3) continue;
      if (this.pitPhase(t) !== null && sgn === this.pit.side) continue;
      const out = this.roadHalf + BARRIER_OFFSET + 2.2;
      const foot = this.terrainY(f.pos.y, out, room);
      const yaw = Math.atan2(f.tan.x, f.tan.z);
      q.setFromAxisAngle(UP, yaw);
      const at = f.pos.clone().addScaledVector(f.side, sgn * out);
      m.compose(at.clone().setY(foot + 1.1), q, one);
      posts.setMatrixAt(n, m);
      m.compose(at.clone().setY(foot + 2.1), q, one);
      boards.setMatrixAt(n, m);
      this.addSolid(at.x, foot, at.z, 0.4, 2.6);
      n += 1;
    }
    posts.count = boards.count = n;
    posts.instanceMatrix.needsUpdate = boards.instanceMatrix.needsUpdate = true;
    posts.castShadow = boards.castShadow = true;
    if (n) this.group.add(posts, boards);
  }

  #buildStartLine() {
    const f = this.frameAt(0);
    const cols = 16;
    const geo = new THREE.BoxGeometry((this.roadHalf * 2) / cols, 0.02, 1.1);
    const paintDepth = { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 };
    const dark = new THREE.MeshStandardMaterial({ color: 0x11151d, ...paintDepth });
    const light = new THREE.MeshStandardMaterial({ color: 0xf2f6fb, ...paintDepth });
    const yaw = Math.atan2(f.tan.x, f.tan.z);
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < cols; c++) {
        const mesh = new THREE.Mesh(geo, (r + c) % 2 ? light : dark);
        const off = -this.roadHalf + (c + 0.5) * (this.roadHalf * 2 / cols);
        mesh.position.copy(f.pos).addScaledVector(f.side, off)
          .addScaledVector(f.tan, r * 1.1).setY(f.pos.y + ROAD_SURFACE + PAINT_LIFT + 0.01);
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
      p.position.copy(f.pos).addScaledVector(f.side, sgn * (this.roadHalf + 3))
        .setY(this.groundAt(0, sgn * (this.roadHalf + 3)) + 4.5);
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
      pos.push(inner.x, inner.y + ROAD_SURFACE, inner.z, outer.x, outer.y + ROAD_SURFACE, outer.z);
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
    const paintDepth = { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 };
    const paint = new THREE.MeshStandardMaterial({
      color: 0xe6edf6, roughness: 0.65, emissive: 0x27303c, emissiveIntensity: 0.4,
      ...paintDepth,
    });
    const boxPaint = new THREE.MeshStandardMaterial({
      color: 0x4de3b0, roughness: 0.6, emissive: 0x0d5f45, emissiveIntensity: 1.1,
      ...paintDepth,
    });
    const strip = new THREE.BoxGeometry(0.18, 0.02, 2.4);
    for (let k = 2; k < STEPS - 2; k += 2) {
      const t = at(k);
      const f = this.frameAt(t);
      const mark = new THREE.Mesh(strip, paint);
      mark.position.copy(f.pos)
        .addScaledVector(f.side, side * (pit.inner - 0.4))
        .setY(f.pos.y + ROAD_SURFACE + PAINT_LIFT + 0.01);
      mark.rotation.y = Math.atan2(f.tan.x, f.tan.z);
      this.group.add(mark);
    }
    const boxFrame = this.frameAt(pit.box);
    const boxYaw = Math.atan2(boxFrame.tan.x, boxFrame.tan.z);
    const box = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.02, 6.4), boxPaint);
    box.position.copy(boxFrame.pos)
      .addScaledVector(boxFrame.side, side * pit.centre)
      .setY(boxFrame.pos.y + ROAD_SURFACE + PAINT_LIFT + 0.015);
    box.rotation.y = boxYaw;
    this.group.add(box);
    this.pitBoxPoint = box.position.clone();

    // The wall along the outside, and the garages standing behind it.
    const wallMat = new THREE.MeshStandardMaterial({
      color: 0x9aa0a8, roughness: 0.92, emissive: 0x2a2f36, emissiveIntensity: 0.3,
    });
    const wallGeo = new THREE.BoxGeometry(0.9, 1.15, 3.2);
    const wall = new THREE.InstancedMesh(wallGeo, wallMat, STEPS + 2);
    // The garages are one building along the back of the lane, not a row of
    // free-standing boxes: a pit complex is a terrace, and spaced boxes read as
    // crates dropped on the grass. Built as a ribbon from the same frames.
    const garageMat = new THREE.MeshStandardMaterial({
      color: 0x1b2230, roughness: 0.8, metalness: 0.2,
      emissive: 0x2b3a52, emissiveIntensity: 0.5, side: THREE.DoubleSide,
    });
    const gPos = [], gIdx = [];
    const FRONT = pit.outer + 2.6, DEPTH = 9.0, HEIGHT = 5.2;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
    let wn = 0;
    for (let k = 0; k <= STEPS; k++) {
      const t = at(k);
      const f = this.frameAt(t);
      const yaw = Math.atan2(f.tan.x, f.tan.z);
      q.setFromAxisAngle(UP, yaw);
      const room = this.verge(Math.round(t * SAMPLES), side);
      const p = f.pos.clone().addScaledVector(f.side, side * (pit.outer + 0.9))
        .setY(this.terrainY(f.pos.y, pit.outer + 0.9, room) + 0.6);
      m.compose(p, q, one);
      wall.setMatrixAt(wn++, m);

      // Cross-section of the terrace: frontage up from the apron, roof back,
      // rear wall down. Skipped at the taper so the building has square ends.
      const phase = k / STEPS;
      if (phase > 0.08 && phase < 0.92) {
        const foot = this.terrainY(f.pos.y, FRONT, room);
        for (const [out, up] of [[FRONT, 0], [FRONT, HEIGHT], [FRONT + DEPTH, HEIGHT], [FRONT + DEPTH, 0]]) {
          const v = f.pos.clone().addScaledVector(f.side, side * out);
          gPos.push(v.x, foot + up, v.z);
        }
        const rings = gPos.length / 3 / 4;
        if (rings > 1) {
          const a = (rings - 2) * 4, b = (rings - 1) * 4;
          for (let j = 0; j < 3; j++) {
            gIdx.push(a + j, b + j, a + j + 1, a + j + 1, b + j, b + j + 1);
          }
        }
      }
    }
    wall.count = wn;
    wall.instanceMatrix.needsUpdate = true;
    wall.castShadow = true;
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.Float32BufferAttribute(gPos, 3));
    gg.setIndex(gIdx);
    gg.computeVertexNormals();
    const garages = new THREE.Mesh(gg, garageMat);
    garages.castShadow = garages.receiveShadow = true;
    this.pitGarageMaterial = garageMat;
    this.group.add(wall, garages);
  }

  // The circuit banks, so a flat plane would bury its low sections. Each side
  // of the road gets a skirt that starts flush under the asphalt and falls to
  // the far-field plane across the room that side has — which is short where
  // the lap doubles back on itself, and wide where there is open country. The
  // whole thing is one call of terrainY per vertex, so the terrain a car sees
  // is the same surface every prop is stood on.
  #buildApron() {
    for (const sign of [-1, 1]) {
      const pos = [], idx = [], uv = [];
      const rings = SKIRT_RINGS.length + 1;
      for (let i = 0; i <= SAMPLES; i++) {
        const k = i % SAMPLES;
        const f = this.frameAt(k / SAMPLES);
        const room = this.verge(k, sign);
        // Innermost ring tucks under the road edge so there is no seam.
        const inner = this.roadHalf - 0.6;
        const along = (i === SAMPLES ? this.length : this.cumulative[k]) / this.vergeTile;
        for (const dist of [inner, ...SKIRT_RINGS.map((r) => this.roadHalf + room * r)]) {
          const v = f.pos.clone().addScaledVector(f.side, sign * dist);
          pos.push(v.x, this.terrainY(f.pos.y, dist, room), v.z);
          uv.push(sign * dist / this.vergeTile, along);
        }
        if (i < SAMPLES) {
          const a = i * rings, b = (i + 1) * rings;
          for (let j = 0; j < rings - 1; j++) {
            if (sign > 0) idx.push(a + j, b + j, a + j + 1, a + j + 1, b + j, b + j + 1);
            else idx.push(a + j, a + j + 1, b + j, a + j + 1, b + j + 1, b + j);
          }
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      g.computeVertexNormals();
      const apron = new THREE.Mesh(g, this.groundMaterial);
      apron.receiveShadow = true;
      this.group.add(apron);
    }
  }

  // Ground plus low-poly hills and trackside markers, all instanced.
  #buildScenery() {
    // The verges are a surface of their own: grass off a circuit, sand off a
    // desert road. Same generator as the asphalt, so the whole scene catches
    // light the same way.
    const kind = this.spec.surface === 'dirt' ? 'sand' : 'grass';
    const verge = terrainMaps(kind);
    this.vergeTile = verge.tile;
    this.groundMaterial = new THREE.MeshStandardMaterial({
      color: this.spec.ground, roughness: 1,
      map: verge.map, roughnessMap: verge.roughnessMap, normalMap: verge.normalMap,
      normalScale: new THREE.Vector2(0.8, 0.8),
    });
    const plane = new THREE.PlaneGeometry(3000, 3000, 1, 1);
    // Metre-based UVs, like the road: the texture tiles at its own scale
    // instead of being stretched over three kilometres.
    const puv = plane.attributes.uv;
    const ppos = plane.attributes.position;
    for (let i = 0; i < puv.count; i++) {
      puv.setXY(i, ppos.getX(i) / this.vergeTile, ppos.getY(i) / this.vergeTile);
    }
    const ground = new THREE.Mesh(plane, this.groundMaterial);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = this.groundY;
    ground.receiveShadow = true;
    this.group.add(ground);
    this.#buildApron();

    const hillGeo = Track.ridgeGeometry();
    this.hillMaterial = new THREE.MeshStandardMaterial({
      color: this.spec.hills, roughness: 1, flatShading: true,
    });
    const hillBudget = this.spec.scenery === 'town' ? 60 : 260;
    const hills = new THREE.InstancedMesh(hillGeo, this.hillMaterial, hillBudget);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    let n = 0;
    for (let i = 0; i < 900 && n < hillBudget; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 330 + Math.random() * 720;
      const p = new THREE.Vector3(Math.cos(a) * r, this.groundY, Math.sin(a) * r);
      const h = 18 + Math.random() * 70;
      // Ridges are long and low across one axis and steep across the other,
      // which is what stops a horizon of them reading as a row of cones.
      s.set(h * (1.1 + Math.random() * 1.4), h, h * (0.6 + Math.random() * 0.5));
      // Measured against the hill's own footprint and against the nearest part
      // of the lap, not the nearest centreline point of one section: a 70m
      // cone whose centre is 80m clear still has its skirt on the road.
      const foot = Math.max(s.x, s.z) + (this.spec.scenery === 'town' ? 240 : 26);
      if (!this.clearOfRoad(p.x, p.z, foot)) continue;
      q.setFromAxisAngle(UP, Math.random() * Math.PI);
      m.compose(p.setY(this.groundY + h / 2), q, s);
      this.addSolid(p.x, this.groundY, p.z, Math.max(s.x, s.z) * 0.42, h);
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
    else if (this.spec.scenery === 'canyon') this.#buildCanyon();
    else if (this.spec.scenery === 'industrial') this.#buildIndustrial();
    this.#buildLife();

    const pylonStep = this.stepFor(34);
    const pylons = new THREE.InstancedMesh(
      pyGeo, this.pylonMaterial, Math.ceil(SAMPLES / pylonStep) * 2 + 4);
    let pn = 0;
    for (let i = 0; i < SAMPLES; i += pylonStep) {
      const pt = i / SAMPLES;
      const f = this.frameAt(pt);
      const lane = this.pitPhase(pt) !== null;
      for (const sgn of [-1, 1]) {
        // The markers sit where the pit lane is. Anything standing in the lane
        // is something a car being waved into it has to drive through.
        if (lane && sgn === this.pit.side) continue;
        const room = this.verge(i, sgn);
        if (room < 6) continue;        // no verge here: the lap comes back past it
        const p = f.pos.clone().addScaledVector(f.side, sgn * (this.roadHalf + 5.2))
          .setY(this.terrainY(f.pos.y, this.roadHalf + 5.2, room) + 1.1);
        m.compose(p, new THREE.Quaternion(), new THREE.Vector3(1, 1, 1));
        pylons.setMatrixAt(pn++, m);
      }
    }
    pylons.count = pn;
    pylons.instanceMatrix.needsUpdate = true;
    this.group.add(pylons);
  }

  // A low-poly ridge: a five-sided cone with its ring pushed about so no two
  // instances of it have the same skyline, and a flattened peak.
  static ridgeGeometry() {
    const sides = 7;
    const pos = [], idx = [];
    const ring = [];
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      const r = 0.5 * (0.7 + ((i * 7919) % 100) / 220);
      ring.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    pos.push(0, -0.5, 0);                         // base centre
    for (const [x, z] of ring) pos.push(x, -0.5, z);
    // Two stacked rings give the flank a shoulder instead of one straight face.
    for (const [x, z] of ring) pos.push(x * 0.52, 0.02, z * 0.52);
    pos.push(((ring[0][0]) * 0.08), 0.5, ((ring[1][1]) * 0.08));   // peak, off-centre
    const base = 1, mid = 1 + sides, peak = 1 + sides * 2;
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      idx.push(0, base + j, base + i);
      idx.push(base + i, base + j, mid + i, mid + i, base + j, mid + j);
      idx.push(mid + i, mid + j, peak);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  // Side roads at the marked junctions. They are scenery, not drivable routes:
  // the circuit is still the loop, these give it somewhere to have come from.
  #buildJunctions() {
    const mat = new THREE.MeshStandardMaterial({
      color: this.spec.road, roughness: 0.94, metalness: 0.02,
    });
    const line = new THREE.MeshStandardMaterial({
      color: 0xd8e2f0, roughness: 0.7,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    const reach = 38;
    const THICK = 0.12;
    for (const j of this.junctions) {
      const f = this.frameAt(j.t);
      const yaw = Math.atan2(f.tan.x, f.tan.z);
      for (const side of j.sides) {
        // The arm begins at the road edge and runs outward. Its top is level
        // with the asphalt: an arm centred half a metre inside the road edge
        // used to draw a strip of side road over the racing surface.
        const arm = new THREE.Mesh(
          new THREE.BoxGeometry(reach, THICK, this.roadHalf * 1.7), mat);
        arm.position.copy(f.pos)
          .addScaledVector(f.side, side * (this.roadHalf + reach / 2))
          .setY(f.pos.y + ROAD_SURFACE - THICK / 2);
        arm.rotation.y = yaw;
        arm.receiveShadow = true;
        this.group.add(arm);

        // Stop line where the side road meets the circuit.
        const stop = new THREE.Mesh(
          new THREE.BoxGeometry(0.5, 0.06, this.roadHalf * 1.5), line);
        stop.position.copy(f.pos)
          .addScaledVector(f.side, side * (this.roadHalf + 1.4))
          .setY(f.pos.y + ROAD_SURFACE + PAINT_LIFT + 0.02);
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
        const room = this.verge(i, side);
        const width = Math.min(4.2, Math.max(0.6, room));
        const inner = f.pos.clone().addScaledVector(f.side, side * (this.roadHalf + 0.1));
        const outer = f.pos.clone().addScaledVector(f.side, side * (this.roadHalf + width));
        strip.push(inner.x, f.pos.y + ROAD_SURFACE + 0.14, inner.z,
          outer.x, this.terrainY(f.pos.y, this.roadHalf + width, room) + 0.18, outer.z);
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

    const windows = windowTexture();
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
    const blockStep = this.stepFor(17);
    for (let i = 0; i < SAMPLES && n < count; i += blockStep) {
      const t = i / SAMPLES;
      if (this.#isNearJunction(t, 0.045)) continue;
      const f = this.frameAt(t);
      const yaw = Math.atan2(f.tan.x, f.tan.z);
      for (const side of [-1, 1]) {
        if (n >= count) break;
        const room = this.verge(i, side);
        // A facade needs the whole block behind it. Where the loop runs back
        // down the next street there is no block, so there is no building.
        if (room < 16) continue;
        const depth = 12 + Math.random() * Math.min(12, room - 12);
        const width = 14 + Math.random() * 16;
        const height = 9 + Math.random() * 26;
        const away = this.roadHalf + 4.6 + depth / 2;
        const at = f.pos.clone().addScaledVector(f.side, side * away)
          .setY(this.terrainY(f.pos.y, away, room) + height / 2 - 0.4);
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
      const foot = this.terrainY(f.pos.y, this.roadHalf + 2.6, this.verge(i, side));
      m.compose(base.clone().setY(foot + 3.5), q, one);
      this.addSolid(base.x, foot, base.z, 0.3, 7);
      posts.setMatrixAt(n, m);
      m.compose(base.clone().addScaledVector(f.side, -side * 0.7).setY(foot + 7.1), q, one);
      heads.setMatrixAt(n, m);
      n += 1;
    }
    posts.count = heads.count = n;
    posts.instanceMatrix.needsUpdate = heads.instanceMatrix.needsUpdate = true;
    this.group.add(posts, heads);
  }

  // A road cut through rock. The walls are ribbons that follow the verge with
  // a jagged top edge, not scattered cones: a cutting is a continuous face,
  // and the profile is what makes a corner blind. The ribbon breaks wherever
  // the lap comes back through the space the wall would fill.
  #buildCanyon() {
    // Height of the cut at a point on the lap. Three waves at different rates
    // give a skyline that never repeats over a lap and never steps sharply.
    const crest = (t, sign) => 9
      + Math.sin(t * Math.PI * 2 * 7 + (sign > 0 ? 1.7 : 0)) * 4.2
      + Math.sin(t * Math.PI * 2 * 17 + 0.6) * 2.4
      + Math.sin(t * Math.PI * 2 * 31 + 2.1) * 1.1;

    for (const sign of [-1, 1]) {
      const pos = [], idx = [];
      let ring = 0;
      for (let i = 0; i <= SAMPLES; i++) {
        const k = i % SAMPLES;
        const t = k / SAMPLES;
        const f = this.frameAt(t);
        const room = this.verge(k, sign);
        if (room < 7) { ring = 0; continue; }
        // The face stands at the back of whatever verge there is, and leans
        // out over it a little, the way a cut face does.
        const base = this.roadHalf + Math.min(room, 11);
        const top = base + 2.6;
        const foot = this.terrainY(f.pos.y, base, room);
        const height = crest(t, sign);
        const a = f.pos.clone().addScaledVector(f.side, sign * base);
        const b = f.pos.clone().addScaledVector(f.side, sign * top);
        pos.push(a.x, foot - 1, a.z, b.x, foot + height, b.z);
        if (ring > 0) {
          const rings = pos.length / 3 / 2;
          const p = (rings - 2) * 2, q = (rings - 1) * 2;
          if (sign > 0) idx.push(p, q, p + 1, p + 1, q, q + 1);
          else idx.push(p, p + 1, q, p + 1, q + 1, q);
        }
        ring += 1;
      }
      if (!idx.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      const wall = new THREE.Mesh(g, this.hillMaterial);
      wall.castShadow = true;
      wall.receiveShadow = true;
      this.group.add(wall);
    }

    // Blocks that have come off the face and been pushed onto the verge.
    const geo = Track.ridgeGeometry();
    const step = this.stepFor(17);
    const slots = Math.ceil(SAMPLES / step) * 2 + 4;
    const boulders = new THREE.InstancedMesh(geo, this.hillMaterial, slots);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sv = new THREE.Vector3();
    let b = 0;
    for (let i = 0; i < SAMPLES; i += step) {
      const f = this.frameAt(i / SAMPLES);
      for (const sgn of [-1, 1]) {
        const room = this.verge(i, sgn);
        if (room < 11 || Math.random() > 0.55) continue;
        const out = this.roadHalf + 4 + Math.random() * (room - 6);
        const at = f.pos.clone().addScaledVector(f.side, sgn * out);
        const foot = this.terrainY(f.pos.y, out, room);
        const size = 1.2 + Math.random() * 2.4;
        q.setFromAxisAngle(UP, Math.random() * Math.PI);
        sv.set(size * 1.5, size, size * 1.3);
        m.compose(at.clone().setY(foot + size * 0.36), q, sv);
        boulders.setMatrixAt(b++, m);
        this.addSolid(at.x, foot, at.z, size * 0.75, size);
      }
    }
    boulders.count = b;
    boulders.instanceMatrix.needsUpdate = true;
    boulders.castShadow = boulders.receiveShadow = true;
    if (b) this.group.add(boulders);
  }

  // A circuit through working docks: stacked containers, long sheds behind
  // them and a crane or two over the top. All of it is boxes, which is what
  // a container terminal is.
  #buildIndustrial() {
    const boxGeo = new THREE.BoxGeometry(6.1, 2.6, 2.44);
    const boxMat = new THREE.MeshStandardMaterial({ roughness: 0.72, metalness: 0.25 });
    const shedMat = new THREE.MeshStandardMaterial({
      color: 0x4c525c, roughness: 0.85, metalness: 0.15,
    });
    const steelMat = new THREE.MeshStandardMaterial({
      color: 0x6e7580, roughness: 0.5, metalness: 0.7,
    });
    this.buildingMaterial = shedMat;
    const step = this.stepFor(21);
    const stacks = Math.ceil(SAMPLES / step) * 2 * 3 + 12;
    const containers = new THREE.InstancedMesh(boxGeo, boxMat, stacks);
    const sheds = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), shedMat, 40);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sv = new THREE.Vector3();
    const one = new THREE.Vector3(1, 1, 1);
    const tint = new THREE.Color();
    // Container paint: oxide reds, sea blues, rust and a little green.
    const PAINT = [0xb1402f, 0x2f5c8a, 0x8a6a3a, 0x3f6f52, 0x9aa0a8, 0x7a3b32];
    let n = 0, sh = 0;

    for (let i = 0; i < SAMPLES; i += step) {
      const f = this.frameAt(i / SAMPLES);
      const yaw = Math.atan2(f.tan.x, f.tan.z);
      q.setFromAxisAngle(UP, yaw);
      for (const sgn of [-1, 1]) {
        const room = this.verge(i, sgn);
        if (room < 12) continue;
        const out = this.roadHalf + 7 + Math.random() * Math.min(10, room - 9);
        const at = f.pos.clone().addScaledVector(f.side, sgn * out);
        const foot = this.terrainY(f.pos.y, out, room);
        const high = 1 + Math.floor(Math.random() * 3);
        for (let k = 0; k < high && n < stacks; k++) {
          const jitter = (Math.random() - 0.5) * 0.5;
          const p = at.clone()
            .addScaledVector(f.tan, jitter)
            .setY(foot + 1.3 + k * 2.62);
          m.compose(p, q, one);
          containers.setColorAt(n, tint.setHex(PAINT[(Math.random() * PAINT.length) | 0]));
          containers.setMatrixAt(n++, m);
        }
        this.addSolid(at.x, foot, at.z, 3.4, high * 2.6);

        // A shed further back, and now and then a crane over the containers.
        if (room > 26 && sh < 40 && Math.random() < 0.5) {
          const sOut = this.roadHalf + 20 + Math.random() * Math.min(14, room - 22);
          const sAt = f.pos.clone().addScaledVector(f.side, sgn * sOut);
          const sFoot = this.terrainY(f.pos.y, sOut, room);
          const h = 7 + Math.random() * 5;
          sv.set(16 + Math.random() * 12, h, 30 + Math.random() * 20);
          m.compose(sAt.clone().setY(sFoot + h / 2), q, sv);
          sheds.setMatrixAt(sh++, m);
          this.addSolid(sAt.x, sFoot, sAt.z, 14, h);
        }
        if (room > 22 && Math.random() < 0.14) {
          this.#buildCrane(f, sgn, room, steelMat);
        }
      }
    }
    containers.count = n;
    sheds.count = sh;
    for (const mesh of [containers, sheds]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      if (mesh.count) this.group.add(mesh);
    }
    this.#buildLamps(38);
  }

  // A gantry crane: two legs, a beam across the top and a jib reaching out
  // over where the water would be.
  #buildCrane(frame, sgn, room, steel) {
    const out = this.roadHalf + Math.min(room - 4, 30);
    const base = frame.pos.clone().addScaledVector(frame.side, sgn * out);
    const foot = this.terrainY(frame.pos.y, out, room);
    const yaw = Math.atan2(frame.tan.x, frame.tan.z);
    const height = 22;
    const group = new THREE.Group();
    group.position.copy(base).setY(foot);
    group.rotation.y = yaw;
    for (const dz of [-7, 7]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(1.1, height, 1.1), steel);
      leg.position.set(0, height / 2, dz);
      group.add(leg);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.4, 17), steel);
    beam.position.set(0, height, 0);
    const jib = new THREE.Mesh(new THREE.BoxGeometry(26, 1.1, 1.2), steel);
    jib.position.set(-sgn * 9, height - 2.4, 0);
    group.add(beam, jib);
    group.traverse((node) => { if (node.isMesh) node.castShadow = true; });
    this.group.add(group);
    this.addSolid(base.x, foot, base.z, 8, height);
  }

  // Fences, hedges and trees: the lane needs edges, not architecture.
  #buildVillage() {
    const postMat = new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 0.95 });
    const railMat = new THREE.MeshStandardMaterial({ color: 0x6b5540, roughness: 0.95 });
    const postGeo = new THREE.BoxGeometry(0.16, 1.3, 0.16);
    const railGeo = new THREE.BoxGeometry(0.1, 0.14, 4.4);
    const step = this.stepFor(4.3);
    const slots = Math.ceil(SAMPLES / step) * 2 + 4;
    const posts = new THREE.InstancedMesh(postGeo, postMat, slots);
    const rails = new THREE.InstancedMesh(railGeo, railMat, slots);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
    let n = 0;
    for (let i = 0; i < SAMPLES && n < slots - 2; i += step) {
      const t = i / SAMPLES;
      if (this.#isNearJunction(t, 0.02)) continue;
      const f = this.frameAt(t);
      const yaw = Math.atan2(f.tan.x, f.tan.z);
      q.setFromAxisAngle(UP, yaw);
      for (const side of [-1, 1]) {
        const at = f.pos.clone().addScaledVector(f.side, side * (this.roadHalf + 3.4));
        const foot = this.terrainY(f.pos.y, this.roadHalf + 3.4, this.verge(i, side));
        m.compose(at.clone().setY(foot + 0.65), q, one);
        posts.setMatrixAt(n, m);
        m.compose(at.clone().setY(foot + 0.95), q, one);
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
    const treeStep = this.stepFor(11);
    for (let i = 0; i < SAMPLES && tn < treeCount; i += treeStep) {
      const f = this.frameAt(i / SAMPLES);
      for (const side of [-1, 1]) {
        if (tn >= treeCount || Math.random() < 0.45) continue;
        const room = this.verge(i, side);
        if (room < 9) continue;
        const away = this.roadHalf + 7 + Math.random() * (room - 7);
        const jitter = (Math.random() - 0.5) * 8;
        const at = f.pos.clone().addScaledVector(f.side, side * away).addScaledVector(f.tan, jitter);
        if (!this.clearOfRoad(at.x, at.z, 6)) continue;
        const foot = this.terrainY(f.pos.y, away, room);
        const scale = 0.8 + Math.random() * 0.9;
        m.compose(at.clone().setY(foot + 1.7 * scale), new THREE.Quaternion(),
          new THREE.Vector3(scale, scale, scale));
        trunks.setMatrixAt(tn, m);
        m.compose(at.clone().setY(foot + 4.4 * scale), new THREE.Quaternion(),
          new THREE.Vector3(scale, scale * 0.85, scale));
        leaves.setMatrixAt(tn, m);
        this.addSolid(at.x, foot, at.z, 0.55 * scale, 5 * scale);
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
        const room = this.verge(i, side);
        if (room < BARRIER_OFFSET + 2) continue;
        const reach = Math.min(room, BARRIER_OFFSET + (town ? 4 : 8.2));
        const away = this.roadHalf + BARRIER_OFFSET + 1.4
          + Math.random() * Math.max(0.4, reach - BARRIER_OFFSET - 1.4);
        const along = (Math.random() - 0.5) * 7;
        const at = f.pos.clone()
          .addScaledVector(f.side, side * away)
          .addScaledVector(f.tan, along)
          .setY(this.terrainY(f.pos.y, away, room));
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
          const room = this.verge(i, side);
          if (room < BARRIER_OFFSET + 3) continue;
          const away = base + pass * 0.62 + Math.random() * 0.3;
          const along = (Math.random() - 0.5) * (this.length / SAMPLES) * step * 0.12;
          const at = f.pos.clone()
            .addScaledVector(f.side, side * away)
            .addScaledVector(f.tan, along)
            .setY(this.terrainY(f.pos.y, away, room));
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
        const room = this.verge(Math.round(t * SAMPLES), side);
        // A gallery is a building's worth of structure. Where the lap folds
        // back inside that span there is nowhere to put one, so the ribbon
        // breaks there instead of standing over the road.
        if ((side === this.pit.side && this.pitPhase(t) !== null)
          || room < BARRIER_OFFSET + depth + 3) {
          ring = 0;                       // break the ribbon
          continue;
        }
        const f = this.frameAt(t);
        const foot = this.terrainY(f.pos.y, base, room);
        for (const [out, up] of profile) {
          const v = f.pos.clone().addScaledVector(f.side, side * (base + out));
          pos.push(v.x, foot + up, v.z);
        }
        const r = new THREE.Vector3();
        r.copy(f.pos).addScaledVector(f.side, side * (base + depth * 0.15));
        roofPos.push(r.x, foot + top + 4.4, r.z);
        r.copy(f.pos).addScaledVector(f.side, side * (base + depth + 1.2));
        roofPos.push(r.x, foot + top + 5.2, r.z);
        if (k % 8 === 0) {
          postAt.push([f.pos.clone().addScaledVector(f.side, side * (base + depth + 1.0)),
            foot, Math.atan2(f.tan.x, f.tan.z), top + 5.2]);
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
      const room = this.verge(Math.round(t * SAMPLES), side);
      if ((side === this.pit.side && this.pitPhase(t) !== null)
        || room < BARRIER_OFFSET + tiers * tread + 3) continue;
      const f = this.frameAt(t);
      const foot = this.terrainY(f.pos.y, base, room);
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
            .setY(foot + (row + 1) * rise);
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
      const index = Math.round((i / 6) * SAMPLES);
      const f = this.frameAt(i / 6);
      const side = i % 2 === 0 ? -1 : 1;
      const room = this.verge(index, side);
      const away = this.roadHalf + Math.min(34, Math.max(22, room - 2));
      const at = f.pos.clone().addScaledVector(f.side, side * away);
      if (!this.clearOfRoad(at.x, at.z, 14)) continue;
      const foot = this.terrainY(f.pos.y, away, room);
      const pole = new THREE.Mesh(mast, steel);
      pole.position.copy(at).setY(foot + 17);
      this.group.add(pole);
      const rig = new THREE.Mesh(rigGeo, this.floodMaterial);
      rig.position.copy(at).setY(foot + 35);
      rig.rotation.y = Math.atan2(f.tan.x, f.tan.z) + (side * Math.PI) / 2;
      this.group.add(rig);
      this.addSolid(at.x, foot, at.z, 1.2, 34);
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
      // Grazing land is whatever is not circuit. A herd placed by lateral
      // offset alone stands in the middle of the road on the far side.
      if (!this.clearOfRoad(at.x, at.z, 16)) continue;
      const facing = Math.random() * Math.PI * 2;
      q.setFromAxisAngle(UP, facing);
      const ground = this.terrainY(f.pos.y, away, this.verge(i, side)) - 0.05;

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
      // Where the river would cross the circuit it is pushed out to the side
      // rather than drawn over the road.
      let guard = 0;
      while (!this.clearOfRoad(centre.x, centre.z, width + 14) && guard++ < 12) {
        centre.addScaledVector(dir, 18);
      }
      const side = dir.clone().multiplyScalar(width * (0.7 + Math.sin(k * 4.1) * 0.3));
      const a = centre.clone().sub(side);
      const b = centre.clone().add(side);
      // On the far field, below the lowest part of the circuit. A river drawn
      // at a fixed height floats over a track that dips beneath it.
      pos.push(a.x, this.groundY + 0.35, a.z, b.x, this.groundY + 0.35, b.z);
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

  // How many corners the lap has: runs of sustained curvature, counted once
  // each rather than once per sample. The menu quotes this, so it is measured
  // from the same centreline the car drives.
  corners() {
    if (this.cornerCount !== undefined) return this.cornerCount;
    let count = 0, inside = false;
    for (let i = 0; i < SAMPLES; i += 2) {
      const bend = this.#curvatureAt(i / SAMPLES, 26) > 0.075;
      if (bend && !inside) count += 1;
      inside = bend;
    }
    this.cornerCount = Math.max(1, count);
    return this.cornerCount;
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
