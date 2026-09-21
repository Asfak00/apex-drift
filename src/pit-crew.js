import * as THREE from 'three';
import { PIT } from './config.js';

// The team. A stop is the one moment in a race where people and car are in the
// same place doing the same thing, so the crew is not scenery: they wait at the
// wall, come over the line when the car arrives, work a corner each, and stand
// back when the car drops.
//
// There are eight of them, so they are built as real objects with jointed limbs
// and posed in JavaScript, rather than instanced and posed in a shader the way
// the grandstand is. Eight figures can afford the joints; five thousand cannot.

const UP = new THREE.Vector3(0, 1, 0);
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
// Smooth in and out of a 0..1 ramp, so nobody starts or stops dead.
const ease = (t) => t * t * (3 - 2 * t);
// A window of a 0..1 timeline, remapped to 0..1 and eased.
const phase = (t, from, to) => ease(clamp((t - from) / (to - from), 0, 1));

// Team colours: the crew are dressed alike, which is most of what makes them
// read as a team rather than as more spectators.
const SUIT = 0x18c08a;
const SUIT_DARK = 0x0c6e52;
const VISOR = 0x1b2230;
const SKIN = [0xf0c9a4, 0xd9a279, 0xb07b4f, 0x7a4b2c];

function limb(radius, length, material) {
  const geo = new THREE.CapsuleGeometry(radius, length, 3, 7);
  geo.translate(0, -length / 2 - radius, 0);   // pivot at the joint
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true;
  return mesh;
}

// One mechanic: hips, chest, two arms, two legs, a helmet. Every joint is a
// Group, so posing is three rotations rather than a rebuilt mesh.
function buildMechanic(skinHex) {
  const suit = new THREE.MeshStandardMaterial({ color: SUIT, roughness: 0.72 });
  const dark = new THREE.MeshStandardMaterial({ color: SUIT_DARK, roughness: 0.78 });
  const skin = new THREE.MeshStandardMaterial({ color: skinHex, roughness: 0.78 });
  const shell = new THREE.MeshStandardMaterial({
    color: 0xe8eef7, roughness: 0.3, metalness: 0.15,
  });
  const visor = new THREE.MeshStandardMaterial({
    color: VISOR, roughness: 0.15, metalness: 0.6,
  });

  const root = new THREE.Group();          // at the feet
  const hips = new THREE.Group();
  hips.position.y = 0.92;
  root.add(hips);

  const chest = new THREE.Group();
  hips.add(chest);
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.16, 0.34, 4, 9), suit);
  torso.geometry.scale(1, 1, 0.74);
  torso.position.y = 0.2;
  torso.castShadow = true;
  chest.add(torso);
  const shoulders = new THREE.Mesh(new THREE.CapsuleGeometry(0.08, 0.3, 3, 7), suit);
  shoulders.geometry.rotateZ(Math.PI / 2);
  shoulders.position.y = 0.4;
  chest.add(shoulders);

  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.08, 7), skin);
  neck.position.y = 0.48;
  chest.add(neck);
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.125, 14, 11), shell);
  helmet.scale.set(0.96, 1.06, 1);
  helmet.position.y = 0.6;
  helmet.castShadow = true;
  chest.add(helmet);
  const face = new THREE.Mesh(
    new THREE.SphereGeometry(0.118, 12, 8, -0.9, 1.8, 0.7, 0.9), visor);
  face.position.y = 0.6;
  face.rotation.y = Math.PI;
  chest.add(face);

  const arms = [];
  const legs = [];
  for (const side of [-1, 1]) {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * 0.21, 0.4, 0);
    chest.add(shoulder);
    const upper = limb(0.052, 0.24, suit);
    shoulder.add(upper);
    const elbow = new THREE.Group();
    elbow.position.y = -0.29;
    shoulder.add(elbow);
    const fore = limb(0.048, 0.22, skin);
    elbow.add(fore);
    const glove = new THREE.Mesh(new THREE.SphereGeometry(0.058, 8, 6), dark);
    glove.position.y = -0.3;
    elbow.add(glove);
    arms.push({ shoulder, elbow, side });

    const hip = new THREE.Group();
    hip.position.set(side * 0.095, 0, 0);
    hips.add(hip);
    const thigh = limb(0.072, 0.32, suit);
    hip.add(thigh);
    const knee = new THREE.Group();
    knee.position.y = -0.39;
    hip.add(knee);
    const shin = limb(0.062, 0.3, suit);
    knee.add(shin);
    const boot = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.07, 0.22), dark);
    boot.position.set(0, -0.45, 0.03);
    knee.add(boot);
    legs.push({ hip, knee, side });
  }

  return { root, hips, chest, arms, legs };
}

// A wheel in the crew's hands: the one they take off and the one they put on.
function buildSpare(radius, width) {
  const group = new THREE.Group();
  const rubber = new THREE.MeshStandardMaterial({ color: 0x0b0e13, roughness: 0.96 });
  const tyre = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, width, 18), rubber);
  tyre.geometry.rotateZ(Math.PI / 2);
  tyre.castShadow = true;
  const band = new THREE.MeshStandardMaterial({
    color: 0xffc94d, emissive: 0xffc94d, emissiveIntensity: 0.5,
    roughness: 0.7, side: THREE.DoubleSide,
  });
  const wall = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 0.88, radius * 0.88, width * 1.06, 18, 1, true), band);
  wall.geometry.rotateZ(Math.PI / 2);
  const rim = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 0.64, radius * 0.64, width * 1.02, 12),
    new THREE.MeshStandardMaterial({ color: 0xc2ccd8, metalness: 1, roughness: 0.2 }));
  rim.geometry.rotateZ(Math.PI / 2);
  group.add(tyre, wall, rim);
  return { group, band };
}

// Where each of the eight stands, relative to the car: x across the car, z
// along it. The wheel crew take a corner each, the jack men the ends, and the
// lollipop man stands in front where the driver can see him.
const STATIONS = [
  { role: 'wheel', corner: 0, x: -1.35, z: 1.3 },
  { role: 'wheel', corner: 1, x: 1.35, z: 1.3 },
  { role: 'wheel', corner: 2, x: -1.35, z: -1.4 },
  { role: 'wheel', corner: 3, x: 1.35, z: -1.4 },
  { role: 'jack', x: 0, z: 2.9 },
  { role: 'jack', x: 0, z: -2.9 },
  { role: 'lollipop', x: -0.9, z: 4.2 },
  { role: 'fuel', x: 1.5, z: -0.2 },
];

export class PitCrew {
  constructor(track) {
    this.group = new THREE.Group();
    this.group.name = 'pit-crew';
    this.members = STATIONS.map((station, i) => {
      const body = buildMechanic(SKIN[i % SKIN.length]);
      this.group.add(body.root);
      const member = { ...body, station, out: 0, swing: Math.random() * 6.28 };
      // The board over the car is the one thing in a pit stop the driver is
      // actually reading, so the man holding it holds something.
      if (station.role === 'lollipop') member.board = this.#buildBoard(body);
      return member;
    });

    // Two spare wheels in the pit lane, which is what a crew is standing over
    // before a car arrives.
    this.spares = [0, 1].map(() => {
      const spare = buildSpare(0.33, 0.34);
      this.group.add(spare.group);
      return spare;
    });

    this.jackLift = 0;
    this.time = 0;
    this.lastCar = null;
    // Eight jointed figures are a hundred-odd draw calls. They are only ever
    // seen from the pit lane, so they are only ever drawn from the pit lane.
    this.group.visible = false;
    this.setTrack(track);
  }

  // A pole with a board on it, hung from the raised arms.
  #buildBoard(body) {
    const pole = new THREE.Group();
    pole.position.set(0, 0.62, 0.12);
    body.chest.add(pole);
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.022, 0.022, 1.5, 7),
      new THREE.MeshStandardMaterial({ color: 0x2a3140, metalness: 0.6, roughness: 0.4 }));
    shaft.position.y = 0.75;
    const panel = new THREE.Mesh(
      new THREE.BoxGeometry(0.62, 0.42, 0.03),
      new THREE.MeshStandardMaterial({
        color: 0xffc94d, emissive: 0xffc94d, emissiveIntensity: 0.55, roughness: 0.5,
      }));
    panel.position.y = 1.62;
    panel.castShadow = true;
    pole.add(shaft, panel);
    pole.visible = false;
    return pole;
  }

  setActive(on) {
    this.group.visible = !!on;
  }

  // The box moves with the circuit, and so does the crew.
  setTrack(track) {
    this.track = track;
    const pit = track.pit;
    const f = track.frameAt(pit.box);
    this.boxPoint = f.pos.clone().addScaledVector(f.side, pit.side * pit.centre);
    this.boxYaw = Math.atan2(f.tan.x, f.tan.z);
    // Waiting room: behind the wall, out of the lane.
    this.wallPoint = f.pos.clone()
      .addScaledVector(f.side, pit.side * (pit.outer + 0.4));
    this.ready = false;
    this.#rest();
  }

  // Put everyone at the wall, standing, with the spares at their feet.
  #rest() {
    const along = new THREE.Vector3(Math.sin(this.boxYaw), 0, Math.cos(this.boxYaw));
    const across = new THREE.Vector3(Math.cos(this.boxYaw), 0, -Math.sin(this.boxYaw));
    this.members.forEach((m, i) => {
      const at = this.wallPoint.clone()
        .addScaledVector(along, (i - 3.5) * 1.15)
        .addScaledVector(across, this.track.pit.side * 0.2);
      m.home = at.setY(this.boxPoint.y);
      m.root.position.copy(m.home);
      m.root.rotation.y = this.boxYaw - (this.track.pit.side * Math.PI) / 2;
    });
    this.spares.forEach((spare, i) => {
      spare.group.position.copy(this.wallPoint)
        .addScaledVector(along, (i === 0 ? 1.4 : -1.4))
        .setY(this.boxPoint.y + 0.33);
      spare.group.rotation.set(0, this.boxYaw, Math.PI / 2);
      spare.group.visible = true;
    });
  }

  // Standing, leaning on one hip, with a slow shift of weight.
  #idlePose(m, t) {
    const sway = Math.sin(t * 1.4 + m.swing) * 0.04;
    m.hips.position.y = 0.92 + sway * 0.1;
    m.hips.rotation.set(0, 0, sway * 0.4);
    m.chest.rotation.set(sway * 0.2, sway * 0.6, 0);
    for (const arm of m.arms) {
      arm.shoulder.rotation.set(sway * 0.5, 0, arm.side * 0.12);
      arm.elbow.rotation.set(-0.25 + sway, 0, 0);
    }
    for (const leg of m.legs) {
      leg.hip.rotation.set(0, 0, 0);
      leg.knee.rotation.set(0, 0, 0);
    }
  }

  // Crouched over a wheel: knees bent, body folded down, both arms forward.
  #workPose(m, t, effort) {
    const pump = Math.sin(t * 16) * 0.16 * effort;
    m.hips.position.y = lerp(0.92, 0.56, effort);
    m.hips.rotation.set(0, 0, 0);
    m.chest.rotation.set(lerp(0, 0.7, effort), 0, 0);
    for (const arm of m.arms) {
      arm.shoulder.rotation.set(lerp(0, -1.5, effort) + pump, 0, arm.side * 0.2);
      arm.elbow.rotation.set(lerp(-0.25, -0.75, effort) - pump, 0, 0);
    }
    for (const leg of m.legs) {
      leg.hip.rotation.set(lerp(0, -1.1, effort), 0, 0);
      leg.knee.rotation.set(lerp(0, 1.5, effort), 0, 0);
    }
  }

  // Bent at the waist with both arms down on the jack handle.
  #jackPose(m, t, effort) {
    const heave = Math.sin(t * 9) * 0.12 * effort;
    m.hips.position.y = lerp(0.92, 0.78, effort);
    m.chest.rotation.set(lerp(0, 0.95, effort) + heave * 0.3, 0, 0);
    for (const arm of m.arms) {
      arm.shoulder.rotation.set(lerp(0, -1.1, effort) - heave, 0, arm.side * 0.15);
      arm.elbow.rotation.set(lerp(-0.25, -0.2, effort), 0, 0);
    }
    for (const leg of m.legs) {
      leg.hip.rotation.set(lerp(0, -0.5, effort), 0, 0);
      leg.knee.rotation.set(lerp(0, 0.7, effort), 0, 0);
    }
  }

  // Both arms up, holding the board over the car.
  #signalPose(m, t, effort) {
    m.hips.position.y = 0.92;
    m.chest.rotation.set(0, 0, 0);
    for (const arm of m.arms) {
      arm.shoulder.rotation.set(lerp(0, -2.5, effort), 0, arm.side * 0.25);
      arm.elbow.rotation.set(lerp(-0.25, -0.1, effort), 0, 0);
    }
    for (const leg of m.legs) {
      leg.hip.rotation.set(0, 0, 0);
      leg.knee.rotation.set(0, 0, 0);
    }
  }

  // `car` is the car on the box, or null. `progress` is 0..1 through the stop.
  update(dt, car, progress = 0) {
    this.time += dt;
    const working = !!car;
    // A stop that ends — finished, or driven away from — gives the car its
    // wheels back exactly where they were.
    if (this.lastCar && this.lastCar !== car) {
      this.#restoreWheels(this.lastCar);
      this.lastCar.pitLift = 0;
    }
    this.lastCar = car;
    // Coming over the wall and going back again is itself an animation.
    const target = working ? 1 : 0;
    const speed = working ? 3.2 : 1.6;

    const along = car
      ? new THREE.Vector3(Math.sin(car.renderYaw), 0, Math.cos(car.renderYaw))
      : null;
    const across = car
      ? new THREE.Vector3(Math.cos(car.renderYaw), 0, -Math.sin(car.renderYaw))
      : null;

    // The stop, as a timeline. Jacks first, wheels off, wheels on, drop.
    const up = phase(progress, 0.05, 0.22) * (1 - phase(progress, 0.82, 0.96));
    const off = phase(progress, 0.2, 0.45);
    const on = phase(progress, 0.55, 0.78);
    this.jackLift = up * 0.13;

    for (const m of this.members) {
      m.out += clamp(target - m.out, -speed * dt, speed * dt);
      const outward = ease(m.out);

      if (car && outward > 0.001) {
        const at = car.renderPosition.clone()
          .addScaledVector(across, m.station.x)
          .addScaledVector(along, m.station.z)
          .setY(car.renderPosition.y - (car.pitLift ?? 0));
        m.root.position.lerpVectors(m.home, at, outward);
        // Facing the car they are working on.
        const face = Math.atan2(
          car.renderPosition.x - m.root.position.x,
          car.renderPosition.z - m.root.position.z);
        m.root.rotation.y = face;
      } else {
        m.root.position.lerp(m.home, Math.min(1, dt * 3));
        m.root.rotation.y = this.boxYaw - (this.track.pit.side * Math.PI) / 2;
      }

      // What they are doing once they get there.
      const effort = outward * (m.station.role === 'lollipop' ? 1 : up);
      if (effort < 0.01) {
        this.#idlePose(m, this.time);
        if (m.board) m.board.visible = false;
        continue;
      }
      if (m.station.role === 'wheel') {
        this.#workPose(m, this.time, effort * Math.max(off * (1 - on * 0.6), on));
      } else if (m.station.role === 'jack') {
        this.#jackPose(m, this.time, effort);
      } else if (m.station.role === 'lollipop') {
        this.#signalPose(m, this.time, outward);
        if (m.board) {
          m.board.visible = true;
          // The board comes down over the car and lifts away on release.
          m.board.rotation.x = lerp(1.35, 0.1, outward * (1 - phase(progress, 0.86, 1)));
        }
      } else {
        this.#workPose(m, this.time, effort * 0.7);
      }
    }

    this.#moveWheels(car, off, on, along, across);
  }

  // The wheels themselves: off the hub, out to the side, and a fresh set back
  // in. The car owns the wheel objects, so their resting place is remembered
  // once and restored the moment the stop ends.
  #moveWheels(car, off, on, along, across) {
    if (!car?.wheels) {
      for (const spare of this.spares) spare.group.visible = true;
      return;
    }
    for (const w of car.wheels) {
      w.home ??= w.pivot.position.x;
      const side = Math.sign(w.home) || 1;
      // Out while it is coming off, back in as the new one goes on.
      const outward = off * (1 - on);
      w.pivot.position.x = w.home + side * outward * 0.62;
      w.pivot.position.y = (w.baseY ??= w.pivot.position.y) + outward * 0.06;
      w.spin.rotation.x += outward * 0.35;
      w.pivot.visible = outward < 0.94;
    }
    // The spares are on the ground until the crew picks them up.
    for (const spare of this.spares) spare.group.visible = off < 0.2;
  }

  #restoreWheels(car) {
    for (const w of car.wheels ?? []) {
      if (w.home === undefined) continue;
      w.pivot.position.x = w.home;
      w.pivot.position.y = w.baseY ?? w.pivot.position.y;
      w.pivot.visible = true;
    }
  }

  dispose(scene) {
    scene.remove(this.group);
    this.group.traverse((node) => {
      node.geometry?.dispose();
      const mat = node.material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
    });
  }
}

export const PIT_SERVICE = PIT.service;
