import { PALETTE, PIT } from './config.js';
import { COMPOUNDS } from './tyres.js';

// The dial: a 270-degree sweep from bottom-left, over the top, to
// bottom-right, in the SVG's 320-unit square. Angles are degrees clockwise
// from +x, which is how SVG draws them.
const CX = 160, CY = 160, A0 = 135, SWEEP = 270;
const SVG = 'http://www.w3.org/2000/svg';
const pt = (deg, r) => [CX + r * Math.cos((deg * Math.PI) / 180), CY + r * Math.sin((deg * Math.PI) / 180)];
function arcPath(r, from, to, ccw = false) {
  const [x0, y0] = pt(from, r), [x1, y1] = pt(to, r);
  const large = Math.abs(to - from) > 180 ? 1 : 0;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${large} ${ccw ? 0 : 1} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}
// Where the delta to the best lap is sampled along the lap.
const SPLITS = 240;

export const formatTime = (s) => {
  if (s == null || !isFinite(s)) return '--:--.--';
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(2).padStart(5, '0')}`;
};

// All DOM reads and writes for the running race live here.
export class Hud {
  constructor(track) {
    this.el = {
      hud: document.getElementById('hud'),
      lap: document.getElementById('lap'),
      pos: document.getElementById('pos'),
      time: document.getElementById('time'),
      last: document.getElementById('last'),
      best: document.getElementById('best'),
      speed: document.getElementById('speed'),
      gear: document.getElementById('gear'),
      dash: document.getElementById('dash'),
      needle: document.getElementById('needle-group'),
      ticks: document.getElementById('dial-ticks'),
      revTrack: document.getElementById('rev-track'),
      revRed: document.getElementById('rev-red'),
      revFill: document.getElementById('rev-fill'),
      boostArc: document.getElementById('boost-arc'),
      boostArcTrack: document.getElementById('boost-arc-track'),
      shiftLights: document.getElementById('shift-lights'),
      posOf: document.getElementById('pos-of'),
      raceLap: document.getElementById('race-lap'),
      lapProgress: document.getElementById('lap-progress'),
      delta: document.getElementById('delta'),
      gripFill: document.getElementById('grip-fill'),
      hudLeft: document.getElementById('hud-left'),
      hudRight: document.getElementById('hud-right'),
      hudTop: document.getElementById('hud-top'),
      hudBottom: document.getElementById('hud-bottom'),
      grip: document.getElementById('grip'),
      road: document.getElementById('road-state'),
      vision: document.getElementById('vision-name'),
      weather: document.getElementById('weather-name'),
      track: document.getElementById('track-name'),
      ahead: document.getElementById('gap-ahead'),
      behind: document.getElementById('gap-behind'),
      toast: document.getElementById('toast'),
      notes: document.getElementById('notes'),
      boost: document.getElementById('boost'),
      boostFill: document.getElementById('boost-fill'),
      boostCharges: document.getElementById('boost-charges'),
      tyres: document.getElementById('tyres'),
      tyreBadge: document.getElementById('tyre-badge'),
      tyreLife: document.getElementById('tyre-life'),
      tyreFill: document.getElementById('tyre-fill'),
      tyreTrack: document.getElementById('tyre-track'),
      thermal: document.getElementById('thermal'),
      pitRow: document.getElementById('pit-row'),
      pitState: document.getElementById('pit-state'),
    };
    this.picks = [...document.querySelectorAll('.pick[data-tyre]')];
    this.treads = [...document.querySelectorAll('#thermal i')];
    this.discs = [...document.querySelectorAll('#thermal b')];
    this.thermalClock = 0;

    this.map = document.getElementById('minimap');
    this.ctx = this.map.getContext('2d');
    this.setTrack(track);

    this.maxKmh = 300;
    this.gears = true;
    this.needleKmh = 0;
    this.shownRpm = 0;
    this.#buildDial();
    this.#buildShiftLights();
    this.toastTimer = 0;
    this.splits = new Float32Array(SPLITS).fill(NaN);
    this.bestSplits = null;
    this.splitLap = null;
    this.fitDirty = true;
    addEventListener('resize', () => { this.fitDirty = true; });
  }

  // The instrument follows the vehicle: its scale runs a little past the
  // vehicle's top speed (estimated from its power, drag and any governor),
  // the rev arc and shift lights only exist with a gearbox, and a bike's
  // tyre card shows two tyres.
  setVehicle(car) {
    const tune = car.tune;
    const power = tune.enginePower * tune.powerBand;
    const top = Math.min(Math.cbrt(power / Math.max(0.05, tune.dragCoeff)), tune.topLimit ?? 999) * 3.6;
    this.maxKmh = [120, 160, 200, 240, 280, 320, 360, 400].find((v) => v >= top * 1.06) ?? 400;
    this.gears = !!tune.caps?.gears;
    this.#buildDial();
    this.el.shiftLights.classList.toggle('off', !this.gears);
    this.el.tyres.classList.toggle('two-wheel', car.profile?.wheels === 2);
    this.needleKmh = 0;
    this.shownRpm = 0;
    this.splits.fill(NaN);
    this.bestSplits = null;
    this.splitLap = null;
    this.fitDirty = true;
  }

  // Scale marks and numerals outside, the rev arc inside them with its
  // redline, and the boost arc across the gap at the bottom of the dial.
  #buildDial() {
    const g = this.el.ticks;
    g.replaceChildren();
    const max = this.maxKmh;
    const major = max <= 160 ? 20 : 40;
    const minor = major / 4;
    for (let v = 0; v <= max + 1e-6; v += minor) {
      const isMajor = Math.abs(v / major - Math.round(v / major)) < 1e-6;
      const a = A0 + (v / max) * SWEEP;
      const [x1, y1] = pt(a, 146);
      const [x2, y2] = pt(a, isMajor ? 131 : 139);
      const line = document.createElementNS(SVG, 'line');
      line.setAttribute('class', isMajor ? 'tick major' : 'tick');
      line.setAttribute('x1', x1.toFixed(2));
      line.setAttribute('y1', y1.toFixed(2));
      line.setAttribute('x2', x2.toFixed(2));
      line.setAttribute('y2', y2.toFixed(2));
      g.appendChild(line);
      if (!isMajor) continue;
      const [tx, ty] = pt(a, 108);
      const label = document.createElementNS(SVG, 'text');
      label.setAttribute('class', 'tick-num');
      label.setAttribute('x', tx.toFixed(2));
      label.setAttribute('y', ty.toFixed(2));
      label.textContent = String(Math.round(v));
      g.appendChild(label);
    }
    this.el.revTrack.setAttribute('d', arcPath(123, A0, A0 + SWEEP));
    this.el.revRed.setAttribute('d', arcPath(123, A0 + SWEEP * 0.86, A0 + SWEEP));
    this.el.revFill.setAttribute('d', arcPath(123, A0, A0 + SWEEP));
    this.revLen = this.el.revFill.getTotalLength();
    this.el.revFill.style.strokeDasharray = `${this.revLen}`;
    this.el.revFill.style.strokeDashoffset = `${this.revLen}`;
    for (const el of [this.el.revTrack, this.el.revRed, this.el.revFill]) {
      el.style.display = this.gears === false ? 'none' : '';
    }
    this.el.boostArcTrack.setAttribute('d', arcPath(144, 118, 62, true));
    this.el.boostArc.setAttribute('d', arcPath(144, 118, 62, true));
    this.boostLen = this.el.boostArc.getTotalLength();
    this.el.boostArc.style.strokeDasharray = `${this.boostLen}`;
  }

  // Nine lights over the gear: three green, three amber, three red, then all
  // of them flash when it is time to change up.
  #buildShiftLights() {
    const g = this.el.shiftLights;
    g.replaceChildren();
    this.lights = [];
    for (let i = 0; i < 9; i++) {
      const [x, y] = pt(244 + i * 6.5, 84);
      const c = document.createElementNS(SVG, 'circle');
      c.setAttribute('cx', x.toFixed(2));
      c.setAttribute('cy', y.toFixed(2));
      c.setAttribute('r', '3.6');
      c.dataset.band = i < 3 ? 'g' : i < 6 ? 'a' : 'r';
      g.appendChild(c);
      this.lights.push(c);
    }
    this.litCount = -1;
  }

  // Each column is scaled as one piece so no card can overlap another: the
  // right column must fit its top and bottom stacks in the window's height,
  // the left its cards, and both together must leave the middle of the
  // screen, where the car is, clear.
  #fit() {
    this.fitDirty = false;
    const { hud, hudLeft, hudRight, hudTop, hudBottom } = this.el;
    if (hud.hidden) { this.fitDirty = true; return; }
    const touch = document.body.classList.contains('touch-ui');
    const avail = hudRight.offsetHeight;
    const top = hudTop.offsetHeight;
    const bottom = hudBottom.offsetHeight;
    const leftH = hudLeft.scrollHeight;
    let scale = 1;
    if (!touch) scale = Math.min(scale, (avail - 16) / Math.max(1, top + bottom));
    scale = Math.min(scale, avail / Math.max(1, leftH));
    const sides = hudLeft.offsetWidth + Math.max(hudTop.offsetWidth, touch ? 0 : hudBottom.offsetWidth);
    const across = touch ? sides + hudBottom.offsetWidth + 40 : sides / 0.64;
    scale = Math.min(scale, innerWidth / Math.max(1, across));
    hud.style.setProperty('--hud-scale', Math.max(0.5, scale).toFixed(3));
  }

  // The gap to the best lap at this point of the lap: elapsed time is
  // recorded as the lap is driven, and the best lap's record is kept.
  #delta(player, clock) {
    const lap = player.lap;
    if (this.splitLap !== lap) {
      const best = player.bestLapTime;
      if (this.splitLap !== null && best != null && player.lastLapTime === best) {
        this.bestSplits = this.splits.slice();
      }
      this.splits.fill(NaN);
      this.splitLap = lap;
      this.lastBin = -1;
    }
    const frac = ((player.progress % 1) + 1) % 1;
    const bin = Math.min(SPLITS - 1, Math.floor(frac * SPLITS));
    const elapsed = clock - player.lapStart;
    // The grid is just behind the line: a lap that begins near its end has
    // not started yet, and a jump back to the start is the line itself.
    if (bin < this.lastBin - SPLITS / 2) {
      this.splits.fill(NaN);
      this.lastBin = -1;
    }
    if (this.lastBin === -1 && bin > SPLITS / 2) return null;
    if (bin > this.lastBin) {
      for (let b = this.lastBin + 1; b <= bin; b++) this.splits[b] = elapsed;
      this.lastBin = bin;
    }
    const ref = this.bestSplits?.[bin];
    return Number.isFinite(ref) ? elapsed - ref : null;
  }

  // The minimap is drawn from a projection of whichever circuit is loaded.
  setTrack(track) {
    this.track = track;
    this.outline = track.outline(10);
    const b = track.bounds();
    const pad = 26;
    const span = Math.max(b.max.x - b.min.x, b.max.z - b.min.z);
    this.scale = (this.map.width - pad * 2) / span;
    this.offsetX = (this.map.width - (b.max.x - b.min.x) * this.scale) / 2;
    this.offsetZ = (this.map.height - (b.max.z - b.min.z) * this.scale) / 2;
    this.originX = b.min.x;
    this.originZ = b.min.z;
    this.pad = pad;
  }

  show(on) {
    this.el.hud.hidden = !on;
    if (on) this.fitDirty = true;
  }

  toast(text, seconds = 1.6, color = '#e8eef7') {
    this.el.toast.textContent = text;
    this.el.toast.style.color = color;
    this.el.toast.classList.add('show');
    this.toastTimer = seconds;
  }

  #toMap(x, z) {
    return [
      this.offsetX + (x - this.originX) * this.scale,
      this.offsetZ + (z - this.originZ) * this.scale,
    ];
  }

  #drawMap(player, rivals) {
    const c = this.ctx, w = this.map.width;
    c.clearRect(0, 0, w, w);
    c.lineJoin = 'round';

    c.beginPath();
    for (let i = 0; i < this.outline.length; i++) {
      const [x, y] = this.#toMap(this.outline[i][0], this.outline[i][1]);
      i ? c.lineTo(x, y) : c.moveTo(x, y);
    }
    c.closePath();
    // The circuit reads as a dark ribbon with a crimson edge, so the white
    // player marker is the brightest thing on the map.
    c.strokeStyle = 'rgba(232,236,244,.10)';
    c.lineWidth = 9;
    c.stroke();
    c.strokeStyle = 'rgba(224,27,36,.62)';
    c.lineWidth = 1.6;
    c.stroke();

    // Direction of travel, marked once at the start line.
    const [sx, sy] = this.#toMap(this.outline[0][0], this.outline[0][1]);
    const [nx, ny] = this.#toMap(this.outline[1][0], this.outline[1][1]);
    c.save();
    c.translate(sx, sy);
    c.rotate(Math.atan2(ny - sy, nx - sx));
    c.fillStyle = 'rgba(255,58,63,.9)';
    c.fillRect(-1, -5, 2, 10);
    c.restore();

    const dot = (car, color, r) => {
      const [x, y] = this.#toMap(car.position.x, car.position.z);
      c.beginPath();
      c.arc(x, y, r, 0, Math.PI * 2);
      c.fillStyle = color;
      c.fill();
    };
    // AI cars carry a palette colour, network cars carry the one the server gave them.
    rivals.forEach((r, i) => {
      const hex = r.color ?? PALETTE.rivals[i % PALETTE.rivals.length];
      dot(r, `#${hex.toString(16).padStart(6, '0')}`, 3);
    });

    // Player arrow points along heading so the map reads at a glance.
    const [px, py] = this.#toMap(player.position.x, player.position.z);
    c.save();
    c.translate(px, py);
    c.rotate(-player.yaw + Math.PI);
    c.beginPath();
    c.moveTo(0, -6); c.lineTo(4.5, 5); c.lineTo(0, 2.5); c.lineTo(-4.5, 5);
    c.closePath();
    c.fillStyle = '#ffffff';
    c.fill();
    c.strokeStyle = 'rgba(224,27,36,.9)';
    c.lineWidth = 1.4;
    c.stroke();
    c.restore();
  }

  // A short-lived line in the feed, for something another driver did.
  note(text, color = 0x4de3b0) {
    const el = document.createElement('div');
    el.className = 'note';
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.style.background = `#${color.toString(16).padStart(6, '0')}`;
    const label = document.createElement('span');
    label.textContent = text;
    el.append(chip, label);
    this.el.notes.append(el);
    // The out animation finishes at 3.3s; drop the node just after.
    setTimeout(() => el.remove(), 3500);
    while (this.el.notes.childElementCount > 4) this.el.notes.firstElementChild.remove();
  }

  #writeGap(el, gap, pace = 30) {
    if (!el) return;
    if (!gap) { el.textContent = '—'; el.classList.remove('close'); return; }
    const metres = Math.abs(gap.metres);
    // Seconds are what a driver races by; beyond a lap-sized gap, distance.
    const text = metres >= 1000
      ? `${(metres / 1000).toFixed(2)} km`
      : `${(metres / pace).toFixed(1)} s`;
    el.textContent = `${gap.name} · ${text}`;
    el.classList.toggle('close', metres < 30);
  }

  // Temperatures change over seconds, so a few repaints a second is plenty.
  #writeThermal(tyres, brakes, dt) {
    this.thermalClock -= dt;
    if (this.thermalClock > 0) return;
    this.thermalClock = 0.2;
    const bands = ['cold', 'ok', 'hot', 'over'];
    this.treads.forEach((el, i) => {
      const band = bands[tyres.band(i) + 1];
      el.textContent = String(Math.round(tyres.temps[i]));
      if (el.dataset.band !== band) { el.className = band; el.dataset.band = band; }
    });
    const labels = ['front', 'rear'];
    this.discs.forEach((el, axle) => {
      el.hidden = !brakes;
      if (!brakes) return;
      const t = brakes.temps[axle];
      el.textContent = String(Math.round(t));
      const band = t > 650 ? 'fade' : t > 480 ? 'warm' : '';
      if (el.className !== band) el.className = band;
      el.title = `${labels[axle]} brakes ${Math.round(t)} C`;
    });
    this.el.thermal.setAttribute('aria-label', `Tyres ${tyres.temps.map(Math.round).join(', ')} C`
      + (brakes ? `; brakes ${brakes.temps.map(Math.round).join(', ')} C` : ''));
  }

  // What is on the car, how much of it is left, and what the pit wall is
  // waiting for. One panel: a driver reads rubber and strategy together.
  #writeTyres(tyres, pit, wear = true, brakes = null, dt = 0) {
    if (this.el.tyres.hidden !== !tyres) {
      this.el.tyres.hidden = !tyres;
      this.fitDirty = true;
    }
    if (!tyres) return;
    this.#writeThermal(tyres, brakes, dt);
    // Without wear there is no life to show, only what the rubber is doing.
    this.el.tyreLife.hidden = !wear;
    if (this.el.tyreTrack) this.el.tyreTrack.hidden = !wear;
    const life = Math.max(0, tyres.life);
    const hex = `#${tyres.color.toString(16).padStart(6, '0')}`;
    this.el.tyreBadge.textContent = tyres.key;
    this.el.tyreBadge.style.background = hex;
    this.el.tyreLife.textContent = `${Math.round(life * 100)}%`;
    this.el.tyreFill.style.width = `${life * 100}%`;
    this.el.tyreFill.style.background = life < 0.14 ? '#ff3a3f' : life < 0.32 ? '#ffc94d' : hex;
    this.el.tyres.classList.toggle('worn', life < 0.32);
    this.el.tyres.classList.toggle('shot', life < 0.14);

    if (this.el.pitRow.hidden !== !pit) {
      this.el.pitRow.hidden = !pit;
      this.fitDirty = true;
    }
    if (!pit) return;
    const state = pit.serving > 0
      ? `SERVICE ${Math.round(pit.serving * 100)}%`
      : pit.speeding
        ? `SLOW · ${Math.round(PIT.limit * 3.6)} KM/H`
        : pit.lane
          ? 'PIT LANE'
          : pit.called
            ? `BOX · ${COMPOUNDS[pit.called].name.toUpperCase()}`
            : `STOPS ${pit.stops}`;
    this.el.pitState.textContent = state;
    this.el.pitState.classList.toggle('hot', !!pit.called || pit.serving > 0);
    this.el.pitState.classList.toggle('bad', !!pit.speeding);
    for (const b of this.picks) {
      b.setAttribute('aria-pressed', String(b.dataset.tyre === pit.next));
    }
  }

  update(dt, state) {
    const { player, rivals, lapCount, position, entries, clock, env, surface } = state;

    // Cards change height as a race goes on (the pit row, the tyre card), so
    // the fit is checked again every second as well as on resize.
    this.fitClock = (this.fitClock ?? 0) + dt;
    if (this.fitClock > 1) { this.fitClock = 0; this.fitDirty = true; }
    if (this.fitDirty) this.#fit();
    const kmh = player.kmh;
    const speedText = String(Math.round(kmh));
    if (this.el.speed.textContent !== speedText) this.el.speed.textContent = speedText;
    const gearText = String(player.gear);
    if (this.el.gear.textContent !== gearText) this.el.gear.textContent = gearText;

    // A needle has mass: it chases the speed rather than jumping to it, and
    // on a dash shaking at high revs it trembles a little.
    this.needleKmh += (Math.min(kmh, this.maxKmh * 1.02) - this.needleKmh) * Math.min(1, dt * 14);
    const rpm = Math.max(0, Math.min(1, player.rpm ?? 0));
    this.shownRpm += (rpm - this.shownRpm) * Math.min(1, dt * 18);
    const tremor = this.shownRpm > 0.85 ? Math.sin(performance.now() * 0.09) * 0.4 : 0;
    const angle = A0 + Math.min(1.02, this.needleKmh / this.maxKmh) * SWEEP;
    this.el.needle.setAttribute('transform', `rotate(${(angle - 270 + tremor).toFixed(2)} ${CX} ${CY})`);
    if (this.gears) {
      this.el.revFill.style.strokeDashoffset = `${this.revLen * (1 - this.shownRpm)}`;
      // Shift lights fill from 70% of the revs and flash at the limit.
      const lit = this.shownRpm < 0.7 ? 0 : Math.min(9, Math.floor((this.shownRpm - 0.7) / 0.26 * 9) + 1);
      const flash = this.shownRpm > 0.965;
      this.el.shiftLights.classList.toggle('flash', flash && (performance.now() % 160) < 80);
      if (lit !== this.litCount) {
        this.lights.forEach((c, i) => c.setAttribute('class', i < lit ? `on ${c.dataset.band}` : ''));
        this.litCount = lit;
      }
    }

    const boost = player.boost ?? { reserve: 0, capacity: 1, firing: false };
    const left = Math.max(0, Math.min(1, boost.reserve / boost.capacity));
    this.el.boostFill.style.width = `${left * 100}%`;
    this.el.boostArc.style.strokeDashoffset = `${this.boostLen * (1 - left)}`;
    this.el.boost.classList.toggle('firing', !!boost.firing);
    this.el.dash.classList.toggle('firing', !!boost.firing);
    this.el.boost.classList.toggle('empty', left < 0.12);

    // What the reserve is worth is capped by what the driver can pay for.
    const charges = state.wallet?.charges ?? 0;
    this.el.boostCharges.textContent = String(charges);
    this.el.boost.classList.toggle('broke', charges === 0);

    this.el.raceLap.hidden = !lapCount;
    this.el.lap.textContent = lapCount ? `${Math.min(player.lap + 1, lapCount)}/${lapCount}` : '--';
    const frac = ((player.progress % 1) + 1) % 1;
    this.el.lapProgress.style.width = `${(frac * 100).toFixed(1)}%`;
    this.el.pos.textContent = entries > 1 ? String(position) : '–';
    this.el.posOf.textContent = entries > 1 ? `/${entries}` : '';
    this.el.time.textContent = formatTime(clock - player.lapStart);
    this.el.last.textContent = formatTime(player.lastLapTime);
    this.el.best.textContent = formatTime(player.bestLapTime);
    // Ahead of the best lap is green, behind it red, by how much in seconds.
    const delta = this.#delta(player, clock);
    if (delta === null) {
      if (this.el.delta.textContent) this.el.delta.textContent = '';
    } else {
      this.el.delta.textContent = `${delta < 0 ? '−' : '+'}${Math.abs(delta).toFixed(2)}`;
      this.el.delta.className = `delta mono ${delta < 0 ? 'gain' : 'loss'}`;
    }

    // What the tyres actually have: the road under the car (water,
    // temperature, rubber, dirt) and the circuit's own surface, then whatever
    // is left after running wide.
    const road = state.grip ?? env.grip * (surface?.grip ?? 1);
    const grip = Math.round(road * (player.onRoad ? 1 : 0.55) * 100);
    const cond = state.condition;
    if (cond && this.el.road) {
      const text = `${Math.round(cond.temperature)}° ${cond.state}`;
      if (this.el.road.textContent !== text) this.el.road.textContent = text;
    }
    this.el.grip.textContent = `${grip}%`;
    const gripColor = grip < 60 ? '#ff3a3f' : grip < 85 ? '#ffc94d' : '#3ddc97';
    this.el.grip.style.color = gripColor;
    this.el.gripFill.style.width = `${Math.min(100, grip)}%`;
    this.el.gripFill.style.background = gripColor;
    if (surface) this.el.track.textContent = surface.name;
    this.el.vision.textContent = env.vision.name;
    this.el.weather.textContent = env.weather.name;

    this.#writeTyres(state.tyres, state.pit, state.wear, state.brakes, dt);

    // Who is in front, who is behind, and by how far, in time at the speed
    // the player is doing now.
    const pace = Math.max(8, Math.abs(player.speed ?? 0));
    this.#writeGap(this.el.ahead, state.gaps?.ahead, pace);
    this.#writeGap(this.el.behind, state.gaps?.behind, pace);

    this.#drawMap(player, rivals);

    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.el.toast.classList.remove('show');
    }
  }
}
