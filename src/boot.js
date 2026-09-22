// The boot sequence: what the player sees while the game is being built.
//
// Two rules decide everything here. The progress bar shows work that has
// actually finished — each step reports in when it is done, and the bar is the
// share of the weight that has reported, never a timer pretending to be one.
// And the screen is not a separate production: the car being revealed is the
// car the menu is about to show, lit by the same studio, so the boot screen is
// the first shot of the game rather than a picture of it.
//
// A returning visitor has all of this cached and has seen the introduction, so
// they get the same real progress without the held beats.

// What is being built, in the order it is built, with the share of the bar
// each one is worth. The labels are what the telemetry panel reads.
const STEPS = [
  { key: 'engine', label: 'Race engine', weight: 1.2 },
  { key: 'physics', label: 'Physics system', weight: 0.6 },
  { key: 'vehicle', label: 'Vehicle system', weight: 1.6 },
  { key: 'track', label: 'Track system', weight: 2.2 },
  { key: 'environment', label: 'Environment', weight: 1.4 },
  { key: 'audio', label: 'Audio engine', weight: 0.5 },
];

// The status line, in the order a car comes to life.
const PHASES = [
  { at: 0.00, text: 'System initialization' },
  { at: 0.18, text: 'Initializing race engine' },
  { at: 0.34, text: 'Calibrating vehicle physics' },
  { at: 0.52, text: 'Loading track data' },
  { at: 0.70, text: 'Building environment' },
  { at: 0.86, text: 'Initializing audio system' },
  { at: 0.96, text: 'Preparing race grid' },
];

const SEEN_KEY = 'apex.seen';
const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class Boot {
  constructor(root = document.getElementById('boot')) {
    this.root = root;
    this.el = {
      status: document.getElementById('boot-status'),
      pct: document.getElementById('boot-pct'),
      fill: document.getElementById('boot-fill'),
      rows: document.getElementById('boot-rows'),
      tagline: document.getElementById('boot-tagline'),
      error: document.getElementById('boot-error'),
      retry: document.getElementById('boot-retry'),
    };
    // A visitor who has been here before does not need the introduction again,
    // only the progress.
    this.returning = localStorage.getItem(SEEN_KEY) === '1';
    if (this.returning) this.root?.classList.add('brief');
    // The menu is built while the boot screen is up; it stays out of sight
    // until the sweep hands the screen over to it.
    document.body.classList.add('booting');

    this.done = new Set();
    this.total = STEPS.reduce((sum, step) => sum + step.weight, 0);
    this.shown = 0;
    this.#buildRows();
    this.el.retry?.addEventListener('click', () => location.reload());
  }

  #buildRows() {
    if (!this.el.rows) return;
    this.el.rows.replaceChildren(...STEPS.map((step) => {
      const row = document.createElement('div');
      row.className = 'boot-row';
      row.dataset.key = step.key;
      row.innerHTML = `<span>${step.label}</span><b>standby</b>`;
      return row;
    }));
  }

  // A step has finished. The bar moves to the share of the work that is really
  // done, and the row for that step reads ready.
  finished(key) {
    if (this.done.has(key)) return;
    this.done.add(key);
    const row = this.el.rows?.querySelector(`[data-key="${key}"]`);
    if (row) {
      row.classList.add('ready');
      row.querySelector('b').textContent = 'ready';
    }
    this.#paint();
  }

  // A step has started, which is worth saying while it is the slow one.
  starting(key) {
    const row = this.el.rows?.querySelector(`[data-key="${key}"]`);
    if (row && !row.classList.contains('ready')) row.querySelector('b').textContent = 'loading';
  }

  get progress() {
    const carried = STEPS
      .filter((step) => this.done.has(step.key))
      .reduce((sum, step) => sum + step.weight, 0);
    return carried / this.total;
  }

  #paint() {
    const value = this.progress;
    // The bar only ever moves forward, and it stops where the work has got to:
    // nothing here walks it to 99% on a timer.
    this.shown = Math.max(this.shown, value);
    if (this.el.fill) this.el.fill.style.width = `${(this.shown * 100).toFixed(1)}%`;
    if (this.el.pct) this.el.pct.textContent = `${Math.round(this.shown * 100)}%`;
    const phase = [...PHASES].reverse().find((p) => this.shown >= p.at);
    if (phase && this.el.status && this.el.status.textContent !== phase.text) {
      this.el.status.textContent = phase.text;
    }
  }

  // Run one step of the build, reporting it either side. Whatever the step
  // returns is passed straight back to the caller.
  async run(key, work) {
    this.starting(key);
    // Let the browser paint the change before the work blocks the thread.
    await frame();
    try {
      const value = await work();
      this.finished(key);
      return value;
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  // The car reveal: the game's own scene, its own car, its own studio. The
  // boot screen holds a camera path around it while the rest is built.
  attach(game) {
    this.game = game;
    // While the reveal owns the camera, the menu's own orbit stands off: two
    // camera controllers on one camera is a fight, not a shot.
    game.introActive = true;
    this.root?.classList.add('with-car');
    const started = performance.now();
    const spin = () => {
      if (!this.game || this.closed) return;
      const t = (performance.now() - started) / 1000;
      game.intro(t);
      this.raf = requestAnimationFrame(spin);
    };
    this.raf = requestAnimationFrame(spin);
  }

  // Loading is done. The last beat is the car lighting up and a sweep of red
  // across the screen, and then the menu is already there behind it.
  async finish() {
    this.#paint();
    if (this.el.status) this.el.status.textContent = 'Race ready';
    this.root?.classList.add('ready');
    await wait(this.returning ? 140 : 460);

    // Headlights, then the sweep, and the menu arrives underneath it.
    this.game?.introHeadlights();
    this.root?.classList.add('sweep');
    document.body.classList.remove('booting');
    await wait(this.returning ? 220 : 420);

    this.closed = true;
    cancelAnimationFrame(this.raf);
    if (this.game) this.game.introActive = false;
    this.game = null;
    this.root?.classList.add('out');
    await wait(360);
    if (this.root) this.root.hidden = true;
    localStorage.setItem(SEEN_KEY, '1');
  }

  // Something did not load. The player is told what happened and given the one
  // control that can help, rather than a bar that never moves again.
  fail(error) {
    console.error('apex drift failed to start', error);
    this.closed = true;
    cancelAnimationFrame(this.raf);
    if (this.game) this.game.introActive = false;
    document.body.classList.remove('booting');
    this.root?.classList.add('failed');
    if (this.el.error) {
      this.el.error.hidden = false;
      const detail = this.el.error.querySelector('p');
      if (detail) detail.textContent = String(error?.message ?? error ?? 'Unknown fault');
    }
  }
}
