import * as THREE from 'three';
import { treadMaps } from './textures.js';
import { Materials } from './materials.js';
import { CLASSES } from './vehicles.js';

// Geometry shared by every vehicle builder, and the builders for the vehicles
// that are not lofted sports cars: a motorcycle and its rider, a kart and its
// driver, and the tall utility bodies (SUV, van, bus, truck). Dimensions are
// real-world metres, so a bus is a bus next to a car and a bike is a bike.

export const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);

export function curveAt(points, u) {
  if (u <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    if (u <= points[i][0]) {
      const [u0, v0] = points[i - 1];
      const [u1, v1] = points[i];
      return lerp(v0, v1, smooth((u - u0) / (u1 - u0)));
    }
  }
  return points[points.length - 1][1];
}

// Superellipse: flat-ish flanks and roof with rounded shoulders, which is the
// cross-section a vehicle body actually has. Higher sharpness is boxier.
function ringPoints(halfWidth, bottom, top, segments, sharpness) {
  const cy = (bottom + top) / 2;
  const hh = Math.max(0.02, (top - bottom) / 2);
  const out = [];
  for (let k = 0; k < segments; k++) {
    const a = (k / segments) * Math.PI * 2;
    const c = Math.cos(a), sn = Math.sin(a);
    const e = 2 / sharpness;
    out.push(
      Math.sign(c) * Math.abs(c) ** e * halfWidth,
      cy + Math.sign(sn) * Math.abs(sn) ** e * hh,
    );
  }
  return out;
}

// Loft a closed tube through stations along the vehicle and cap both ends.
export function loft(stations, segments) {
  const position = [];
  const uv = [];
  const index = [];
  stations.forEach((st, i) => {
    const ring = ringPoints(st.halfWidth, st.bottom, st.top, segments, st.sharpness ?? 2.7);
    for (let k = 0; k < segments; k++) {
      position.push(ring[k * 2], ring[k * 2 + 1], st.z);
      // u runs around the section (0 flank, 0.25 roof, 0.5 other flank,
      // 0.75 floor); v runs nose to tail. That is enough to paint a vehicle.
      uv.push(k / segments, i / (stations.length - 1));
    }
  });
  for (let i = 0; i < stations.length - 1; i++) {
    for (let k = 0; k < segments; k++) {
      const a = i * segments + k;
      const b = i * segments + ((k + 1) % segments);
      const c = a + segments;
      const d = b + segments;
      index.push(a, c, b, b, c, d);
    }
  }
  const capCentre = (st) => [0, (st.bottom + st.top) / 2, st.z];
  const first = stations[0], last = stations[stations.length - 1];
  const frontCentre = position.length / 3;
  position.push(...capCentre(first));
  uv.push(0.5, 0);
  const backCentre = position.length / 3;
  position.push(...capCentre(last));
  uv.push(0.5, 1);
  const lastRing = (stations.length - 1) * segments;
  for (let k = 0; k < segments; k++) {
    const a = k, b = (k + 1) % segments;
    index.push(frontCentre, b, a);
    const c = lastRing + k, d = lastRing + ((k + 1) % segments);
    index.push(backCentre, c, d);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return geo;
}

// A profile lofted from curves in u (0 nose, 1 tail): half width, bottom, top.
export function profileLoft({ length, beam, bottom, top, sharpness = 2.7, stations = 36, segments = 20 }) {
  const out = [];
  for (let i = 0; i < stations; i++) {
    const u = i / (stations - 1);
    out.push({
      z: (0.5 - u) * length,
      halfWidth: curveAt(beam, u),
      bottom: curveAt(bottom, u),
      top: curveAt(top, u),
      sharpness,
    });
  }
  return loft(out, segments);
}

// A cylinder from one point to another: limbs, forks, stays, pipes.
export function strut(from, to, radius, material, segments = 8) {
  const a = new THREE.Vector3(...from), b = new THREE.Vector3(...to);
  const dir = b.clone().sub(a);
  const len = dir.length();
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, len, segments), material);
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  return mesh;
}

export function box(w, h, d, material, x = 0, y = 0, z = 0) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.position.set(x, y, z);
  return mesh;
}

// Wheels for any layout: one per axle for a bike, two for a car, twin rear
// tyres for a bus or a truck. Each wheel is a steering pivot holding a
// spinning group, the disc and the caliper; arches are optional liners.
export function buildWheels(g, { axles, radius, width, arches = true, spokes = 5 }) {
  const tread = treadMaps();
  const rubber = Materials.rubber(tread.map, tread.normalMap);
  const rimMat = Materials.rim();
  // Discs glow when they are hot. The materials belong to this vehicle, one
  // per axle group, so one car braking does not light up the grid and the
  // fronts, which do most of the work, can glow while the rears do not.
  const discMat = Materials.brakeDisc();
  const rearDiscMat = Materials.brakeDisc();
  const caliperMat = Materials.caliper();
  const archMat = Materials.archLiner();
  // A coloured sidewall band: which compound is on is readable from the chase
  // camera, not only from the HUD.
  const tyreMat = new THREE.MeshStandardMaterial({
    color: 0xffc94d, emissive: 0xffc94d, emissiveIntensity: 0.55,
    roughness: 0.7, side: THREE.DoubleSide,
  });

  const wheels = [];
  for (const axle of axles) {
    const r = axle.radius ?? radius;
    const w = (axle.width ?? width) * (axle.dual ? 1.8 : 1);
    const tyreGeo = new THREE.CylinderGeometry(r, r, w, 24);
    tyreGeo.rotateZ(Math.PI / 2);
    const rimGeo = new THREE.CylinderGeometry(r * 0.66, r * 0.66, w * 1.04, 16);
    rimGeo.rotateZ(Math.PI / 2);
    const spokeGeo = new THREE.BoxGeometry(w * 1.06, r * 1.16, 0.045 * Math.max(1, r / 0.35));
    const wallGeo = new THREE.CylinderGeometry(r * 0.88, r * 0.88, w * 1.06, 20, 1, true);
    wallGeo.rotateZ(Math.PI / 2);
    const archGeo = new THREE.CylinderGeometry(r * 1.16, r * 1.16, w * 1.02, 18, 1, true);
    archGeo.rotateZ(Math.PI / 2);
    const discGeo = new THREE.CylinderGeometry(r * 0.56, r * 0.56, Math.min(0.05, w * 0.3), 16);
    const sides = axle.x === 0 ? [0] : [-1, 1];
    for (const side of sides) {
      const pivot = new THREE.Group();
      pivot.position.set(side * axle.x, r, axle.z);
      const spin = new THREE.Group();
      const tyre = new THREE.Mesh(tyreGeo, rubber);
      tyre.castShadow = true;
      spin.add(tyre, new THREE.Mesh(rimGeo, rimMat), new THREE.Mesh(wallGeo, tyreMat));
      for (let k = 0; k < spokes; k++) {
        const spoke = new THREE.Mesh(spokeGeo, rimMat);
        spoke.rotation.x = (k / spokes) * Math.PI;
        spin.add(spoke);
      }
      const disc = new THREE.Mesh(discGeo, axle.steers ? discMat : rearDiscMat);
      disc.rotation.z = Math.PI / 2;
      disc.position.x = side === 0 ? w * 0.6 : 0;
      const caliper = new THREE.Mesh(
        new THREE.BoxGeometry(Math.min(0.09, w * 0.34), r * 0.5, r * 0.22), caliperMat);
      caliper.position.set(side === 0 ? w * 0.6 : -side * w * 0.1, r * 0.1, -r * 0.42);
      pivot.add(spin, disc, caliper);
      g.add(pivot);
      if (arches && side !== 0) {
        const arch = new THREE.Mesh(archGeo, archMat);
        arch.position.set(side * (axle.x - w * 0.08), r + 0.05, axle.z);
        g.add(arch);
      }
      wheels.push({ pivot, spin, steers: !!axle.steers, radius: r });
    }
  }
  return { wheels, tyreMat, discMat, rearDiscMat };
}

// Everything that is not a wheel moves together on the suspension: roll,
// pitch and ride height act on this group and leave the wheels on the road.
export function wrapBody(g, wheels, keep = []) {
  const pivots = new Set([...wheels.map((w) => w.pivot), ...keep]);
  const body = new THREE.Group();
  body.name = 'body';
  for (const child of [...g.children]) if (!pivots.has(child)) body.add(child);
  g.add(body);
  return body;
}

// --- rider -------------------------------------------------------------------
// One kit for anyone sitting on or in an open vehicle: helmet with a dark
// visor, suit, gloves and boots. Joints are placed by the caller.
function kit(accent) {
  return {
    suit: Materials.fabric(accent),
    dark: Materials.leather(0x16181c),
    helmet: Materials.carPaint({ color: accent }),
    visor: Materials.glass(0x05070a, 0.9),
  };
}

function helmet(group, m, at, radius) {
  const shell = new THREE.Mesh(new THREE.SphereGeometry(radius, 20, 14), m.helmet);
  shell.position.set(...at);
  shell.castShadow = true;
  const visor = new THREE.Mesh(
    new THREE.SphereGeometry(radius * 1.01, 20, 10, -Math.PI * 0.35, Math.PI * 0.7,
      Math.PI * 0.32, Math.PI * 0.24), m.visor);
  visor.position.copy(shell.position);
  group.add(shell, visor);
}

// --- motorcycle ------------------------------------------------------------------
export function buildBike(color, b, spec) {
  const g = new THREE.Group();
  const paint = Materials.carPaint({ color });
  const trim = Materials.trim();
  const metal = Materials.brushedMetal(0x6d747c);
  const chrome = Materials.chrome();
  const r = 0.31;
  const zf = 0.71, zr = -0.71;
  const { wheels, tyreMat, discMat, rearDiscMat } = buildWheels(g, {
    axles: [
      { z: zf, x: 0, steers: true, width: 0.12 },
      { z: zr, x: 0, steers: false, width: 0.19 },
    ],
    radius: r, arches: false,
  });

  // Fairing, tank and tail in one lofted shell: narrow at the nose, widest at
  // the tank, dipping to the seat and rising again to the tail.
  const shell = new THREE.Mesh(profileLoft({
    length: 1.9,
    beam: [[0, 0.08], [0.12, 0.19], [0.3, 0.25], [0.45, 0.23], [0.62, 0.16], [0.82, 0.12], [1, 0.05]],
    bottom: [[0, 0.62], [0.12, 0.43], [0.3, 0.42], [0.45, 0.6], [0.62, 0.74], [0.82, 0.8], [1, 0.86]],
    top: [[0, 0.8], [0.12, 0.99], [0.3, 1.02], [0.46, 0.97], [0.56, 0.86], [0.66, 0.84], [0.84, 0.93], [1, 0.9]],
    sharpness: 2.4,
  }), paint);
  shell.position.z = 0.05;
  shell.castShadow = true;
  g.add(shell);
  const screen = new THREE.Mesh(profileLoft({
    length: 0.28,
    beam: [[0, 0.1], [1, 0.16]],
    bottom: [[0, 0.95], [1, 0.97]],
    top: [[0, 1.02], [1, 1.16]],
    sharpness: 2.2, stations: 6, segments: 14,
  }), Materials.glass(0x1b2835, 0.55));
  screen.position.z = 0.83;
  g.add(screen);

  g.add(box(0.34, 0.4, 0.56, metal, 0, 0.44, 0.02));          // engine
  g.add(box(0.26, 0.05, 0.46, Materials.leather(), 0, 0.87, -0.26)); // seat
  for (const sx of [-0.13, 0.13]) g.add(strut([sx, 0.44, -0.1], [sx, r, zr], 0.035, trim)); // swingarm
  g.add(strut([0.15, 0.36, -0.1], [0.17, 0.62, -0.92], 0.05, chrome, 12));  // exhaust
  const headMat = Materials.lens(0xfff6e0, 0xfff0d0, 2.2);
  const tailMat = Materials.lens(0x2a0505, 0xff2a2a, 1.6);
  g.add(box(0.14, 0.07, 0.05, headMat, 0, 0.78, 1.0));
  g.add(box(0.12, 0.05, 0.04, tailMat, 0, 0.88, -0.93));

  // Forks and bars turn with the front wheel.
  const front = wheels[0].pivot;
  for (const sx of [-0.09, 0.09]) front.add(strut([sx, 0, 0], [sx, 0.62, -0.26], 0.028, chrome));
  front.add(strut([-0.34, 0.66, -0.3], [0.34, 0.66, -0.3], 0.018, trim));

  // Rider, tucked in: hips on the seat, chest over the tank, hands on the
  // bars, feet on the pegs.
  const m = kit(spec.rider ?? 0x1c2233);
  const rider = new THREE.Group();
  rider.name = 'rider';
  const torso = box(0.34, 0.5, 0.22, m.suit, 0, 1.05, -0.02);
  torso.rotation.x = 1.0;
  torso.castShadow = true;
  rider.add(torso);
  helmet(rider, m, [0, 1.2, 0.26], 0.15);
  for (const s of [-1, 1]) {
    rider.add(strut([s * 0.17, 1.1, 0.08], [s * 0.26, 0.98, 0.3], 0.045, m.suit));
    rider.add(strut([s * 0.26, 0.98, 0.3], [s * 0.3, 0.97, 0.42], 0.04, m.dark));
    rider.add(strut([s * 0.13, 0.9, -0.26], [s * 0.21, 0.74, 0.06], 0.07, m.suit));
    rider.add(strut([s * 0.21, 0.74, 0.06], [s * 0.17, 0.42, -0.2], 0.055, m.suit));
    rider.add(box(0.09, 0.1, 0.22, m.dark, s * 0.17, 0.38, -0.16));
  }
  g.add(rider);
  const body = wrapBody(g, wheels, [rider]);
  return { group: g, wheels, headMat, tailMat, tyreMat, discMat, rearDiscMat, body, rider };
}

// --- kart --------------------------------------------------------------------------
export function buildKart(color, b, spec) {
  const g = new THREE.Group();
  const paint = Materials.carPaint({ color, metallic: false });
  const trim = Materials.trim();
  const metal = Materials.brushedMetal(0x8a939d);
  const { wheels, tyreMat, discMat, rearDiscMat } = buildWheels(g, {
    axles: [
      { z: 0.54, x: 0.56, steers: true, radius: 0.13, width: 0.13 },
      { z: -0.51, x: 0.64, steers: false, radius: 0.14, width: 0.2 },
    ],
    radius: 0.13, width: 0.14, arches: false, spokes: 3,
  });
  for (const sx of [-0.28, 0.28]) g.add(box(0.035, 0.035, 1.3, metal, sx, 0.1, 0));
  g.add(box(0.95, 0.03, 0.03, metal, 0, 0.1, 0.48));
  g.add(box(1.2, 0.035, 0.035, metal, 0, 0.14, -0.51));      // rear axle
  g.add(box(0.56, 0.012, 1.0, trim, 0, 0.07, 0.02));          // floor tray
  // Bodywork: a nose cone, a front panel under the wheel and two side pods.
  g.add(box(1.0, 0.12, 0.26, paint, 0, 0.14, 0.83));
  const panel = box(0.42, 0.26, 0.06, paint, 0, 0.27, 0.36);
  panel.rotation.x = -0.35;
  g.add(panel);
  for (const s of [-1, 1]) g.add(box(0.2, 0.14, 0.7, paint, s * 0.46, 0.14, -0.05));
  g.add(box(0.4, 0.34, 0.36, Materials.plastic(0x101216), 0, 0.26, -0.22)); // seat
  g.add(box(0.2, 0.24, 0.3, metal, -0.36, 0.26, -0.32));                   // engine
  g.add(strut([-0.36, 0.3, -0.45], [-0.44, 0.34, -0.85], 0.035, Materials.chrome()));
  g.add(box(1.1, 0.06, 0.06, metal, 0, 0.16, -0.9));                        // rear bumper
  const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.018, 8, 24), trim);
  wheel.position.set(0, 0.46, 0.2);
  wheel.rotation.x = -1.0;
  g.add(wheel);

  // Driver, sitting upright and low with arms out to the wheel.
  const m = kit(spec.rider ?? 0x223a5e);
  const torso = box(0.34, 0.44, 0.22, m.suit, 0, 0.5, -0.22);
  torso.rotation.x = -0.25;
  torso.castShadow = true;
  g.add(torso);
  helmet(g, m, [0, 0.84, -0.17], 0.14);
  for (const s of [-1, 1]) {
    g.add(strut([s * 0.17, 0.64, -0.18], [s * 0.11, 0.52, 0.16], 0.04, m.suit));
    g.add(strut([s * 0.1, 0.26, -0.12], [s * 0.12, 0.2, 0.56], 0.06, m.suit));
  }
  const headMat = Materials.lens(0x222222, 0x000000, 0);
  const tailMat = Materials.lens(0x2a0505, 0xff2a2a, 0);
  const body = wrapBody(g, wheels);
  return { group: g, wheels, headMat, tailMat, tyreMat, discMat, rearDiscMat, body };
}

// --- utility bodies ------------------------------------------------------------------
// Tall, boxy vehicles are lofted too, only with square sections, and their
// glass is set into the body as panes rather than blown over it as a canopy.
function pane(w, h, material, x, y, z, ry = 0, rx = 0) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), material);
  mesh.position.set(x, y, z);
  mesh.rotation.set(rx, ry, 0);
  return mesh;
}

function lamps(g, headMat, tailMat, width, headY, tailY, front, rear) {
  const geo = new THREE.BoxGeometry(width * 0.16, 0.14, 0.06);
  for (const s of [-1, 1]) {
    const head = new THREE.Mesh(geo, headMat);
    head.position.set(s * width * 0.36, headY, front);
    const tail = new THREE.Mesh(geo, tailMat);
    tail.position.set(s * width * 0.4, tailY, rear);
    g.add(head, tail);
  }
}

// Paint for a utility body in the loft's coordinates: the body colour with a
// band at waist height down both flanks (u = 0 and 0.5 are the flanks).
function bandTexture(color, accent) {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const c = canvas.getContext('2d');
  c.fillStyle = `#${new THREE.Color(color).getHexString()}`;
  c.fillRect(0, 0, size, size);
  c.fillStyle = `#${new THREE.Color(accent).getHexString()}`;
  for (const at of [0, 0.5, 1]) c.fillRect((at - 0.035) * size, 0, 0.07 * size, size);
  c.fillStyle = '#15181d';
  c.fillRect(0.7 * size, 0, 0.1 * size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function buildUtility(color, b, spec) {
  const g = new THREE.Group();
  const kind = spec.class;
  const trim = Materials.trim();
  const glass = Materials.glass(0x0f1b27, 0.8);
  const headMat = Materials.lens(0xfff6e0, 0xfff0d0, 2.2);
  const tailMat = Materials.lens(0x2a0505, 0xff2a2a, 1.6);
  const hw = b.width / 2;
  const L = b.length;
  let axles, radius, width;

  if (kind === 'suv') {
    const paint = Materials.carPaint({ color });
    g.add(new THREE.Mesh(profileLoft({
      length: L,
      beam: [[0, hw * 0.82], [0.1, hw * 0.98], [0.5, hw], [0.9, hw * 0.98], [1, hw * 0.86]],
      bottom: [[0, 0.46], [0.1, 0.36], [0.9, 0.36], [1, 0.48]],
      top: [[0, 0.9], [0.12, 1.02], [0.3, 1.08], [0.86, 1.1], [1, 1.04]],
      sharpness: 3.4,
    }), paint));
    const house = new THREE.Mesh(profileLoft({
      length: L * 0.66,
      beam: [[0, hw * 0.84], [0.5, hw * 0.9], [1, hw * 0.86]],
      bottom: [[0, 1.04], [1, 1.06]],
      top: [[0, 1.12], [0.18, 1.64], [0.9, 1.7], [1, 1.52]],
      sharpness: 3, stations: 18,
    }), glass);
    house.position.z = -L * 0.08;
    g.add(house);
    g.add(box(b.width * 0.86, 0.05, L * 0.5, paint, 0, 1.71, -L * 0.1));      // roof panel
    for (const s of [-1, 1]) g.add(box(0.04, 0.05, L * 0.46, Materials.brushedMetal(), s * hw * 0.72, 1.77, -L * 0.1));
    g.add(box(b.width * 0.5, 0.2, 0.08, trim, 0, 0.72, L * 0.5));              // grille
    lamps(g, headMat, tailMat, b.width, 0.9, 1.0, L * 0.49, -L * 0.49);
    radius = 0.38; width = 0.28;
    axles = [{ z: L * 0.31, x: hw - 0.2, steers: true }, { z: -L * 0.3, x: hw - 0.2 }];
  } else if (kind === 'van') {
    const paint = Materials.paintedMetal(color);
    g.add(new THREE.Mesh(profileLoft({
      length: L,
      beam: [[0, hw * 0.86], [0.1, hw * 0.98], [1, hw]],
      bottom: [[0, 0.42], [0.08, 0.34], [0.95, 0.34], [1, 0.42]],
      top: [[0, 0.98], [0.08, 1.22], [0.18, 2.2], [0.26, 2.34], [1, 2.36]],
      sharpness: 4.6,
    }), paint));
    g.add(pane(b.width * 0.86, 0.86, glass, 0, 1.72, L * 0.39, 0, -0.62));     // windscreen
    for (const s of [-1, 1]) g.add(pane(0.8, 0.6, glass, s * (hw + 0.005), 1.75, L * 0.22, s * Math.PI / 2));
    g.add(box(b.width * 0.6, 0.22, 0.06, trim, 0, 0.7, L * 0.5));
    lamps(g, headMat, tailMat, b.width, 0.95, 1.1, L * 0.495, -L * 0.5);
    radius = 0.36; width = 0.24;
    axles = [{ z: L * 0.33, x: hw - 0.2, steers: true }, { z: -L * 0.31, x: hw - 0.2 }];
  } else if (kind === 'bus') {
    const paint = Materials.paintedMetal(0xffffff);
    paint.map = bandTexture(color, 0xf0f2f5);
    g.add(new THREE.Mesh(profileLoft({
      length: L,
      beam: [[0, hw * 0.97], [0.03, hw], [0.97, hw], [1, hw * 0.97]],
      bottom: [[0, 0.36], [1, 0.36]],
      top: [[0, 2.9], [0.02, 3.05], [0.98, 3.05], [1, 2.95]],
      sharpness: 6, stations: 24,
    }), paint));
    // Windows down both sides, a deep windscreen, doors on the kerb side
    // (the driver's right, which is -x here).
    for (const s of [-1, 1]) g.add(pane(L * 0.84, 1.18, glass, s * (hw + 0.006), 2.02, -L * 0.03, s * Math.PI / 2));
    g.add(pane(b.width * 0.92, 1.7, glass, 0, 1.95, L * 0.5 + 0.006));
    g.add(pane(b.width * 0.8, 0.9, glass, 0, 2.2, -L * 0.5 - 0.006, Math.PI));
    for (const z of [L * 0.4, -L * 0.02]) g.add(pane(1.1, 2.3, Materials.glass(0x0a1016, 0.9), -hw - 0.012, 1.5, z, -Math.PI / 2));
    const sign = Materials.lens(0x201a05, 0xffb31a, 1.6);
    g.add(pane(b.width * 0.7, 0.26, sign, 0, 2.86, L * 0.5 + 0.01));
    lamps(g, headMat, tailMat, b.width, 0.75, 0.9, L * 0.5 + 0.02, -L * 0.5 - 0.02);
    radius = 0.5; width = 0.3;
    axles = [{ z: L * 0.5 - 2.65, x: hw - 0.26, steers: true }, { z: L * 0.5 - 8.6, x: hw - 0.36, dual: true }];
  } else {
    // Tractor unit: a tall cab over the front axle, then bare chassis rails,
    // a fifth-wheel plate and two driven axles under it.
    const paint = Materials.paintedMetal(color, 0.38);
    const cabLen = 2.35;
    const cab = new THREE.Mesh(profileLoft({
      length: cabLen,
      beam: [[0, hw * 0.95], [0.08, hw], [1, hw]],
      bottom: [[0, 0.62], [1, 0.62]],
      top: [[0, 2.7], [0.12, 3.05], [1, 3.1]],
      sharpness: 5, stations: 14,
    }), paint);
    cab.position.z = L * 0.5 - cabLen / 2;
    g.add(cab);
    g.add(pane(b.width * 0.9, 1.0, glass, 0, 2.3, L * 0.5 + 0.02, 0, -0.08));
    for (const s of [-1, 1]) g.add(pane(0.8, 0.7, glass, s * (hw + 0.006), 2.35, L * 0.5 - 0.5, s * Math.PI / 2));
    g.add(box(b.width * 0.8, 0.5, 0.1, Materials.chrome(), 0, 1.1, L * 0.5 + 0.03)); // grille
    const rail = Materials.brushedMetal(0x2a2f36);
    for (const s of [-1, 1]) g.add(box(0.12, 0.3, L - 0.6, rail, s * 0.46, 0.78, -0.3));
    g.add(box(1.5, 0.12, 1.3, rail, 0, 1.08, -L * 0.5 + 1.85));      // fifth wheel
    for (const s of [-1, 1]) {
      const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 1.1, 18), Materials.brushedMetal(0xb9c0c8));
      tank.rotation.x = Math.PI / 2;
      tank.position.set(s * (hw - 0.3), 0.72, L * 0.5 - cabLen - 0.6);
      g.add(tank);
      g.add(strut([s * (hw - 0.25), 1.4, L * 0.5 - cabLen - 0.1], [s * (hw - 0.25), 3.6, L * 0.5 - cabLen - 0.1], 0.07, Materials.chrome()));
    }
    for (const z of [-L * 0.5 + 2.55, -L * 0.5 + 1.25]) g.add(box(b.width, 0.06, 0.9, trim, 0, 1.1, z));
    lamps(g, headMat, tailMat, b.width, 0.9, 1.0, L * 0.5 + 0.04, -L * 0.5);
    radius = 0.52; width = 0.32;
    axles = [
      { z: L * 0.5 - 1.1, x: hw - 0.28, steers: true },
      { z: -L * 0.5 + 2.55, x: hw - 0.4, dual: true },
      { z: -L * 0.5 + 1.25, x: hw - 0.4, dual: true },
    ];
  }

  for (const child of g.children) child.castShadow = !child.material?.transparent;
  // The vehicle's origin is its centre of mass, which is where the physics
  // puts the axles from. Slide the body so the front axle lands there; the
  // collision hull follows the same offset.
  const shift = (CLASSES[kind]?.physics.frontAxle ?? axles[0].z) - axles[0].z;
  for (const child of g.children) child.position.z += shift;
  for (const axle of axles) axle.z += shift;
  const { wheels, tyreMat, discMat, rearDiscMat } = buildWheels(g, { axles, radius, width });
  const body = wrapBody(g, wheels);
  return { group: g, wheels, headMat, tailMat, tyreMat, discMat, rearDiscMat, body, centerZ: shift };
}
