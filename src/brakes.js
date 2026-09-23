// Brake discs as a heat store. Braking turns the car's speed into heat in the
// discs, split front to rear by the brake bias; moving air takes it away, and
// a glowing disc also radiates. A disc that is too hot grips the pad less,
// which is fade; one that is stone cold bites a little less too.
const CAPACITY = 5000;          // J/K per axle, both discs
const INTO_DISCS = 0.92;        // of braking work that ends up in the discs
const FADE_START = 650;         // C where the pad starts to lose bite
const FADE_SPAN = 300;          // C over which it loses the most it will
const FADE_MAX = 0.25;          // at worst a quarter of the bite is gone

export class Brakes {
  constructor(bias = 0.62) {
    this.bias = bias;
    this.reset();
  }

  reset(air = 20) {
    this.temps = [air + 60, air + 60];
  }

  // `force` is the braking force the tyres actually passed to the road, so
  // a locked wheel heats its tyre rather than its disc.
  heat(dt, { force, speed, air }) {
    const work = Math.max(0, force) * Math.max(0, speed) * INTO_DISCS;
    const conv = 0.008 + 0.0008 * speed;
    for (let axle = 0; axle < 2; axle++) {
      const t = this.temps[axle];
      const share = axle === 0 ? this.bias : 1 - this.bias;
      const radiant = 0.02 * ((t + 273) / 1073) ** 3;
      this.temps[axle] = t + (work * share / CAPACITY - (conv + radiant) * (t - air)) * dt;
    }
  }

  // Share of the pedal's force the discs can deliver right now.
  axleEfficiency(axle) {
    const t = this.temps[axle];
    const fade = FADE_MAX * Math.min(1, Math.max(0, (t - FADE_START) / FADE_SPAN));
    const cold = 0.05 * Math.min(1, Math.max(0, (120 - t) / 100));
    return 1 - fade - cold;
  }

  get efficiency() {
    return this.axleEfficiency(0) * this.bias + this.axleEfficiency(1) * (1 - this.bias);
  }

  get fading() { return Math.max(...this.temps) > FADE_START; }

  // How visibly the disc glows, 0 to 1: dull red from about 420 C.
  glow(axle) {
    return Math.min(1, Math.max(0, (this.temps[axle] - 420) / 480));
  }
}
