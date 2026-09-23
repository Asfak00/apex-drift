import * as THREE from 'three';
import { Car } from './car.js';
import { PHYSICS_STEP } from './config.js';

// A vehicle's figures are measured, not written down: the same Car and the
// same physics the race runs are driven through a standing start, a stop from
// 100 km/h and a skidpad, headless, on an endless flat test ground. Change
// the setup and the numbers change because the car did.

// Flat, open, and grippy everywhere: every query the physics makes has an
// answer and none of them gets in the way.
const GROUND = {
  length: 1e6,
  checkpoints: [0, 0.25, 0.5, 0.75],
  roadHalf: 1e6,
  side: new THREE.Vector3(1, 0, 0),
  project(position) {
    return { index: 0, t: 0.5, lateral: position.x, height: 0, side: this.side };
  },
  drivable() { return true; },
  wallLimit() { return 1e9; },
  inPitLane() { return false; },
  inPitBox() { return false; },
  pitPhase() { return null; },
  frameAt() {
    return { pos: new THREE.Vector3(), side: this.side, tan: new THREE.Vector3(0, 0, 1) };
  },
};

const DT = PHYSICS_STEP;
const DRY = { grip: 1, wet: 0 };
const WET = { grip: 0.89, wet: 0.85 };
const CLIMATE = { air: 20, road: 30, standing: 0 };

const cars = new Map();

function testCar(key, chassis) {
  let car = cars.get(key);
  if (!car) {
    car = new Car(GROUND, { chassis, name: 'TEST' });
    cars.set(key, car);
  }
  return car;
}

function reset(car, speed = 0) {
  car.placeAt({ position: new THREE.Vector3(0, 0, 0), heading: 0, t: 0.5 });
  car.velocity.set(0, 0, speed);
  car.speed = speed;
  car.transfer.fill(0);
  car.lean = 0;
  car.lastAx = 0;
  car.latAccel = 0;
  car.tyres.fit(car.tyres.compound);
  car.brakes.reset(CLIMATE.air);
  car.boost.reserve = 0;
  car.input = { throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false };
}

function step(car, road = DRY) {
  car.update(DT, road.grip, road.wet, CLIMATE);
}

// Standing start: time to 100 and to 200 km/h, then on to the top speed,
// which is where the car stops gaining.
function acceleration(car) {
  reset(car);
  car.input.throttle = 1;
  let t = 0, t100 = null, t200 = null, top = 0, lastGain = 0;
  while (t < 90) {
    step(car);
    t += DT;
    const kmh = car.kmh;
    if (t100 === null && kmh >= 100) t100 = t;
    if (t200 === null && kmh >= 200) t200 = t;
    if (kmh > top + 0.05) { top = kmh; lastGain = t; }
    if (t - lastGain > 3) break;
  }
  return { t100, t200, top };
}

// Stop from 100 km/h, in metres.
function braking(car) {
  reset(car, 100 / 3.6);
  car.input.brake = 1;
  const start = car.position.clone();
  let t = 0;
  while (car.speed > 0.5 && t < 30) { step(car); t += DT; }
  return car.position.distanceTo(start);
}

// Skidpad: steering held, speed held at the target by the throttle, lateral
// acceleration averaged once it has settled. At full lock that is the
// vehicle's cornering limit. Part-way in, the slip angles give its
// understeer gradient: how many degrees more slip the front runs than the
// rear per g of cornering, the number a chassis engineer balances a car by.
function skidpad(car, road, kmh = 100, steer = 1) {
  const target = kmh / 3.6;
  reset(car, target);
  let t = 0, sum = 0, n = 0, slip = 0;
  while (t < 7) {
    const err = target - car.speed;
    car.input.throttle = Math.max(0, Math.min(1, 0.35 + err * 0.6));
    car.input.brake = err < -1.5 ? Math.min(1, -err * 0.2) : 0;
    car.input.steer = steer;
    step(car, road);
    t += DT;
    if (t > 5) {
      sum += Math.abs(car.latAccel ?? 0);
      const [f, r] = car.slipAngles ?? [0, 0];
      slip += Math.abs(f) - Math.abs(r);
      n += 1;
    }
  }
  const g = sum / Math.max(1, n) / 9.81;
  const deg = (slip / Math.max(1, n)) * (180 / Math.PI);
  return { g, gradient: g > 0.05 ? deg / g : 0 };
}

// Performance index from the measured figures, on a 100-999 scale: how
// quickly it accelerates, how fast it goes, how hard it corners, how short it
// stops. Nothing here is a number someone chose for the car.
function index({ t100, top, g, stop }) {
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const accel = clamp01((14 - (t100 ?? 14)) / 12);
  const speed = clamp01((top - 60) / 280);
  const corner = clamp01((g - 0.4) / 3.3);
  const brakes = clamp01((80 - stop) / 60);
  const pi = Math.round(100 + 899 * (0.3 * accel + 0.25 * speed + 0.3 * corner + 0.15 * brakes));
  const letter = pi >= 900 ? 'X' : pi >= 800 ? 'R' : pi >= 700 ? 'S' : pi >= 600 ? 'A'
    : pi >= 500 ? 'B' : pi >= 400 ? 'C' : 'D';
  return { pi, letter };
}

export function measure(key, chassis, setup) {
  const car = testCar(key, chassis);
  car.setSetup(setup);
  const acc = acceleration(car);
  const stop = braking(car);
  const dry = skidpad(car, DRY);
  const wet = skidpad(car, WET);
  const mid = skidpad(car, DRY, 80, 0.4);
  return {
    ...acc, stop, g: dry.g, wetG: wet.g, balance: mid.gradient,
    ...index({ t100: acc.t100, top: acc.top, g: dry.g, stop }),
  };
}
