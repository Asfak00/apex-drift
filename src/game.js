import * as THREE from 'three';
import {
  MODES, VISIONS, WEATHERS, CAMERAS, CHASSIS, TRACKS, PHYSICS_STEP, MAX_STEPS, BOOST, CAR, PIT,
} from './config.js';
import { COMPOUNDS, COMPOUND_KEYS } from './tyres.js';
import { Track } from './track.js';
import { Car, RemoteCar, makeRivals } from './car.js';
import { Environment } from './environment.js';
import { Hud, formatTime } from './hud.js';
import { Input } from './input.js';
import { Audio } from './audio.js';
import { Effects } from './effects.js';
import { TouchControls, isTouchDevice } from './touch.js';
import { Wallet } from './wallet.js';
import { PitCrew } from './pit-crew.js';

const VISION_KEYS = Object.keys(VISIONS);
const WEATHER_KEYS = Object.keys(WEATHERS);
const TRACK_KEYS = Object.keys(TRACKS);

export class Game {
  constructor(canvas, { onFinish, onExit } = {}) {
    this.onFinish = onFinish ?? (() => {});
    this.onExit = onExit ?? (() => {});

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    // Phones pay for every pixel twice over; cap the buffer before it costs
    // frames that the physics step would rather have.
    this.mobile = isTouchDevice();
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, this.mobile ? 1.4 : 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(66, 1, 0.5, 2200);
    this.camPos = new THREE.Vector3();
    this.camLook = new THREE.Vector3();

    this.trackKey = 'apex';
    this.chassisKey = 'gt';
    this.track = new Track(TRACKS[this.trackKey]);
    this.scene.add(this.track.group);
    this.env = new Environment(this.scene, this.renderer, this.track);
    this.hud = new Hud(this.track);
    this.input = new Input();
    this.audio = new Audio();
    this.touch = new TouchControls(this.input);
    this.#bindBoostButton();
    this.#bindPitButtons();
    this.effects = new Effects(this.scene);
    this.effects.setSurface(this.track.spec);
    this.crew = new PitCrew(this.track);
    this.scene.add(this.crew.group);
    this.shake = 0;
    this.wasBoosting = false;
    this.wallet = new Wallet();
    this.boostHeld = false;
    this.overtakes = 0;

    this.player = new Car(this.track, {
      name: 'YOU', headlights: true, chassis: CHASSIS[this.chassisKey],
    });
    this.scene.add(this.player.mesh);
    this.rivals = [];
    this.cars = [this.player];
    this.net = null;
    this.remotes = new Map();
    // `cars` is the whole field, used for standings and the HUD. `simulated`
    // is the subset this client actually runs physics for: itself, plus any AI.
    // Remote cars only replay snapshots and must never enter the physics loop.
    this.simulated = [this.player];

    this.cameraMode = 0;
    this.state = 'idle';
    this.clock = 0;
    this.countdown = 0;
    this.visionIndex = 0;
    this.weatherIndex = 0;
    this.accumulator = 0;

    this.#bindActions();
    this.#bindResize();
    this.lastFrame = performance.now();
    this.loop = this.loop.bind(this);
  }

  #bindActions() {
    this.input.on('camera', () => {
      this.cameraMode = (this.cameraMode + 1) % CAMERAS.length;
      this.hud.toast(CAMERAS[this.cameraMode].toUpperCase(), 0.9);
    });
    this.input.on('vision', () => {
      this.visionIndex = (this.visionIndex + 1) % VISION_KEYS.length;
      this.#applyEnv();
      this.hud.toast(this.env.vision.name.toUpperCase(), 1.1, '#6f9cff');
    });
    this.input.on('weather', () => {
      this.weatherIndex = (this.weatherIndex + 1) % WEATHER_KEYS.length;
      this.#applyEnv();
      this.hud.toast(this.env.weather.name.toUpperCase(), 1.1, '#4de3b0');
    });
    this.input.on('sound', () => {
      const on = this.audio.toggle();
      this.hud.toast(on ? 'SOUND ON' : 'SOUND OFF', 1, on ? '#4de3b0' : '#7d8ba3');
    });
    this.input.on('respawn', () => {
      if (this.state === 'racing') {
        this.player.resetToTrack(this.clock);
        this.hud.toast('RESPAWN', 0.8, '#ffc94d');
      }
    });
    for (const key of COMPOUND_KEYS) {
      this.input.on(`tyre-${key}`, () => this.chooseCompound(key));
    }
    this.input.on('pit', () => this.togglePit());
    this.input.on('pit-assist', () => this.toggleAssist());
    this.input.on('menu', () => {
      if (this.state === 'racing' || this.state === 'countdown') this.stop(), this.onExit();
    });
  }

  // Which set the crew will fit at the next stop. Choosing one while a stop is
  // already called changes the call rather than making a second one.
  chooseCompound(key) {
    if (!COMPOUNDS[key]) return;
    this.nextCompound = key;
    // The choice stands whether or not a stop was ever called: it is what the
    // crew fits the moment the car pulls up on the box.
    this.player.pitChoice = key;
    if (this.player.pitState.want) this.player.requestPit(key);
    this.hud.toast(`${COMPOUNDS[key].name.toUpperCase()} SELECTED`, 1,
      `#${COMPOUNDS[key].color.toString(16).padStart(6, '0')}`);
  }

  // Call a stop, or wave it off. The car takes it when it reaches the box.
  // The crew work on whichever car is actually on the box, and are on screen
  // only while there is a car in the lane to work on.
  #updateCrew(dt) {
    const inLane = this.simulated.some((car) => car.pitState.inLane)
      || this.track.pitPhase(this.track.project(this.player.position, this.player.hintIndex).t)
        !== null;
    this.crew.setActive(inLane);
    if (!inLane && !this.crew.lastCar) return;

    const onBox = this.simulated.find((car) => car.pitState.serving > 0)
      ?? (this.crew.lastCar?.pitState.serving > 0 ? this.crew.lastCar : null);
    const progress = onBox ? Math.min(1, onBox.pitState.serving / PIT.service) : 0;
    this.crew.update(dt, onBox, progress);
    if (onBox) onBox.pitLift = this.crew.jackLift;
  }

  // Hand the car to the lane. Engaged from the pit entry, it drives the same
  // line the AI drives — down at the limit, stopped on the box — and gives the
  // car back the moment the stop is done or the driver touches the controls.
  toggleAssist() {
    if (!this.mode?.tyres) {
      this.hud.toast('NO TYRE WEAR IN THIS MODE', 1.2, '#7d8ba3');
      return;
    }
    this.assist = !this.assist;
    if (this.assist) {
      if (!this.player.pitState.want) this.player.requestPit(this.nextCompound ?? 'medium');
      this.hud.toast('PIT ASSIST ON', 1.4, '#4de3b0');
    } else {
      this.hud.toast('PIT ASSIST OFF', 1.1, '#7d8ba3');
    }
  }

  // Calling a stop is an announcement, not a permission: the lane is open for
  // as long as the tyres wear, and stopping on the box is always enough.
  togglePit() {
    if (!this.mode?.tyres) {
      this.hud.toast('NO TYRE WEAR IN THIS MODE', 1.2, '#7d8ba3');
      return;
    }
    const want = this.player.pitState.want;
    if (want) {
      this.player.cancelPit();
      this.hud.toast('PIT CALL CANCELLED', 1.1, '#7d8ba3');
    } else {
      const key = this.nextCompound ?? 'medium';
      this.player.requestPit(key);
      this.hud.toast(`BOX ANY LAP · ${COMPOUNDS[key].name.toUpperCase()}`, 1.6, '#ffc94d');
    }
  }

  // Swapping a circuit replaces the geometry every other system reads from, so
  // the environment, the minimap and every car are re-pointed in one place.
  setTrack(key) {
    if (key === this.trackKey || !TRACKS[key]) return;
    this.track.dispose(this.scene);
    this.track = new Track(TRACKS[key]);
    this.trackKey = key;
    this.scene.add(this.track.group);
    this.env.setTrack(this.track);
    this.hud.setTrack(this.track);
    this.effects.setSurface(this.track.spec);
    this.crew.setTrack(this.track);
    for (const car of this.simulated) car.track = this.track;
  }

  // A chassis change is a different car, so the old one is replaced outright.
  setChassis(key) {
    if (key === this.chassisKey || !CHASSIS[key]) return;
    this.chassisKey = key;
    this.player.dispose(this.scene);
    this.player = new Car(this.track, {
      name: 'YOU', headlights: true, chassis: CHASSIS[key],
    });
    this.scene.add(this.player.mesh);
    this.simulated[0] = this.player;
    this.cars[0] = this.player;
  }

  // The socket is owned by main.js; the game only subscribes to what changes
  // the race: who is on track, when it starts, and how it ended.
  attachNet(net) {
    this.net = net;
    net.on('snap', (cars) => this.#onSnapshot(cars));
    net.on('roster', (roster) => this.#syncRemotes(roster));
    net.on('go', () => {
      if (this.state === 'countdown') {
        this.state = 'racing';
        this.raceStart = this.clock;
        for (const car of this.simulated) car.lapStart = this.clock;
      }
    });
    net.on('lap-flash', ({ name, lap, color }) => {
      this.hud.note(`${name} → lap ${lap + 1}`, color);
    });
    net.on('offline', () => {
      if (this.state !== 'idle') this.hud.toast('DISCONNECTED', 2, '#ff5f5f');
    });
  }

  #syncRemotes(roster) {
    if (!this.net) return;
    const live = new Set();
    for (const entry of roster) {
      if (entry.id === this.net.id) continue;
      live.add(entry.id);
      let car = this.remotes.get(entry.id);
      if (!car) {
        car = new RemoteCar(entry);
        this.remotes.set(entry.id, car);
        this.scene.add(car.mesh);
        car.setHeadlights(this.env.lightsOn);
      }
      car.lap = entry.lap ?? car.lap;
    }
    for (const [id, car] of this.remotes) {
      if (live.has(id)) continue;
      car.dispose(this.scene);
      this.remotes.delete(id);
    }
    this.rivals = [...this.remotes.values()];
    this.cars = [this.player, ...this.rivals];
    this.simulated = [this.player];
  }

  #onSnapshot(cars) {
    for (const entry of cars) {
      this.remotes.get(entry.id)?.applySnapshot(entry.s, entry.lap);
    }
  }

  #clearRemotes() {
    for (const car of this.remotes.values()) car.dispose(this.scene);
    this.remotes.clear();
  }

  // The same control the Shift key drives, so there is always a visible way to
  // spend a boost charge.
  #bindBoostButton() {
    const button = document.getElementById('boost-btn');
    if (!button) return;
    this.boostButton = button;
    const set = (on) => {
      this.input.touch.boost = on;
      button.classList.toggle('held', on);
    };
    button.addEventListener('pointerdown', (e) => {
      button.setPointerCapture(e.pointerId);
      set(true);
      e.preventDefault();
    });
    for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
      button.addEventListener(type, () => set(false));
    }
  }

  // The same two decisions the keys make, on screen for anyone without them.
  #bindPitButtons() {
    for (const button of document.querySelectorAll('.pick[data-tyre]')) {
      button.addEventListener('click', (e) => {
        e.preventDefault();
        this.chooseCompound(button.dataset.tyre);
      });
    }
    document.getElementById('pit-call')?.addEventListener('click', (e) => {
      e.preventDefault();
      this.togglePit();
    });
    // One control for the whole stop: call it, drive in, get served, drive out.
    for (const id of ['pit-assist', 'touch-pit']) {
      document.getElementById(id)?.addEventListener('click', (e) => {
        e.preventDefault();
        this.toggleAssist();
      });
    }
    this.assistButton = document.getElementById('pit-assist');
  }

  #bindResize() {
    const resize = () => {
      const w = innerWidth, h = innerHeight;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    };
    addEventListener('resize', resize);
    resize();
  }

  // The circuit decides the music and the car decides the engine note.
  #applyAudioProfile() {
    this.audio.setMood(this.track.spec.music ?? 'circuit');
    this.audio.setEngine(CHASSIS[this.chassisKey]?.engine ?? 'v12');
  }

  #applyEnv() {
    this.env.apply(VISION_KEYS[this.visionIndex], WEATHER_KEYS[this.weatherIndex]);
    for (const car of this.cars) car.setHeadlights(this.env.lightsOn, this.env.weather.wet);
  }

  // Display and control preferences the player set. Applied immediately so a
  // change is visible in the preview behind the settings panel.
  applySettings({ quality, shadows, steering, touchControls }) {
    if (quality !== undefined) {
      const scale = { low: 0.75, medium: 1, high: 1.35 }[quality] ?? 1;
      const cap = this.mobile ? 1.4 : 2;
      this.renderer.setPixelRatio(Math.min(devicePixelRatio * scale, cap));
      this.env.quality = { low: 0.25, medium: 0.6, high: 1 }[quality] ?? 0.6;
      this.env.apply(VISION_KEYS[this.visionIndex], WEATHER_KEYS[this.weatherIndex]);
    }
    if (shadows !== undefined) {
      this.renderer.shadowMap.enabled = shadows;
      this.scene.traverse((node) => { if (node.material) node.material.needsUpdate = true; });
    }
    if (steering !== undefined) this.input.sensitivity = steering;
    if (touchControls !== undefined) {
      this.touchMode = touchControls;
      const on = touchControls === 'on' || (touchControls === 'auto' && this.mobile);
      this.showTouch = on;
      if (this.state === 'racing' || this.state === 'countdown') this.touch.show(on);
    }
  }

  // The menu is shown over a live scene: the chosen car, parked on the chosen
  // circuit, under the chosen sky and weather, turning slowly. Selecting an
  // option and seeing it are the same act.
  preview({ mode, vision, weather, track = this.trackKey, chassis = this.chassisKey }) {
    this.setChassis(chassis);
    this.setTrack(track);
    this.mode = MODES[mode];
    this.modeKey = mode;
    this.multiplayer = false;
    this.visionIndex = Math.max(0, VISION_KEYS.indexOf(vision));
    this.weatherIndex = Math.max(0, WEATHER_KEYS.indexOf(weather));

    for (const rival of this.rivals) if (rival instanceof Car) this.scene.remove(rival.mesh);
    this.#clearRemotes();
    this.rivals = [];
    this.cars = [this.player];
    this.simulated = [this.player];

    this.#applyEnv();
    this.#applyAudioProfile();
    this.player.placeAt(this.track.gridSlot(0));
    this.player.render(1);
    this.hud.show(false);
    this.touch.show(false);
    this.audio.silenceEngine();
    this.state = 'preview';
    this.previewAngle ??= 0.6;
    this.lastFrame = performance.now();
    if (!this.running) { this.running = true; requestAnimationFrame(this.loop); }
  }

  #orbitPreview(dt) {
    this.previewAngle += dt * 0.22;
    const car = this.player;
    const centre = car.position;
    // Close enough that the car is the subject, high enough to read its shape.
    const radius = 6.2 + car.chassis.body.length * 0.62;
    this.camera.position.set(
      centre.x + Math.sin(this.previewAngle) * radius,
      centre.y + 1.95,
      centre.z + Math.cos(this.previewAngle) * radius,
    );
    this.camera.lookAt(centre.x, centre.y + 0.5, centre.z);
    if (this.camera.fov !== 40) {
      this.camera.fov = 40;
      this.camera.updateProjectionMatrix();
    }
  }

  start({ mode, vision, weather, track = this.trackKey, chassis = this.chassisKey }) {
    this.setChassis(chassis);
    this.setTrack(track);
    this.mode = MODES[mode];
    this.modeKey = mode;
    this.visionIndex = Math.max(0, VISION_KEYS.indexOf(vision));
    this.weatherIndex = Math.max(0, WEATHER_KEYS.indexOf(weather));

    this.multiplayer = !!this.net?.online;
    if (this.multiplayer) {
      // Rivals are real people; the roster, not makeRivals, decides the field.
      for (const r of this.rivals) if (r instanceof Car) this.scene.remove(r.mesh);
      this.#syncRemotes(this.net.roster);
    } else {
      for (const r of this.rivals) this.scene.remove(r.mesh);
      this.#clearRemotes();
      this.rivals = makeRivals(this.track, this.mode.rivals);
      for (const r of this.rivals) this.scene.add(r.mesh);
      this.cars = [this.player, ...this.rivals];
      this.simulated = [...this.cars];
    }

    // Each player keeps a fixed grid slot so two clients never share one.
    const slotOf = (car) => (this.multiplayer && car === this.player
      ? Math.max(0, this.net.roster.findIndex((r) => r.id === this.net.id))
      : this.simulated.indexOf(car));
    this.simulated.forEach((car) => {
      car.placeAt(this.track.gridSlot(slotOf(car)));
      car.lap = 0;
      car.nextCheckpoint = 1;
      car.lastLapTime = null;
      car.bestLapTime = null;
      car.finished = false;
      car.crossedLine = false;
      car.lapStart = 0;
      // Tyres are part of the race, not part of the car: the mode decides
      // whether they wear, whether there is a lane to change them in, and what
      // everyone starts on.
      car.wearing = !!this.mode.tyres;
      car.pitAllowed = !!this.mode.pit;
      car.lapsLeft = this.mode.laps ?? 0;
      car.cancelPit();
      car.pitState.stops = 0;
      car.pitChoice = this.mode.tyre ?? 'medium';
      car.setCompound(car.ai ? this.#rivalStart(car) : (this.mode.tyre ?? 'medium'));
    });
    this.nextCompound = this.mode.tyre ?? 'medium';
    this.assist = false;

    this.#applyEnv();
    this.#applyAudioProfile();
    this.clock = 0;
    this.accumulator = 0;
    this.overtakes = 0;
    this.raceStart = 0;
    this.input.clear();
    this.hud.show(true);
    this.touch.show(this.showTouch ?? this.mobile);

    if (this.multiplayer) {
      // The server already broadcast the countdown; it also decides when to go.
      this.state = 'countdown';
      this.countdown = Infinity;
    } else if (this.modeKey === 'roam') {
      this.state = 'racing';
      this.hud.toast('FREE ROAM', 1.4, '#4de3b0');
    } else {
      this.state = 'countdown';
      this.countdown = 3.999;
    }

    this.lastFrame = performance.now();
    if (!this.running) { this.running = true; requestAnimationFrame(this.loop); }
  }

  // A field that all starts on the same rubber has no strategy in it. Long
  // races spread the grid across the compounds; short ones all go soft.
  #rivalStart(car) {
    if ((this.mode.laps ?? 0) < 8) return 'soft';
    const order = ['medium', 'hard', 'soft', 'medium', 'hard'];
    return order[this.rivals.indexOf(car) % order.length];
  }

  stop() {
    this.state = 'idle';
    this.multiplayer = false;
    this.hud.show(false);
    this.touch.show(false);
    this.audio.silenceEngine();
    this.audio.silenceCrowd();
    this.audio.duckMusic(1);
    this.hud.show(false);
    this.input.clear();
  }

  // Standings sort on laps completed plus fraction of the current lap.
  standings() {
    return [...this.cars].sort((a, b) => b.progress - a.progress);
  }

  // Everything the crowd reacts to goes through here: a swell over the bed and
  // a lift in what the figures in the stands are doing.
  #roar(strength) {
    this.cheer = Math.min(1, Math.max(this.cheer ?? 0, strength));
    this.audio.cheer(strength * (this.track.spec.crowd ?? 0.25));
  }

  #pitServed(car) {
    const label = `${car.tyres.name} tyres`;
    if (car === this.player) {
      this.hud.toast(label.toUpperCase(), 1.6,
        `#${car.tyres.color.toString(16).padStart(6, '0')}`);
      this.#roar(0.7);
    } else {
      this.hud.note(`${car.name} → ${label}`, car.color);
    }
  }

  #lapCrossed(car) {
    const lapTime = this.clock - car.lapStart;
    car.lapStart = this.clock;
    if (lapTime < 4) return;                  // ignore the first line sweep on the grid
    car.lap += 1;
    // progress was written during physics, before this lap landed. Re-derive it
    // now or the car that just took the flag sorts below the whole field.
    car.progress = car.lap + (car.progress % 1);
    car.lastLapTime = lapTime;
    if (this.mode.laps) car.lapsLeft = Math.max(0, this.mode.laps - car.lap);
    if (car === this.player) this.#roar(0.55);
    if (car.bestLapTime == null || lapTime < car.bestLapTime) {
      car.bestLapTime = lapTime;
      if (car === this.player) this.hud.toast(`BEST ${formatTime(lapTime)}`, 1.6, '#4de3b0');
    } else if (car === this.player) {
      this.hud.toast(formatTime(lapTime), 1.3);
    }

    if (car === this.player && this.multiplayer) {
      this.net.reportLap(car.lap, car.bestLapTime);
    }
    // Everyone should see someone else start a new lap, not just the driver.
    if (car !== this.player && this.mode.laps && car.lap < this.mode.laps) {
      this.hud.note(`${car.name} → lap ${car.lap + 1}`, car.color);
    }

    if (this.mode.laps && car.lap >= this.mode.laps && !car.finished) {
      car.finished = true;
      car.finishTime = this.clock - this.raceStart;
      if (car === this.player) this.#finish();
    }
  }

  #finish() {
    this.state = 'finished';
    const order = this.standings();
    const place = order.indexOf(this.player) + 1;
    this.hud.toast('FINISH', 2.2, '#ffc94d');
    this.#roar(1);
    if (this.multiplayer) {
      // The server ranks the field once everyone is in; main.js renders that.
      this.lastPayout = this.wallet.award({
        place,
        entries: this.cars.length,
        laps: this.player.lap,
        bestLap: this.player.bestLapTime,
        overtakes: this.overtakes,
      });
      this.net.reportFinish(this.player.finishTime, this.player.bestLapTime);
      this.hud.toast('WAITING FOR FIELD', 2.6, '#ffc94d');
      return;
    }
    const payout = this.wallet.award({
      place,
      entries: this.cars.length,
      laps: this.player.lap,
      bestLap: this.player.bestLapTime,
      overtakes: this.overtakes,
    });
    this.onFinish({
      payout,
      mode: this.mode.name,
      place,
      entries: this.cars.length,
      total: this.player.finishTime,
      best: this.player.bestLapTime,
      vision: this.env.vision.name,
      weather: this.env.weather.name,
      track: this.track.spec.name,
      // Same row shape the server sends, so one renderer draws both.
      table: order.map((car, i) => ({
        place: i + 1,
        name: car === this.player ? 'You' : car.name,
        color: car.color,
        total: car.finished ? car.finishTime : null,
        best: car.bestLapTime,
        lap: car.lap,
        finished: car.finished,
        you: car === this.player,
      })),
    });
  }

  #updateCamera(dt) {
    const car = this.player;
    const mode = CAMERAS[this.cameraMode];
    // Follow the drawn car, not the physics car, or the view judders at any
    // frame rate that is not an exact multiple of the physics step.
    const here = car.renderPosition;
    const fwd = car.renderForward;
    let target, look;

    if (mode === 'hood') {
      target = here.clone().addScaledVector(fwd, 0.35).setY(here.y + 1.32);
      look = here.clone().addScaledVector(fwd, 30).setY(here.y + 1.6);
      this.camPos.copy(target);
    } else if (mode === 'cinematic') {
      // Trackside pole set back from the corner, high enough to clear the
      // barriers and the scenery behind them.
      const p = this.track.project(here, car.hintIndex);
      const f = this.track.frameAt(p.t + 0.03);
      const off = this.track.roadHalf + 16;
      target = f.pos.clone().addScaledVector(f.side, off).setY(f.pos.y + 13);
      this.camPos.lerp(target, Math.min(1, dt * 1.8));
      look = here;
    } else {
      // Chase: distance and height open up with speed for a sense of pace.
      const back = 8.4 + Math.min(4.5, car.kmh * 0.016);
      const high = 3.5 + Math.min(1.6, car.kmh * 0.005);
      target = here.clone().addScaledVector(fwd, -back).setY(here.y + high);
      this.camPos.lerp(target, Math.min(1, dt * 6.5));
      look = here.clone().addScaledVector(fwd, 12).setY(here.y + 1.2);
    }

    this.camLook.lerp(look, Math.min(1, dt * 9));
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);
    // Shake decays on its own; a hit spends into it and the camera pays it out.
    if (this.shake > 0.001) {
      const amp = this.shake * 0.55;
      this.camera.position.x += (Math.random() - 0.5) * amp;
      this.camera.position.y += (Math.random() - 0.5) * amp * 0.7;
      this.camera.position.z += (Math.random() - 0.5) * amp;
      this.shake = Math.max(0, this.shake - dt * 2.6);
    }

    // Ease the field of view instead of snapping it to the current speed.
    const boostKick = car.boost?.firing ? BOOST.fovKick : 0;
    const wantFov = 66 + Math.min(14, car.kmh * 0.045) + boostKick;
    this.camera.fov += (wantFov - this.camera.fov) * Math.min(1, dt * 4);
    this.camera.updateProjectionMatrix();
  }

  // Who the player is chasing and who is chasing them, measured along the
  // centreline rather than through the scenery.
  #gaps(order) {
    const me = order.indexOf(this.player);
    const span = this.track.length;
    const gapTo = (other) => {
      if (!other) return null;
      return {
        name: other.name,
        metres: (other.progress - this.player.progress) * span,
      };
    };
    return { ahead: gapTo(order[me - 1]), behind: gapTo(order[me + 1]) };
  }

  // A car going the other way past your window is one of the strongest cues
  // that something is happening, so it gets its own sound.
  #detectPasses(dt) {
    const fwd = this.player.renderForward;
    const side = new THREE.Vector3(Math.cos(this.player.renderYaw), 0, -Math.sin(this.player.renderYaw));
    const here = this.player.renderPosition;
    this.passState ??= new Map();

    for (const rival of this.rivals) {
      const delta = rival.position.clone().sub(here);
      const along = delta.dot(fwd);
      const across = delta.dot(side);
      const previous = this.passState.get(rival);
      this.passState.set(rival, along);
      if (previous === undefined) continue;

      // Crossed level with the player, close alongside, at a real speed.
      const crossed = (previous > 0) !== (along > 0);
      const closing = Math.abs(along - previous) / Math.max(dt, 1e-3);
      if (!crossed || Math.abs(across) > 9 || closing < 4) continue;
      const strength = Math.min(1, closing / 26);
      this.audio.passBy(strength, Math.sign(across) || 1);
      // Going past someone who was ahead of you is an overtake worth points,
      // and the one thing a grandstand always reacts to.
      if (previous > 0 && along < 0) {
        this.overtakes += 1;
        this.#roar(0.9);
      }
    }
  }

  // Cars are resolved as circles on the ground plane: push them apart, then
  // exchange momentum along the contact normal. Remote cars are replaying a
  // snapshot and cannot be moved, so they take no push and give all of it back.
  #contact(a, b, bothDynamic) {
    const dx = b.position.x - a.position.x;
    const dz = b.position.z - a.position.z;
    const distSq = dx * dx + dz * dz;
    const reach = a.radius + b.radius;
    if (distSq > reach * reach || distSq < 1e-6) return;

    const dist = Math.sqrt(distSq);
    const nx = dx / dist, nz = dz / dist;
    const overlap = reach - dist;
    const share = bothDynamic ? 0.5 : 1;
    a.position.x -= nx * overlap * share;
    a.position.z -= nz * overlap * share;
    if (bothDynamic) {
      b.position.x += nx * overlap * 0.5;
      b.position.z += nz * overlap * 0.5;
    }

    const bv = b.velocity;
    const rvx = a.velocity.x - bv.x;
    const rvz = a.velocity.z - bv.z;
    const closing = rvx * nx + rvz * nz;
    if (closing <= 0) return;   // already separating: nothing to resolve

    const invA = 1 / a.tune.mass;
    const invB = bothDynamic ? 1 / b.tune.mass : 0;
    const j = -(1 + 0.35) * closing / (invA + invB);
    a.applyImpulse(new THREE.Vector3(nx * j * invA, 0, nz * j * invA));
    if (bothDynamic) {
      b.applyImpulse(new THREE.Vector3(-nx * j * invB, 0, -nz * j * invB));
    }

    // A hit off the nose twists the car; that twist is most of the feel.
    const twist = (Math.cos(a.yaw) * nx - Math.sin(a.yaw) * nz) * closing * 0.018;
    a.yaw -= twist;
    if (bothDynamic) b.yaw += twist;

    this.#reportImpact(closing, (a.position.x + b.position.x) / 2,
      (a.position.y + b.position.y) / 2, (a.position.z + b.position.z) / 2, a, b);
  }

  #reportImpact(closing, x, y, z, a, b) {
    const strength = Math.min(1, closing / 26);
    if (strength < 0.04) return;
    // Only the local driver's own collisions shake the local camera.
    if (a === this.player || b === this.player) {
      this.shake = Math.min(1, this.shake + strength);
      this.audio.impact(strength);
    }
    this.effects.impact(new THREE.Vector3(x, y + 0.4, z), strength);
  }

  // Scenery is not decoration: a building, a tree or a lamp post stops a car.
  // The obstacle cannot move, so the car takes all of the correction.
  #contactSolid(car) {
    const near = this.track.solidsNear(car.position.x, car.position.z, car.radius + 4);
    for (const solid of near) {
      const dx = solid.x - car.position.x;
      const dz = solid.z - car.position.z;
      const distSq = dx * dx + dz * dz;
      const reach = car.radius + solid.radius;
      if (distSq > reach * reach || distSq < 1e-6) continue;

      const dist = Math.sqrt(distSq);
      const nx = dx / dist, nz = dz / dist;
      car.position.x -= nx * (reach - dist);
      car.position.z -= nz * (reach - dist);

      const closing = car.velocity.x * nx + car.velocity.z * nz;
      if (closing <= 0) continue;
      // Hitting something immovable takes the speed out of the car rather than
      // trading it, which is what running into a wall actually does.
      car.velocity.x -= nx * closing * 1.4;
      car.velocity.z -= nz * closing * 1.4;
      car.speed = car.velocity.dot(car.forward);
      car.yawRate *= 0.45;
      this.#reportImpact(closing, car.position.x, car.position.y, car.position.z, car, car);
    }
  }

  #resolveContacts() {
    const dyn = this.simulated;
    const kin = [...this.remotes.values()];
    for (let i = 0; i < dyn.length; i++) {
      for (let k = i + 1; k < dyn.length; k++) this.#contact(dyn[i], dyn[k], true);
      for (const remote of kin) this.#contact(dyn[i], remote, false);
      this.#contactSolid(dyn[i]);
    }
  }

  // One fixed physics tick. Nothing in here may depend on the frame rate.
  #step(dt) {
    this.clock += dt;
    // Weather grip and the circuit's own surface both bite at once.
    const grip = this.env.grip * this.track.surfaceGrip;

    if (this.state === 'countdown' && this.multiplayer) {
      // Nothing to tick: the 'go' message flips the state.
    } else if (this.state === 'countdown') {
      const before = Math.ceil(this.countdown);
      this.countdown -= dt;
      const after = Math.ceil(this.countdown);
      if (after !== before) {
        this.hud.toast(after > 0 ? String(after) : 'GO', after > 0 ? 0.9 : 1.1,
          after > 0 ? '#ffc94d' : '#4de3b0');
        this.audio.beep(after <= 0);
        this.audio.duckMusic(after > 0 ? 0.4 : 1);
      }
      if (this.countdown <= 0) {
        this.state = 'racing';
        this.raceStart = this.clock;
        for (const car of this.simulated) car.lapStart = this.clock;
      }
    }

    const live = this.state === 'racing';
    // Off the clock the cars hold station: brake only while still rolling, so
    // the brake input can never be read as a reverse request on the grid.
    const held = (car) => ({
      throttle: 0, brake: car.speed > 0.5 ? 1 : 0, steer: 0, handbrake: true,
    });
    for (const car of this.simulated) {
      if (car.ai) {
        if (live) car.driveAI(dt, this.clock); else car.input = held(car);
      } else {
        const driver = live ? this.input.sample(dt) : held(car);
        car.input = live && this.assist ? this.#assistInput(car, driver) : driver;
      }
      car.update(dt, grip, this.env.weather.wet);
      if (this.state === 'countdown') {
        car.velocity.set(0, 0, 0);
        car.speed = 0;
      }
      if (car.consumePitFlag()) this.#pitServed(car);
      if (car.consumeLapFlag() && this.state !== 'countdown') this.#lapCrossed(car);
    }
    this.#resolveContacts();
  }

  // The assist only has the car while it is in the pit lane's stretch of the
  // circuit and the driver is not fighting it. Any real input hands it back.
  #assistInput(car, driver) {
    if (driver.throttle > 0.05 || driver.brake > 0.05 || Math.abs(driver.steer) > 0.1) {
      this.assist = false;
      this.hud.toast('PIT ASSIST OFF', 1, '#7d8ba3');
      return driver;
    }
    const p = this.track.project(car.position, car.hintIndex);
    if (this.track.pitPhase(p.t) === null) return driver;
    if (car.pitState.done) {
      this.assist = false;
      return driver;
    }
    return car.pitLaneInput(p, this.track.length);
  }

  // A boost costs a charge on the press, not per second. Holding it down runs
  // the reserve the one charge bought; letting go ends it.
  #armBoost() {
    const held = !!this.player.input.boost;
    if (held && !this.boostHeld) {
      if (this.wallet.spendBoost()) {
        this.player.boost.armed = true;
      } else {
        this.player.boost.armed = false;
        this.hud.note('No boost charges — finish races to earn points', 0xffc94d);
      }
    }
    if (!held) this.player.boost.armed = false;
    this.boostHeld = held;
  }

  // The engine note is derived, not stored: revs are where the car sits inside
  // the gear the HUD is already showing.
  #updateSound(dt) {
    const car = this.player;
    if (this.state === 'idle') { this.audio.silenceEngine(); return; }

    const ratios = CAR.gearRatios;
    const gear = typeof car.gear === 'number' ? car.gear : 1;
    const low = ratios[gear - 1] ?? 0;
    const high = ratios[gear] ?? ratios[ratios.length - 1];
    const rpm = Math.min(1, Math.max(0.08, (car.kmh - low) / Math.max(1, high - low)));

    const firing = !!car.boost?.firing;
    if (firing && !this.wasBoosting) this.audio.boost();
    this.wasBoosting = firing;

    this.audio.engine({
      rpm, load: car.input.throttle, kmh: car.kmh, slide: car.slide ?? 0, boosting: firing,
    });
  }

  loop(now) {
    requestAnimationFrame(this.loop);
    const frame = Math.min(0.25, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    if (this.state === 'idle') { this.renderer.render(this.scene, this.camera); return; }

    if (this.state === 'preview') {
      this.#orbitPreview(frame);
      this.track.update(frame, 0.3);
      this.env.update(frame, this.camera, performance.now() / 1000);
      this.effects.update(frame);
      this.renderer.render(this.scene, this.camera);
      return;
    }

    // Physics advances in fixed slices so handling is identical on a 60 Hz
    // laptop and a 144 Hz monitor; the leftover drives the draw interpolation.
    this.accumulator += frame;
    let steps = 0;
    while (this.accumulator >= PHYSICS_STEP && steps < MAX_STEPS) {
      this.#step(PHYSICS_STEP);
      this.accumulator -= PHYSICS_STEP;
      steps += 1;
    }
    // A long stall (tab in the background) must not be paid back all at once.
    if (steps === MAX_STEPS) this.accumulator = 0;

    const alpha = this.accumulator / PHYSICS_STEP;
    for (const car of this.simulated) car.render(alpha);

    for (const remote of this.remotes.values()) {
      remote.update(frame);
      // Remote cars report a lap count, not a position on the lap; the shared
      // track turns their position into the same progress key the sort uses.
      const rp = this.track.project(remote.position, remote.hintIndex ?? null);
      remote.hintIndex = rp.index;
      remote.progress = remote.lap + rp.t;
    }
    if (this.multiplayer) this.net.pushState(this.player, now);

    this.effects.tyreSmoke(this.player, frame);
    this.effects.update(frame);
    this.#updateCrew(frame);
    // The crowd hums along with the pace of the race and swells when something
    // happens; both the figures and the sound read from the same number.
    this.cheer = Math.max(0, (this.cheer ?? 0) - frame * 0.42);
    const draw = this.track.spec.crowd ?? 0.25;
    const excite = Math.min(1, 0.18 + this.player.kmh / 460 + this.cheer);
    this.track.update(frame, excite);
    this.audio.crowd(draw, excite, frame);
    this.#updateSound(frame);
    this.env.update(frame, this.camera, this.clock);
    this.#updateCamera(frame);

    this.#armBoost();
    this.#detectPasses(frame);
    const order = this.standings();
    this.hud.update(frame, {
      gaps: this.#gaps(order),
      player: this.player,
      rivals: this.rivals,
      lapCount: this.mode.laps,
      position: order.indexOf(this.player) + 1,
      entries: this.cars.length,
      clock: this.clock,
      env: this.env,
      surface: this.track.spec,
      wallet: this.wallet,
      tyres: this.mode.tyres ? this.player.tyres : null,
      pit: this.mode.tyres
        ? {
          lane: this.player.inPitLane,
          called: this.player.pitState.want,
          serving: this.player.pitProgress,
          stops: this.player.pitState.stops,
          next: this.nextCompound,
          speeding: this.player.inPitLane && this.player.kmh > PIT.limit * 3.6 + 2,
        }
        : null,
    });
    if (this.boostButton) this.boostButton.disabled = !this.wallet.canBoost();
    if (this.assistButton) {
      this.assistButton.hidden = !this.mode.tyres;
      this.assistButton.classList.toggle('on', !!this.assist);
    }
    document.getElementById('touch-pit')?.classList.toggle('held', !!this.assist);

    this.renderer.render(this.scene, this.camera);
  }
}
