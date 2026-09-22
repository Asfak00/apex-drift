// Keyboard state plus one-shot action events. The game polls axes and
// subscribes to actions; nothing else touches the DOM key events.
const AXIS_KEYS = {
  throttle: ['KeyW', 'ArrowUp'],
  brake:    ['KeyS', 'ArrowDown'],
  left:     ['KeyA', 'ArrowLeft'],
  right:    ['KeyD', 'ArrowRight'],
  handbrake:['Space'],
  boost:    ['ShiftLeft', 'ShiftRight'],
};

// While the driver is typing, the keyboard belongs to the field, not the car.
const isTyping = (target) => {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
};

const ACTION_KEYS = {
  Digit1: 'tyre-soft',
  Digit2: 'tyre-medium',
  Digit3: 'tyre-hard',
  KeyT: 'pit',
  KeyP: 'pit-assist',
  KeyC: 'camera',
  KeyV: 'vision',
  KeyB: 'weather',
  KeyR: 'respawn',
  Escape: 'menu',
  KeyM: 'sound',
  F3: 'debug',
};

export class Input {
  constructor(target = window) {
    this.down = new Set();
    this.listeners = new Map();
    // Filled in by the on-screen controls; merged with the keyboard on sample.
    this.touch = { throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false };
    this.sensitivity = 1;
    // A stick gives a real amount of steering rather than all or nothing.
    this.padDeadzone = 0.12;
    // A key is all or nothing, and a car's wheel is not. The key axis is ramped
    // so tapping left is a correction and holding it still reaches full lock
    // inside two tenths of a second.
    this.keySteer = 0;
    this.keyAttack = 5.5;    // per second, pressed
    this.keyRelease = 9;     // per second, let go

    target.addEventListener('keydown', (e) => {
      if (isTyping(e.target)) return;
      if (e.repeat) return;
      const all = Object.values(AXIS_KEYS).flat();
      if (all.includes(e.code) || e.code in ACTION_KEYS) e.preventDefault();
      this.down.add(e.code);
      const action = ACTION_KEYS[e.code];
      if (action) this.#emit(action);
    });
    target.addEventListener('keyup', (e) => this.down.delete(e.code));
    target.addEventListener('blur', () => this.down.clear());
  }

  on(action, fn) {
    if (!this.listeners.has(action)) this.listeners.set(action, []);
    this.listeners.get(action).push(fn);
  }

  // Public: the on-screen buttons raise the same actions the keys do.
  emit(action) {
    for (const fn of this.listeners.get(action) ?? []) fn();
  }

  #emit(action) {
    this.emit(action);
  }

  // First connected gamepad, if any. Left stick steers, triggers drive.
  #pad() {
    const pads = navigator.getGamepads?.() ?? [];
    for (const pad of pads) if (pad?.connected) return pad;
    return null;
  }

  #axis(value) {
    return Math.abs(value) < this.padDeadzone ? 0 : value;
  }

  #any(codes) {
    return codes.some((c) => this.down.has(c));
  }

  // Sampled straight into a car's input block each frame.
  sample(dt = 1 / 60) {
    const left = this.#any(AXIS_KEYS.left);
    const right = this.#any(AXIS_KEYS.right);
    const want = (left ? 1 : 0) - (right ? 1 : 0);
    const rate = (want === 0 ? this.keyRelease : this.keyAttack) * dt;
    this.keySteer += Math.max(-rate, Math.min(rate, want - this.keySteer));
    const t = this.touch;
    const pad = this.#pad();
    // Stick and triggers read as fractions, so a small input is a small input.
    const padSteer = pad ? -this.#axis(pad.axes[0] ?? 0) : 0;
    const padThrottle = pad ? Math.max(pad.buttons[7]?.value ?? 0, 0) : 0;
    const padBrake = pad ? Math.max(pad.buttons[6]?.value ?? 0, 0) : 0;
    const padBoost = pad ? !!pad.buttons[0]?.pressed : false;
    const padHand = pad ? !!pad.buttons[1]?.pressed : false;

    return {
      throttle: Math.max(this.#any(AXIS_KEYS.throttle) ? 1 : 0, t.throttle, padThrottle),
      brake: Math.max(this.#any(AXIS_KEYS.brake) ? 1 : 0, t.brake, padBrake),
      steer: Math.max(-1, Math.min(1,
        (this.keySteer + t.steer + padSteer) * this.sensitivity)),
      handbrake: this.#any(AXIS_KEYS.handbrake) || t.handbrake || padHand,
      boost: this.#any(AXIS_KEYS.boost) || t.boost || padBoost,
    };
  }

  clear() {
    this.down.clear();
    this.keySteer = 0;
    this.touch.throttle = 0;
    this.touch.brake = 0;
    this.touch.steer = 0;
    this.touch.handbrake = false;
    this.touch.boost = false;
  }
}
