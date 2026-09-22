import * as THREE from 'three';
import { treadMaps } from './textures.js';
import { CAR, PALETTE, CHASSIS, BOOST, PIT, ROAD_SURFACE } from './config.js';
import { TyreSet } from './tyres.js';

// A chassis only ever scales the shared baseline, so every variant stays on the
// same handling model and no one of them needs its own physics path.
function tuneFor(chassis) {
  const d = chassis.drive;
  return {
    ...CAR,
    mass: CAR.mass * d.mass,
    enginePower: CAR.enginePower * d.power,
    brakePower: CAR.brakePower * d.brake,
    gripLat: CAR.gripLat * d.grip,
    maxSteer: CAR.maxSteer * d.steer,
    halfWidth: chassis.body.width / 2,
    // A bigger wing is more downforce, so the aero cars are the ones that keep
    // turning when everything else has run out of corner.
    downforce: CAR.downforce * (0.55 + chassis.body.wing * 0.6) * d.grip,
  };
}

const UP = new THREE.Vector3(0, 1, 0);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// Lateral force from one axle at a given slip angle. Rising, peaking, then
// falling away: that shape is what makes a car turn in, hold, and then let go
// progressively instead of switching between gripping and spinning.
function tyreForce(slip, maxForce, tune) {
  return -maxForce * Math.sin(tune.tyreC * Math.atan(tune.tyreB * slip));
}

// A car body is a surface, not a box. Each class is described by three curves
// running front to rear — the beltline, the sill, and how wide the car is —
// and the shell is lofted through superelliptical cross-sections along them.
// That is what gives a nose that narrows, haunches that bulge over the rear
// wheels, and a tail that tapers, instead of a slab with a profile cut in it.
//
// u runs 0 at the nose to 1 at the tail. Heights are metres above the sill
// reference; beam is a fraction of the car's half width.

// The road ribbon is drawn a few centimetres proud of the centreline, and the
// wheels have to stand on that, not on the centreline itself.

const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);

function curveAt(points, u) {
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

// Each entry: belt (top of the bodywork), sill (bottom), beam (half width),
// roof (the glasshouse, over the cabin only), and where the cabin sits.
const SHAPES = {
  gt: {
    cabin: [0.34, 0.72],
    belt: [[0, 0.30], [0.10, 0.44], [0.34, 0.52], [0.70, 0.54], [0.88, 0.50], [1, 0.40]],
    sill: [[0, 0.16], [0.12, 0.02], [0.85, 0.02], [1, 0.18]],
    beam: [[0, 0.62], [0.13, 0.93], [0.34, 0.99], [0.66, 1], [0.88, 0.95], [1, 0.70]],
    roof: [[0.34, 0.06], [0.46, 0.96], [0.62, 1], [0.72, 0.10]],
  },
  mid: {
    cabin: [0.20, 0.52],
    belt: [[0, 0.16], [0.08, 0.30], [0.22, 0.40], [0.52, 0.48], [0.80, 0.50], [1, 0.36]],
    sill: [[0, 0.12], [0.10, 0.00], [0.88, 0.00], [1, 0.14]],
    beam: [[0, 0.58], [0.12, 0.90], [0.30, 0.97], [0.62, 1], [0.86, 0.96], [1, 0.72]],
    roof: [[0.20, 0.05], [0.30, 0.92], [0.44, 0.96], [0.52, 0.14]],
  },
  rear: {
    cabin: [0.26, 0.58],
    belt: [[0, 0.20], [0.09, 0.34], [0.26, 0.44], [0.62, 0.50], [0.86, 0.46], [1, 0.34]],
    sill: [[0, 0.14], [0.11, 0.01], [0.86, 0.01], [1, 0.16]],
    beam: [[0, 0.56], [0.12, 0.88], [0.32, 0.96], [0.68, 1], [0.88, 0.93], [1, 0.66]],
    roof: [[0.26, 0.06], [0.36, 0.95], [0.48, 0.98], [0.58, 0.28]],
  },
  rally: {
    cabin: [0.30, 0.80],
    belt: [[0, 0.30], [0.10, 0.48], [0.30, 0.56], [0.78, 0.58], [0.92, 0.54], [1, 0.42]],
    sill: [[0, 0.20], [0.10, 0.04], [0.88, 0.04], [1, 0.22]],
    beam: [[0, 0.68], [0.12, 0.95], [0.30, 1], [0.72, 1], [0.90, 0.96], [1, 0.76]],
    roof: [[0.30, 0.10], [0.40, 0.97], [0.74, 1], [0.80, 0.62]],
  },
  muscle: {
    cabin: [0.42, 0.76],
    belt: [[0, 0.28], [0.09, 0.46], [0.42, 0.52], [0.72, 0.52], [0.90, 0.48], [1, 0.38]],
    sill: [[0, 0.18], [0.11, 0.02], [0.86, 0.02], [1, 0.20]],
    beam: [[0, 0.64], [0.12, 0.94], [0.40, 0.98], [0.70, 1], [0.90, 0.94], [1, 0.72]],
    roof: [[0.42, 0.08], [0.52, 0.94], [0.62, 0.96], [0.76, 0.22]],
  },
  hyper: {
    cabin: [0.24, 0.54],
    belt: [[0, 0.12], [0.07, 0.26], [0.24, 0.36], [0.56, 0.44], [0.82, 0.46], [1, 0.32]],
    sill: [[0, 0.10], [0.09, 0.00], [0.90, 0.00], [1, 0.12]],
    beam: [[0, 0.54], [0.11, 0.92], [0.28, 1], [0.66, 1], [0.88, 0.96], [1, 0.68]],
    roof: [[0.24, 0.05], [0.34, 0.92], [0.46, 0.95], [0.54, 0.12]],
  },
  proto: {
    cabin: [0.30, 0.60],
    belt: [[0, 0.10], [0.06, 0.24], [0.26, 0.34], [0.60, 0.40], [0.86, 0.42], [1, 0.30]],
    sill: [[0, 0.08], [0.08, 0.00], [0.92, 0.00], [1, 0.10]],
    beam: [[0, 0.52], [0.10, 0.92], [0.30, 1], [0.70, 1], [0.90, 0.94], [1, 0.62]],
    roof: [[0.30, 0.04], [0.40, 0.90], [0.52, 0.92], [0.60, 0.10]],
  },
};

// Superellipse: flat-ish flanks and roof with rounded shoulders, which is the
// cross-section a car body actually has.
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

// Loft a closed tube through stations along the car and cap both ends.
function loft(stations, segments) {
  const position = [];
  const uv = [];
  const index = [];
  stations.forEach((st, i) => {
    const ring = ringPoints(st.halfWidth, st.bottom, st.top, segments, st.sharpness ?? 2.7);
    for (let k = 0; k < segments; k++) {
      position.push(ring[k * 2], ring[k * 2 + 1], st.z);
      // u runs around the section (0 flank, 0.25 roof, 0.5 other flank,
      // 0.75 floor); v runs nose to tail. That is enough to paint a car.
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
  // Caps: a fan to the centre of the first and last ring.
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
  geo.setIndex(index);
  geo.computeVertexNormals();
  return geo;
}

// Height of the beltline — the top of the bodywork — above the car's ground
// plane. BELT_RISE lifts the whole body relative to the wheels; without it a
// car reads as a slab with big wheels bolted to it.
const BELT_RISE = 1.12;

function beltHeight(b, shape, u) {
  return b.ride - 0.30 + curveAt(shape.belt, u) * BELT_RISE + b.roof * 0.18;
}

// The paint itself: body colour, a dark roof and spine, dark rockers along the
// bottom, and accent stripes over the spine. Painted in the loft's own
// coordinates, so it lands correctly on any body shape.
function paintTexture(color, scheme) {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const c = canvas.getContext('2d');
  const base = new THREE.Color(color);
  const carbon = '#14171d';

  c.fillStyle = `#${base.getHexString()}`;
  c.fillRect(0, 0, size, size);

  const band = (from, to, style) => {
    c.fillStyle = style;
    c.fillRect(from * size, 0, (to - from) * size, size);
  };

  // u: 0 flank | 0.25 roof | 0.5 flank | 0.75 floor
  if (scheme !== 'plain') {
    band(0.19, 0.31, carbon);
    band(0.66, 0.86, '#0d1014');
  }
  if (scheme === 'stripes' || scheme === 'hyper') {
    const accent = base.clone().offsetHSL(0, 0.06, 0.16);
    c.fillStyle = `#${accent.getHexString()}`;
    c.fillRect(0.224 * size, 0, 0.013 * size, size);
    c.fillRect(0.263 * size, 0, 0.013 * size, size);
  }
  if (scheme === 'hyper') {
    c.fillStyle = carbon;
    for (const at of [0.055, 0.435]) {
      c.save();
      c.translate(at * size, 0);
      c.rotate(0.05);
      c.fillRect(0, 0.36 * size, 0.05 * size, size);
      c.restore();
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function shellGeometry(b, shape) {
  const STATIONS = 40, SEGMENTS = 20;
  const stations = [];
  for (let i = 0; i < STATIONS; i++) {
    const u = i / (STATIONS - 1);
    stations.push({
      z: (0.5 - u) * b.length,
      halfWidth: (b.width / 2) * curveAt(shape.beam, u),
      bottom: b.ride - 0.30 + curveAt(shape.sill, u),
      top: beltHeight(b, shape, u),
      sharpness: 2.7,
    });
  }
  return loft(stations, SEGMENTS);
}

function glassGeometry(b, shape) {
  const [from, to] = shape.cabin;
  const STATIONS = 22, SEGMENTS = 16;
  const stations = [];
  for (let i = 0; i < STATIONS; i++) {
    const k = i / (STATIONS - 1);
    const u = lerp(from, to, k);
    const height = curveAt(shape.roof, u);          // 0 at the pillars, 1 at the roof
    const belt = beltHeight(b, shape, u);
    stations.push({
      z: (0.5 - u) * b.length,
      halfWidth: (b.width / 2) * curveAt(shape.beam, u) * (0.80 + height * 0.06),
      bottom: belt - 0.05,
      // A glasshouse is shallow. Adding the full roof figure on top of an
      // already-raised beltline is what turns a coupe into a van.
      top: belt + 0.02 + height * (b.roof * 0.66 + 0.06),
      sharpness: 2.2,
    });
  }
  return loft(stations, SEGMENTS);
}

// An original marque badge and race number, drawn to a canvas. No real-world
// marks: these cars are their own.
function liveryTexture(chassis) {
  const w = 512, h = 256;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const c = canvas.getContext('2d');
  c.clearRect(0, 0, w, h);

  const number = { gt: '7', mid: '12', rear: '9', rally: '4', muscle: '28', proto: '1' }[chassis.shape] ?? '5';
  c.fillStyle = 'rgba(248,250,253,0.96)';
  c.beginPath();
  c.arc(150, 128, 86, 0, Math.PI * 2);
  c.fill();
  c.strokeStyle = 'rgba(12,16,22,0.85)';
  c.lineWidth = 7;
  c.stroke();

  c.fillStyle = '#12161d';
  c.font = '700 116px system-ui, sans-serif';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(number, 150, 134);

  const word = chassis.name.split(' ')[0].toUpperCase();
  c.fillStyle = 'rgba(248,250,253,0.92)';
  c.font = '800 46px system-ui, sans-serif';
  c.textAlign = 'left';
  c.fillText(word, 268, 112);
  c.fillStyle = 'rgba(248,250,253,0.55)';
  c.font = '600 22px system-ui, sans-serif';
  c.fillText('APEX SERIES', 270, 158);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function buildBody(color, body, chassis = null) {
  const b = body ?? CHASSIS.gt.body;
  const spec = chassis ?? CHASSIS.gt;
  const shape = SHAPES[b.shape ?? spec.shape] ?? SHAPES.gt;
  const g = new THREE.Group();

  // Automotive paint: a metallic base under a clear coat.
  const paint = new THREE.MeshPhysicalMaterial({
    map: paintTexture(color, spec.scheme ?? 'stripes'),
    metalness: 0.7, roughness: 0.26,
    clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 1.35,
  });
  // Wings and spoilers are bare carbon, not painted panels.
  const carbonMat = new THREE.MeshPhysicalMaterial({
    color: 0x16191f, metalness: 0.5, roughness: 0.34,
    clearcoat: 0.8, clearcoatRoughness: 0.2, envMapIntensity: 1.1,
  });
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x0e1a26, metalness: 0.2, roughness: 0.03,
    transparent: true, opacity: 0.72, envMapIntensity: 1.7,
  });
  const trim = new THREE.MeshStandardMaterial({
    color: 0x12161d, roughness: 0.58, metalness: 0.4,
  });
  const chrome = new THREE.MeshStandardMaterial({
    color: 0xadb7c4, metalness: 1, roughness: 0.13, envMapIntensity: 1.7,
  });

  const shell = new THREE.Mesh(shellGeometry(b, shape), paint);
  shell.castShadow = true;
  shell.receiveShadow = true;
  g.add(shell);

  const greenhouse = new THREE.Mesh(glassGeometry(b, shape), glass);
  g.add(greenhouse);

  const hw = b.width / 2;
  const beltAt = (u) => beltHeight(b, shape, u);
  const zAt = (u) => (0.5 - u) * b.length;

  // Door livery: a flat decal just proud of the flank, where the body is
  // closest to flat.
  const doorU = (shape.cabin[0] + shape.cabin[1]) / 2;
  const decalTex = liveryTexture(spec);
  const decalMat = new THREE.MeshStandardMaterial({
    map: decalTex, transparent: true, roughness: 0.35, metalness: 0.1,
    polygonOffset: true, polygonOffsetFactor: -2,
  });
  const decalGeo = new THREE.PlaneGeometry(b.length * 0.34, b.length * 0.17);
  for (const side of [-1, 1]) {
    const decal = new THREE.Mesh(decalGeo, decalMat);
    decal.position.set(side * (hw * curveAt(shape.beam, doorU) + 0.012),
      beltAt(doorU) - 0.22, zAt(doorU));
    decal.rotation.y = side > 0 ? Math.PI / 2 : -Math.PI / 2;
    g.add(decal);
  }

  // Lower bodywork, grille, exhausts.
  const sill = new THREE.Mesh(
    new THREE.BoxGeometry(b.width * 0.99, 0.13, b.length * 0.54), trim);
  sill.position.set(0, b.ride - 0.26, 0);
  g.add(sill);
  const splitter = new THREE.Mesh(
    new THREE.BoxGeometry(b.width * 0.96, 0.06, 0.46), trim);
  splitter.position.set(0, b.ride - 0.30, b.length * 0.45);
  g.add(splitter);
  const diffuser = new THREE.Mesh(
    new THREE.BoxGeometry(b.width * 0.86, 0.2, 0.4), trim);
  diffuser.position.set(0, b.ride - 0.22, -b.length * 0.45);
  g.add(diffuser);
  const grille = new THREE.Mesh(
    new THREE.BoxGeometry(b.width * 0.46, 0.14, 0.1), trim);
  grille.position.set(0, beltAt(0) - 0.16, b.length * 0.485);
  g.add(grille);
  for (const sx of [-0.32, 0.32]) {
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.085, 0.18, 10), chrome);
    pipe.rotation.x = Math.PI / 2;
    pipe.position.set(sx, b.ride - 0.22, -b.length * 0.49);
    g.add(pipe);
  }
  for (const sx of [-1, 1]) {
    const mirror = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.09, 0.24), trim);
    mirror.position.set(sx * (hw * 0.96 + 0.1), beltAt(shape.cabin[0]) + 0.04,
      zAt(shape.cabin[0] + 0.03));
    g.add(mirror);
  }

  // Detailing that belongs to one class and not the others.
  const detail = b.shape ?? spec.shape;
  if (detail === 'mid' || detail === 'rear' || detail === 'proto') {
    for (const side of [-1, 1]) {
      const intake = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.2, b.length * 0.16), trim);
      intake.position.set(side * (hw * 0.96), beltAt(0.62) - 0.2, zAt(0.63));
      g.add(intake);
    }
  }
  if (detail === 'muscle') {
    const scoop = new THREE.Mesh(new THREE.BoxGeometry(b.width * 0.34, 0.1, b.length * 0.14), trim);
    scoop.position.set(0, beltAt(0.22) + 0.06, zAt(0.24));
    g.add(scoop);
  }
  if (detail === 'rally') {
    const spoiler = new THREE.Mesh(new THREE.BoxGeometry(b.width * 0.92, 0.07, 0.3), carbonMat);
    spoiler.position.set(0, beltAt(0.80) + b.roof + 0.24, zAt(0.82));
    g.add(spoiler);
  }
  if (detail === 'hyper') {
    // Twin-plane rear wing on tall swan-neck stays, plus front canards.
    const span = b.width * 1.06;
    for (const [lift, chord, tilt] of [[0.52, b.wing * 0.4, -0.16], [0.74, b.wing * 0.3, -0.28]]) {
      const plane = new THREE.Mesh(new THREE.BoxGeometry(span, 0.05, chord), carbonMat);
      plane.position.set(0, beltAt(0.95) + lift, zAt(0.97));
      plane.rotation.x = tilt;
      g.add(plane);
    }
    for (const sx of [-span * 0.38, span * 0.38]) {
      const stay = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.8, 0.12), carbonMat);
      stay.position.set(sx, beltAt(0.95) + 0.4, zAt(0.95));
      g.add(stay);
    }
    for (const side of [-1, 1]) {
      for (const [lift, len] of [[0.02, 0.3], [0.14, 0.24]]) {
        const canard = new THREE.Mesh(new THREE.BoxGeometry(len, 0.03, 0.26), carbonMat);
        canard.position.set(side * (hw * 0.82), beltAt(0.05) - 0.18 + lift, zAt(0.07));
        canard.rotation.z = side * 0.2;
        g.add(canard);
      }
    }
  }
  if (detail === 'proto') {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.3, b.length * 0.3), carbonMat);
    fin.position.set(0, beltAt(0.72) + 0.2, zAt(0.74));
    g.add(fin);
  }

  // Rear wing, sized by the class.
  if (b.wing > 0.2) {
    const span = b.width * (detail === 'proto' ? 1.05 : 0.94);
    const wing = new THREE.Mesh(new THREE.BoxGeometry(span, 0.06, b.wing * 0.55), carbonMat);
    const wingY = beltAt(0.95) + (detail === 'proto' ? 0.46 : 0.2);
    wing.position.set(0, wingY, zAt(0.96));
    wing.rotation.x = -0.14;
    g.add(wing);
    for (const sx of [-span * 0.34, span * 0.34]) {
      const stay = new THREE.Mesh(new THREE.BoxGeometry(0.06, wingY - beltAt(0.9), 0.09), trim);
      stay.position.set(sx, (wingY + beltAt(0.9)) / 2, zAt(0.95));
      g.add(stay);
    }
  }

  const headMat = new THREE.MeshStandardMaterial({
    color: 0xfff6e0, emissive: 0xfff0d0, emissiveIntensity: 2.2,
    metalness: 0.2, roughness: 0.14,
  });
  const tailMat = new THREE.MeshStandardMaterial({
    color: 0x2a0505, emissive: 0xff2a2a, emissiveIntensity: 1.6,
    metalness: 0.2, roughness: 0.2,
  });
  const lampGeo = new THREE.BoxGeometry(b.width * 0.19, 0.11, 0.08);
  for (const sx of [-b.width * 0.3, b.width * 0.3]) {
    const head = new THREE.Mesh(lampGeo, headMat);
    head.position.set(sx, beltAt(0.03) - 0.04, b.length * 0.478);
    g.add(head);
    const tail = new THREE.Mesh(lampGeo, tailMat);
    tail.position.set(sx, beltAt(0.97) - 0.02, -b.length * 0.482);
    g.add(tail);
  }

  // Wheels tuck just inside the haunches, with a dark liner behind each.
  const radius = 0.29 + b.ride * 0.11;
  const width = b.width * 0.18;
  const tyreGeo = new THREE.CylinderGeometry(radius, radius, width, 22);
  tyreGeo.rotateZ(Math.PI / 2);
  const rimGeo = new THREE.CylinderGeometry(radius * 0.66, radius * 0.66, width * 1.04, 16);
  rimGeo.rotateZ(Math.PI / 2);
  const spokeGeo = new THREE.BoxGeometry(width * 1.06, radius * 1.16, 0.045);
  const archGeo = new THREE.CylinderGeometry(radius * 1.16, radius * 1.16, width * 1.02, 18, 1, true);
  archGeo.rotateZ(Math.PI / 2);

  // A coloured sidewall band: which compound is on the car should be readable
  // from the chase camera, not only from the HUD.
  const wallGeo = new THREE.CylinderGeometry(radius * 0.88, radius * 0.88, width * 1.06, 20, 1, true);
  wallGeo.rotateZ(Math.PI / 2);
  const tyreMat = new THREE.MeshStandardMaterial({
    color: 0xffc94d, emissive: 0xffc94d, emissiveIntensity: 0.55,
    roughness: 0.7, side: THREE.DoubleSide,
  });

  // Rubber with tread: the pattern is cut into the carcass rather than
  // painted on, so a turning wheel reads as a tyre and not as a cylinder.
  const tread = treadMaps();
  const rubber = new THREE.MeshStandardMaterial({
    color: 0x24272d, roughness: 0.93, metalness: 0,
    map: tread.map, normalMap: tread.normalMap,
    normalScale: new THREE.Vector2(0.9, 0.9),
  });
  const rimMat = new THREE.MeshStandardMaterial({
    color: 0xc2ccd8, metalness: 1, roughness: 0.18, envMapIntensity: 1.6,
  });
  // Discs glow when they are being used. The material belongs to this car, so
  // one car braking does not light up the whole grid.
  const discMat = new THREE.MeshStandardMaterial({
    color: 0x3b4149, metalness: 0.9, roughness: 0.45,
    emissive: 0xff3a10, emissiveIntensity: 0,
  });
  const caliperMat = new THREE.MeshStandardMaterial({
    color: 0xb4321f, metalness: 0.4, roughness: 0.5,
  });
  const archMat = new THREE.MeshStandardMaterial({ color: 0x07090c, roughness: 1, side: THREE.BackSide });

  const wheels = [];
  const frontU = 0.20, rearU = 0.78;
  for (const [u, steers] of [[frontU, true], [rearU, false]]) {
    const z = zAt(u);
    // Tuck the wheel under the haunch so the bodywork covers its top edge.
    const x = hw * curveAt(shape.beam, u) - width * 0.62;
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * x, radius, z);
      const spin = new THREE.Group();
      const tyre = new THREE.Mesh(tyreGeo, rubber);
      tyre.castShadow = true;
      spin.add(tyre, new THREE.Mesh(rimGeo, rimMat), new THREE.Mesh(wallGeo, tyreMat));
      for (let k = 0; k < 5; k++) {
        const spoke = new THREE.Mesh(spokeGeo, rimMat);
        spoke.rotation.x = (k / 5) * Math.PI;
        spin.add(spoke);
      }
      const disc = new THREE.Mesh(
        new THREE.CylinderGeometry(radius * 0.56, radius * 0.56, width * 0.3, 14), discMat);
      disc.rotation.z = Math.PI / 2;
      // Caliper clamped over the back of the disc, where one sits.
      const caliper = new THREE.Mesh(
        new THREE.BoxGeometry(width * 0.34, radius * 0.5, radius * 0.22), caliperMat);
      caliper.position.set(-side * width * 0.1, radius * 0.1, -radius * 0.42);
      pivot.add(spin, disc, caliper);
      g.add(pivot);

      const arch = new THREE.Mesh(archGeo, archMat);
      arch.position.set(side * (x - width * 0.08), radius + 0.05, z);
      g.add(arch);
      wheels.push({ pivot, spin, steers, radius });
    }
  }

  return { group: g, wheels, headMat, tailMat, tyreMat, discMat };
}

export class Car {
  constructor(track, {
    color = null, ai = false, name = 'YOU', headlights = false, chassis = CHASSIS.gt,
  } = {}) {
    this.track = track;
    this.ai = ai;
    this.name = name;
    this.chassis = chassis;
    this.tune = tuneFor(chassis);
    // Where this tyre curve peaks, in radians of slip. Derived from the curve
    // itself so the steering limit tracks any change to the tyre model.
    this.peakSlip = Math.tan(Math.PI / (2 * this.tune.tyreC)) / this.tune.tyreB;

    const built = buildBody(color ?? chassis.color, chassis.body, chassis);
    this.color = color ?? chassis.color;
    this.mesh = built.group;
    this.wheels = built.wheels;
    this.headMat = built.headMat;
    this.tailMat = built.tailMat;
    this.tyreMat = built.tyreMat;
    this.discMat = built.discMat;

    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    // Physics runs on a fixed step; the renderer draws between the last two.
    this.prevPosition = new THREE.Vector3();
    this.prevYaw = 0;
    this.yaw = 0;
    this.yawRate = 0;        // rad/s, now a state the tyres act on
    this.steer = 0;
    this.speed = 0;          // signed forward speed, m/s
    this.gear = 1;
    this.gripMul = 1;        // set from weather each frame
    this.onRoad = true;
    this.hintIndex = 0;

    this.lap = 0;
    this.nextCheckpoint = 0;
    this.progress = 0;       // laps + fraction, the sort key for standings
    this.lastLapTime = null;
    this.bestLapTime = null;
    this.lapStart = 0;
    this.finished = false;

    this.input = { throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false };
    this.aiSkill = 1;
    // The AI's own state belongs to any car that could be driven by it, not
    // only to the ones the grid happens to build: a car flagged `ai` with a
    // missing phase steers by NaN.
    this.aiPhase = 0;

    // Tyres are a consumable with a compound and a life. `wearing` is off in
    // the modes that are about a single lap, so a time trial is never decided
    // by rubber the driver cannot change.
    this.tyres = new TyreSet('medium');
    this.wearing = false;
    // A pit stop is a state the car is in, not an event: requested, in the
    // lane, being worked on, then back out.
    this.pitState = {
      want: null, inLane: false, serving: 0, stops: 0,
      served: false, done: false, fitted: false,
    };
    // What the crew fits when the car stops without a call having been made.
    this.pitChoice = 'medium';
    this.wheelspin = 0;
    this.lockup = 0;
    this.lastAx = 0;
    this.setCompound('medium');

    // A timed reserve rather than a second throttle.
    this.boost = {
      reserve: BOOST.capacity, capacity: BOOST.capacity, firing: false, cooldown: 0,
      // AI cars carry their own charges; the player's are bought with points.
      armed: ai,
    };
    // Collision body: one circle big enough to cover the shell.
    this.radius = Math.max(chassis.body.width, chassis.body.length * 0.55) * 0.5;
    this.slide = 0;   // how far past the grip limit the tyres are, for smoke

    if (headlights) {
      this.beams = [-0.6, 0.6].map((sx) => {
        const s = new THREE.SpotLight(0xfff0d8, 0, 95, Math.PI / 7, 0.45, 1.1);
        s.position.set(sx, 0.6, 2.4);
        s.target.position.set(sx * 1.6, -0.6, 26);
        this.mesh.add(s, s.target);
        return s;
      });
    }
  }

  // Fitting a set is the one place the compound changes, so the sidewall and
  // the physics can never disagree about what is on the car.
  setCompound(key) {
    this.tyres.fit(key);
    this.tyreMat?.color.setHex(this.tyres.color);
    if (this.tyreMat) this.tyreMat.emissive.setHex(this.tyres.color);
  }

  get forward() {
    return new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
  }
  get right() {
    return new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
  }
  get kmh() {
    return Math.abs(this.speed) * 3.6;
  }

  // Lateral acceleration the car can hold right now: what the tyres give on
  // their own, plus what the wings press on with at this speed.
  lateralGrip(speed = Math.abs(this.speed)) {
    const aero = this.tune.downforce * speed * speed;
    return (this.tune.gripLat + aero) * this.gripMul
      * (this.onRoad ? 1 : this.tune.offTrackGrip);
  }

  // What the road gives, multiplied by what the tyres can still take from it.
  surfaceGrip(roadGrip, wet) {
    return roadGrip * (this.wearing ? this.tyres.grip(wet) : this.tyres.spec.grip);
  }

  placeAt(slot) {
    this.position.copy(slot.position);
    this.yaw = slot.heading;
    this.velocity.set(0, 0, 0);
    this.speed = 0;
    this.steer = 0;
    this.yawRate = 0;
    this.hintIndex = this.track.project(this.position).index;
    this.prevPosition.copy(this.position);
    this.prevYaw = this.yaw;
    this.mesh.position.copy(this.position);
    this.mesh.rotation.y = this.yaw;
  }

  // `lateral` puts the car back on something other than the centreline, which
  // is how a car recovered inside the pit lane ends up in the pit lane.
  resetToTrack(clock = 0, lateral = 0) {
    const p = this.track.project(this.position, this.hintIndex);
    const f = this.track.frameAt(p.t);
    this.position.copy(f.pos).addScaledVector(f.side, lateral)
      .setY(f.pos.y + ROAD_SURFACE);
    this.yaw = Math.atan2(f.tan.x, f.tan.z);
    this.velocity.set(0, 0, 0);
    this.speed = 0;
    this.yawRate = 0;
    this.steer = 0;
    this.lapStart = clock;
  }

  setHeadlights(on, wetBoost = 0) {
    const lit = on ? 1 : 0;
    // Headlights have to light the road at night, not decorate the front of
    // the car.
    if (this.beams) for (const b of this.beams) b.intensity = on ? 280 + wetBoost * 90 : 0;
    this.headMat.emissiveIntensity = on ? 3.2 : 0.6;
  }

  // --- physics -----------------------------------------------------------
  // A bicycle model with slip-angle tyres. Steering sets a wheel angle; the
  // tyres decide what the car does about it. Yaw is something the car has, not
  // something the steering wheel writes directly, which is why it settles
  // instead of snapping.
  update(dt, roadGrip, wet = 0) {
    const i = this.input;
    const tune = this.tune;
    const grip = this.surfaceGrip(roadGrip, wet);
    this.gripMul = grip;
    this.prevPosition.copy(this.position);
    this.prevYaw = this.yaw;

    // Lock tightens with speed, and the wheel returns to centre on its own.
    const speed = Math.abs(this.speed);
    // Full lock means "as hard as this car can turn right now", not a fixed
    // wheel angle. A tyre only makes its peak force at a few degrees of slip,
    // so a fixed lock asks for six times too much angle at speed and the car
    // simply ploughs. Capping the request at the angle the grip can actually
    // use makes the same input mean the same share of the car's cornering
    // ability at 60 km/h and at 250.
    // The wheel angle a corner needs is the geometric angle for its radius
    // PLUS the slip angle the front tyre must be running to make the force.
    // Leaving the second term out asks for a fraction of the angle required;
    // leaving the first out asks for far too much at low speed.
    const gripLimit = (tune.gripLat + tune.downforce * speed * speed) * grip
      * (this.onRoad ? 1 : tune.offTrackGrip);
    const vSafe = Math.max(speed, 5);
    const geometric = (tune.wheelBase * gripLimit) / (vSafe * vSafe);
    const lock = Math.min(
      tune.maxSteer,
      Math.max(tune.minSteer, geometric + this.peakSlip * tune.steerOverrun),
    );
    // Shape the request before it becomes an angle. The tyre curve is steep
    // near the centre, so a linear input spends most of the grip in the first
    // third of the travel and the rest of it does nothing.
    const asked = Math.sign(i.steer) * Math.abs(i.steer) ** tune.steerCurve;
    const target = asked * lock;
    const rate = (i.steer === 0 ? tune.steerReturn : tune.steerRate) * dt;
    this.steer += clamp(target - this.steer, -rate, rate);

    const fwd = this.forward, right = this.right;
    let vF = this.velocity.dot(fwd);
    let vL = this.velocity.dot(right);
    let r = this.yawRate;

    // --- axle loads -------------------------------------------------------
    // Loads come first, because what the engine and the brakes are allowed to
    // do is decided by what the tyres under them can hold. Load transfer uses
    // last step's acceleration: at 120 Hz that is the same number to three
    // decimals, and it breaks the circle between force and load.
    const a = tune.frontAxle, b = tune.rearAxle, L = a + b;
    // Downforce is wheel load, not extra friction. That distinction matters:
    // aero load does not shift forward or back under acceleration, so the
    // faster the car goes the less a given weight transfer costs the front
    // axle — which is why a fast car can still turn while accelerating.
    const mu = (tune.gripLat / 9.81) * grip * (this.onRoad ? 1 : tune.offTrackGrip);
    const aeroLoad = (tune.downforce * speed * speed) * tune.mass * (9.81 / tune.gripLat);
    const weight = tune.mass * 9.81;
    const transfer = clamp(tune.mass * this.lastAx * tune.cogHeight / L,
      -weight * 0.3, weight * 0.3);
    const loadFront = Math.max(0, weight * (b / L) - transfer + aeroLoad * tune.aeroBalance);
    const loadRear = Math.max(0, weight * (a / L) + transfer + aeroLoad * (1 - tune.aeroBalance));
    const rearCap = mu * loadRear * tune.rearGripBias;
    const frontCap = mu * loadFront;

    // --- longitudinal -----------------------------------------------------
    // Constant force below the power band, constant power above it.
    const driveForce = tune.enginePower
      * Math.min(1, tune.powerBand / Math.max(Math.abs(vF), tune.powerBand));
    const demand = i.throttle > 0 ? i.throttle * driveForce * (vF < 0 ? 1.6 : 1) : 0;
    const boostDemand = this.#updateBoost(dt, i, vF);
    // The road can only push back as hard as the rear tyres can grip it.
    // Without this the car took full acceleration AND lost all its cornering
    // grip to a force the tyres were never making — which is exactly why a wet
    // circuit used to turn every corner into a slide.
    const pull = demand + boostDemand;
    const traction = Math.max(0, rearCap * 0.97);
    const drive = Math.min(pull, traction);
    this.wheelspin = pull > 1 ? Math.min(1, (pull - drive) / Math.max(1, pull)) : 0;

    // Brakes are limited the same way, by all four tyres together.
    const brakeAsked = i.brake > 0 && vF > 0.5 ? i.brake * tune.brakePower : 0;
    const brakeGrip = (frontCap + rearCap) * 0.98;
    const brakeForce = Math.min(brakeAsked, brakeGrip);
    this.lockup = brakeAsked > 1 ? Math.min(1, (brakeAsked - brakeForce) / brakeAsked) : 0;

    let force = drive - brakeForce;
    if (i.brake > 0 && vF <= 0.5) force -= i.brake * tune.enginePower * tune.reverseFactor;
    const surfaceDrag = this.onRoad ? 0 : tune.offTrackDrag;
    force -= Math.sign(vF) * (tune.rollResist + surfaceDrag) * tune.mass * 0.01;
    force -= tune.dragCoeff * vF * Math.abs(vF);
    force -= this.#pitLimiter(vF);
    const ax = force / tune.mass;
    this.lastAx = ax;

    // --- tyres ------------------------------------------------------------
    const u = Math.max(speed, 1.2);          // keep the slip angles well behaved
    const dir = vF >= 0 ? 1 : -1;
    const slipFront = Math.atan((vL + a * r) / u) - this.steer * dir;
    const slipRear = Math.atan((vL - b * r) / u);

    // A tyre has one grip budget. Whatever an axle is already spending on
    // driving or braking is not available for cornering, so hard power takes
    // grip from the rear (which rotates the car) instead of leaving the front
    // to carry a corner it no longer has the load for.
    const budget = (capacity, longitudinal) =>
      Math.sqrt(Math.max(0, capacity * capacity - longitudinal * longitudinal));
    const frontCapacity = budget(frontCap, brakeForce * 0.62);
    const rearCapacity = budget(rearCap, drive + brakeForce * 0.38);

    let forceFront = tyreForce(slipFront, frontCapacity, tune);
    let forceRear = tyreForce(slipRear, rearCapacity, tune);
    if (i.handbrake) forceRear *= tune.handbrakeGrip;

    const inertia = tune.mass * L * L * tune.inertiaFactor;
    const cos = Math.cos(this.steer);
    const latAccel = (forceFront * cos + forceRear) / tune.mass;
    // Damping opposes the rotation itself, which is what stops the yaw
    // overshooting and swinging back against the steering.
    const damping = tune.yawDamp * (1 + speed * 0.02) * r;
    const yawAccel = (a * forceFront * cos - b * forceRear) / inertia - damping;

    // Below walking pace the slip model has nothing to work with, so it hands
    // over to plain geometry. The blend keeps the handover invisible.
    const blend = clamp((speed - 0.8) / 2.4, 0, 1);
    const geometricYaw = (vF / L) * Math.tan(this.steer);
    vF += ax * dt;
    // No Coriolis term here. Velocity is kept in world space and re-projected
    // onto the car's axes at the top of every step, so the rotation of the body
    // frame is already accounted for; subtracting vF * r as well applies it
    // twice and cancels about half of the cornering force.
    vL = blend * (vL + latAccel * dt) + (1 - blend) * vL * 0.82;
    r = blend * (r + yawAccel * dt) + (1 - blend) * geometricYaw;

    this.yawRate = r;
    this.latAccel = latAccel;
    // Signed sideways velocity, in m/s. The camera and the effects both want to
    // know which way the car is sliding, not only how much.
    this.sideslip = vL;
    this.velocity.copy(fwd).multiplyScalar(vF).addScaledVector(right, vL);
    this.speed = vF;
    this.yaw += r * dt;

    // How fast the rear tyre is scrubbing sideways: the smoke and the hiss.
    this.slide = Math.abs(Math.sin(slipRear)) * speed;

    this.position.addScaledVector(this.velocity, dt);

    // Stick to the road surface and bounce off the barriers.
    const p = this.track.project(this.position, this.hintIndex);
    this.hintIndex = p.index;
    // The pit lane is sealed surface too, so a car in it is on the road.
    this.onRoad = this.track.drivable(p.t, p.lateral);

    // Stop the body at the barrier face, not at its centreline, so the car
    // never visually sinks into the wall it is resting against. Over the pit
    // lane the wall on that side is the far side of the lane.
    const wallAt = this.track.wallLimit(p.t, Math.sign(p.lateral) || 1) - tune.halfWidth;
    if (Math.abs(p.lateral) > wallAt) {
      const over = Math.abs(p.lateral) - wallAt;
      this.position.addScaledVector(p.side, -Math.sign(p.lateral) * over);
      const intoWall = this.velocity.dot(p.side) * Math.sign(p.lateral);
      if (intoWall > 0) {
        this.velocity.addScaledVector(p.side, -Math.sign(p.lateral) * intoWall * 1.5);
        this.speed = this.velocity.dot(this.forward);
        this.yawRate *= 0.5;
      }
    }
    this.position.y += (p.height + ROAD_SURFACE - this.position.y) * Math.min(1, dt * 12);

    this.#syncMesh(dt, vF, vL);
    this.#trackProgress(p);
    this.#updatePit(dt, p);
    if (this.wearing) {
      this.tyres.wear(dt, {
        lateral: this.latAccel,
        limit: this.lateralGrip(speed),
        // Spinning wheels and locked wheels take rubber off faster than
        // cornering does; that is why a clumsy driver stops sooner.
        slide: this.slide + this.wheelspin * 7,
        locked: this.lockup,
        abrasive: this.track.spec.surface === 'dirt' ? 1.7 : 1,
        wetness: wet,
      });
    }
  }

  // Ask for a stop. The car takes it the next time it is in the box, stopped.
  requestPit(compound) {
    this.pitState.want = compound;
  }

  cancelPit() {
    this.pitState.want = null;
    this.pitState.serving = 0;
    this.pitState.done = false;
  }

  get inPitLane() { return this.pitState.inLane; }
  get pitProgress() {
    return this.pitState.want ? Math.min(1, this.pitState.serving / PIT.service) : 0;
  }

  consumePitFlag() {
    const f = this.pitState.served;
    this.pitState.served = false;
    return f;
  }

  // Being worked on is a state, not an event: stopped on the box with a set
  // called for, held there until the crew is done.
  #updatePit(dt, p) {
    const st = this.pitState;
    st.inLane = this.track.inPitLane(p.t, p.lateral);
    // One service per visit. Leaving the lane is what arms the next one, or a
    // car that stayed parked on the box would be re-shod every few seconds.
    if (!st.inLane) { st.serving = 0; st.done = false; return; }
    // Stopping on the box is the call. A driver who takes the lane and pulls up
    // gets serviced whether or not they told the pit wall first, which is what
    // taking the lane means.
    if (!st.done && this.wearing
        && this.track.inPitBox(p.t, p.lateral) && Math.abs(this.speed) < 1.2) {
      st.serving += dt;
      this.velocity.set(0, 0, 0);
      this.speed = 0;
      this.yawRate = 0;
      // The wheels are on well before the car comes off the jacks, so the set
      // is fitted at the point the crew actually fits it. Grip changing while
      // the car is held still costs nothing and keeps rubber and colour in step.
      if (!st.fitted && st.serving >= PIT.service * 0.55) {
        this.setCompound(st.want ?? this.pitChoice ?? this.tyres.compound);
        st.fitted = true;
      }
      if (st.serving >= PIT.service) {
        st.want = null;
        st.serving = 0;
        st.fitted = false;
        st.stops += 1;
        st.served = true;
        st.done = true;
      }
    } else if (Math.abs(this.speed) > 2) {
      st.serving = 0;
      st.fitted = false;
    }
  }

  // The driver hands the car to the lane: the same line the AI takes, so there
  // is one description of how a car gets from the entry to the box.
  pitLaneInput(p, len) {
    this.#drivePitLane(p, len);
    return this.input;
  }

  // The lane has a speed limit, and a limiter is what holds a car to it.
  #pitLimiter(vF) {
    if (!this.pitState.inLane) return 0;
    const over = Math.abs(vF) - PIT.limit;
    if (over <= 0) return 0;
    return Math.sign(vF) * Math.min(1, over / 3) * this.tune.mass * 7.5;
  }

  // Draw the car between the last two physics states. Everything that is not
  // position or heading can be written straight out: it is already smooth.
  render(alpha) {
    this.mesh.position.lerpVectors(this.prevPosition, this.position, alpha);
    // The jacks are the crew's business, not the physics': the body is drawn
    // lifted, while the car the simulation knows about stays on the ground.
    this.mesh.position.y += this.pitLift ?? 0;
    const d = Math.atan2(
      Math.sin(this.yaw - this.prevYaw), Math.cos(this.yaw - this.prevYaw),
    );
    this.mesh.rotation.y = this.prevYaw + d * alpha;
  }

  get renderPosition() { return this.mesh.position; }
  get renderYaw() { return this.mesh.rotation.y; }
  // Across the car as it is drawn, which is what a tyre mark is laid along.
  get renderRight() {
    const y = this.mesh.rotation.y;
    return new THREE.Vector3(Math.cos(y), 0, -Math.sin(y));
  }
  get renderForward() {
    const y = this.mesh.rotation.y;
    return new THREE.Vector3(Math.sin(y), 0, Math.cos(y));
  }

  dispose(scene) {
    scene.remove(this.mesh);
    this.mesh.traverse((node) => {
      node.geometry?.dispose();
      const m = node.material;
      if (Array.isArray(m)) m.forEach((x) => x.dispose());
      else m?.dispose();
    });
  }

  #syncMesh(dt, vF, vL) {
    // Body roll and pitch read the forces without needing a physics engine.
    const roll = clamp((this.latAccel ?? 0) * 0.011, -0.13, 0.13);
    const pitch = clamp(-this.input.throttle * 0.02 + this.input.brake * 0.035, -0.06, 0.06);
    // Ease toward the target so a sudden input never snaps the body.
    const k = Math.min(1, dt * 9);
    this.mesh.rotation.z += (roll - this.mesh.rotation.z) * k;
    this.mesh.rotation.x += (pitch - this.mesh.rotation.x) * k;

    for (const w of this.wheels) {
      w.spin.rotation.x += (vF / w.radius) * dt;
      if (w.steers) w.pivot.rotation.y = this.steer;
    }
    this.tailMat.emissiveIntensity = this.input.brake > 0 ? 4.5 : 1.3;
    // Heat in the discs builds while braking hard at speed and bleeds off
    // again. A glow that follows the pedal exactly looks like a switch.
    const work = this.input.brake * Math.min(1, this.kmh / 140);
    const heat = this.brakeHeat ?? 0;
    this.brakeHeat = heat + (work - heat) * Math.min(1, dt * 1.6);
    if (this.discMat) this.discMat.emissiveIntensity = this.brakeHeat * 2.4;

    const ratios = this.tune.gearRatios;
    const kmh = this.kmh;
    let g = 1;
    while (g < ratios.length - 1 && kmh > ratios[g]) g++;
    this.gear = this.speed < -0.6 ? 'R' : kmh < 1 ? 'N' : g;
  }

  // Checkpoints must be taken in order, so cutting the circuit cannot score a lap.
  #trackProgress(p) {
    const cps = this.track.checkpoints;
    const target = cps[this.nextCheckpoint];
    const delta = ((p.t - target) + 1) % 1;
    if (delta < 0.05) {
      this.nextCheckpoint = (this.nextCheckpoint + 1) % cps.length;
      if (this.nextCheckpoint === 1) this.crossedLine = true;
    }
    this.progress = this.lap + p.t;
  }

  consumeLapFlag() {
    const f = this.crossedLine;
    this.crossedLine = false;
    return f;
  }

  // Boost drains while held and only refills once the driver is off it.
  #updateBoost(dt, i, vF) {
    const b = this.boost;
    const wants = !!i.boost && b.armed && vF > -0.5;
    const floor = b.firing ? 0 : BOOST.minToStart;
    b.firing = wants && b.reserve > floor;

    if (b.firing) {
      b.reserve = Math.max(0, b.reserve - BOOST.drain * dt);
      b.cooldown = BOOST.delay;
      return BOOST.thrust;
    }
    if (b.cooldown > 0) b.cooldown -= dt;
    else b.reserve = Math.min(b.capacity, b.reserve + BOOST.refill * dt);
    return 0;
  }

  // Take a hit from another car: change momentum, not position.
  applyImpulse(impulse) {
    this.velocity.add(impulse);
    this.speed = this.velocity.dot(this.forward);
  }

  get rotationRate() { return this.yawRate; }

  // --- AI ----------------------------------------------------------------
  // Heading change over a fixed arc gives the corner radius there, which is the
  // only thing the AI needs to pick a speed: v = sqrt(latAccel * radius).
  #bend(t, arc) {
    const len = this.track.length;
    const a = this.track.frameAt(t);
    const b = this.track.frameAt(t + arc / len);
    const ha = Math.atan2(a.tan.x, a.tan.z);
    const hb = Math.atan2(b.tan.x, b.tan.z);
    const signed = Math.atan2(Math.sin(hb - ha), Math.cos(hb - ha));
    return { signed, radius: Math.abs(signed) < 1e-3 ? 1e4 : arc / Math.abs(signed) };
  }

  // Solving v^2 = (mechanical + downforce * v^2) * grip * radius for v. Past a
  // certain radius the aero term alone carries the corner, so it is flat out.
  // A driver cannot spend the whole grip budget on the corner and still drive
  // out of it, so the estimate is taken at a margin, and the aero share is
  // capped: at the limit the formula divides by nothing and promises a speed
  // no tyre can hold.
  #cornerSpeed(t, arc) {
    const { radius } = this.#bend(t, arc);
    const grip = this.gripMul;
    const aeroShare = Math.min(0.85, this.tune.downforce * grip * radius);
    return Math.sqrt((this.tune.gripLat * grip * radius) / (1 - aeroShare)) * 0.94;
  }

  driveAI(dt, clock) {
    const track = this.track;
    const len = track.length;
    const p = track.project(this.position, this.hintIndex);
    const speed = Math.max(3, Math.abs(this.speed));

    // Strategy: call a stop before the cliff, not after it, and fit whatever
    // compound will see the rest of the race out.
    if (this.wearing && this.pitAllowed && !this.pitState.want
        && this.tyres.life < 0.20 && (this.lapsLeft ?? 99) > 1) {
      this.requestPit(this.lapsLeft > 26 ? 'hard' : this.lapsLeft > 11 ? 'medium' : 'soft');
    }
    // A car that has stopped where it should not be is recovered: on the
    // circuit to the racing line, in the pit lane to the middle of the lane.
    // Without the second case a spin inside the lane is a dead car, because
    // nothing out there is going to move it.
    const parked = this.kmh < 14 && !track.inPitBox(p.t, p.lateral);
    this.stuckFor = parked ? (this.stuckFor ?? 0) + dt : 0;
    if (this.stuckFor > 3
        && (this.pitState.inLane || Math.abs(p.lateral) > track.roadHalf + 1.6)) {
      this.resetToTrack(clock, this.pitState.inLane ? track.pit.centre * track.pit.side : 0);
      this.stuckFor = 0;
      return;
    }

    if (this.pitState.want && track.pitPhase(p.t) !== null) {
      this.#drivePitLane(p, len);
      return;
    }

    // Aim a fixed time ahead, then pull the aim point toward the inside of
    // the corner the car is already in.
    const aimArc = 11 + speed * 0.5;
    const aim = track.frameAt(p.t + aimArc / len);
    const here = this.#bend(p.t, 55);
    const inside = clamp(here.signed * 90, -this.track.roadHalf * 0.55, this.track.roadHalf * 0.55);
    const wobble = Math.sin(clock * 0.8 + this.aiPhase) * 1.2;
    const goal = aim.pos.clone().addScaledVector(aim.side, inside + wobble);

    const toGoal = goal.sub(this.position).setY(0);
    const err = Math.atan2(
      Math.sin(Math.atan2(toGoal.x, toGoal.z) - this.yaw),
      Math.cos(Math.atan2(toGoal.x, toGoal.z) - this.yaw),
    );
    // Proportional on heading error, damped on yaw rate: the same thing a
    // driver does with their hands.
    this.input.steer = clamp(err * 1.9 - this.yawRate * 0.28, -1, 1);

    // Brake for whatever corner sits one braking distance away, never for the
    // one already under the wheels.
    const brakeArc = Math.max(22, speed * speed / 17);
    const target = Math.min(
      74 * this.aiSkill,
      this.#cornerSpeed(p.t + brakeArc / len, 55) * this.aiSkill,
      this.#cornerSpeed(p.t, 40) * this.aiSkill * 1.15,
    );

    if (speed > target + 1.5) {
      this.input.throttle = 0;
      this.input.brake = clamp((speed - target) / 10, 0.15, 1);
    } else {
      this.input.brake = 0;
      this.input.throttle = speed < target - 1
        ? clamp(1 - Math.abs(err) * 0.5, 0.4, 1)
        : 0.35;
    }
    this.input.handbrake = false;
    // Only on a straight, only with reserve in hand, and never while braking.
    this.input.boost = here.radius > 400 && this.boost.reserve > this.boost.capacity * 0.5
      && this.input.brake === 0;

  }

  // Down the lane at the limit, stop on the box, then back out. The same line
  // the player drives, aimed at the lane centre instead of the racing line.
  #drivePitLane(p, len) {
    const track = this.track;
    const pit = track.pit;
    const speed = Math.abs(this.speed);
    const aim = track.frameAt(p.t + Math.max(8, speed * 0.6) / len);
    const goal = aim.pos.clone().addScaledVector(aim.side, pit.side * pit.centre);

    const toGoal = goal.sub(this.position).setY(0);
    const err = Math.atan2(
      Math.sin(Math.atan2(toGoal.x, toGoal.z) - this.yaw),
      Math.cos(Math.atan2(toGoal.x, toGoal.z) - this.yaw),
    );
    this.input.steer = clamp(err * 2.1 - this.yawRate * 0.3, -1, 1);
    this.input.boost = false;
    this.input.handbrake = false;

    // Distance to the box along the lane, so the car brakes for it in time.
    // Short of the box the car keeps a crawl on: braking to a stop on the
    // approach leaves it parked a few metres out, where nobody can work on it.
    const toBox = ((pit.box - p.t) + 1) % 1 * len;
    const onBox = track.inPitBox(p.t, p.lateral);
    const target = onBox ? 0
      : toBox < 40 ? Math.max(2.2, toBox * 0.34)
        : pit.limit * 0.94;
    if (speed > target + 0.6) {
      this.input.throttle = 0;
      this.input.brake = clamp((speed - target) / 6, 0.2, 1);
    } else {
      this.input.brake = 0;
      this.input.throttle = clamp((target - speed) / 5, 0, 0.55);
    }
  }
}

const AI_CHASSIS = ['mid', 'muscle', 'rear', 'rally', 'proto'];

export function makeRivals(track, count) {
  return Array.from({ length: count }, (_, i) => {
    const car = new Car(track, {
      color: PALETTE.rivals[i % PALETTE.rivals.length],
      ai: true,
      name: `CPU ${i + 1}`,
      chassis: CHASSIS[AI_CHASSIS[i % AI_CHASSIS.length]],
    });
    car.aiSkill = 0.93 + i * 0.035;
    car.aiPhase = i * 2.1;
    return car;
  });
}

// A name tag that hangs over a car. Canvas texture keeps it dependency-free and
// readable against any sky.
export function makeLabel(text, color) {
  const pad = 16, font = 44;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = `700 ${font}px system-ui, sans-serif`;
  canvas.width = Math.ceil(ctx.measureText(text).width) + pad * 2;
  canvas.height = font + pad * 2;

  const c = canvas.getContext('2d');
  c.font = `700 ${font}px system-ui, sans-serif`;
  c.textBaseline = 'middle';
  c.fillStyle = 'rgba(6,10,18,.72)';
  c.beginPath();
  c.roundRect(0, 0, canvas.width, canvas.height, 14);
  c.fill();
  c.strokeStyle = `#${color.toString(16).padStart(6, '0')}`;
  c.lineWidth = 4;
  c.stroke();
  c.fillStyle = '#e8eef7';
  c.fillText(text, pad, canvas.height / 2 + 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texture, depthTest: false, transparent: true,
  }));
  sprite.scale.set(canvas.width / canvas.height * 1.9, 1.9, 1);
  sprite.position.set(0, 3.1, 0);
  sprite.renderOrder = 10;
  return sprite;
}

// Another player's car. Purely presentational: it never runs physics, it eases
// toward whatever transform the server last relayed.
export class RemoteCar {
  constructor({ id, name, color, chassis }) {
    const spec = CHASSIS[chassis] ?? CHASSIS.gt;
    const built = buildBody(color ?? spec.color, spec.body, spec);
    this.id = id;
    this.name = name;
    this.color = color ?? chassis.color;
    this.mesh = built.group;
    this.wheels = built.wheels;
    this.headMat = built.headMat;
    this.tailMat = built.tailMat;
    this.tyreMat = built.tyreMat;
    this.discMat = built.discMat;

    this.label = makeLabel(name, color);
    this.mesh.add(this.label);

    this.position = new THREE.Vector3();
    this.target = new THREE.Vector3();
    // Derived from the reported heading and speed so contacts can read it.
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.targetYaw = 0;
    this.speed = 0;
    this.steer = 0;
    this.lap = 0;
    this.seen = false;
    this.radius = Math.max(spec.body.width, spec.body.length * 0.55) * 0.5;
  }

  get kmh() { return Math.abs(this.speed) * 3.6; }

  // [x, y, z, yaw, speed, steer] as packed by Net.pushState.
  applySnapshot(s, lap) {
    this.target.set(s[0], s[1], s[2]);
    this.targetYaw = s[3];
    this.speed = s[4];
    this.steer = s[5];
    this.lap = lap ?? this.lap;
    if (!this.seen) {
      this.position.copy(this.target);
      this.yaw = this.targetYaw;
      this.seen = true;
    }
  }

  setHeadlights(on) {
    this.headMat.emissiveIntensity = on ? 3.2 : 0.6;
  }

  update(dt) {
    // Snapshots land at 20 Hz; this smooths the gap without predicting ahead.
    const k = Math.min(1, dt * 11);
    this.position.lerp(this.target, k);
    const delta = Math.atan2(
      Math.sin(this.targetYaw - this.yaw), Math.cos(this.targetYaw - this.yaw),
    );
    this.yaw += delta * k;

    this.velocity.set(Math.sin(this.yaw) * this.speed, 0, Math.cos(this.yaw) * this.speed);
    this.mesh.position.copy(this.position);
    this.mesh.rotation.y = this.yaw;
    this.label.position.set(0, 3.1, 0);

    for (const w of this.wheels) {
      w.spin.rotation.x += (this.speed / w.radius) * dt;
      if (w.steers) w.pivot.rotation.y = this.steer;
    }
  }

  dispose(scene) {
    scene.remove(this.mesh);
    this.label.material.map.dispose();
    this.label.material.dispose();
  }
}
