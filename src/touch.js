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
    if (!on) this.reset();
  }

  reset() {
    this.state.throttle = 0;
    this.state.brake = 0;
    this.state.steer = 0;
    this.state.handbrake = false;
    this.state.boost = false;
    if (this.knob) this.knob.style.transform = 'translateX(0px)';
  }

  // Steering is a drag: where the thumb is relative to where it landed decides
  // the angle, so the wheel is wherever the thumb happens to be.
  #bindSteer() {
    const pad = this.pad;
    let originX = 0;
    let pointer = null;
    const travel = () => Math.max(46, pad.clientWidth * 0.34);

    const move = (e) => {
      if (e.pointerId !== pointer) return;
      const offset = clamp(e.clientX - originX, -travel(), travel());
      this.state.steer = -offset / travel();
      this.knob.style.transform = `translateX(${offset}px)`;
    };
    const end = (e) => {
      if (e.pointerId !== pointer) return;
      pointer = null;
      this.state.steer = 0;
      this.knob.style.transform = 'translateX(0px)';
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
