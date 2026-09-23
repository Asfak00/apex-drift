import * as THREE from 'three';

// The state of the road itself, as numbers the physics reads and the surface
// shows. A circuit is not the same place twice: it warms in the sun and cools
// under cloud, holds water after rain and dries off slowly, rubbers in along
// the line cars actually drive, and gathers dust where nobody drives at all.
//
// Everything is anchored to the grip the weather table was tuned for: on a
// road that has settled into the conditions, with no rubber down, road grip is
// the table's number. Temperature acts through the tyres. The
// model only moves grip away from that as the road itself changes, so the AI's
// corner speeds and every existing balance still hold at the start.

// Lengthwise resolution of rubber, driven line and debris. ~15-30 m a segment
// on the circuits in the game, which is about the size of a braking zone.
export const BINS = 128;

// Layer the road is also drawn on, for the reflection pass's mask. The main
// camera never looks at it on its own; the road simply lives on both.
export const REFLECT_LAYER = 6;
const SAVE_VERSION = 1;

// Air temperature by time of day, then what the weather takes off it.
const AMBIENT = { day: 24, sunset: 19, dusk: 15, night: 12, neon: 14 };
const WEATHER_AIR = { clear: 0, rain: -4, storm: -6, fog: -3, snow: -20 };

// Water on the surface. A damp road costs a little; standing water, which is
// what the tyre has to push out of the way, costs most.
const DAMP_COST = 0.09;
const STANDING_COST = 0.2;
const waterGrip = (wet, standing) => 1 - wet * DAMP_COST - standing * STANDING_COST;

// How much water stands once a given weather has set in: none until the rain
// is heavy enough to beat the drainage.
const settledStanding = (wet) => Math.max(0, wet - 0.75) * 2.2;

const clamp01 = (v) => Math.min(1, Math.max(0, v));

// --- puddles -----------------------------------------------------------
// Where water stands is decided by one function that runs twice: in the road
// shader, which draws the water, and here, which tells the tyres they are in
// it. Both use the same integer hash, so what a driver sees and what the car
// feels are the same puddle. Water gathers at the road's edges (the camber
// drains it there) and in the circuit's low points; as the standing water
// rises it floods lower-lying ground first and spreads.
export const PUDDLE_GLSL = `
  uint puddleHash(ivec2 c) {
    uint x = uint(c.x) * 1597334677u ^ uint(c.y) * 3812015801u;
    x = (x ^ (x >> 16u)) * 2246822519u;
    x ^= x >> 13u;
    return x;
  }
  float puddleRand(ivec2 c) { return float(puddleHash(c) & 16777215u) / 16777215.0; }
  float puddleNoise(vec2 p) {
    ivec2 i = ivec2(floor(p));
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = puddleRand(i), b = puddleRand(i + ivec2(1, 0));
    float c = puddleRand(i + ivec2(0, 1)), d = puddleRand(i + ivec2(1, 1));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  // xz: world position; across: 0 at one road edge, 1 at the other; low: how
  // far this stretch sits below its surroundings, 0 to 1; standing: 0 to 1.
  float puddleAt(vec2 xz, float across, float low, float standing) {
    float site = puddleNoise(xz * 0.11) * 0.6 + puddleNoise(xz * 0.37 + vec2(17.0, 31.0)) * 0.4;
    float edge = pow(clamp(abs(across - 0.5) * 2.0, 0.0, 1.0), 4.0);
    site += edge * 0.22 + low * 0.3;
    float level = 1.3 - standing;
    return smoothstep(level, level + 0.06, site) * smoothstep(0.02, 0.1, standing);
  }
`;

function puddleRand(x, y) {
  let h = (Math.imul(x | 0, 1597334677) ^ Math.imul(y | 0, 3812015801 | 0)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 2246822519 | 0) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  return (h & 16777215) / 16777215;
}

function puddleNoise(px, py) {
  const ix = Math.floor(px), iy = Math.floor(py);
  let fx = px - ix, fy = py - iy;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const a = puddleRand(ix, iy), b = puddleRand(ix + 1, iy);
  const c = puddleRand(ix, iy + 1), d = puddleRand(ix + 1, iy + 1);
  return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
}

const smooth = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

export function puddleAt(x, z, across, low, standing) {
  let site = puddleNoise(x * 0.11, z * 0.11) * 0.6
    + puddleNoise(x * 0.37 + 17, z * 0.37 + 31) * 0.4;
  const edge = clamp01(Math.abs(across - 0.5) * 2) ** 4;
  site += edge * 0.22 + low * 0.3;
  const level = 1.3 - standing;
  return smooth(level, level + 0.06, site) * smooth(0.02, 0.1, standing);
}
const approach = (v, target, rate, dt) => v + (target - v) * (1 - Math.exp(-rate * dt));

export class TrackCondition {
  constructor() {
    this.track = null;
    this.rubber = new Float32Array(BINS);
    this.line = new Float32Array(BINS).fill(0.5);
    this.lineWeight = new Float32Array(BINS);
    this.debris = new Float32Array(BINS);
    this.temperature = 24;
    this.air = 20;
    this.wetness = 0;
    this.standingWater = 0;
    this.dust = 0.2;
    this.trend = 0;           // + wetting, - drying, for the HUD
    this.surfaceDirty = true;
    this.paintClock = 0;
    this.saveClock = 0;
    this.weather = null;
    // Shared with every shader that draws or reflects the road's water.
    this.uniforms = {
      uStanding: { value: 0 },
      uWet: { value: 0 },
      uRain: { value: 0 },
      uTime: { value: 0 },
    };
    this.lowness = null;
  }

  // One number for "how far this road has come": rubber laid across the lap.
  get evolution() {
    let sum = 0;
    for (let i = 0; i < BINS; i++) sum += this.rubber[i];
    return sum / BINS;
  }

  // --- circuit -----------------------------------------------------------
  // The condition belongs to a circuit, so swapping circuits files the old
  // one away and brings the new one's history back.
  setTrack(track, key) {
    if (this.track === track) return;
    if (this.track) this.save();
    this.track = track;
    this.#load(key ?? track.spec.name);
    this.#attachSurface(track);
    this.surfaceDirty = true;
  }

  // Called when conditions are chosen from the menu rather than changed on
  // track: the road is taken to have been out in that weather for a while.
  // Water only ever goes up here; a road that is wetter than the new weather
  // keeps its water and dries from there.
  settle(weather, vision, visionKey, weatherKey) {
    this.weather = weather;
    this.air = this.#airTemperature(visionKey, weatherKey);
    this.wetness = Math.max(this.wetness, weather.wet);
    this.standingWater = Math.max(this.standingWater, settledStanding(weather.wet));
    this.uniforms.uStanding.value = this.standingWater;
    this.uniforms.uWet.value = this.wetness;
    this.uniforms.uRain.value = weather.particle === 'rain' ? weather.wet : 0;
    this.temperature = this.#targetTemperature(weather, vision, visionKey, weatherKey);
    this.surfaceDirty = true;
  }

  #airTemperature(visionKey, weatherKey) {
    return (AMBIENT[visionKey] ?? 20) + (WEATHER_AIR[weatherKey] ?? 0);
  }

  #targetTemperature(weather, vision, visionKey, weatherKey) {
    const air = this.#airTemperature(visionKey, weatherKey);
    const [sx, sy, sz] = vision.sun;
    const elevation = Math.max(0, sy / Math.hypot(sx, sy, sz));
    // A lit circuit at night is lit by lamps, which warm nothing.
    const solar = vision.lights ? 0 : vision.sunI * elevation * weather.lightScale * 7;
    return air + solar - this.wetness * 3;
  }

  // --- simulation --------------------------------------------------------
  update(dt, { weather, vision, visionKey, weatherKey }) {
    this.weather = weather;
    this.air = this.#airTemperature(visionKey, weatherKey);
    const raining = weather.wet;
    const before = this.wetness;

    // Water arrives faster than it leaves. A shower wets the road in about a
    // minute; drying takes several, and a warm surface dries faster.
    if (raining > this.wetness) {
      this.wetness = approach(this.wetness, raining, 0.025 + raining * 0.02, dt);
    } else {
      const warmth = clamp01((this.temperature - 5) / 35);
      this.wetness = approach(this.wetness, raining, 0.004 + warmth * 0.008, dt);
    }
    // Water only stands once the surface is saturated, and pools slowly.
    const standing = settledStanding(raining) * clamp01((this.wetness - 0.6) / 0.4);
    this.standingWater = approach(this.standingWater, standing,
      standing > this.standingWater ? 0.01 : 0.009, dt);
    this.trend = Math.sign(this.wetness - before) * (Math.abs(this.wetness - before) > dt * 1e-4 ? 1 : 0);

    // Surface temperature follows the sky with a lag; water pulls it down
    // quickly.
    const target = this.#targetTemperature(weather, vision, visionKey, weatherKey);
    this.temperature = approach(this.temperature, target, 1 / 180 + this.wetness / 50, dt);

    // Dust settles on a dry road over half an hour; rain lays it.
    this.dust = clamp01(this.dust + dt * ((1 - this.wetness) / 1800 - this.wetness / 60));

    // Loose material off the verges is swept away by the cars and the wind.
    for (let i = 0; i < BINS; i++) {
      if (this.debris[i] > 0) this.debris[i] = Math.max(0, this.debris[i] - dt / 45);
    }

    this.uniforms.uStanding.value = this.standingWater;
    this.uniforms.uWet.value = this.wetness;
    this.uniforms.uRain.value = weather.particle === 'rain' ? weather.wet : 0;
    this.uniforms.uTime.value += dt;

    this.paintClock += dt;
    this.saveClock += dt;
    if (this.saveClock > 30) { this.saveClock = 0; this.save(); }
  }

  // What a car does to the road this tick: rubber where it works the tyres,
  // the line it takes across the surface, and dirt carried back from the verge.
  drive(dt, car) {
    if (!this.track) return;
    const p = this.track.project(car.position, car.hintIndex);
    const across = clamp01((p.lateral / this.track.roadHalf + 1) / 2);
    car.puddle = this.puddleUnder(car.position, p.t, across);
    if (car.kmh < 15) return;
    const bin = Math.min(BINS - 1, Math.floor(p.t * BINS));
    if (!car.onRoad) {
      car.wasOff = true;
      return;
    }
    if (car.wasOff) {
      // Back on the road with the verge in the tread: the next stretch is dirty.
      this.debris[bin] = Math.min(1, this.debris[bin] + 0.5);
      car.wasOff = false;
    }
    // Rubber is laid by load, not by presence: a car cruising lays almost
    // none, a car sliding or braking at the limit lays most.
    const work = 0.3 * Math.min(1, car.kmh / 180) + Math.min(2, (car.slide ?? 0) * 0.25)
      + (car.lockup ?? 0);
    const amount = dt * 0.004 * work * (1 - this.wetness * 0.8);
    this.rubber[bin] = Math.min(1, this.rubber[bin] + amount * (1 - this.rubber[bin]));
    // Wheels scrub dust off the line they use.
    this.debris[bin] = Math.max(0, this.debris[bin] - dt * 0.05);

    // The line is where the rubber went, weighted by how much of it.
    const weight = Math.min(60, this.lineWeight[bin]);
    const k = amount / (weight * 0.004 + amount + 1e-6);
    this.line[bin] += (across - this.line[bin]) * k;
    this.lineWeight[bin] = weight + amount / 0.004;
    this.surfaceDirty = true;
  }

  // Standing water under a point of the road: the same function the road
  // shader draws with.
  puddleUnder(position, t, across) {
    if (!this.lowness || this.standingWater < 0.02) return 0;
    const n = this.lowness.length - 1;
    const low = this.lowness[Math.round(t * n) % n];
    return puddleAt(position.x, position.z, across, low, this.standingWater);
  }

  // --- what the tyres feel -----------------------------------------------
  #binOf(car) {
    const n = this.track?.points.length ?? 1;
    return Math.min(BINS - 1, Math.floor(((car.hintIndex ?? 0) / n) * BINS));
  }

  // Road grip under one car, as a multiplier on its tyres. The weather's
  // tuned figure, adjusted by the water actually on the road, the surface
  // temperature, rubber, dust and debris at the car's stretch of the lap.
  gripFor(car) {
    const w = this.weather;
    if (!w) return 1;
    const settled = waterGrip(w.wet, settledStanding(w.wet));
    const base = Math.min(1, w.grip / settled);
    const water = waterGrip(this.wetness, this.standingWater);
    const bin = this.#binOf(car);
    const rubber = this.rubber[bin];
    // Rubber bites on a dry road and turns greasy in the wet.
    const line = 1 + rubber * (0.035 * (1 - this.wetness) - 0.05 * this.wetness);
    const dust = 1 - this.dust * 0.03 * (1 - rubber);
    const debris = 1 - this.debris[bin] * 0.06;
    // A tyre in standing water is riding on it, not on the road.
    const puddle = 1 - (car.puddle ?? 0) * 0.2;
    // Temperature is not here: it acts through the tyres, which take heat
    // from a warm road and lose it to a cold one (see TyreSet.heat).
    return base * water * line * dust * debris * puddle;
  }

  // Temperatures and water the tyres and brakes exchange heat with.
  get climate() {
    return { air: this.air, road: this.temperature, standing: this.standingWater };
  }

  // One word for the HUD.
  get state() {
    if (this.standingWater > 0.15) return 'STANDING WATER';
    if (this.wetness > 0.6) return 'WET';
    if (this.wetness > 0.12) return this.trend < 0 ? 'DRYING' : 'DAMP';
    return 'DRY';
  }

  // --- the surface -------------------------------------------------------
  // Rubber and the driven line are drawn into the road itself: a darker, more
  // polished band where cars have actually been, following whatever line they
  // took. Two floats per road vertex, updated about once a second.
  #attachSurface(track) {
    const geo = track.road?.geometry;
    const mat = track.roadMaterial;
    if (!geo || !mat) return;
    const count = geo.attributes.position.count;
    const samples = count / 2 - 1;
    // How far each stretch sits below the road around it: water runs downhill
    // and stands in the dips.
    const pos = geo.attributes.position.array;
    const height = new Float32Array(samples + 1);
    for (let s = 0; s <= samples; s++) height[s] = (pos[s * 6 + 1] + pos[s * 6 + 4]) / 2;
    this.lowness = new Float32Array(samples + 1);
    const reach = 20;
    for (let s = 0; s <= samples; s++) {
      let sum = 0;
      for (let k = -reach; k <= reach; k++) sum += height[((s + k) % samples + samples) % samples];
      this.lowness[s] = clamp01((sum / (reach * 2 + 1) - height[s]) / 0.6);
    }
    this.surface = new THREE.BufferAttribute(new Float32Array(count * 4), 4);
    for (let v = 0; v < count; v++) {
      this.surface.array[v * 4] = v % 2;
      this.surface.array[v * 4 + 3] = this.lowness[Math.floor(v / 2)];
    }
    geo.setAttribute('aRubber', this.surface);
    // The reflection pass draws the road again into its mask.
    track.road.layers.enable(REFLECT_LAYER);
    const uniforms = this.uniforms;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          attribute vec4 aRubber;
          varying vec4 vRubber;
          varying vec2 vWaterXZ;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vRubber = aRubber;
          vWaterXZ = (modelMatrix * vec4(transformed, 1.0)).xz;`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec4 vRubber;
          varying vec2 vWaterXZ;
          uniform float uStanding;
          uniform float uRain;
          uniform float uTime;
          float gPuddle = 0.0;
          ${PUDDLE_GLSL}
          float rubberBand() {
            float d = (vRubber.x - vRubber.z) / 0.14;
            return exp(-d * d) * vRubber.y;
          }
          // Rings from raindrops landing in standing water, one drop per
          // half-metre cell at a time, as a slope in world x and z.
          vec2 rainRipple(vec2 p, float t) {
            vec2 cell = floor(p);
            ivec2 c = ivec2(cell);
            float phase = fract(t * 1.3 + puddleRand(c));
            vec2 centre = vec2(puddleRand(c + ivec2(7, 3)), puddleRand(c + ivec2(11, 5))) * 0.4 + 0.3;
            vec2 d = fract(p) - centre;
            float r = length(d);
            float front = phase * 0.3;
            float ring = sin((r - front) * 70.0) * smoothstep(0.06, 0.0, abs(r - front)) * (1.0 - phase);
            return d / max(r, 1e-3) * ring;
          }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          gPuddle = puddleAt(vWaterXZ, vRubber.x, vRubber.w, uStanding);
          // Water over asphalt: darker, and the aggregate no longer shows.
          diffuseColor.rgb *= (1.0 - rubberBand() * 0.2) * (1.0 - gPuddle * 0.45);`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          roughnessFactor *= 1.0 - rubberBand() * 0.12;
          roughnessFactor = mix(roughnessFactor, 0.03, gPuddle);`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
          // Standing water is flat: it fills the texture of the road, and
          // only the rain breaks it up.
          normal = normalize(mix(normal, nonPerturbedNormal, gPuddle));
          if (gPuddle > 0.01 && uRain > 0.01) {
            vec2 slope = rainRipple(vWaterXZ * 2.0, uTime) * uRain * gPuddle;
            normal = normalize(normal + (viewMatrix * vec4(slope.x, 0.0, slope.y, 0.0)).xyz * 0.35);
          }`);
    };
    mat.customProgramCacheKey = () => 'road-water';
    mat.needsUpdate = true;
  }

  // Push the numbers into the road vertices. Cheap, but not every frame.
  paint() {
    if (!this.surface || !this.surfaceDirty || this.paintClock < 1) return false;
    this.paintClock = 0;
    this.surfaceDirty = false;
    const arr = this.surface.array;
    const verts = this.surface.count;
    const samples = verts / 2 - 1;
    for (let s = 0; s <= samples; s++) {
      // Sample between bins so the band fades along the lap, not in steps.
      const f = ((s % samples) / samples) * BINS - 0.5;
      const i0 = (Math.floor(f) + BINS) % BINS;
      const i1 = (i0 + 1) % BINS;
      const k = f - Math.floor(f);
      const rubber = this.rubber[i0] * (1 - k) + this.rubber[i1] * k;
      const line = this.line[i0] * (1 - k) + this.line[i1] * k;
      for (let side = 0; side < 2; side++) {
        const o = (s * 2 + side) * 4;
        arr[o + 1] = rubber;
        arr[o + 2] = line;
      }
    }
    this.surface.needsUpdate = true;
    return true;
  }

  // --- persistence -------------------------------------------------------
  // Each circuit keeps its own history between sessions. Time away is paid
  // back on load: water dries, loose debris is gone, rubber fades over days.
  save() {
    if (!this.key) return;
    const round = (a) => Array.from(a, (v) => Math.round(v * 1000) / 1000);
    try {
      localStorage.setItem(this.key, JSON.stringify({
        v: SAVE_VERSION,
        at: Date.now(),
        rubber: round(this.rubber),
        line: round(this.line),
        lineWeight: round(this.lineWeight),
        temperature: this.temperature,
        wetness: this.wetness,
        standingWater: this.standingWater,
        dust: this.dust,
      }));
    } catch { /* storage full or blocked: the road simply forgets */ }
  }

  #load(name) {
    this.key = `apex.condition.${String(name).toLowerCase().replace(/\W+/g, '-')}`;
    this.rubber.fill(0);
    this.line.fill(0.5);
    this.lineWeight.fill(0);
    this.debris.fill(0);
    this.wetness = 0;
    this.standingWater = 0;
    this.dust = 0.2;
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(this.key) ?? 'null'); } catch { saved = null; }
    if (!saved || saved.v !== SAVE_VERSION || saved.rubber?.length !== BINS) return;

    const minutes = Math.max(0, (Date.now() - saved.at) / 60000);
    const days = minutes / 1440;
    const fade = Math.pow(0.5, days / 3);
    for (let i = 0; i < BINS; i++) {
      this.rubber[i] = clamp01(saved.rubber[i] * fade);
      this.line[i] = clamp01(saved.line?.[i] ?? 0.5);
      this.lineWeight[i] = (saved.lineWeight?.[i] ?? 0) * fade;
    }
    this.temperature = saved.temperature ?? 24;
    this.wetness = clamp01(saved.wetness * Math.exp(-minutes / 6));
    this.standingWater = clamp01(saved.standingWater * Math.exp(-minutes / 3));
    this.dust = clamp01(saved.dust + (1 - saved.dust) * (1 - Math.exp(-days / 2)));
  }
}
