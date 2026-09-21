// Tunables for the whole game. Every preset is data, never branching logic.

export const CAR = {
  mass: 1180,
  enginePower: 10200,      // N at full throttle, up to powerBand
  // Above this speed the engine is power-limited, so drive force falls off as
  // 1/v. A real car cannot pull its standing-start force at 160 km/h, and
  // pretending it can unloads the front axle far more than any car does.
  powerBand: 21,           // m/s (~76 km/h)
  brakePower: 15000,       // N
  reverseFactor: 0.42,
  dragCoeff: 0.68,         // air resistance
  rollResist: 7.4,         // rolling resistance
  halfWidth: 0.95,         // body half-width, used for barrier contact

  // Bicycle-model geometry: distance from the centre of mass to each axle.
  frontAxle: 1.24,
  rearAxle: 1.46,
  get wheelBase() { return this.frontAxle + this.rearAxle; },
  cogHeight: 0.44,         // drives load transfer under power and braking
  aeroBalance: 0.46,       // share of downforce carried by the front axle
  inertiaFactor: 0.24,     // yaw inertia = mass * wheelBase^2 * this

  maxSteer: 0.68,          // rad of lock at a standstill (~39 degrees)
  minSteer: 0.012,         // never less than this, however fast
  // How far past the grip limit full lock is allowed to ask. Above 1 the
  // driver can still provoke a slide; at 1 the car would only ever understeer.
  // Kept close to 1: at 1.4 the tyre curve was already falling away by the time
  // the input reached the stop, so holding full lock turned *less* sharply than
  // holding three quarters of it. Full input must be the strongest input.
  steerOverrun: 1.08,
  // The input is not the wheel angle. Raised to a power, a small movement asks
  // for a small share of the grip instead of most of it, which is what gives
  // the wheel a usable range at speed rather than everything in the first third.
  steerCurve: 1.35,
  steerRate: 6.8,          // rad/s the wheel itself can travel
  steerReturn: 8.0,        // rad/s the wheel self-centres when released

  // Lateral tyre curve: force = -muN * sin(C * atan(B * slipAngle)).
  // Peak grip lands near 0.22 rad of slip, then falls away into a slide.
  gripLat: 22.4,           // mechanical grip: peak lateral acceleration, m/s^2
  // Aerodynamic grip, in m/s^2 per (m/s)^2 of speed. Downforce rises with the
  // square of speed, so a fast car corners harder the faster it goes: this is
  // what stops the turning circle growing without limit at the top end.
  downforce: 0.0128,
  // Stiffer tyres: more force for a small slip angle, so the car answers the
  // wheel instead of leaning on it.
  tyreB: 12.5,
  tyreC: 1.42,
  // Aerodynamic and relaxation damping on yaw. Without it the car can chase
  // its own tail at speed and momentarily rotate against the steering.
  yawDamp: 0.15,
  // Road cars are built to run out of front grip before rear grip: the car
  // washes wide and stays pointing forwards instead of swapping ends.
  rearGripBias: 1.03,
  handbrakeGrip: 0.32,     // rear grip multiplier while the handbrake is held
  offTrackGrip: 0.52,
  offTrackDrag: 5.2,
  gearRatios: [0, 42, 76, 112, 152, 200], // km/h ceiling per gear
};

// Boost is a timed reserve, not a second throttle: it drains fast, refills
// slowly, and only refills while it is not being used.
export const BOOST = {
  thrust: 7600,      // extra N while held
  capacity: 3.2,     // seconds of boost when full
  drain: 1.0,        // seconds of reserve spent per second held
  refill: 0.34,      // seconds of reserve regained per second off boost
  delay: 0.9,        // seconds after release before refill starts
  minToStart: 0.35,  // cannot tap boost below this much reserve
  fovKick: 9,        // degrees of extra field of view at full boost
};

// Visions = time of day. Drive lighting, sky, fog tint, headlights.
export const VISIONS = {
  day:    { name:'Day',     sky:0x87b6e8, horizon:0xd8e6f4, sun:[0.45,0.85,0.30], sunColor:0xfff4e0,
            sunI:2.4, ambient:0xc8dcf0, ambI:1.05, fog:0xbcd4ec, fogNear:120, fogFar:620,
            groundTint:0x4a6b48, lights:false, exposure:1.0 },
  sunset: { name:'Sunset',  sky:0xff9a52, horizon:0xffd9a0, sun:[-0.85,0.16,0.38], sunColor:0xffb066,
            sunI:2.8, ambient:0xff9e78, ambI:0.72, fog:0xffae74, fogNear:80, fogFar:480,
            groundTint:0x5c5238, lights:true, exposure:1.05 },
  dusk:   { name:'Dusk',    sky:0x2c3e70, horizon:0x7b6ba8, sun:[-0.6,0.1,0.5], sunColor:0x8fa6ff,
            sunI:1.0, ambient:0x4a5a90, ambI:0.6, fog:0x3a4a78, fogNear:60, fogFar:400,
            groundTint:0x2e3a48, lights:true, exposure:1.15 },
  night:  { name:'Night',   sky:0x050a18, horizon:0x101d38, sun:[0.3,0.7,-0.4], sunColor:0x6f86c4,
            sunI:0.28, ambient:0x243356, ambI:0.34, fog:0x070d1c, fogNear:35, fogFar:260,
            groundTint:0x14202e, lights:true, exposure:1.35 },
  neon:   { name:'Neon',    sky:0x160a2e, horizon:0x4a1d6b, sun:[0.2,0.5,0.6], sunColor:0xff4fd8,
            sunI:0.9, ambient:0x5a2a8c, ambI:0.8, fog:0x2a0f45, fogNear:45, fogFar:330,
            groundTint:0x1e1038, lights:true, exposure:1.25 },
};

// Weather changes grip, visibility and particle field. Stacks on top of any vision.
// `grip` is what the road gives back, not what the car can use: how much of it
// reaches the tarmac is the tyres' business, and a driving axle that is already
// spending its grip on power has none of it left for the corner.
export const WEATHERS = {
  clear: { name:'Clear', grip:1.00, particle:null, count:0,
           fogScale:1.00, lightScale:1.00, wet:0.0, wind:0.0, lightning:false },
  rain:  { name:'Rain',  grip:0.89, particle:'rain', count:9000,
           fogScale:0.55, lightScale:0.62, wet:0.85, wind:0.22, lightning:false },
  storm: { name:'Storm', grip:0.80, particle:'rain', count:14000,
           fogScale:0.36, lightScale:0.40, wet:1.0, wind:0.55, lightning:true },
  fog:   { name:'Fog',   grip:0.95, particle:null, count:0,
           fogScale:0.20, lightScale:0.72, wet:0.25, wind:0.05, lightning:false },
  snow:  { name:'Snow',  grip:0.73, particle:'snow', count:7000,
           fogScale:0.42, lightScale:0.85, wet:0.35, wind:0.30, lightning:false },
};

export const MODES = {
  race:  { name:'Race',      laps:3, rivals:3, tyres:true, tyre:'soft',
           hint:'Three laps, three rivals. Position is scored on laps then checkpoint order.' },
  gp:    { name:'Grand Prix',laps:54, rivals:5, tyres:true, tyre:'medium', pit:true,
           hint:'Fifty-four laps. One set of tyres will not last: watch the wear and take the pit lane.' },
  trial: { name:'Time Trial',laps:3, rivals:0, tyres:false,
           hint:'Empty circuit. Chase your own best lap, nothing else on track.' },
  roam:  { name:'Free Roam', laps:0, rivals:2, tyres:false,
           hint:'No flag, no clock. Learn the circuit and swap skies and weather at will.' },
};

// The pit lane runs alongside the start/finish straight, outside the barrier
// line, and every circuit gets one in the same place relative to its own loop.
export const PIT = {
  entry: 0.885,        // t where the lane peels off
  exit: 0.075,         // t where it rejoins
  box: 0.985,          // t of the working box
  half: 4.6,           // half-width of the lane surface
  gap: 5.4,            // lane centre, measured out from the road edge
  limit: 22,           // m/s (~80 km/h) speed limit in the lane
  service: 2.6,        // seconds stationary in the box to change a set
};

export const CAMERAS = ['chase', 'hood', 'cinematic'];

// Physics runs on a fixed step and the renderer interpolates between them, so
// frame rate never changes how a car handles.
export const PHYSICS_STEP = 1 / 120;
export const MAX_STEPS = 8;

// Chassis variants. `drive` values multiply the CAR baseline; `body` drives the
// mesh proportions, so each one looks like what it drives like.
// Six car classes, each with its own body profile rather than one silhouette
// rescaled. `shape` selects the extruded side profile and the detailing that
// goes with it; `drive` scales the shared physics baseline; `body` sets the
// proportions both the mesh and the menu silhouette are built from.
//
// These are original cars in the classes real ones occupy. No marque names or
// licensed bodywork, which a game cannot ship without a licence.
export const CHASSIS = {
  gt: {
    name: 'Meridian GT', category: 'Front-engine grand tourer',
    shape: 'gt', scheme: 'stripes', engine: 'flat6', color: 0x1d3f74,
    blurb: 'Long bonnet, cabin set back over the rear axle. Heavy and planted; happiest leaning on a fast sweeper.',
    drive: { power: 1.10, mass: 1.12, grip: 0.98, steer: 0.90, brake: 1.02 },
    body: { width: 1.96, length: 4.74, roof: 0.52, ride: 0.56, wing: 0.40, nose: 1.5 },
  },
  mid: {
    name: 'Vermiglio V12', category: 'Mid-engine supercar',
    shape: 'mid', scheme: 'stripes', engine: 'v12', color: 0xb3121a,
    blurb: 'Cab-forward wedge with the engine behind your shoulders. Sharpest turn-in here, and the least patience.',
    drive: { power: 1.20, mass: 0.93, grip: 1.12, steer: 1.08, brake: 1.14 },
    body: { width: 2.04, length: 4.52, roof: 0.38, ride: 0.42, wing: 0.68, nose: 0.9 },
  },
  rear: {
    name: 'Kestrel RS', category: 'Rear-engine sports car',
    shape: 'rear', scheme: 'plain', engine: 'flat6', color: 0xdcdfe4,
    blurb: 'Weight behind the back axle and a fastback that never stops falling. Rotates hard, rewards patience on the throttle.',
    drive: { power: 1.08, mass: 0.96, grip: 1.06, steer: 1.12, brake: 1.06 },
    body: { width: 1.88, length: 4.32, roof: 0.44, ride: 0.48, wing: 0.34, nose: 0.95 },
  },
  rally: {
    name: 'Tarmac R4', category: 'Rally hatch',
    shape: 'rally', scheme: 'stripes', engine: 'turbo4', color: 0x2f7dc4,
    blurb: 'Tall, short and stubborn. Keeps the most grip once the surface turns loose.',
    drive: { power: 0.96, mass: 0.94, grip: 1.05, steer: 1.20, brake: 0.98 },
    body: { width: 1.84, length: 4.06, roof: 0.50, ride: 0.58, wing: 0.46, nose: 0.8 },
  },
  muscle: {
    name: 'Brawler 428', category: 'Muscle fastback',
    shape: 'muscle', scheme: 'stripes', engine: 'v8', color: 0xc46a12,
    blurb: 'Enormous bonnet, enormous torque, modest interest in corners. Straight-line weapon.',
    drive: { power: 1.26, mass: 1.20, grip: 0.90, steer: 0.84, brake: 0.92 },
    body: { width: 2.02, length: 4.96, roof: 0.46, ride: 0.58, wing: 0.30, nose: 1.72 },
  },
  hyper: {
    name: 'Volt Bolide', category: 'Track hypercar',
    shape: 'hyper', engine: 'hybrid', color: 0x1b9ff0, scheme: 'hyper',
    blurb: 'Carbon over electric blue, twin-plane wing, canards. The most downforce and the most speed, if you can hold it.',
    drive: { power: 1.30, mass: 0.90, grip: 1.20, steer: 1.06, brake: 1.22 },
    body: { width: 2.10, length: 4.70, roof: 0.34, ride: 0.36, wing: 1.35, nose: 1.35 },
  },
  proto: {
    name: 'Vanguard LMP', category: 'Closed prototype',
    shape: 'proto', scheme: 'hyper', engine: 'hybrid', color: 0x18c08a,
    blurb: 'Barely road-shaped. Vast downforce, knife-edge balance, and nothing spare when it lets go.',
    drive: { power: 1.16, mass: 0.86, grip: 1.18, steer: 1.02, brake: 1.20 },
    body: { width: 2.08, length: 4.66, roof: 0.38, ride: 0.34, wing: 1.25, nose: 1.6 },
  },
};

// Circuits. Control points are raw (x, z) metres; the rest changes how the
// circuit reads and how much grip it gives back.
export const TRACKS = {
  apex: {
    name: 'Apex Ring',
    crowd: 0.55, stands: [[0.80, 0.22]],
    blurb: 'The home circuit. Wide asphalt, one long straight, a hairpin and a banked sweeper.',
    surface: 'asphalt', roadHalf: 14.5, grip: 1.0, barriers: 'armco', music: 'circuit', bank: [3.4, 1.6],
    road: 0x2b2f38, ground: 0x4a6b48, hills: 0x3c5740, kerbs: true,
    // An esses section and a double apex, so the lap is not two long arcs.
    points: [
      [0, -260], [120, -244], [186, -196], [214, -140], [196, -86], [226, -40],
      [214, 26], [150, 52], [92, 36], [46, 74], [12, 126], [-24, 172],
      [-18, 224], [-84, 262], [-160, 254], [-214, 212], [-232, 150],
      [-196, 104], [-206, 46], [-250, 2], [-246, -68], [-204, -122],
      [-222, -178], [-160, -226], [-92, -246],
    ],
  },
  canyon: {
    name: 'Canyon Run',
    crowd: 0.12,
    blurb: 'Narrow concrete ledge cut through rock. Tight, fast, and there is nowhere to put a mistake.',
    surface: 'concrete', roadHalf: 11.5, grip: 0.95, barriers: 'concrete', music: 'desert', bank: [6.2, 2.8],
    road: 0x4a4e55, ground: 0x6b5340, hills: 0x7a5c44, kerbs: false,
    points: [
      [0, -200], [150, -190], [235, -120], [225, -20], [140, 25], [55, 80],
      [80, 175], [10, 250], [-95, 250], [-165, 185], [-140, 95], [-190, 25],
      [-260, -35], [-215, -130], [-120, -185],
    ],
  },
  dust: {
    name: 'Dust Bowl',
    crowd: 0.16,
    blurb: 'Loose dirt, wide and flowing. Everything slides, so carry the slide instead of fighting it.',
    surface: 'dirt', roadHalf: 17.0, grip: 0.72, barriers: 'none', music: 'desert', bank: [2.0, 1.1],
    road: 0x6b5233, ground: 0x8a7248, hills: 0x9a7f52, kerbs: false,
    points: [
      [0, -230], [130, -215], [225, -140], [250, -25], [175, 65], [45, 95],
      [-35, 165], [-60, 250], [-165, 270], [-255, 190], [-230, 75], [-270, -45],
      [-230, -155], [-125, -225],
    ],
  },
  town: {
    name: 'Old Town',
    crowd: 0.40,
    blurb: 'City streets. Long straights, square junctions, and 90-degree corners you have to brake for.',
    surface: 'asphalt', roadHalf: 11.0, grip: 0.97, barriers: 'pillars', music: 'street', bank: [0, 0], scenery: 'town',
    road: 0x33373f, ground: 0x4c5158, hills: 0x3d434c, kerbs: false,
    // A closed rectilinear loop: five rights and one left make the 360.
    segments: [
      ['straight', 92], ['cross'], ['straight', 92], ['right', 90, 28],
      ['straight', 104], ['right', 90, 28],
      ['straight', 24], ['left', 90, 28],
      ['straight', 64], ['right', 90, 28],
      ['straight', 104], ['cross'], ['right', 90, 28],
      ['straight', 112], ['cross'], ['straight', 112], ['right', 90, 28],
    ],
  },
  village: {
    name: 'Green Lane',
    crowd: 0.20,
    blurb: 'A country lane through farmland. Wide open, softer bends, and a long run between the hedges.',
    surface: 'asphalt', roadHalf: 9.0, grip: 0.93, barriers: 'fence', music: 'rural', bank: [1.6, 0.9], scenery: 'village',
    road: 0x3a3a36, ground: 0x5f7a44, hills: 0x4d6638, kerbs: false,
    segments: [
      ['straight', 116], ['tee', 'left'], ['straight', 116], ['right', 90, 34],
      ['straight', 172], ['tee', 'right'], ['right', 90, 34],
      ['straight', 62], ['right', 90, 34],
      ['straight', 52], ['left', 90, 34],
      ['straight', 102], ['right', 90, 34],
      ['straight', 52], ['right', 90, 34],
    ],
  },
  dock: {
    name: 'Dock Quarter',
    crowd: 0.35,
    blurb: 'Twelve corners and barely a straight. Left, right, left again — the circuit never lets you settle.',
    surface: 'asphalt', roadHalf: 10.5, grip: 0.96, bank: [0, 0], scenery: 'town',
    barriers: 'concrete', music: 'street',
    road: 0x30343c, ground: 0x474d55, hills: 0x3a4049, kerbs: true,
    // Eight rights and four lefts make the 360, and the axis lengths cancel,
    // so the loop closes exactly despite never running straight for long.
    segments: [
      ['straight', 68], ['cross'], ['straight', 68], ['right', 90, 22],
      ['straight', 76], ['left', 90, 22],
      ['straight', 56], ['right', 90, 22],
      ['straight', 96], ['right', 90, 22],
      ['straight', 76], ['left', 90, 22],
      ['straight', 56], ['cross'], ['right', 90, 22],
      ['straight', 116], ['right', 90, 22],
      ['straight', 96], ['right', 90, 22],
      ['straight', 46], ['left', 90, 22],
      ['straight', 56], ['left', 90, 22],
      ['straight', 46], ['right', 90, 22],
      ['straight', 76], ['right', 90, 22],
    ],
  },
  stadium: {
    name: 'Grand Stadium',
    blurb: 'A closed arena ringed by tiered galleries. Thirty thousand people, floodlights, and a roar you can feel through the wheel.',
    surface: 'asphalt', roadHalf: 13.5, grip: 1.0, barriers: 'concrete', music: 'circuit',
    bank: [2.2, 1.0], scenery: 'stadium', crowd: 1,
    road: 0x2a2e36, ground: 0x3a4a3c, hills: 0x333b44, kerbs: true,
    // Galleries run the whole way round, so the stands cover the entire loop.
    stands: [[0.0, 1.0]],
    points: [
      [0, -230], [118, -222], [196, -172], [224, -96], [212, -14],
      [232, 62], [188, 132], [110, 168], [24, 158], [-52, 182],
      [-108, 238], [-186, 240], [-248, 190], [-258, 112], [-222, 44],
      [-244, -34], [-246, -116], [-200, -186], [-118, -222],
    ],
  },
  night: {
    name: 'Harbour Mile',
    crowd: 0.45, stands: [[0.86, 0.14]],
    blurb: 'A short street loop of long straights and square corners. Heavy braking, hard on tyres.',
    surface: 'asphalt', roadHalf: 13.0, grip: 0.98, barriers: 'concrete', music: 'street', bank: [0.8, 0.4],
    road: 0x24272e, ground: 0x2f3742, hills: 0x39424f, kerbs: true,
    points: [
      [0, -180], [170, -180], [200, -145], [200, 80], [170, 115], [-40, 115],
      [-70, 150], [-70, 190], [-110, 225], [-200, 225], [-235, 190], [-235, -140],
      [-200, -180],
    ],
  },
};

export const PALETTE = {
  player: 0x18c08a,
  rivals: [0xb3121a, 0xc46a12, 0x1d3f74, 0xdcdfe4],
  road:   0x2b2f38,
  kerbA:  0xe8eef7,
  kerbB:  0xff5f5f,
};
