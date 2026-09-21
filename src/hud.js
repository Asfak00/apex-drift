import { PALETTE, PIT } from './config.js';
import { COMPOUNDS } from './tyres.js';

// Top of the dial. The needle, the arc and the scale all read from this one
// number, so they can never disagree.
const MAX_KMH = 300;

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
      needle: document.getElementById('needle'),
      gaugeFill: document.getElementById('gauge-fill'),
      grip: document.getElementById('grip'),
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
      pitRow: document.getElementById('pit-row'),
      pitState: document.getElementById('pit-state'),
    };
    this.picks = [...document.querySelectorAll('.pick[data-tyre]')];

    this.map = document.getElementById('minimap');
    this.ctx = this.map.getContext('2d');
    this.setTrack(track);

    this.gaugeLen = this.el.gaugeFill.getTotalLength();
    this.el.gaugeFill.style.strokeDasharray = this.gaugeLen;
    this.#buildTicks();
    this.toastTimer = 0;
  }

  // Scale marks live outside the arc; the big number lives inside it.
  #buildTicks() {
    const g = document.getElementById('gauge-ticks');
    g.replaceChildren();
    const ns = 'http://www.w3.org/2000/svg';
    const CX = 120, CY = 132, STEPS = 12;
    for (let i = 0; i <= STEPS; i++) {
      const major = i % 2 === 0;
      const a = Math.PI - (i / STEPS) * Math.PI;
      const cos = Math.cos(a), sin = Math.sin(a);
      const line = document.createElementNS(ns, 'line');
      line.setAttribute('class', major ? 'tick major' : 'tick');
      line.setAttribute('x1', CX + cos * 89);
      line.setAttribute('y1', CY - sin * 89);
      line.setAttribute('x2', CX + cos * (major ? 78 : 82));
      line.setAttribute('y2', CY - sin * (major ? 78 : 82));
      g.appendChild(line);
      if (!major) continue;
      const label = document.createElementNS(ns, 'text');
      label.setAttribute('class', 'tick-label');
      label.setAttribute('x', CX + cos * 102);
      label.setAttribute('y', CY - sin * 102);
      label.textContent = (i / STEPS) * MAX_KMH;
      g.appendChild(label);
    }
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

  show(on) { this.el.hud.hidden = !on; }

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
    c.strokeStyle = 'rgba(160,190,225,.32)';
    c.lineWidth = 8;
    c.stroke();
    c.strokeStyle = 'rgba(200,225,255,.16)';
    c.lineWidth = 1.5;
    c.stroke();

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
    c.fillStyle = '#4de3b0';
    c.fill();
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

  #writeGap(el, gap) {
    if (!el) return;
    if (!gap) { el.textContent = '—'; el.classList.remove('close'); return; }
    const metres = Math.abs(gap.metres);
    const distance = metres >= 1000
      ? `${(metres / 1000).toFixed(2)} km`
      : `${Math.round(metres)} m`;
    el.textContent = `${gap.name} · ${distance}`;
    el.classList.toggle('close', metres < 30);
  }

  // What is on the car, how much of it is left, and what the pit wall is
  // waiting for. One panel: a driver reads rubber and strategy together.
  #writeTyres(tyres, pit) {
    this.el.tyres.hidden = !tyres;
    if (!tyres) return;
    const life = Math.max(0, tyres.life);
    const hex = `#${tyres.color.toString(16).padStart(6, '0')}`;
    this.el.tyreBadge.textContent = tyres.key;
    this.el.tyreBadge.style.background = hex;
    this.el.tyreLife.textContent = `${Math.round(life * 100)}%`;
    this.el.tyreFill.style.width = `${life * 100}%`;
    this.el.tyreFill.style.background = life < 0.14 ? '#ff5f5f' : life < 0.32 ? '#ffc94d' : hex;
    this.el.tyres.classList.toggle('worn', life < 0.32);
    this.el.tyres.classList.toggle('shot', life < 0.14);

    this.el.pitRow.hidden = !pit;
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

    const kmh = player.kmh;
    this.el.speed.textContent = Math.round(kmh);
    this.el.gear.textContent = player.gear;

    // The needle pivots on the hub via the SVG attribute, which carries its own
    // centre of rotation.
    const frac = Math.min(1, kmh / MAX_KMH);
    this.el.needle.setAttribute('transform', `rotate(${-90 + frac * 180} 120 132)`);
    this.el.gaugeFill.style.strokeDashoffset = this.gaugeLen * (1 - frac);
    this.el.gaugeFill.style.stroke = kmh > 240 ? '#ff5f5f' : kmh > 170 ? '#ffc94d' : '#4de3b0';

    const boost = player.boost ?? { reserve: 0, capacity: 1, firing: false };
    const left = Math.max(0, Math.min(1, boost.reserve / boost.capacity));
    this.el.boostFill.style.width = `${left * 100}%`;
    this.el.boost.classList.toggle('firing', !!boost.firing);
    this.el.boost.classList.toggle('empty', left < 0.12);

    // What the reserve is worth is capped by what the driver can pay for.
    const charges = state.wallet?.charges ?? 0;
    this.el.boostCharges.textContent = String(charges);
    this.el.boost.classList.toggle('broke', charges === 0);

    this.el.lap.textContent = lapCount ? `${Math.min(player.lap + 1, lapCount)}/${lapCount}` : '--';
    this.el.pos.textContent = entries > 1 ? `${position}/${entries}` : '--';
    this.el.time.textContent = formatTime(clock - player.lapStart);
    this.el.last.textContent = formatTime(player.lastLapTime);
    this.el.best.textContent = formatTime(player.bestLapTime);

    // What the tyres actually have: weather, then the circuit's own surface,
    // then whatever is left after running wide.
    const surfaceGrip = surface?.grip ?? 1;
    const grip = Math.round(env.grip * surfaceGrip * (player.onRoad ? 1 : 0.55) * 100);
    this.el.grip.textContent = `${grip}%`;
    this.el.grip.style.color = grip < 60 ? '#ff5f5f' : grip < 85 ? '#ffc94d' : '#4de3b0';
    if (surface) this.el.track.textContent = surface.name;
    this.el.vision.textContent = env.vision.name;
    this.el.weather.textContent = env.weather.name;

    this.#writeTyres(state.tyres, state.pit);

    // Who is in front, who is behind, and by how far.
    this.#writeGap(this.el.ahead, state.gaps?.ahead);
    this.#writeGap(this.el.behind, state.gaps?.behind);

    this.#drawMap(player, rivals);

    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.el.toast.classList.remove('show');
    }
  }
}
