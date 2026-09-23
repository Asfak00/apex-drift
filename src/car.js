import * as THREE from 'three';
import { CAR, PALETTE, CHASSIS, BOOST, PIT, ROAD_SURFACE } from './config.js';
import { TyreSet } from './tyres.js';
import { Brakes } from './brakes.js';
import { tuneFor, classOf, hullFor } from './vehicles.js';
import { Materials } from './materials.js';
import {
  lerp, curveAt, loft, buildWheels, wrapBody, buildBike, buildKart, buildUtility,
} from './vehicle-meshes.js';

const UP = new THREE.Vector3(0, 1, 0);

// Hot steel, from the first dull red to orange. The colour is set per frame
// only while the disc is visibly hot.
const DISC_DULL = new THREE.Color(0x6a0800);
const DISC_HOT = new THREE.Color(0xff6a1c);
function discGlow(mat, glow) {
  if (!mat) return;
  mat.emissiveIntensity = glow > 0 ? glow ** 1.5 * 3.2 : 0;
  if (glow > 0) mat.emissive.lerpColors(DISC_DULL, DISC_HOT, glow);
}
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
  // Four-door electric fastback: a long cabin over a flat battery floor.
  ev: {
    cabin: [0.24, 0.80],
    belt: [[0, 0.24], [0.1, 0.4], [0.26, 0.48], [0.7, 0.52], [0.9, 0.48], [1, 0.38]],
    sill: [[0, 0.14], [0.12, 0.02], [0.88, 0.02], [1, 0.16]],
    beam: [[0, 0.6], [0.12, 0.92], [0.3, 0.99], [0.7, 1], [0.9, 0.95], [1, 0.72]],
    roof: [[0.24, 0.05], [0.36, 0.94], [0.6, 1], [0.8, 0.2]],
  },
  proto: {
    cabin: [0.30, 0.60],
    belt: [[0, 0.10], [0.06, 0.24], [0.26, 0.34], [0.60, 0.40], [0.86, 0.42], [1, 0.30]],
    sill: [[0, 0.08], [0.08, 0.00], [0.92, 0.00], [1, 0.10]],
    beam: [[0, 0.52], [0.10, 0.92], [0.30, 1], [0.70, 1], [0.90, 0.94], [1, 0.62]],
    roof: [[0.30, 0.04], [0.40, 0.90], [0.52, 0.92], [0.60, 0.10]],
  },
};

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
  // Vehicles that are not lofted sports cars have builders of their own; all
  // of them hand back the same parts, so the rest of the game never asks.
  const kind = spec.class;
  if (kind === 'moto') return buildBike(color, b, spec);
  if (kind === 'kart') return buildKart(color, b, spec);
  if (kind === 'suv' || kind === 'van' || kind === 'bus' || kind === 'truck') {
    return buildUtility(color, b, spec);
  }
  const shape = SHAPES[b.shape ?? spec.shape] ?? SHAPES.gt;
  const g = new THREE.Group();

  // Automotive paint: a metallic base with flakes under a clear coat; wings
  // and spoilers are bare carbon; glass is glass.
  const paint = Materials.carPaint({ map: paintTexture(color, spec.scheme ?? 'stripes') });
  const carbonMat = Materials.carbon();
  const glass = Materials.glass();
  const trim = Materials.trim();
  const chrome = Materials.chrome();

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
  const tuck = (u) => hw * curveAt(shape.beam, u) - width * 0.62;
  const { wheels, tyreMat, discMat, rearDiscMat } = buildWheels(g, {
    axles: [
      { z: zAt(0.20), x: tuck(0.20), steers: true },
      { z: zAt(0.78), x: tuck(0.78) },
    ],
    radius, width,
  });
  const bodyGroup = wrapBody(g, wheels);
  return { group: g, wheels, headMat, tailMat, tyreMat, discMat, rearDiscMat, body: bodyGroup };
}

// Tyre capacity under load. Grip rises with load but by less and less, so an
// axle whose load has moved to one side grips less in total than the same axle
// loaded evenly. That is what roll stiffness trades: whichever axle takes more
// of the car's lateral load transfer loses more grip.
const LOAD_SENSITIVITY = 0.12;
function tyreCapacity(load, nominal) {
  return load * (1 - LOAD_SENSITIVITY * (load / nominal - 1));
}
function axlePair(load, shift, nominal) {
  const d = Math.min(Math.abs(shift), load * 0.49);
  return tyreCapacity(load / 2 + d, nominal) + tyreCapacity(load / 2 - d, nominal);
}
// Share of an axle's grip a differential can put down as drive: an open diff
// is held to twice what the unloaded inside wheel can take, a locked one uses
// both wheels fully.
function diffShare(load, shift, nominal, lock) {
  const pair = axlePair(load, shift, nominal);
  if (pair <= 1e-6) return 1;
  const d = Math.min(Math.abs(shift), load * 0.49);
  const open = 2 * tyreCapacity(load / 2 - d, nominal);
  return (open + (pair - open) * lock) / pair;
}

export class Car {
  constructor(track, {
    color = null, ai = false, name = 'YOU', headlights = false, chassis = CHASSIS.gt, setup = null,
  } = {}) {
    this.track = track;
    this.ai = ai;
    this.name = name;
    this.chassis = chassis;
    this.profile = classOf(chassis);
    this.tune = tuneFor(chassis, setup);
    // Lateral load moved across each axle, as set up and as it came: [front,
    // rear, stock front, stock rear], in newtons.
    this.transfer = [0, 0, 0, 0];
    this.lean = 0;           // rad, two-wheelers only; positive leans left
    this.wheelie = 0;
    this.stoppie = 0;
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
    this.rearDiscMat = built.rearDiscMat;
    this.body = built.body;
    this.rider = built.rider ?? null;
    // Disc temperatures, and the fade that comes with too much of it.
    this.brakes = new Brakes(this.tune.brakeBias);
    // Share of each axle's load on the driver's left tyres; 0.5 is straight.
    this.leftShare = 0.5;

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
    this.tyres.coldPsi = [...this.tune.pressure];
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
    // Collision body: a row of circles along the body; `radius` is the circle
    // that holds all of them, for the cheap test before the real one.
    this.hull = hullFor(chassis.body, built.centerZ ?? 0);
    this.radius = Math.max(...this.hull.map((h) => Math.abs(h.offset) + h.radius));
    this.slide = 0;   // how far past the grip limit the tyres are, for smoke

    if (headlights && !this.profile.caps.dark) {
      // Lamps where the vehicle's lamps are: one on a bike, two on anything
      // else, at its own nose and height.
      const bd = chassis.body;
      const sides = this.profile.wheels === 2 ? [0] : [-1, 1];
      const nose = bd.length / 2 + (built.centerZ ?? 0);
      const lampY = Math.max(0.5, bd.ride + 0.1);
      this.beams = sides.map((side) => {
        const sx = side * Math.min(0.6, bd.width * 0.3);
        const s = new THREE.SpotLight(0xfff0d8, 0, 95, Math.PI / 7, 0.45, 1.1);
        s.position.set(sx, lampY, nose);
        s.target.position.set(sx * 1.6, -0.6, nose + 24);
        this.mesh.add(s, s.target);
        return s;
      });
    }
  }

  // A new setup is a new tune. State carries over: a car can be re-tuned in
  // the garage, or between sessions, without being rebuilt.
  setSetup(setup) {
    this.tune = tuneFor(this.chassis, setup);
    this.brakes.bias = this.tune.brakeBias;
    this.tyres.coldPsi = [...this.tune.pressure];
    if (this.body) this.body.position.y = (this.tune.setup.rideHeight ?? 0) / 1000;
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
  // `air` and `road` are temperatures in C and `standing` the sheet water on
  // the road, from the track condition; they drive tyre and brake heat.
  update(dt, roadGrip, wet = 0, { air = 20, road = 25, standing = 0 } = {}) {
    const i = this.input;
    const tune = this.tune;
    // Tread temperature changes grip axle by axle. The car-wide figure every
    // estimate reads (the steering limit, the AI's corner speed) takes the
    // mean; the axles then carry their own difference from it, so hot rears
    // make a car loose and cold fronts make it push.
    const tyreFront = this.tyres.axleGrip(0, this.leftShare) * this.tyres.pressureGrip(0);
    const tyreRear = this.tyres.axleGrip(1, this.leftShare) * this.tyres.pressureGrip(1);
    const tyreMean = (tyreFront + tyreRear) / 2;
    const grip = this.surfaceGrip(roadGrip, wet) * tyreMean;
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

    // A two-wheeler corners by leaning, and the rider decides the lean. The
    // bike can only turn as hard as its lean balances (a = g tan lean), so a
    // steering input first rolls the bike over and the turn follows it. Near
    // a standstill a foot is down and the lean no longer matters.
    if (tune.lean) {
      const wantAccel = asked * gripLimit;
      const wantLean = clamp(Math.atan(wantAccel / 9.81), -tune.maxLean, tune.maxLean)
        * clamp(speed / 6, 0, 1);
      const before = this.lean;
      this.lean += clamp(wantLean - this.lean, -tune.leanRate * dt, tune.leanRate * dt);
      this.leanRate = (this.lean - before) / dt;
      // The rider leans the bike; the front wheel follows the lean. The bars
      // settle at the angle the lean's curvature needs (L / R, with
      // 1 / R = g tan(lean) / v^2) plus the slip the front tyre runs to make
      // that force. Below walking pace a foot is down and the bars are steered.
      const v2 = Math.max(speed, 3) ** 2;
      const need = 9.81 * Math.tan(this.lean);
      const share = Math.min(1, Math.abs(need) / Math.max(1, gripLimit));
      const leanSteer = Math.atan(tune.wheelBase * need / v2)
        + Math.sign(this.lean) * share * this.peakSlip * 0.5;
      const ride = clamp((speed - 3) / 5, 0, 1);
      this.steer = clamp(ride * leanSteer + (1 - ride) * this.steer, -tune.maxSteer, tune.maxSteer);
    }

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
    // A bike can move its whole weight onto one wheel; a car's suspension
    // geometry never lets it get near that.
    const reach = tune.lean ? 0.95 : 0.3;
    const transfer = clamp(tune.mass * this.lastAx * tune.cogHeight / L,
      -weight * reach, weight * reach);
    const loadFront = Math.max(0, weight * (b / L) - transfer + aeroLoad * tune.aeroBalance);
    const loadRear = Math.max(0, weight * (a / L) + transfer + aeroLoad * (1 - tune.aeroBalance));

    // Lateral load transfer, split front to rear by roll stiffness and moved
    // across as fast as the springs and dampers let it. Grip is measured
    // against the vehicle as it came, so the stock setup drives exactly as it
    // always did and a change of setup moves the balance from there.
    const nomF = weight * (b / L) / 2, nomR = weight * (a / L) / 2;
    const shifts = this.transfer;
    let sensF = 1, sensR = 1;
    if (!tune.lean) {
      const ay = Math.abs(this.latAccel ?? 0);
      const shift = tune.mass * ay * tune.cogHeight / tune.trackWidth;
      const stock = tune.mass * ay * tune.cogHeight0 / tune.trackWidth;
      const k = 1 - Math.exp(-dt / tune.rollTau), k0 = 1 - Math.exp(-dt / tune.rollTau0);
      shifts[0] += (shift * tune.rollFront - shifts[0]) * k;
      shifts[1] += (shift * (1 - tune.rollFront) - shifts[1]) * k;
      shifts[2] += (stock * tune.rollFront0 - shifts[2]) * k0;
      shifts[3] += (stock * (1 - tune.rollFront0) - shifts[3]) * k0;
      const ref = (load, s, n) => Math.max(1e-6, axlePair(load, s, n));
      sensF = axlePair(loadFront, shifts[0], nomF) / ref(loadFront, shifts[2], nomF);
      sensR = axlePair(loadRear, shifts[1], nomR) / ref(loadRear, shifts[3], nomR);
    }
    const rearCap = mu * loadRear * tune.rearGripBias * (tyreRear / tyreMean) * sensR;
    const frontCap = mu * loadFront * (tyreFront / tyreMean) * sensF;

    // --- longitudinal -----------------------------------------------------
    // Constant force below the power band, constant power above it. A
    // shorter final drive multiplies the force at the wheels (power is power)
    // and reaches the rev limit sooner; a governor or an electric motor's
    // top speed is a limit of its own.
    const fd = tune.finalDrive;
    const driveForce = tune.enginePower
      * Math.min(fd, tune.powerBand / Math.max(Math.abs(vF), 1e-3));
    const governor = clamp((tune.topLimit / fd - Math.abs(vF)) / 2, 0, 1);
    const demand = i.throttle > 0 ? i.throttle * driveForce * governor * (vF < 0 ? 1.6 : 1) : 0;
    const boostDemand = this.#updateBoost(dt, i, vF);
    // The road can only push back as hard as the rear tyres can grip it.
    // Without this the car took full acceleration AND lost all its cornering
    // grip to a force the tyres were never making — which is exactly why a wet
    // circuit used to turn every corner into a slide.
    const pull = demand + boostDemand;
    // The drive is split between the axles by the drivetrain, and each axle
    // puts down what its tyres and its differential allow.
    const split = tune.driveFront;
    const lockF = tune.caps.diff ? diffShare(loadFront, shifts[0], nomF, tune.diffAccel)
      / diffShare(loadFront, shifts[0], nomF, tune.diffAccel0) : 1;
    const lockR = tune.caps.diff ? diffShare(loadRear, shifts[1], nomR, tune.diffAccel)
      / diffShare(loadRear, shifts[1], nomR, tune.diffAccel0) : 1;
    const driveF = Math.min(pull * split, Math.max(0, frontCap * 0.97 * lockF));
    let driveR = Math.min(pull * (1 - split), Math.max(0, rearCap * 0.97 * lockR));
    // Past this much drive the front wheel of a bike leaves the ground.
    this.wheelie = 0;
    if (tune.lean) {
      const lift = weight * (b / tune.cogHeight) * 0.97;
      this.wheelie = clamp((driveR - lift) / lift, 0, 1);
      driveR = Math.min(driveR, lift);
    }
    const drive = driveF + driveR;
    this.wheelspin = pull > 1 ? Math.min(1, (pull - drive) / Math.max(1, pull)) : 0;

    // Brakes are limited the same way, by all four tyres together, and by
    // what the discs can still do at their temperature. A bike's rear wheel
    // lifts before its front tyre gives up.
    const brakeAsked = i.brake > 0 && vF > 0.5
      ? i.brake * tune.brakePower * this.brakes.efficiency : 0;
    let brakeGrip = (frontCap + rearCap) * 0.98;
    this.stoppie = 0;
    if (tune.lean) {
      const lift = weight * (a / tune.cogHeight) * 0.97;
      this.stoppie = clamp((brakeAsked - lift) / lift, 0, 1);
      brakeGrip = Math.min(brakeGrip, lift);
    }
    const brakeForce = Math.min(brakeAsked, brakeGrip);
    this.lockup = brakeAsked > 1 ? Math.min(1, (brakeAsked - brakeForce) / brakeAsked) : 0;

    let force = drive - brakeForce;
    // An electric motor off the throttle is a generator: it slows the car and
    // puts charge back.
    const regen = tune.regen > 0 && i.throttle < 0.05 && vF > 1 ? tune.regen * tune.mass : 0;
    force -= regen;
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
    this.slipAngles = [slipFront, slipRear];

    // A tyre has one grip budget. Whatever an axle is already spending on
    // driving or braking is not available for cornering, so hard power takes
    // grip from the rear (which rotates the car) instead of leaving the front
    // to carry a corner it no longer has the load for.
    const budget = (capacity, longitudinal) =>
      Math.sqrt(Math.max(0, capacity * capacity - longitudinal * longitudinal));
    // Brake bias decides which axle's grip the braking spends: too far
    // forward and the car will not turn on the brakes, too far back and the
    // rear steps out.
    const bias = tune.brakeBias;
    const frontCapacity = budget(frontCap, brakeForce * bias + driveF);
    const rearCapacity = budget(rearCap, driveR + brakeForce * (1 - bias));

    let forceFront = tyreForce(slipFront, frontCapacity, tune);
    let forceRear = tyreForce(slipRear, rearCapacity, tune);
    if (i.handbrake) forceRear *= tune.handbrakeGrip;
    // Leaning is the limit: a tyre can only push sideways as hard as the lean
    // balances, plus what a foot on the ground allows at walking pace.
    if (tune.lean) {
      const balance = Math.tan(Math.abs(this.lean)) * 1.08 + clamp(1 - speed / 7, 0, 1) * 1.2;
      forceFront = clamp(forceFront, -loadFront * balance, loadFront * balance);
      forceRear = clamp(forceRear, -loadRear * balance, loadRear * balance);
    }

    const inertia = tune.mass * L * L * tune.inertiaFactor;
    const cos = Math.cos(this.steer);
    const latAccel = (forceFront * cos + forceRear) / tune.mass;
    // Damping opposes the rotation itself, which is what stops the yaw
    // overshooting and swinging back against the steering. A differential
    // adds to it: the more it locks the rear wheels together, the more it
    // resists the car rotating, on power and on the coast alike.
    const baseDamp = tune.yawDamp * (1 + speed * 0.02);
    let diffDamp = 0;
    if (tune.caps.diff) {
      diffDamp = i.throttle > 0.1
        ? (tune.diffAccel - tune.diffAccel0) : (tune.diffDecel - tune.diffDecel0);
    }
    const damping = baseDamp * Math.max(0.35, 1 + diffDamp * 0.4) * r;
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
    let lateral = latAccel;
    // A rolling bike's heading is tied to its lean: it turns at exactly the
    // rate its lean balances (r = g tan(lean) / v) and barely slips sideways.
    // Only when the lean asks for more than the tyres have does it slide, and
    // then the tyre model above is what happens.
    if (tune.lean && speed > 4) {
      const want = 9.81 * Math.tan(this.lean);
      if (Math.abs(want) <= gripLimit) {
        // The lean is already rate-limited, so its yaw rate is smooth as it is.
        r = (want / Math.max(speed, 4)) * dir;
        vL *= Math.exp(-dt / 0.1);
        lateral = want;
      }
    }

    this.yawRate = r;
    this.latAccel = lateral;
    // Signed sideways velocity, in m/s. The camera and the effects both want to
    // know which way the car is sliding, not only how much.
    this.sideslip = vL;
    this.velocity.copy(fwd).multiplyScalar(vF).addScaledVector(right, vL);
    this.speed = vF;
    this.yaw += r * dt;

    // How fast the rear tyre is scrubbing sideways: the smoke and the hiss.
    this.slide = Math.abs(Math.sin(slipRear)) * speed;

    // --- heat -------------------------------------------------------------
    // The tread heats by the work it does sliding: lateral force times the
    // speed it scrubs sideways at its slip angle, plus the longitudinal slip
    // of driving, braking, wheelspin and lock-ups.
    const scrubF = Math.abs(forceFront) * u * Math.abs(Math.sin(slipFront));
    const scrubR = Math.abs(forceRear) * u * Math.abs(Math.sin(slipRear));
    const braking = (share) => brakeForce * share * (0.06 * speed + this.lockup * speed * 0.5);
    const driving = (share) => share * (0.04 * speed + this.wheelspin * 12);
    // A left turn loads the right-hand tyres; `right` in this model points to
    // the driver's left, so positive lateral acceleration is a left turn. A
    // bike's tyres are in line: nothing moves across.
    this.leftShare = tune.lean ? 0.5 : clamp(0.5 - latAccel * 0.015, 0.15, 0.85);
    this.tyres.heat(dt, {
      power: [scrubF + braking(bias) + driving(driveF), scrubR + braking(1 - bias) + driving(driveR)],
      load: [loadFront, loadRear],
      left: this.leftShare,
      speed, air, road, wet, standing,
    });
    // A locked wheel is not turning its disc: that work went into the tyre.
    // An electric car's motor does part of the braking and keeps it.
    this.brakes.heat(dt, {
      force: brakeForce * (1 - this.lockup) * (tune.electric ? 0.6 : 1), speed: vF, air,
    });
    if (tune.battery > 0) {
      // Charge in kWh: drawn by the drive, returned by the motor braking.
      const kw = (drive * Math.max(0, vF) / 0.9 - (regen + brakeForce * 0.4) * Math.max(0, vF) * 0.7) / 1000;
      this.charge = Math.min(tune.battery, Math.max(0, (this.charge ?? tune.battery) - kw * dt / 3600));
    }

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
    const tune = this.tune;
    const k = Math.min(1, dt * 9);
    if (tune.lean) {
      // The whole machine leans on its tyres' contact line, and the rider
      // hangs off a little further into the corner. A wheelie or a stoppie
      // pitches it about the wheel still on the ground.
      this.mesh.rotation.z = -this.lean;
      const pitch = -this.wheelie * 0.38 + this.stoppie * 0.22;
      this.mesh.rotation.x += (pitch - this.mesh.rotation.x) * Math.min(1, dt * 5);
      if (this.rider) {
        this.rider.rotation.z = -this.lean * 0.2;
        this.rider.position.x = this.lean * 0.14;
      }
    } else if (tune.caps.tilt) {
      // Body roll and pitch read the forces without needing a physics engine;
      // softer springs roll further. The body moves on the wheels, not with
      // them.
      const soft = tune.rollScale;
      const roll = clamp((this.latAccel ?? 0) * 0.011 * soft, -0.16, 0.16);
      const pitch = clamp((-this.input.throttle * 0.02 + this.input.brake * 0.035) * soft, -0.08, 0.08);
      const target = this.body ?? this.mesh;
      const kk = Math.min(1, dt * 9 / Math.max(0.6, tune.rollTau / 0.11));
      target.rotation.z += (roll - target.rotation.z) * kk;
      target.rotation.x += (pitch - target.rotation.x) * kk;
    }

    for (const w of this.wheels) {
      w.spin.rotation.x += (vF / w.radius) * dt;
      // A bike's bars turn against the lean for an instant before they turn
      // with it: counter-steer.
      if (w.steers) w.pivot.rotation.y = this.steer - (tune.lean ? (this.leanRate ?? 0) * 0.04 : 0);
    }
    this.tailMat.emissiveIntensity = this.input.brake > 0 ? 4.5 : 1.3;
    // Discs glow by their temperature: nothing until about 420 C, then dull
    // red warming toward orange. The glow lags the pedal because the heat does.
    discGlow(this.discMat, this.brakes.glow(0));
    discGlow(this.rearDiscMat, this.brakes.glow(1));

    const ratios = this.tune.gearRatios;
    const kmh = this.kmh;
    let g = 1;
    while (g < ratios.length - 1 && kmh > ratios[g]) g++;
    // A single-speed drive has no gear to show, only a direction.
    const moving = this.speed < -0.6 ? 'R' : kmh < 1 ? 'N' : null;
    this.gear = moving ?? (tune.caps.gears ? g : 'D');
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
    // the corner the car is already in. A bike has to roll into its lean
    // before it turns, so it looks further ahead and takes corners with more
    // in hand.
    const lean = this.tune.lean;
    const aimArc = lean ? 16 + speed * 0.62 : 11 + speed * 0.5;
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
    if (lean) {
      // Pure pursuit: the arc through the aim point needs a lateral
      // acceleration, and on a bike asking for a lateral acceleration is
      // asking for a lean. Steering the lean directly keeps the rider ahead
      // of the roll instead of chasing the heading it lags behind.
      const reach = Math.max(6, toGoal.length());
      const need = speed * speed * (2 * Math.sin(err) / reach);
      const limit = (this.tune.gripLat + this.tune.downforce * speed * speed) * this.gripMul;
      const share = clamp(need / Math.max(1, limit), -1, 1);
      this.input.steer = Math.sign(share) * Math.abs(share) ** (1 / this.tune.steerCurve);
    } else {
      this.input.steer = clamp(err * 1.9 - this.yawRate * 0.28, -1, 1);
    }

    // Brake for whatever corner sits one braking distance away, never for the
    // one already under the wheels.
    const brakeArc = Math.max(22, speed * speed / 17);
    const margin = lean ? 0.86 : 1;
    const target = Math.min(
      74 * this.aiSkill,
      this.#cornerSpeed(p.t + brakeArc / len, 55) * this.aiSkill * margin,
      this.#cornerSpeed(p.t, 40) * this.aiSkill * 1.15 * margin,
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

// Rivals come from the player's group: a car race against cars, a bike race
// against bikes, a bus against the heavy vehicles. Class-restricted racing
// is the default because a bus is not meant to keep up with a hypercar.
export function rivalPool(playerKey) {
  const group = classOf(CHASSIS[playerKey]).group;
  if (group === 'car') return AI_CHASSIS;
  return Object.keys(CHASSIS).filter((k) => classOf(CHASSIS[k]).group === group);
}

export function makeRivals(track, count, playerKey = 'gt') {
  const pool = rivalPool(playerKey);
  return Array.from({ length: count }, (_, i) => {
    const car = new Car(track, {
      color: PALETTE.rivals[i % PALETTE.rivals.length],
      ai: true,
      name: `CPU ${i + 1}`,
      chassis: CHASSIS[pool[i % pool.length]],
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
    this.chassis = spec;
    this.lean = !!classOf(spec).caps.lean;
    this.hull = hullFor(spec.body, built.centerZ ?? 0);
    this.radius = Math.max(...this.hull.map((h) => Math.abs(h.offset) + h.radius));
    this.label.position.set(0, spec.body.roof + spec.body.ride + 2.2, 0);
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
    // A remote bike leans by how hard it is turning: a = v * yaw rate.
    if (this.lean && dt > 0) {
      const rate = (delta * k) / dt;
      const want = Math.atan(Math.max(-1.7, Math.min(1.7, this.speed * rate / 9.81)));
      this.mesh.rotation.z += (-want - this.mesh.rotation.z) * Math.min(1, dt * 8);
    }

    this.velocity.set(Math.sin(this.yaw) * this.speed, 0, Math.cos(this.yaw) * this.speed);
    this.mesh.position.copy(this.position);
    this.mesh.rotation.y = this.yaw;

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
