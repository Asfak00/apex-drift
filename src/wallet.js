// Points and boost charges, kept on this device. Every driver gets a set of
// free boosts to learn with; after those are gone a boost is something you have
// to have earned. One place owns the rules and the storage, so the HUD, the
// race and the scoreboard can never disagree about what you can afford.

const FREE_BOOSTS = 10;
const BOOST_COST = 25;

// What a race pays out.
const PODIUM = [60, 40, 25];
const FINISH_BASE = 15;
const PER_LAP = 10;
const BEST_LAP_BONUS = 20;
const PER_OVERTAKE = 5;

// A missing key reads as null, and Number(null) is 0 — which is a perfectly
// finite number and would silently swallow the default. Check for the key.
const readNumber = (key, fallback) => {
  const stored = localStorage.getItem(key);
  if (stored === null) return fallback;
  const raw = Number(stored);
  return Number.isFinite(raw) ? raw : fallback;
};

// Badges are derived from the record, never stored: there is one source of
// truth for what a driver has done.
const BADGES = [
  { id: 'first-win', name: 'First Win', hint: 'Win a race', test: (r) => r.wins >= 1 },
  { id: 'podium', name: 'Podium x3', hint: 'Finish top three, three times', test: (r) => r.podiums >= 3 },
  { id: 'regular', name: 'Regular', hint: 'Start 10 races', test: (r) => r.races >= 10 },
  { id: 'centurion', name: 'Centurion', hint: 'Complete 50 laps', test: (r) => r.laps >= 50 },
  { id: 'overtaker', name: 'Overtaker', hint: 'Make 25 overtakes', test: (r) => r.overtakes >= 25 },
  { id: 'banked', name: 'Banked', hint: 'Hold 500 points at once', test: (r) => r.best >= 500 },
];

export class Wallet {
  constructor() {
    this.points = Math.max(0, readNumber('apex.points', 0));
    this.free = Math.max(0, readNumber('apex.free', FREE_BOOSTS));
    this.cost = BOOST_COST;
    this.record = {
      races: Math.max(0, readNumber('apex.races', 0)),
      wins: Math.max(0, readNumber('apex.wins', 0)),
      podiums: Math.max(0, readNumber('apex.podiums', 0)),
      laps: Math.max(0, readNumber('apex.laps', 0)),
      overtakes: Math.max(0, readNumber('apex.overtakes', 0)),
      best: Math.max(0, readNumber('apex.bestPoints', 0)),
    };
  }

  badges() {
    return BADGES.map((b) => ({
      id: b.id, name: b.name, hint: b.hint, earned: b.test(this.record),
    }));
  }

  #save() {
    localStorage.setItem('apex.points', String(this.points));
    localStorage.setItem('apex.free', String(this.free));
    for (const [key, value] of Object.entries({
      races: 'apex.races', wins: 'apex.wins', podiums: 'apex.podiums',
      laps: 'apex.laps', overtakes: 'apex.overtakes', best: 'apex.bestPoints',
    })) localStorage.setItem(value, String(this.record[key]));
  }

  // How many boosts could be fired right now: the free ones first, then
  // whatever the points balance will buy.
  get charges() {
    return this.free + Math.floor(this.points / this.cost);
  }

  canBoost() {
    return this.charges > 0;
  }

  // Free charges are spent before points, so nobody pays while they still have
  // a freebie left.
  spendBoost() {
    if (this.free > 0) {
      this.free -= 1;
      this.#save();
      return { spent: 'free', left: this.charges };
    }
    if (this.points >= this.cost) {
      this.points -= this.cost;
      this.#save();
      return { spent: 'points', left: this.charges };
    }
    return null;
  }

  // Called once when a race ends. Returns the breakdown so the scoreboard can
  // show where the points came from.
  award({ place, entries, laps, bestLap, overtakes }) {
    const lines = [];
    const add = (label, value) => {
      if (value > 0) lines.push({ label, value });
      return value;
    };

    let total = 0;
    if (entries > 1) {
      total += add(`Finished P${place}`, PODIUM[place - 1] ?? FINISH_BASE);
    } else {
      total += add('Run completed', FINISH_BASE);
    }
    total += add(`${laps} lap${laps === 1 ? '' : 's'}`, laps * PER_LAP);
    total += add('Best lap set', bestLap ? BEST_LAP_BONUS : 0);
    total += add(`${overtakes} overtake${overtakes === 1 ? '' : 's'}`, overtakes * PER_OVERTAKE);

    this.points += total;

    this.record.races += 1;
    this.record.laps += laps;
    this.record.overtakes += overtakes;
    if (entries > 1 && place === 1) this.record.wins += 1;
    if (entries > 1 && place <= 3) this.record.podiums += 1;
    this.record.best = Math.max(this.record.best, this.points);

    const before = this.badges();
    this.#save();
    const earnedNow = this.badges().filter(
      (b, i) => b.earned && !before[i].earned,
    );

    return { total, lines, balance: this.points, charges: this.charges, earnedNow };
  }
}
