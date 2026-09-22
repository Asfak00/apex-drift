// Every sound here is synthesised at runtime: no audio files to ship, license
// or wait on. One AudioContext, one master gain, three voices — music bed,
// engine, and one-shot effects.

const LOOKAHEAD = 0.12;          // seconds of notes scheduled ahead of the clock
const semitone = (hz, n) => hz * (2 ** (n / 12));

// A lap time as an engineer would say it, not as a clock shows it: minutes
// when there are minutes, and tenths, because nobody reads out milliseconds.
export function spokenTime(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'no time';
  const mins = Math.floor(seconds / 60);
  const rest = seconds - mins * 60;
  // Truncated, not rounded: a 24.382 lap is called as twenty-four point three,
  // the same tenth the clock on the screen is showing.
  const said = (Math.floor(rest * 10) / 10).toFixed(1);
  if (!mins) return `${said} seconds`;
  return `${mins} minute${mins === 1 ? '' : 's'}, ${said}`;
}

// Everything the mixer is told each frame comes from the physics. A single
// non-finite value there would otherwise throw inside the audio graph and take
// the frame with it, so every number that reaches an AudioParam passes here.
const safe = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback);

// A mood per kind of circuit. Same engine, different key, tempo and voicing, so
// a street race and a country lane do not sound like the same place.
export const MOODS = {
  circuit: {
    bpm: 128, lead: 'sawtooth', bass: 'square', cut: 2400, drive: 0.055,
    bars: [
      { root: 110.00, arp: [0, 3, 7, 12] },
      { root: 87.31, arp: [0, 4, 7, 12] },
      { root: 130.81, arp: [0, 4, 7, 11] },
      { root: 98.00, arp: [0, 4, 7, 12] },
    ],
  },
  street: {
    bpm: 104, lead: 'square', bass: 'sawtooth', cut: 1500, drive: 0.048,
    bars: [
      { root: 98.00, arp: [0, 3, 7, 10] },
      { root: 116.54, arp: [0, 3, 7, 10] },
      { root: 87.31, arp: [0, 5, 7, 10] },
      { root: 77.78, arp: [0, 4, 7, 10] },
    ],
  },
  rural: {
    bpm: 96, lead: 'triangle', bass: 'triangle', cut: 1200, drive: 0.06,
    bars: [
      { root: 130.81, arp: [0, 4, 7, 9] },
      { root: 98.00, arp: [0, 5, 9, 12] },
      { root: 110.00, arp: [0, 3, 7, 10] },
      { root: 116.54, arp: [0, 4, 7, 11] },
    ],
  },
  desert: {
    bpm: 112, lead: 'sawtooth', bass: 'square', cut: 900, drive: 0.07,
    bars: [
      { root: 73.42, arp: [0, 1, 5, 8] },
      { root: 73.42, arp: [0, 3, 5, 10] },
      { root: 87.31, arp: [0, 1, 7, 8] },
      { root: 65.41, arp: [0, 4, 5, 7] },
    ],
  },
};

// How each class of car sounds. A V12 is not a turbo four.
export const ENGINES = {
  v12: { types: ['sawtooth', 'sawtooth'], detune: 6, base: 62, span: 150, cut: 620, q: 4.2, grit: 0.05 },
  v8: { types: ['square', 'sawtooth'], detune: 16, base: 40, span: 96, cut: 380, q: 5.4, grit: 0.12 },
  flat6: { types: ['sawtooth', 'triangle'], detune: 9, base: 55, span: 132, cut: 540, q: 3.6, grit: 0.07 },
  turbo4: { types: ['square', 'square'], detune: 22, base: 68, span: 168, cut: 760, q: 2.8, grit: 0.15 },
  hybrid: { types: ['triangle', 'sawtooth'], detune: 3, base: 96, span: 220, cut: 1500, q: 2.0, grit: 0.03 },
};

// One fader per family of sound, with the level it sits at when the driver
// leaves it alone. Everything routes through one of these, so nothing can get
// loud enough to bury the rest of the mix on its own.
const BUSES = {
  music:  { base: 0.34 },
  engine: { base: 0.85 },
  tyres:  { base: 0.7 },
  env:    { base: 0.6 },
  sfx:    { base: 0.5 },
  ui:     { base: 0.5 },
};

export const BUS_KEYS = Object.keys(BUSES);

// Where a fader's position is kept, and how a missing one is read.
export const MIX_STORE = 'apex.mix2';

export function storedLevel(key, fallback = 1) {
  const raw = localStorage.getItem(`${MIX_STORE}.${key}`);
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.min(1.5, value) : fallback;
}

export class Audio {
  constructor() {
    this.ctx = null;
    this.enabled = localStorage.getItem('apex.sound') !== 'off';
    this.musicLevel = Number(localStorage.getItem('apex.music') ?? 1);
    this.sfxLevel = Number(localStorage.getItem('apex.sfx') ?? 1);
    // Every bus remembers where the driver left it. A missing entry reads as
    // "never set", not as zero: Number(null) is 0, and a fader that defaults to
    // silence is a game with no sound.
    this.levels = {};
    for (const key of BUS_KEYS) this.levels[key] = storedLevel(key);
    this.levels.music = this.musicLevel;
    this.levels.sfx = this.sfxLevel;
    this.masterLevel = storedLevel('master');
    this.started = false;
    this.bar = 0;
    this.beat = 0;
    this.nextNoteAt = 0;
    this.mood = MOODS.circuit;
    this.engineProfile = ENGINES.v12;
  }

  // Browsers only allow audio after a gesture, so this is called from a click.
  start() {
    if (this.started) return;
    const Ctx = window.AudioContext ?? window.webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    this.started = true;

    this.master = this.ctx.createGain();
    this.master.gain.value = this.enabled ? 0.9 * this.masterLevel : 0;
    // A limiter on the way out. Twenty voices can all peak at once — a pile-up
    // during a cheer with the boost lit — and without this the sum clips.
    this.limiter = this.ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -8;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 8;
    this.limiter.attack.value = 0.004;
    this.limiter.release.value = 0.16;
    this.master.connect(this.limiter);
    this.limiter.connect(this.ctx.destination);

    this.bus = {};
    for (const key of BUS_KEYS) {
      const gain = this.ctx.createGain();
      gain.gain.value = BUSES[key].base * this.levels[key];
      gain.connect(this.master);
      this.bus[key] = gain;
    }
    // Named aliases for the two buses the rest of the game already knows.
    this.musicBus = this.bus.music;
    this.sfxBus = this.bus.sfx;

    this.noise = this.#noiseBuffer();
    this.#buildEngine();
    this.#buildTyres();
    this.#buildWeather();
    this.#buildCrowd();
    this.nextNoteAt = this.ctx.currentTime + 0.1;
    this.timer = setInterval(() => this.#schedule(), 25);
  }

  // Circuits pick the music; cars pick the engine note.
  setMood(key) {
    const mood = MOODS[key] ?? MOODS.circuit;
    if (mood === this.mood) return;
    this.mood = mood;
    this.bar = 0;
    this.beat = 0;
  }

  setEngine(key) {
    const profile = ENGINES[key] ?? ENGINES.v12;
    this.engineProfile = profile;
    if (!this.started) return;
    this.engineOsc.forEach((osc, i) => {
      osc.type = profile.types[i] ?? 'sawtooth';
      osc.detune.value = i ? profile.detune : -profile.detune;
    });
    this.engineFilter.Q.value = profile.q;
  }

  resume() {
    if (this.ctx?.state === 'suspended') this.ctx.resume();
  }

  setEnabled(on) {
    this.enabled = on;
    localStorage.setItem('apex.sound', on ? 'on' : 'off');
    this.#pushMaster();
  }

  // The master fader sits in front of every bus, so it is the one control that
  // can pull the whole mix down without changing its balance.
  setMasterLevel(level) {
    this.masterLevel = Math.max(0, Math.min(1.5, level));
    localStorage.setItem(`${MIX_STORE}.master`, String(this.masterLevel));
    this.#pushMaster();
  }

  #pushMaster() {
    if (!this.master) return;
    this.master.gain.setTargetAtTime(
      this.enabled ? 0.9 * this.masterLevel : 0, this.ctx.currentTime, 0.05);
  }

  // One way in for every fader, so a level is set, stored and applied in the
  // same place whatever asked for it.
  setLevel(key, level) {
    if (!BUSES[key]) return;
    const value = Math.max(0, Math.min(1.5, level));
    this.levels[key] = value;
    localStorage.setItem(`${MIX_STORE}.${key}`, String(value));
    if (key === 'music') { this.musicLevel = value; localStorage.setItem('apex.music', String(value)); }
    if (key === 'sfx') { this.sfxLevel = value; localStorage.setItem('apex.sfx', String(value)); }
    this.bus?.[key]?.gain.setTargetAtTime(
      BUSES[key].base * value, this.ctx.currentTime, 0.05);
  }

  setMusicLevel(level) { this.setLevel('music', level); }
  setSfxLevel(level) { this.setLevel('sfx', level); }

  toggle() {
    this.setEnabled(!this.enabled);
    return this.enabled;
  }

  #noiseBuffer() {
    const len = Math.floor(this.ctx.sampleRate * 2);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  // --- engine ------------------------------------------------------------
  // Two detuned saws through a lowpass give a usable engine note; a noise bed
  // on top carries road and wind. Both are driven from the car each frame.
  #buildEngine() {
    const ctx = this.ctx;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 900;
    this.engineFilter.Q.value = this.engineProfile.q;
    this.engineGain.connect(this.bus.engine);
    this.engineFilter.connect(this.engineGain);

    this.engineOsc = [0, 1].map((i) => {
      const o = ctx.createOscillator();
      o.type = this.engineProfile.types[i] ?? 'sawtooth';
      o.frequency.value = 60;
      o.detune.value = i ? this.engineProfile.detune : -this.engineProfile.detune;
      o.connect(this.engineFilter);
      o.start();
      return o;
    });

    // The sub layer: an octave below the note, sine, no bite. It is what makes
    // a big engine felt rather than only heard, and it is the layer that comes
    // in at low revs where the saws have nothing to say.
    this.engineSub = ctx.createOscillator();
    this.engineSub.type = 'sine';
    this.engineSub.frequency.value = 30;
    this.engineSubGain = ctx.createGain();
    this.engineSubGain.gain.value = 0;
    this.engineSub.connect(this.engineSubGain);
    this.engineSubGain.connect(this.bus.engine);
    this.engineSub.start();

    // Top end: a narrow resonant band over the note that only opens up near
    // the limiter, which is the layer that makes revs read as revs.
    this.engineTop = ctx.createBiquadFilter();
    this.engineTop.type = 'bandpass';
    this.engineTop.frequency.value = 2400;
    this.engineTop.Q.value = 6;
    this.engineTopGain = ctx.createGain();
    this.engineTopGain.gain.value = 0;
    const topSrc = ctx.createBufferSource();
    topSrc.buffer = this.noise;
    topSrc.loop = true;
    topSrc.connect(this.engineTop);
    this.engineTop.connect(this.engineTopGain);
    this.engineTopGain.connect(this.bus.engine);
    topSrc.start();

    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 700;
    this.windGain.connect(this.bus.env);
    this.windFilter.connect(this.windGain);
    const wind = ctx.createBufferSource();
    wind.buffer = this.#noiseBuffer();
    wind.loop = true;
    wind.connect(this.windFilter);
    wind.start();
  }

  // --- tyres -------------------------------------------------------------
  // Three things a tyre does, on three voices: it rolls, it scrubs, and at the
  // limit it squeals. The squeal is tonal — two detuned saws through a narrow
  // band — because a sliding tyre is a resonance, not a hiss, and hiss alone
  // is what makes a slide sound like wind.
  #buildTyres() {
    const ctx = this.ctx;
    this.rollGain = ctx.createGain();
    this.rollGain.gain.value = 0;
    this.rollFilter = ctx.createBiquadFilter();
    this.rollFilter.type = 'lowpass';
    this.rollFilter.frequency.value = 420;
    this.rollFilter.Q.value = 0.9;
    this.rollFilter.connect(this.rollGain);
    this.rollGain.connect(this.bus.tyres);
    const roll = ctx.createBufferSource();
    roll.buffer = this.noise;
    roll.loop = true;
    roll.connect(this.rollFilter);
    roll.start();

    this.squealGain = ctx.createGain();
    this.squealGain.gain.value = 0;
    this.squealBand = ctx.createBiquadFilter();
    this.squealBand.type = 'bandpass';
    this.squealBand.frequency.value = 1100;
    this.squealBand.Q.value = 7;
    this.squealBand.connect(this.squealGain);
    this.squealGain.connect(this.bus.tyres);
    this.squealOsc = [0, 1].map((i) => {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = 420;
      o.detune.value = i ? 24 : -31;
      o.connect(this.squealBand);
      o.start();
      return o;
    });
    // Grit under the squeal: rubber tearing rather than a clean tone.
    const grit = ctx.createBufferSource();
    grit.buffer = this.noise;
    grit.loop = true;
    this.squealGrit = ctx.createGain();
    this.squealGrit.gain.value = 0.35;
    grit.connect(this.squealGrit);
    this.squealGrit.connect(this.squealBand);
    grit.start();
  }

  // Everything the tyres are doing this frame. `surface` changes what rolling
  // sounds like, `wet` puts water under it, `off` is a wheel on the verge.
  tyres({ kmh: rawKmh = 0, slide: rawSlide = 0, lockup: rawLock = 0,
    off = false, wet: rawWet = 0, surface = 'asphalt' } = {}) {
    if (!this.started || !this.rollGain) return;
    const t = this.ctx.currentTime;
    const kmh = Math.max(0, safe(rawKmh));
    const slide = Math.max(0, safe(rawSlide));
    const lockup = Math.max(0, Math.min(1, safe(rawLock)));
    const wet = Math.max(0, Math.min(1, safe(rawWet)));
    const speed = Math.min(1, kmh / 240);

    // Rolling: quiet and dull on asphalt, loud and broadband on gravel.
    const coarse = off || surface === 'dirt';
    this.rollFilter.frequency.setTargetAtTime(
      (coarse ? 900 : 380) + speed * (coarse ? 2600 : 900), t, 0.12);
    this.rollGain.gain.setTargetAtTime(
      speed * (coarse ? 0.4 : 0.1) * (1 + wet * 0.5), t, 0.12);

    // Squeal: how far past the limit, and pitched by how fast it is scrubbing.
    // Water takes the squeal away and leaves the hiss behind.
    const scrub = Math.max(Math.min(1, (slide - 1.4) / 7), lockup * 0.8);
    const voice = Math.max(0, scrub) * (1 - wet * 0.6) * (off ? 0.25 : 1);
    const pitch = 360 + Math.min(1, slide / 9) * 520 + speed * 180;
    for (const o of this.squealOsc) o.frequency.setTargetAtTime(pitch, t, 0.08);
    this.squealBand.frequency.setTargetAtTime(pitch * 2.2, t, 0.09);
    this.squealGain.gain.setTargetAtTime(voice * 0.26, t, 0.07);
  }

  silenceTyres() {
    if (!this.started || !this.rollGain) return;
    const t = this.ctx.currentTime;
    this.rollGain.gain.setTargetAtTime(0, t, 0.2);
    this.squealGain.gain.setTargetAtTime(0, t, 0.15);
  }

  // --- weather -----------------------------------------------------------
  // Rain is broadband noise with a low shelf taken out of it; a storm is the
  // same bed with more of it and more top end.
  #buildWeather() {
    const ctx = this.ctx;
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;
    this.rainFilter = ctx.createBiquadFilter();
    this.rainFilter.type = 'highpass';
    this.rainFilter.frequency.value = 1100;
    this.rainFilter.connect(this.rainGain);
    this.rainGain.connect(this.bus.env);
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.connect(this.rainFilter);
    src.start();
  }

  // `amount` 0..1 of precipitation, `wind` 0..1 of how hard it is blowing.
  setWeather(rawAmount = 0, rawWind = 0) {
    if (!this.started || !this.rainGain) return;
    const t = this.ctx.currentTime;
    const amount = Math.max(0, Math.min(1, safe(rawAmount)));
    const wind = Math.max(0, Math.min(1, safe(rawWind)));
    this.rainGain.gain.setTargetAtTime(amount * 0.16, t, 0.8);
    this.rainFilter.frequency.setTargetAtTime(1400 - amount * 500 + wind * 400, t, 0.8);
  }

  // A crack of thunder, some distance away.
  thunder(strength = 1) {
    this.#burst({ type: 'noise', dur: 1.6 + strength, gain: 0.3 * strength,
      filter: { type: 'lowpass', from: 900, to: 90, q: 0.9 } });
    this.#burst({ type: 'sine', freq: 62, sweepTo: 28, dur: 1.9, gain: 0.34 * strength });
  }

  // rpm 0..1 within the current gear, load 0..1 from the throttle. The layers
  // are crossfaded by revs and by load: sub at the bottom, saws through the
  // middle, resonant top end into the limiter. Off the throttle the whole
  // thing backs off instead of holding its note, which is what makes lifting
  // audible.
  engine({ rpm: revs, load: pedal, kmh: speed, slide: slip, boosting, gear = 1 }) {
    if (!this.started) return;
    const t = this.ctx.currentTime;
    const e = this.engineProfile;
    const rpm = Math.max(0, Math.min(1, safe(revs, 0.1)));
    const load = Math.max(0, Math.min(1, safe(pedal)));
    const kmh = Math.max(0, safe(speed));
    const slide = Math.max(0, safe(slip));
    const base = e.base + rpm * e.span + (boosting ? e.span * 0.18 : 0);
    for (const o of this.engineOsc) o.frequency.setTargetAtTime(base, t, 0.05);
    this.engineFilter.frequency.setTargetAtTime(e.cut + rpm * 2400 + load * 700, t, 0.06);

    // Overrun: a closed throttle at revs is quieter and duller, and it pops.
    const drive = 0.35 + load * 0.65;
    this.engineGain.gain.setTargetAtTime(
      (0.09 + rpm * 0.07 + e.grit * load) * drive + load * 0.13, t, 0.07);
    this.engineSub.frequency.setTargetAtTime(base * 0.5, t, 0.05);
    this.engineSubGain.gain.setTargetAtTime((0.13 - rpm * 0.05) * drive, t, 0.09);

    // The limiter layer only exists at the top of the gear.
    const top = Math.max(0, (rpm - 0.62) / 0.38);
    this.engineTop.frequency.setTargetAtTime(1500 + rpm * 2600, t, 0.06);
    this.engineTopGain.gain.setTargetAtTime(top * top * 0.075 * drive, t, 0.06);

    // A shift is a change of gear, so the sound of one belongs here rather
    // than in whatever part of the game happens to notice.
    if (this.lastGear !== undefined && gear !== this.lastGear && rpm > 0.1) {
      if (gear > this.lastGear) this.shift(); else this.blip();
    }
    this.lastGear = gear;
    // Lifting off at high revs pops once, not every frame.
    if (this.lastLoad > 0.5 && load < 0.15 && rpm > 0.55) this.overrun();
    this.lastLoad = load;

    // Wind rises with speed; a sliding tyre adds a hiss on top of it.
    const hiss = Math.min(1, slide * 0.35);
    this.windFilter.frequency.setTargetAtTime(500 + kmh * 4 + hiss * 1800, t, 0.1);
    this.windGain.gain.setTargetAtTime(Math.min(0.14, kmh / 2600) + hiss * 0.1, t, 0.1);
  }

  silenceEngine() {
    if (!this.started) return;
    const t = this.ctx.currentTime;
    this.engineGain.gain.setTargetAtTime(0, t, 0.2);
    this.engineSubGain?.gain.setTargetAtTime(0, t, 0.2);
    this.engineTopGain?.gain.setTargetAtTime(0, t, 0.2);
    this.windGain.gain.setTargetAtTime(0, t, 0.2);
    this.silenceTyres();
  }

  // --- crowd -------------------------------------------------------------
  // A stand full of people is noise shaped like a thousand voices at once.
  // What makes it read as people rather than as wind is the formants: three
  // resonances in the range a voice occupies, with the vowel band drifting the
  // way a crowd's does. On top of that sit the swells — a crowd is never at a
  // constant volume, it breathes.
  #buildCrowd() {
    const ctx = this.ctx;
    this.crowdGain = ctx.createGain();
    this.crowdGain.gain.value = 0;
    this.crowdGain.connect(this.master);

    // Chest: the low body of a big crowd, felt more than heard.
    this.crowdHum = ctx.createBiquadFilter();
    this.crowdHum.type = 'bandpass';
    this.crowdHum.frequency.value = 260;
    this.crowdHum.Q.value = 0.8;

    // Vowel: the formant that carries "people" rather than "static".
    this.crowdVowel = ctx.createBiquadFilter();
    this.crowdVowel.type = 'bandpass';
    this.crowdVowel.frequency.value = 720;
    this.crowdVowel.Q.value = 2.6;
    this.crowdVowelGain = ctx.createGain();
    this.crowdVowelGain.gain.value = 0.55;

    // Roar: the bright edge that comes up when they are actually shouting.
    this.crowdRoar = ctx.createBiquadFilter();
    this.crowdRoar.type = 'bandpass';
    this.crowdRoar.frequency.value = 1500;
    this.crowdRoar.Q.value = 1.4;
    this.crowdRoarGain = ctx.createGain();
    this.crowdRoarGain.gain.value = 0.2;

    const bed = ctx.createBufferSource();
    bed.buffer = this.#noiseBuffer();
    bed.loop = true;
    for (const node of [this.crowdHum, this.crowdVowel, this.crowdRoar]) bed.connect(node);
    this.crowdHum.connect(this.crowdGain);
    this.crowdVowel.connect(this.crowdVowelGain);
    this.crowdVowelGain.connect(this.crowdGain);
    this.crowdRoar.connect(this.crowdRoarGain);
    this.crowdRoarGain.connect(this.crowdGain);
    bed.start();

    // Two slow oscillators breathe the bed and drift the vowel, so the crowd
    // is never a flat wall of noise.
    const swell = ctx.createOscillator();
    swell.type = 'sine';
    swell.frequency.value = 0.11;
    const swellDepth = ctx.createGain();
    // The swell is added to the crowd's gain, so it starts at nothing: a depth
    // set before anyone is in the stands is a hum over an empty circuit.
    swellDepth.gain.value = 0;
    swell.connect(swellDepth);
    swellDepth.connect(this.crowdGain.gain);
    swell.start();

    const drift = ctx.createOscillator();
    drift.type = 'sine';
    drift.frequency.value = 0.07;
    const driftDepth = ctx.createGain();
    driftDepth.gain.value = 130;
    drift.connect(driftDepth);
    driftDepth.connect(this.crowdVowel.frequency);
    drift.start();
    this.crowdSwell = swellDepth;

    // Random cheers on top: a crowd reacts to things the game never told it
    // about, and the gaps between them are what make it sound live.
    this.crowdSize = 0;
    this.nextCheer = 6 + Math.random() * 8;
  }

  // `size` is how many people the circuit holds, `excite` what they are doing.
  crowd(size, excite, dt = 0) {
    if (!this.started || !this.crowdGain) return;
    const t = this.ctx.currentTime;
    const level = Math.max(0, Math.min(1, safe(size)));
    const heat = Math.max(0, Math.min(1, safe(excite)));
    this.crowdSize = level;
    const body = level * (0.10 + heat * 0.30) * this.sfxLevel;
    this.crowdGain.gain.setTargetAtTime(body, t, 0.35);
    this.crowdSwell.gain.setTargetAtTime(body * 0.42, t, 0.8);
    this.crowdVowelGain.gain.setTargetAtTime(0.45 + heat * 0.35, t, 0.5);
    this.crowdRoarGain.gain.setTargetAtTime(0.08 + heat * 0.7, t, 0.4);
    this.crowdRoar.frequency.setTargetAtTime(1200 + heat * 900, t, 0.5);

    // A big crowd finds something to shout about on its own.
    if (dt > 0 && level > 0.2) {
      this.nextCheer -= dt * (0.5 + heat);
      if (this.nextCheer <= 0) {
        this.cheer(level * (0.35 + Math.random() * 0.45));
        this.nextCheer = 5 + Math.random() * 9;
      }
    }
  }

  silenceCrowd() {
    if (!this.started || !this.crowdGain) return;
    const t = this.ctx.currentTime;
    // The swell is added to the gain, so it has to go quiet as well or the
    // crowd keeps breathing over an empty menu.
    this.crowdGain.gain.setTargetAtTime(0, t, 0.3);
    this.crowdSwell.gain.setTargetAtTime(0, t, 0.3);
  }

  // A swell over the bed, for the moments a crowd actually reacts to.
  // A swell over the bed: voices rising together and falling away, with the
  // vowel band sweeping up through the shout and back down.
  cheer(strength = 1) {
    if (!this.started) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const dur = 1.3 + strength * 1.2;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;

    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = 1.1;
    band.frequency.setValueAtTime(560, t);
    band.frequency.linearRampToValueAtTime(1650, t + dur * 0.22);
    band.frequency.linearRampToValueAtTime(700, t + dur);

    // A second, higher formant makes the swell read as voices rather than
    // as a filter sweep.
    const top = ctx.createBiquadFilter();
    top.type = 'bandpass';
    top.Q.value = 2.2;
    top.frequency.setValueAtTime(1900, t);
    top.frequency.linearRampToValueAtTime(2600, t + dur * 0.3);
    const topGain = ctx.createGain();
    topGain.gain.value = 0.35;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.08 + strength * 0.26, t + dur * 0.2);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(band); band.connect(g);
    src.connect(top); top.connect(topGain); topGain.connect(g);
    g.connect(this.sfxBus);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  // --- one-shot effects --------------------------------------------------
  #burst({ freq, sweepTo, dur, gain, type = 'sine', filter = null }) {
    if (!this.started) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node;
    if (type === 'noise') {
      node = ctx.createBufferSource();
      node.buffer = this.noise;
    } else {
      node = ctx.createOscillator();
      node.type = type;
      node.frequency.setValueAtTime(freq, t);
      if (sweepTo) node.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    }
    if (filter) {
      const f = ctx.createBiquadFilter();
      f.type = filter.type;
      f.frequency.setValueAtTime(filter.from, t);
      if (filter.to) f.frequency.exponentialRampToValueAtTime(filter.to, t + dur);
      f.Q.value = filter.q ?? 1;
      node.connect(f); f.connect(g);
    } else {
      node.connect(g);
    }
    g.connect(this.sfxBus);
    node.start(t);
    node.stop(t + dur + 0.02);
  }

  // Strength 0..1 — a light scrape and a heavy hit should not sound alike.
  impact(strength) {
    const s = Math.min(1, Math.max(0.12, strength));
    this.#burst({ type: 'noise', dur: 0.18 + s * 0.2, gain: 0.25 * s,
      filter: { type: 'lowpass', from: 1800 + s * 2200, to: 260, q: 1.2 } });
    this.#burst({ type: 'sine', freq: 130 * (0.7 + s * 0.6), sweepTo: 42,
      dur: 0.26 + s * 0.24, gain: 0.5 * s });
  }

  // A car going past is a band of noise sweeping down in pitch and across the
  // stereo field, which is most of what makes a pass read as a pass.
  passBy(strength, side) {
    if (!this.started) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const dur = 0.42 + strength * 0.2;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;

    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = 1.6;
    band.frequency.setValueAtTime(320, t);
    band.frequency.exponentialRampToValueAtTime(1500 + strength * 900, t + dur * 0.4);
    band.frequency.exponentialRampToValueAtTime(260, t + dur);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.1 + strength * 0.22, t + dur * 0.42);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    const pan = ctx.createStereoPanner?.();
    src.connect(band);
    if (pan) {
      // Sweep across the listener from the side the car went by on.
      pan.pan.setValueAtTime(side * 0.9, t);
      pan.pan.linearRampToValueAtTime(-side * 0.6, t + dur);
      band.connect(pan); pan.connect(g);
    } else {
      band.connect(g);
    }
    g.connect(this.sfxBus);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  onBoost() {
    this.#burst({ type: 'noise', dur: 0.5, gain: 0.16,
      filter: { type: 'bandpass', from: 380, to: 3600, q: 2.2 } });
  }

  // A short blip of the throttle, for the garage: picking a car should make a
  // noise, and the noise should be that car's engine.
  rev(engineKey) {
    if (!this.started) return;
    const e = ENGINES[engineKey] ?? this.engineProfile;
    const ctx = this.ctx, t = ctx.currentTime;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22, t + 0.09);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.85);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(e.cut, t);
    f.frequency.linearRampToValueAtTime(e.cut + 2600, t + 0.22);
    f.frequency.linearRampToValueAtTime(e.cut, t + 0.8);
    f.Q.value = e.q;
    f.connect(g);
    g.connect(this.bus.engine);
    for (const [i, type] of e.types.entries()) {
      const o = ctx.createOscillator();
      o.type = type;
      o.detune.value = i ? e.detune : -e.detune;
      o.frequency.setValueAtTime(e.base, t);
      o.frequency.linearRampToValueAtTime(e.base + e.span * 0.9, t + 0.2);
      o.frequency.exponentialRampToValueAtTime(e.base * 1.15, t + 0.8);
      o.connect(f);
      o.start(t);
      o.stop(t + 0.9);
    }
  }

  // The sound a control makes when it takes a selection.
  click(strong = false) {
    this.#burst({ type: 'noise', dur: strong ? 0.09 : 0.05, gain: strong ? 0.1 : 0.05,
      filter: { type: 'bandpass', from: strong ? 2200 : 3200, to: 1200, q: 4 } });
  }

  // --- the car's own events ----------------------------------------------
  // An upshift: the note is cut, the gearbox thuds, and the engine picks the
  // next gear up. Only the thud is a sound of its own; the rest is the engine
  // layers answering the new ratio.
  shift() {
    this.#burst({ type: 'noise', dur: 0.09, gain: 0.12,
      filter: { type: 'bandpass', from: 900, to: 320, q: 3.2 } });
  }

  // A downshift blip.
  blip() {
    this.#burst({ type: 'sawtooth', freq: 220, sweepTo: 150, dur: 0.12, gain: 0.07 });
  }

  // Off the throttle at revs: unburnt fuel lighting in the pipe.
  overrun() {
    for (let i = 0; i < 3; i++) {
      setTimeout(() => this.#burst({
        type: 'noise', dur: 0.06, gain: 0.05 + Math.random() * 0.06,
        filter: { type: 'bandpass', from: 1400 + Math.random() * 900, to: 400, q: 4 },
      }), i * (40 + Math.random() * 70));
    }
  }

  // --- race events -------------------------------------------------------
  // Every event the race can announce goes through one of these, so the game
  // says "this happened" and the mixer decides what that sounds like: which
  // figure plays, what it ducks, and whether the engineer says anything.
  //
  // Two notes up for a lap, a third for a personal best, and a bell for the
  // last lap: the driver should know which of those happened without reading.
  onLapComplete(seconds, { best = false } = {}) {
    const root = best ? 660 : 523.25;
    this.#chime([root, root * 1.25, ...(best ? [root * 1.5] : [])], 0.16, 0.12);
    // The call comes after the tone, not over it.
    const time = spokenTime(seconds);
    if (best) this.say(`New personal best. ${time}.`, 0.42);
    else this.say(`Lap complete. ${time}.`, 0.42);
  }

  onFinalLap() {
    this.#chime([784, 784, 1046.5], 0.2, 0.13);
    this.say('Final lap.', 0.5);
  }

  onCountdown(go) {
    this.#burst({ type: 'triangle', freq: go ? 880 : 520, dur: go ? 0.34 : 0.16,
      gain: 0.22 });
  }

  // Up is a rising pair, down is the same interval falling.
  onPositionChange(gained) {
    this.#chime(gained ? [523.25, 784] : [784, 523.25], 0.1, 0.09);
  }

  // The flag: a fanfare if it is a win, a flat pair of notes if it is not.
  onRaceFinish({ won = false, place = 0, seconds = null } = {}) {
    if (won) this.#chime([523.25, 659.25, 784, 1046.5], 0.17, 0.16, 'triangle');
    else this.#chime([440, 392], 0.3, 0.1, 'sine');
    const time = seconds ? ` Final time ${spokenTime(seconds)}.` : '';
    const where = place ? ` P ${place}.` : '';
    this.say(`Race complete.${where}${time}`, 0.62);
  }

  onPitEntry() {
    this.#chime([392, 523.25], 0.12, 0.08);
  }

  // --- the engineer ------------------------------------------------------
  // Spoken calls use the browser's own voice: a racing game has to say the lap
  // time out loud, and shipping recorded speech means shipping audio files and
  // a licence for every language. If the platform has no voice, the tones
  // above still carry the event and nothing is lost but the words.
  say(text, duckFor = 0.45) {
    const synth = window.speechSynthesis;
    if (!synth || !this.enabled || this.levels.ui === 0) return;
    // Anything still queued is stale: the last thing that happened is the
    // thing worth hearing.
    synth.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.08;
    utterance.pitch = 0.92;
    utterance.volume = Math.min(1, this.levels.ui);
    this.#duck(duckFor);
    utterance.onend = () => this.#duck(0);
    utterance.onerror = () => this.#duck(0);
    synth.speak(utterance);
    // A voice that never reports back must not leave the mix down.
    clearTimeout(this.duckTimer);
    this.duckTimer = setTimeout(() => this.#duck(0), 1200 + text.length * 70);
  }

  // Hold the race down under a call. `amount` 0 restores the mix.
  #duck(amount) {
    if (!this.started) return;
    const t = this.ctx.currentTime;
    for (const key of ['engine', 'tyres', 'env', 'music']) {
      const base = BUSES[key].base * this.levels[key];
      this.bus[key].gain.setTargetAtTime(base * (1 - amount), t, 0.12);
    }
  }

  // The gun on the wheel, four nuts at a time.
  onTyreChange() {
    for (let i = 0; i < 5; i++) {
      setTimeout(() => this.#burst({
        type: 'noise', dur: 0.12, gain: 0.1,
        filter: { type: 'bandpass', from: 2600 + Math.random() * 700, to: 1800, q: 5 },
      }), i * 90);
    }
  }

  // A short melodic figure on the UI bus, used by every event above so they
  // all sit at the same level and in the same voice.
  #chime(notes, step = 0.14, gain = 0.12, type = 'square') {
    if (!this.started) return;
    const ctx = this.ctx;
    notes.forEach((freq, i) => {
      const when = ctx.currentTime + i * step;
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(freq, when);
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 3200;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(gain, when + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, when + step * 1.7);
      o.connect(f); f.connect(g); g.connect(this.bus.ui);
      o.start(when);
      o.stop(when + step * 1.8);
    });
  }

  // --- music bed ---------------------------------------------------------
  #voice(freq, when, dur, { type = 'sawtooth', gain = 0.15, cut = 1600 }) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, when);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(cut, when);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(gain, when + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    o.connect(f); f.connect(g); g.connect(this.musicBus);
    o.start(when);
    o.stop(when + dur + 0.02);
  }

  #drum(when, kick) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.setValueAtTime(kick ? 0.5 : 0.1, when);
    g.gain.exponentialRampToValueAtTime(0.0001, when + (kick ? 0.2 : 0.05));
    if (kick) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(128, when);
      o.frequency.exponentialRampToValueAtTime(44, when + 0.14);
      o.connect(g);
      o.start(when); o.stop(when + 0.22);
    } else {
      const n = ctx.createBufferSource();
      n.buffer = this.noise;
      const f = ctx.createBiquadFilter();
      f.type = 'highpass';
      f.frequency.value = 7000;
      n.connect(f); f.connect(g);
      n.start(when); n.stop(when + 0.06);
    }
    g.connect(this.musicBus);
  }

  // Walks the clock forward one eighth-note at a time, staying just ahead of
  // the audio hardware so nothing is ever scheduled late.
  #schedule() {
    if (!this.started) return;
    const mood = this.mood;
    const BEAT = 60 / mood.bpm;
    const eighth = BEAT / 2;
    while (this.nextNoteAt < this.ctx.currentTime + LOOKAHEAD) {
      const when = this.nextNoteAt;
      const bar = mood.bars[this.bar % mood.bars.length];
      const step = this.beat;

      if (step % 4 === 0) this.#drum(when, true);
      if (step % 2 === 1) this.#drum(when, false);
      if (step % 4 === 0) {
        this.#voice(bar.root / 2, when, BEAT * 1.8,
          { type: mood.bass, gain: 0.17, cut: 420 });
      }
      // Arp rides the offbeats and climbs an octave in the second half of the bar.
      const degree = bar.arp[step % bar.arp.length];
      const octave = step >= 4 ? 12 : 0;
      this.#voice(semitone(bar.root * 2, degree + octave), when, eighth * 1.4,
        { type: mood.lead, gain: mood.drive, cut: mood.cut });
      if (step === 0) {
        this.#voice(semitone(bar.root, 7), when, BEAT * 3.6,
          { type: 'triangle', gain: 0.05, cut: 900 });
      }

      this.nextNoteAt += eighth;
      this.beat += 1;
      if (this.beat >= 8) { this.beat = 0; this.bar += 1; }
    }
  }

  // Duck the music under the countdown and lift it when the flag drops.
  duckMusic(amount, seconds = 0.4) {
    if (!this.started) return;
    this.musicBus.gain.setTargetAtTime(
      0.34 * this.musicLevel * amount, this.ctx.currentTime, seconds);
  }
}
