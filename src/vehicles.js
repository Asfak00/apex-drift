import { CAR } from './config.js';

// Every vehicle in the game runs on one physics core, one camera, one mixer
// and one race system. What makes a motorcycle a motorcycle and a bus a bus is
// data: a class profile that sets the physics, how the drive reaches the road,
// what powers it, how the camera and the engine note should treat it, and
// which parts of the simulation apply at all. Adding another kind of vehicle
// is adding a profile, not another code path.

// Share of the drive on the front axle.
export const DRIVETRAINS = { RWD: 0, FWD: 1, AWD: 0.4 };

// What each capability switches on. Anything a profile leaves out is off.
//   lean      balances on two wheels: corners by leaning, can wheelie/stoppie
//   diff      has a differential worth setting up (not a solid axle, not a bike)
//   aero      has wings the driver can adjust
//   gears     has a gearbox; without it the drive is a single speed
//   battery   runs on stored electricity: regenerative braking, no shifts
//   tilt      body rolls and pitches on its suspension
//   dark      carries no lamps
const CAR_CAPS = { diff: true, aero: true, gears: true, tilt: true };

// Chase camera numbers every car already used; the others scale from them.
const CAR_CAMERA = { back: 8.4, high: 3.5, look: 1.2, hood: 1.32, hoodForward: 0.35, roll: 0 };

// Class profiles. `physics` holds absolute values that replace the shared car
// baseline; the cars that were tuned against that baseline keep it untouched.
// `group` decides who races whom: rivals are drawn from the player's group.
export const CLASSES = {
  car: {
    name: 'Car', group: 'car', wheels: 4,
    drivetrain: 'RWD', powertrain: 'combustion', transmission: 'sequential',
    caps: CAR_CAPS, physics: {}, rollFront: 0.52, camera: CAR_CAMERA,
  },
  ev: {
    name: 'Electric car', group: 'car', wheels: 4,
    drivetrain: 'AWD', powertrain: 'electric', transmission: 'single-speed',
    caps: { ...CAR_CAPS, gears: false, battery: true },
    // A heavy battery set low in the floor: more mass, a lower centre, and
    // full torque from a standstill that runs out of revs well short of a
    // petrol car's top speed.
    physics: {
      mass: 1340, cogHeight: 0.38, enginePower: 11800, powerBand: 20, topLimit: 72,
      regen: 1.6, battery: 82,
    },
    rollFront: 0.53, camera: CAR_CAMERA,
  },
  suv: {
    name: 'SUV', group: 'utility', wheels: 4,
    drivetrain: 'AWD', powertrain: 'combustion', transmission: 'automatic',
    caps: { diff: true, gears: true, tilt: true },
    physics: {
      mass: 2150, frontAxle: 1.38, rearAxle: 1.50, cogHeight: 0.72,
      enginePower: 14200, powerBand: 18, brakePower: 21000, dragCoeff: 1.02,
      gripLat: 15.5, downforce: 0.0012, maxSteer: 0.62, steerRate: 5.2,
      inertiaFactor: 0.26, yawDamp: 0.22, topLimit: 65,
      gearRatios: [0, 38, 70, 102, 140, 180],
    },
    rollFront: 0.55,
    camera: { back: 9.6, high: 4.2, look: 1.6, hood: 1.85, hoodForward: 0.2, roll: 0 },
  },
  van: {
    name: 'Van', group: 'utility', wheels: 4,
    drivetrain: 'FWD', powertrain: 'combustion', transmission: 'automatic',
    caps: { diff: true, gears: true, tilt: true },
    physics: {
      mass: 2350, frontAxle: 1.50, rearAxle: 1.90, cogHeight: 0.95,
      enginePower: 10800, powerBand: 13, brakePower: 20000, dragCoeff: 1.32,
      gripLat: 13.5, downforce: 0, maxSteer: 0.6, steerRate: 4.6,
      inertiaFactor: 0.27, yawDamp: 0.26, topLimit: 46,
      gearRatios: [0, 32, 58, 86, 118, 150],
    },
    rollFront: 0.56,
    camera: { back: 10.2, high: 4.6, look: 1.9, hood: 2.05, hoodForward: 1.2, roll: 0 },
  },
  bus: {
    name: 'Bus', group: 'heavy', wheels: 4,
    drivetrain: 'RWD', powertrain: 'combustion', transmission: 'automatic',
    caps: { gears: true, tilt: true },
    // Twelve tonnes on a six-metre wheelbase: it turns wide, leans hard, and
    // stops from a long way out. The governor holds it at a road bus's speed.
    physics: {
      mass: 12000, frontAxle: 3.25, rearAxle: 2.75, cogHeight: 1.25,
      enginePower: 26000, powerBand: 9, brakePower: 72000, dragCoeff: 3.9,
      gripLat: 7.6, downforce: 0, maxSteer: 0.62, steerRate: 2.6, steerReturn: 3.2,
      inertiaFactor: 0.22, yawDamp: 0.4, topLimit: 27,
      reverseFactor: 0.3, gearRatios: [0, 18, 34, 52, 72, 100],
    },
    rollFront: 0.5,
    camera: { back: 19, high: 7.2, look: 2.6, hood: 2.55, hoodForward: 5.3, roll: 0 },
  },
  truck: {
    name: 'Truck', group: 'heavy', wheels: 6,
    drivetrain: 'RWD', powertrain: 'combustion', transmission: 'automatic',
    caps: { gears: true, tilt: true },
    physics: {
      mass: 8600, frontAxle: 1.55, rearAxle: 2.35, cogHeight: 1.3,
      enginePower: 27000, powerBand: 13, brakePower: 56000, dragCoeff: 3.4,
      gripLat: 8.0, downforce: 0, maxSteer: 0.6, steerRate: 2.9, steerReturn: 3.5,
      inertiaFactor: 0.25, yawDamp: 0.36, topLimit: 25,
      reverseFactor: 0.3, gearRatios: [0, 16, 30, 46, 64, 92],
    },
    rollFront: 0.48,
    camera: { back: 15.5, high: 6.4, look: 2.8, hood: 2.7, hoodForward: 1.7, roll: 0 },
  },
  kart: {
    name: 'Kart', group: 'kart', wheels: 4,
    drivetrain: 'RWD', powertrain: 'combustion', transmission: 'direct',
    // A solid rear axle and no suspension to speak of: nothing to set up in
    // the diff, and the chassis flex is the only roll there is. No lamps.
    caps: { gears: false, dark: true },
    physics: {
      mass: 165, frontAxle: 0.54, rearAxle: 0.51, cogHeight: 0.24,
      enginePower: 1450, powerBand: 13.5, brakePower: 1500, dragCoeff: 0.46,
      gripLat: 21, downforce: 0, maxSteer: 0.5, steerRate: 7.5, steerReturn: 9,
      inertiaFactor: 0.2, yawDamp: 0.12, topLimit: 38, rollResist: 5.5,
      tyreB: 14, tyreC: 1.45, reverseFactor: 0, gearRatios: [0, 200],
    },
    rollFront: 0.5,
    camera: { back: 4.8, high: 1.7, look: 0.45, hood: 0.72, hoodForward: -0.3, roll: 0 },
  },
  moto: {
    name: 'Motorcycle', group: 'bike', wheels: 2,
    drivetrain: 'RWD', powertrain: 'combustion', transmission: 'sequential',
    // Two wheels in line. Cornering force needs lean, so the bike has to roll
    // into a corner before it can turn; hard acceleration lifts the front and
    // hard braking lifts the rear, and those are the limits, not tyre grip.
    caps: { lean: true, gears: true },
    physics: {
      mass: 275, frontAxle: 0.72, rearAxle: 0.70, cogHeight: 0.66,
      enginePower: 3400, powerBand: 44, brakePower: 3300, dragCoeff: 0.26,
      gripLat: 17.5, downforce: 0.0006, maxSteer: 0.5, steerRate: 5,
      inertiaFactor: 0.2, yawDamp: 0.16, topLimit: 84, rollResist: 3.2,
      maxLean: 1.05, leanRate: 2.4, reverseFactor: 0,
      gearRatios: [0, 72, 118, 158, 196, 236],
    },
    rollFront: 0.5,
    camera: { back: 5.8, high: 2.2, look: 1.0, hood: 1.34, hoodForward: -0.15, roll: 0.55 },
  },
};

export function classOf(chassis) {
  return CLASSES[chassis?.class] ?? CLASSES.car;
}

// --- setup ------------------------------------------------------------------
// The parameters a driver can change, each one a real input to the physics.
// `needs` names the capability a parameter depends on.
export const SETUP_PARAMS = [
  { key: 'rideHeight', group: 'Suspension', label: 'Ride height', unit: 'mm',
    min: -20, max: 30, step: 1, def: 0, needs: 'tilt' },
  { key: 'stiffness', group: 'Suspension', label: 'Spring rate', unit: '%',
    min: 70, max: 140, step: 1, def: 100, needs: 'tilt' },
  { key: 'damping', group: 'Suspension', label: 'Damping', unit: '%',
    min: 60, max: 140, step: 1, def: 100, needs: 'tilt' },
  { key: 'rollFront', group: 'Suspension', label: 'Front roll stiffness', unit: '%',
    min: 35, max: 70, step: 1, def: (cls) => Math.round(cls.rollFront * 100), needs: 'tilt' },
  { key: 'diffAccel', group: 'Differential', label: 'Power lock', unit: '%',
    min: 20, max: 100, step: 1, def: 100, needs: 'diff' },
  { key: 'diffDecel', group: 'Differential', label: 'Coast lock', unit: '%',
    min: 0, max: 100, step: 1, def: 50, needs: 'diff' },
  { key: 'finalDrive', group: 'Gearbox', label: 'Final drive', unit: '×',
    min: 0.85, max: 1.2, step: 0.01, def: 1 },
  { key: 'pressureFront', group: 'Tyres', label: 'Front pressure (cold)', unit: 'psi',
    min: 20, max: 32, step: 0.5, def: 26 },
  { key: 'pressureRear', group: 'Tyres', label: 'Rear pressure (cold)', unit: 'psi',
    min: 20, max: 32, step: 0.5, def: 26 },
  { key: 'wing', group: 'Aero', label: 'Downforce', unit: '%',
    min: 60, max: 140, step: 1, def: 100, needs: 'aero' },
  { key: 'aeroBalance', group: 'Aero', label: 'Aero balance (front)', unit: '%',
    min: 38, max: 54, step: 1, def: 46, needs: 'aero' },
  { key: 'brakeBias', group: 'Brakes', label: 'Brake bias (front)', unit: '%',
    min: 52, max: 74, step: 1, def: 62 },
  { key: 'brakePressure', group: 'Brakes', label: 'Brake pressure', unit: '%',
    min: 80, max: 110, step: 1, def: 100 },
  { key: 'steerLock', group: 'Steering', label: 'Steering lock', unit: '%',
    min: 85, max: 115, step: 1, def: 100 },
];

export function paramsFor(chassis) {
  const cls = classOf(chassis);
  return SETUP_PARAMS.filter((p) => !p.needs || cls.caps[p.needs]);
}

export function defaultSetup(chassis) {
  const cls = classOf(chassis);
  const out = {};
  for (const p of SETUP_PARAMS) out[p.key] = typeof p.def === 'function' ? p.def(cls) : p.def;
  return out;
}

// Simple mode: five controls a driver can reason about, each moving several
// real parameters together. -1 and +1 are the ends of each slider.
export const SIMPLE = [
  { key: 'balance', label: 'Balance', ends: ['Stable', 'Agile'], needs: 'tilt' },
  { key: 'downforce', label: 'Downforce', ends: ['Low drag', 'High grip'], needs: 'aero' },
  { key: 'gearing', label: 'Gearing', ends: ['Acceleration', 'Top speed'] },
  { key: 'brakes', label: 'Brake bias', ends: ['Rear', 'Front'] },
  { key: 'stiffness', label: 'Suspension', ends: ['Soft', 'Stiff'], needs: 'tilt' },
];

export function simpleFor(chassis) {
  const cls = classOf(chassis);
  return SIMPLE.filter((s) => !s.needs || cls.caps[s.needs]);
}

export function fromSimple(chassis, simple) {
  const base = defaultSetup(chassis);
  const v = (k) => Math.max(-1, Math.min(1, simple[k] ?? 0));
  const b = v('balance');
  return {
    ...base,
    // More agile: softer front roll stiffness and more front downforce give
    // the front axle the grip, a more open diff lets the car rotate on power.
    rollFront: base.rollFront - 10 * b,
    aeroBalance: base.aeroBalance + 4 * b,
    diffAccel: Math.min(100, base.diffAccel - 30 * Math.max(0, b)),
    wing: base.wing + 35 * v('downforce'),
    finalDrive: +(base.finalDrive - 0.12 * v('gearing')).toFixed(2),
    brakeBias: base.brakeBias + 6 * v('brakes'),
    stiffness: base.stiffness + 35 * v('stiffness'),
    damping: base.damping + 30 * v('stiffness'),
    rideHeight: Math.round(base.rideHeight - 10 * v('stiffness')),
  };
}

// Named setups. Each is a simple-mode position plus the few parameters simple
// mode does not reach.
export const PRESETS = {
  balanced: { name: 'Balanced', simple: {} },
  grip: { name: 'Grip', simple: { balance: -0.1, downforce: 0.6, gearing: -0.2, brakes: 0.1, stiffness: 0.5 },
    extra: { pressureFront: 25, pressureRear: 25 } },
  drift: { name: 'Drift', simple: { balance: 0.7, downforce: -0.5, gearing: -0.4, brakes: -0.3, stiffness: 0.3 },
    extra: { diffAccel: 100, diffDecel: 80, pressureRear: 30.5, steerLock: 115 } },
  speed: { name: 'Speed', simple: { downforce: -0.8, gearing: 0.8, stiffness: 0.4 } },
  wet: { name: 'Wet', simple: { balance: -0.3, downforce: 0.8, gearing: -0.1, brakes: 0.4, stiffness: -0.6 },
    extra: { pressureFront: 24, pressureRear: 24, rideHeight: 15, diffAccel: 55 } },
  track: { name: 'Track', simple: { balance: 0.1, downforce: 0.9, gearing: -0.3, brakes: 0.2, stiffness: 0.8 },
    extra: { rideHeight: -15 } },
};

export function presetSetup(chassis, key) {
  const preset = PRESETS[key] ?? PRESETS.balanced;
  return clampSetup(chassis, { ...fromSimple(chassis, preset.simple), ...(preset.extra ?? {}) });
}

export function clampSetup(chassis, setup) {
  const out = { ...defaultSetup(chassis) };
  for (const p of SETUP_PARAMS) {
    const v = Number(setup?.[p.key]);
    if (Number.isFinite(v)) out[p.key] = Math.min(p.max, Math.max(p.min, v));
  }
  return out;
}

// --- the tune ---------------------------------------------------------------
// Everything the physics reads for one vehicle with one setup. The first half
// is the class and the chassis; the second is what the driver changed, each
// adjustment folded into the quantity it actually changes.
export function tuneFor(chassis, setup = null) {
  const cls = classOf(chassis);
  const base = { ...CAR, topLimit: 120, regen: 0, battery: 0, maxLean: 0, leanRate: 0, ...cls.physics };
  const d = chassis.drive;
  const s = clampSetup(chassis, setup ?? {});
  const def = defaultSetup(chassis);
  const tune = {
    ...base,
    wheelBase: base.frontAxle + base.rearAxle,
    mass: base.mass * d.mass,
    enginePower: base.enginePower * d.power,
    brakePower: base.brakePower * d.brake,
    gripLat: base.gripLat * d.grip,
    maxSteer: base.maxSteer * d.steer,
    halfWidth: chassis.body.width / 2,
    trackWidth: chassis.body.width * 0.84,
    // A bigger wing is more downforce, so the aero cars are the ones that
    // keep turning when everything else has run out of corner.
    downforce: base.downforce * (0.55 + chassis.body.wing * 0.6) * d.grip,
    caps: cls.caps,
    lean: !!cls.caps.lean,
    driveFront: DRIVETRAINS[cls.drivetrain] ?? 0,
    electric: cls.powertrain === 'electric',
  };

  // Ride height moves the centre of gravity with it, and on a car with a
  // floor that works, a lower car makes more downforce.
  tune.cogHeight0 = tune.cogHeight;
  tune.cogHeight += (s.rideHeight / 1000) * 0.9;
  if (cls.caps.aero) {
    tune.downforce *= (1 - s.rideHeight * 0.003) * (s.wing / 100);
    // A wing that makes more downforce drags more air behind it.
    tune.dragCoeff *= 1 + 0.22 * (s.wing / 100 - 1);
    tune.aeroBalance = s.aeroBalance / 100;
  }
  // Roll stiffness split and how quickly load moves across the car. Stiffer
  // springs and firmer dampers move it sooner; the defaults are kept beside
  // them because grip is measured against the car as it came.
  tune.rollFront = s.rollFront / 100;
  tune.rollFront0 = def.rollFront / 100;
  tune.rollTau = 0.11 / ((s.stiffness / 100) ** 0.8 * (s.damping / 100) ** 0.6);
  tune.rollTau0 = 0.11;
  tune.rollScale = 100 / s.stiffness;
  tune.diffAccel = s.diffAccel / 100;
  tune.diffDecel = s.diffDecel / 100;
  tune.diffAccel0 = def.diffAccel / 100;
  tune.diffDecel0 = def.diffDecel / 100;
  tune.finalDrive = s.finalDrive;
  tune.gearRatios = base.gearRatios.map((k) => k / s.finalDrive);
  tune.pressure = [s.pressureFront, s.pressureRear];
  tune.brakeBias = s.brakeBias / 100;
  tune.brakePower *= s.brakePressure / 100;
  tune.maxSteer *= s.steerLock / 100;
  tune.setup = s;
  return tune;
}

// Collision hull: a row of circles along the body, as wide as the vehicle.
// One circle fits a car badly and a bus not at all.
export function hullFor(body, centerZ = 0) {
  const r = Math.max(0.3, body.width * 0.5);
  const n = Math.max(1, Math.round(body.length / body.width));
  const span = Math.max(0, body.length / 2 - r);
  return Array.from({ length: n }, (_, i) => ({
    offset: centerZ + (n === 1 ? 0 : -span + (2 * span * i) / (n - 1)), radius: r,
  }));
}
