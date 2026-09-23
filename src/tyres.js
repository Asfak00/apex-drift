// Tyres are a consumable, not a constant. A set has a compound, a life, and a
// grip that falls as that life is spent. Everything that reads grip reads it
// from here, so a worn set is slow for the same reason a wet road is slow.

// Three compounds, in the order a strategist thinks about them. `grip` is the
// multiplier on the car's lateral grip when the set is new; `wear` is how fast
// it spends that life; `wet` is how much of the weather's water penalty the
// compound takes on top of the road's own. `window` is the tread temperature,
// in degrees C, where the compound works, and `heat` how readily it gets
// there: a soft compound works cooler and warms faster.
export const COMPOUNDS = {
  soft:   { key: 'S', name: 'Soft',   grip: 1.10, wear: 2.00, wet: 1.25, color: 0xff4d4d,
            window: [75, 100], heat: 1.2 },
  medium: { key: 'M', name: 'Medium', grip: 1.00, wear: 1.00, wet: 1.00, color: 0xffc94d,
            window: [82, 106], heat: 1.0 },
  hard:   { key: 'H', name: 'Hard',   grip: 0.92, wear: 0.55, wet: 0.82, color: 0xe8eef7,
            window: [90, 116], heat: 0.82 },
};

// Wheel order everywhere: front left, front right, rear left, rear right.
export const WHEELS = ['FL', 'FR', 'RL', 'RR'];

// Tread heat. A set is fitted warm, off the blankets. Heat comes from the
// tread sliding over the road (the work the tyre does at its slip angle, in
// wheelspin and in lock-ups) and from the carcass flexing as it rolls. It
// leaves into the air, faster at speed, into the road, and very quickly into
// standing water.
const BLANKET = 72;             // C when fitted
const CAPACITY = 5200;          // J/K, effective tread and carcass per tyre
const HEAT_SHARE = 0.35;        // of sliding work that stays in the tread
const ROLLING = 0.012;          // rolling loss per newton of load per m/s
const COLD_PSI = 26;            // pressure set cold, at 20 C
const HOT_OPTIMUM = 31.5;       // psi at which the contact patch is best, hot

export const COMPOUND_KEYS = Object.keys(COMPOUNDS);

// Life spent per second at reference stress. Tuned so a medium set is good for
// roughly fifteen racing laps of a two-kilometre circuit.
const BASE_WEAR = 0.00112;

export class TyreSet {
  constructor(compound = 'medium') {
    // Pressures belong to the car's setup, not to a set: a fresh set is
    // inflated to the same cold figures as the last.
    this.coldPsi = [COLD_PSI, COLD_PSI];
    this.fit(compound);
    this.stints = 0;
  }

  fit(compound) {
    this.compound = COMPOUNDS[compound] ? compound : 'medium';
    this.spec = COMPOUNDS[this.compound];
    this.life = 1;
    this.stints = (this.stints ?? 0) + 1;
    this.temps = [BLANKET, BLANKET, BLANKET, BLANKET];
  }

  // One step of tread temperature. `power` is the sliding work each axle is
  // doing, in watts; `load` each axle's vertical load in newtons; `left` the
  // share of each axle's load on its left tyre, which is how the outside of a
  // corner comes to run hotter than the inside.
  heat(dt, { power, load, left, speed, air, road, wet = 0, standing = 0 }) {
    const conv = 0.004 + 0.00022 * speed;
    // Water cools the tread, but only the surface film: a tyre working hard
    // in the rain still runs warm, just not as warm.
    const water = 0.008 * wet + 0.016 * standing;
    for (let i = 0; i < 4; i++) {
      const axle = i < 2 ? 0 : 1;
      const share = i % 2 === 0 ? left : 1 - left;
      const work = power[axle] * share + ROLLING * load[axle] * share * speed;
      const t = this.temps[i];
      // A soft tyre flexes more, and flexing is heat.
      const flex = 1 + 0.035 * (COLD_PSI - this.coldPsi[axle]);
      const gain = (HEAT_SHARE * this.spec.heat * work * flex) / CAPACITY;
      const loss = conv * (t - air) + 0.003 * (t - road) + water * (t - road);
      this.temps[i] = t + (gain - loss) * dt;
    }
  }

  // What temperature does to one tyre's grip. Inside the window, nothing.
  // Cold rubber is hard and slides; past the window the tread goes greasy.
  tempGrip(i) {
    const t = this.temps[i];
    const [lo, hi] = this.spec.window;
    if (t < lo) return 1 - 0.1 * Math.min(1, (lo - t) / (lo - 15)) ** 1.3;
    if (t > hi) return 1 - Math.min(0.2, (t - hi) * 0.0065);
    return 1;
  }

  // An axle's grip is its tyres' grip weighted by the load each one carries:
  // in a corner the loaded outside tyre is most of the axle.
  axleGrip(axle, left = 0.5) {
    const l = axle * 2;
    return this.tempGrip(l) * left + this.tempGrip(l + 1) * (1 - left);
  }

  // Hot air in a sealed tyre: pressure rises with temperature.
  pressure(i) { return this.coldPsi[i < 2 ? 0 : 1] * (this.temps[i] + 273.15) / 293.15; }

  // The contact patch is best at one hot pressure. Set the cold pressure so
  // the tyre arrives there at its working temperature: over it the patch
  // crowns and shrinks, under it the sidewall folds.
  pressureGrip(axle) {
    const p = (this.pressure(axle * 2) + this.pressure(axle * 2 + 1)) / 2;
    return 1 - Math.min(0.08, 0.0022 * (p - HOT_OPTIMUM) ** 2);
  }

  // How far past its window the hottest tyre is, 0 to 1: squeal and smoke.
  get overheat() {
    const hi = this.spec.window[1];
    return Math.min(1, Math.max(0, (Math.max(...this.temps) - hi) / 30));
  }

  // Where each tyre sits against the window, for the HUD: -1 cold, 0 in,
  // 1 hot, 2 overheating.
  band(i) {
    const t = this.temps[i];
    const [lo, hi] = this.spec.window;
    if (t < lo - 8) return -1;
    if (t <= hi) return 0;
    return t > hi + 15 ? 2 : 1;
  }

  get key() { return this.spec.key; }
  get name() { return this.spec.name; }
  get color() { return this.spec.color; }
  get dead() { return this.life <= 0.02; }

  // What the compound is worth right now. New rubber gives the compound's own
  // grip; a spent set gives about seventy per cent of it, and the last tenth of
  // the life falls away faster than the rest — which is the cliff a driver
  // feels and pits for. A worn set is slow, not undriveable: the stop has to be
  // a decision, not a rescue.
  grip(wetness = 0) {
    const l = Math.max(0, this.life);
    let fade = 0.70 + 0.30 * Math.pow(l, 0.55);
    if (l < 0.12) fade *= 0.80 + 0.20 * (l / 0.12);
    // Water costs a soft slick more than a hard one, but never enough to put
    // a hard set above a soft one: the order is soft, medium, hard, always.
    const water = 1 - wetness * 0.06 * (this.spec.wet - 1) - wetness * 0.02;
    return this.spec.grip * fade * water;
  }

  // Stress is how hard the set is being worked: cornering load, wheelspin and
  // lock-up all cost life, cruising in a straight line costs very little.
  wear(dt, { lateral = 0, limit = 1, slide = 0, abrasive = 1, locked = 0, wetness = 0 }) {
    const load = Math.min(1.6, Math.abs(lateral) / Math.max(1, limit));
    // An overheated tread tears: past the window, life goes faster.
    const hot = 1 + Math.max(0, Math.max(...this.temps) - this.spec.window[1]) / 25;
    const stress = (0.22 + load * load * 1.15 + Math.min(1.2, slide * 0.14) + locked * 0.55) * hot;
    // Water keeps the surface cool and the tyre off its limit, so a wet race is
    // gentle on rubber however unpleasant it is to drive.
    const cooling = 1 - wetness * 0.4;
    this.life = Math.max(0,
      this.life - dt * BASE_WEAR * this.spec.wear * stress * abrasive * cooling);
    return this.life;
  }
}
