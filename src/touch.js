// On-screen controls for phones and tablets. They write into the same input
// block the keyboard writes into, so the car has one control path and neither
// scheme knows about the other.

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export const isTouchDevice = () =>
  matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;

export class TouchControls {
  constructor(input) {
    this.input = input;
    this.state = input.touch;
    this.root = document.getElementById('touch');
    this.pad = document.getElementById('steer-pad');
    this.knob = document.getElementById('steer-knob');

    this.#bindSteer();
    this.#bindPedal('pedal-gas', 'throttle');
    this.#bindPedal('pedal-brake', 'brake');
    this.#bindPedal('pedal-boost', 'boost');
    this.#bindPedal('pedal-hand', 'handbrake');
    this.#bindTap('touch-camera', 'camera');
    this.#bindTap('touch-menu', 'menu');
  }

  show(on) {
    this.root.hidden = !on;
    // The HUD is laid out for a mouse until the on-screen controls appear: the
    // dial and the pedals both want the bottom-right corner, and on a phone
    // there is not room for both. One class moves the HUD out of their way.
    document.body.classList.toggle('touch-ui', !!on);
    if (!on) this.reset();
  }

  reset() {
    this.state.throttle = 0;
    this.state.brake = 0;
    this.state.steer = 0;
    this.state.handbrake = false;
    this.state.boost = false;
    this.#paint(0);
  }

  #paint(amount) {
    if (this.knob) {
      const travel = this.pad ? Math.max(46, this.pad.clientWidth * 0.34) : 46;
      this.knob.style.transform =
        `translateX(${-amount * travel}px) rotate(${-amount * 38}deg)`;
    }
    this.pad?.style.setProperty('--steer', String(amount));
  }

  // Steering is a drag, and a drag has to do three things a raw offset does
  // not: ignore the wobble of a thumb that is only resting, give fine control
  // near the centre and full lock at the edge, and let the driver wind lock
  // back off without lifting. The origin follows the thumb once it is past
  // full travel, so the wheel can always be turned back the other way.
  #bindSteer() {
    const pad = this.pad;
    const DEAD = 0.07;
    let originX = 0;
    let pointer = null;
    const travel = () => Math.max(46, pad.clientWidth * 0.34);

    const write = (amount) => {
      this.state.steer = amount;
      this.#paint(amount);
    };

    const move = (e) => {
      if (e.pointerId !== pointer) return;
      const span = travel();
      let offset = e.clientX - originX;
      // Past full lock the origin comes with the thumb, so the next movement
      // in the other direction unwinds the wheel immediately.
      if (offset > span) originX = e.clientX - span;
      else if (offset < -span) originX = e.clientX + span;
      offset = clamp(e.clientX - originX, -span, span);

      const raw = offset / span;
      const size = Math.abs(raw);
      // Dead zone first, then an expo curve: small angles stay small, and the
      // last of the travel is where full lock lives.
      const live = size < DEAD ? 0 : (size - DEAD) / (1 - DEAD);
      write(-Math.sign(raw) * live * live * (3 - 2 * live));
    };
    const end = (e) => {
      if (e.pointerId !== pointer) return;
      pointer = null;
      write(0);
      pad.classList.remove('active');
    };

    pad.addEventListener('pointerdown', (e) => {
      pointer = e.pointerId;
      originX = e.clientX;
      pad.setPointerCapture(e.pointerId);
      pad.classList.add('active');
      e.preventDefault();
    });
    pad.addEventListener('pointermove', move);
    pad.addEventListener('pointerup', end);
    pad.addEventListener('pointercancel', end);
  }

  #bindPedal(id, field) {
    const el = document.getElementById(id);
    if (!el) return;
    const set = (on) => {
      this.state[field] = field === 'throttle' || field === 'brake' ? (on ? 1 : 0) : on;
      el.classList.toggle('held', on);
    };
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      set(true);
      e.preventDefault();
    });
    for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
      el.addEventListener(type, () => set(false));
    }
  }

  #bindTap(id, action) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('click', (e) => {
      e.preventDefault();
      this.input.emit(action);
    });
  }
}
