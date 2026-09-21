// Tyres are a consumable, not a constant. A set has a compound, a life, and a
// grip that falls as that life is spent. Everything that reads grip reads it
// from here, so a worn set is slow for the same reason a wet road is slow.

// Three compounds, in the order a strategist thinks about them. `grip` is the
// multiplier on the car's lateral grip when the set is new; `wear` is how fast
// it spends that life; `wet` is how much of the weather's water penalty the
// compound takes on top of the road's own.
export const COMPOUNDS = {
  soft:   { key: 'S', name: 'Soft',   grip: 1.10, wear: 2.00, wet: 1.25, color: 0xff4d4d },
  medium: { key: 'M', name: 'Medium', grip: 1.00, wear: 1.00, wet: 1.00, color: 0xffc94d },
  hard:   { key: 'H', name: 'Hard',   grip: 0.92, wear: 0.55, wet: 0.82, color: 0xe8eef7 },
};

export const COMPOUND_KEYS = Object.keys(COMPOUNDS);

// Life spent per second at reference stress. Tuned so a medium set is good for
// roughly fifteen racing laps of a two-kilometre circuit.
const BASE_WEAR = 0.00112;

export class TyreSet {
  constructor(compound = 'medium') {
    this.fit(compound);
    this.stints = 0;
  }

  fit(compound) {
    this.compound = COMPOUNDS[compound] ? compound : 'medium';
    this.spec = COMPOUNDS[this.compound];
    this.life = 1;
    this.stints = (this.stints ?? 0) + 1;
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
    const stress = 0.22 + load * load * 1.15 + Math.min(1.2, slide * 0.14) + locked * 0.55;
    // Water keeps the surface cool and the tyre off its limit, so a wet race is
    // gentle on rubber however unpleasant it is to drive.
    const cooling = 1 - wetness * 0.4;
    this.life = Math.max(0,
      this.life - dt * BASE_WEAR * this.spec.wear * stress * abrasive * cooling);
    return this.life;
  }
}
