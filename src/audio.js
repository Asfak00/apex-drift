// Every sound here is synthesised at runtime: no audio files to ship, license
// or wait on. One AudioContext, one master gain, three voices — music bed,
// engine, and one-shot effects.

const LOOKAHEAD = 0.12;          // seconds of notes scheduled ahead of the clock
const semitone = (hz, n) => hz * (2 ** (n / 12));

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

export class Audio {
  constructor() {
    this.ctx = null;
    this.enabled = localStorage.getItem('apex.sound') !== 'off';
    this.musicLevel = Number(localStorage.getItem('apex.music') ?? 1);
    this.sfxLevel = Number(localStorage.getItem('apex.sfx') ?? 1);
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
    this.master.gain.value = this.enabled ? 0.9 : 0;
    this.master.connect(this.ctx.destination);

    this.musicBus = this.ctx.createGain();
    this.musicBus.gain.value = 0.34 * this.musicLevel;
    this.musicBus.connect(this.master);

    this.sfxBus = this.ctx.createGain();
    this.sfxBus.gain.value = 0.5 * this.sfxLevel;
    this.sfxBus.connect(this.master);

    this.#buildEngine();
    this.noise = this.#noiseBuffer();
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
    if (this.master) {
      this.master.gain.setTargetAtTime(on ? 0.9 : 0, this.ctx.currentTime, 0.05);
    }
  }

  setMusicLevel(level) {
    this.musicLevel = level;
    localStorage.setItem('apex.music', String(level));
    this.musicBus?.gain.setTargetAtTime(0.34 * level, this.ctx.currentTime, 0.05);
  }

  setSfxLevel(level) {
    this.sfxLevel = level;
    localStorage.setItem('apex.sfx', String(level));
    this.sfxBus?.gain.setTargetAtTime(0.5 * level, this.ctx.currentTime, 0.05);
  }

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
    this.engineGain.connect(this.master);
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

    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 700;
    this.windGain.connect(this.master);
    this.windFilter.connect(this.windGain);
    const wind = ctx.createBufferSource();
    wind.buffer = this.#noiseBuffer();
    wind.loop = true;
    wind.connect(this.windFilter);
    wind.start();
  }

  // rpm 0..1 within the current gear, load 0..1 from the throttle.
  engine({ rpm, load, kmh, slide, boosting }) {
    if (!this.started) return;
    const t = this.ctx.currentTime;
    const e = this.engineProfile;
    const base = e.base + rpm * e.span + (boosting ? e.span * 0.18 : 0);
    for (const o of this.engineOsc) o.frequency.setTargetAtTime(base, t, 0.05);
    this.engineFilter.frequency.setTargetAtTime(e.cut + rpm * 2400 + load * 700, t, 0.06);
    this.engineGain.gain.setTargetAtTime(0.1 + load * 0.16 + rpm * 0.06 + e.grit * load, t, 0.08);

    // Wind rises with speed; a sliding tyre adds a hiss on top of it.
    const hiss = Math.min(1, slide * 0.35);
    this.windFilter.frequency.setTargetAtTime(500 + kmh * 4 + hiss * 1800, t, 0.1);
    this.windGain.gain.setTargetAtTime(Math.min(0.14, kmh / 2600) + hiss * 0.1, t, 0.1);
  }

  silenceEngine() {
    if (!this.started) return;
    this.engineGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.2);
    this.windGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.2);
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

  boost() {
    this.#burst({ type: 'noise', dur: 0.5, gain: 0.16,
      filter: { type: 'bandpass', from: 380, to: 3600, q: 2.2 } });
  }

  beep(high) {
    this.#burst({ type: 'triangle', freq: high ? 880 : 520, dur: high ? 0.34 : 0.16,
      gain: 0.22 });
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
