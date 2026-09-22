import { MODES, VISIONS, WEATHERS, CHASSIS, TRACKS, CAMERAS } from './config.js';
import { Game } from './game.js';
import { storedLevel } from './audio.js';
import { formatTime } from './hud.js';
import { Net } from './net.js';
import {
  LOGO, MODE_ICONS, visionSwatch, weatherSwatch, carIcon, circuitIcon,
} from './ui-icons.js';
import { renderChassisThumbs } from './car-thumbs.js';
import { makeCode, normaliseCode, DEFAULT_ROOM } from './room-code.js';
import { Boot } from './boot.js';

const $ = (id) => document.getElementById(id);
const menu = $('menu');
const results = $('results');
const lan = $('lan');

const choice = {
  mode: 'race', vision: 'day', weather: 'clear', track: 'apex', chassis: 'gt',
};
// The circuit and conditions are shared in a lobby; the car is each driver's own.
const SHARED = new Set(['mode', 'vision', 'weather', 'track']);
const net = new Net();
let connected = false;
let ready = false;
// A refusal and the socket closing arrive together; the refusal is the useful
// one, so it wins the status line.
let refusal = null;
// A room in the address means someone sent an invite; otherwise this is the
// server's shared room, which is what two people on one Wi-Fi expect.
let roomCode = normaliseCode(new URLSearchParams(location.search).get('room') ?? DEFAULT_ROOM);

const inviteUrl = () => `${location.origin}${location.pathname}?room=${roomCode}`;

function showInvite() {
  $('invite-link').value = inviteUrl();
  $('room-code').textContent = roomCode;
}

function setRoom(code, { reconnect = false } = {}) {
  roomCode = normaliseCode(code);
  const url = new URL(location.href);
  url.searchParams.set('room', roomCode);
  history.replaceState(null, '', url);
  showInvite();
  if (reconnect && connected) {
    net.close();
    connected = false;
    ready = false;
    step = STEPS.indexOf('connect');
    paintWizard();
  }
}

// --- driver name ---------------------------------------------------------
const nameInput = $('name');
nameInput.value = localStorage.getItem('apex.name') ?? '';
nameInput.addEventListener('input', () => localStorage.setItem('apex.name', nameInput.value));
const driverName = () => nameInput.value.trim() || 'Racer';

$('logo').innerHTML = LOGO;
$('boot-logo').innerHTML = LOGO;

// Real renders of the real meshes, made once at start-up. If the throwaway
// context cannot be created, the drawn silhouettes still carry the picker, so
// a failure here costs the pictures and nothing else.
let carThumbs = {};
function loadThumbs() {
  try {
    carThumbs = renderChassisThumbs();
  } catch (err) {
    console.warn('car previews unavailable, using drawn icons', err);
  }
}
const carCard = (key, chassis) => (carThumbs[key]
  ? `<img class="opt-shot" src="${carThumbs[key]}" alt="" />`
  : carIcon(chassis));

// --- preset pickers ------------------------------------------------------
const segments = {};

// One card per option: an icon of the thing, then its name.
function segment(hostId, table, field, iconFor, onPick) {
  const host = $(hostId);
  host.replaceChildren();
  for (const [key, value] of Object.entries(table)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'opt';
    b.dataset.key = key;
    b.innerHTML = `${iconFor(key, value)}<span class="nm">${value.name}</span>`;
    b.setAttribute('aria-pressed', String(choice[field] === key));
    b.addEventListener('click', () => {
      choice[field] = key;
      paintField(field, key);
      // A selection is confirmed by sound as well as by the panel lighting up.
      game.audio.start();
      game.audio.resume();
      if (field === 'chassis') game.audio.rev(value.engine);
      else game.audio.click(field === 'track');
      onPick?.(key, value);
      refreshPreview();
      // In a lobby the conditions are shared, so a pick is an announcement.
      if (!connected) return;
      if (SHARED.has(field)) net.setSettings({ [field]: key });
      else net.setChassis(key);
    });
    host.appendChild(b);
  }
  // A field can be shown in more than one place (the car appears on the home
  // panel and again in the multiplayer flow); every copy stays in step.
  (segments[field] ??= []).push(hostId);
}

function paintField(field, key) {
  for (const hostId of segments[field] ?? []) {
    for (const b of $(hostId).children) {
      b.setAttribute('aria-pressed', String(b.dataset.key === key));
    }
  }
}

// --- navigation ----------------------------------------------------------
// The rail decides which part of the setup the panel is showing. Two of its
// entries are doors rather than views: multiplayer opens the join flow, and
// settings opens the settings sheet.
const VIEWS = ['race', 'garage', 'tracks', 'career'];
let view = 'race';

function setView(next) {
  if (next === 'network') { openWizard(); return; }
  if (next === 'settings') { openSettings(); return; }
  if (!VIEWS.includes(next)) return;
  view = next;
  for (const btn of $('rail').children) {
    btn.setAttribute('aria-pressed', String(btn.dataset.view === next));
  }
  for (const el of document.querySelectorAll('.setup [data-view]')) {
    el.hidden = el.dataset.view !== next;
  }
  if (next === 'career') renderCareer();
  // The garage is the studio; everywhere else stands the car on the circuit
  // under the conditions that are selected, so a change to the weather or the
  // time of day is something the player watches happen.
  refreshPreview();
  renderSpec();
}

// What the bottom of the stage is showing: the car in the garage, the circuit
// under Tracks, the race under Race. Every figure comes from the same data the
// race itself runs on.
function renderSpec() {
  if (view === 'tracks') return renderTrackSpec();
  if (view === 'race') return renderRaceSpec();
  return renderCarSpec();
}

// Bars as a share of the best car in the game at that one thing, so a full bar
// means "nothing here does this better".
const BEST = Object.values(CHASSIS).reduce((acc, c) => ({
  speed: Math.max(acc.speed, c.drive.power / c.drive.mass),
  accel: Math.max(acc.accel, (c.drive.power * c.drive.grip) / c.drive.mass),
  grip: Math.max(acc.grip, c.drive.grip),
  steer: Math.max(acc.steer, c.drive.steer),
  brake: Math.max(acc.brake, c.drive.brake),
}), { speed: 0, accel: 0, grip: 0, steer: 0, brake: 0 });

function paintSpec({ name, tag, bars, blurb }) {
  $('spec-name').textContent = name;
  $('spec-class').textContent = tag;
  $('spec-blurb').textContent = blurb ?? '';
  $('spec-bars').replaceChildren(...bars.map(([label, value, shown]) => {
    const el = document.createElement('div');
    el.className = 'spec-bar';
    el.innerHTML = `<span>${label}</span>`
      + (value === null
        ? `<b class="spec-figure">${shown}</b>`
        : `<i><b></b></i>`);
    if (value !== null) {
      requestAnimationFrame(() => {
        el.querySelector('i b').style.width = `${Math.round(Math.min(1, value) * 100)}%`;
      });
    }
    return el;
  }));
}

function renderCarSpec() {
  const chassis = CHASSIS[choice.chassis];
  const d = chassis.drive;
  paintSpec({
    name: chassis.name,
    tag: chassis.category,
    blurb: chassis.blurb,
    bars: [
      ['Top speed', (d.power / d.mass) / BEST.speed],
      ['Accel', ((d.power * d.grip) / d.mass) / BEST.accel],
      ['Handling', d.grip / BEST.grip],
      ['Drift', d.steer / BEST.steer],
      ['Braking', d.brake / BEST.brake],
    ],
  });
}

// Length and corner count are measured from the built circuit, not written
// down beside it, so they cannot drift out of step with the track itself.
function renderTrackSpec() {
  const spec = TRACKS[choice.track];
  const built = game.track?.spec === spec ? game.track : null;
  const km = built ? (built.length / 1000).toFixed(2) : '—';
  const corners = built ? built.corners() : '—';
  paintSpec({
    name: spec.name,
    tag: `${spec.surface} · ${spec.barriers ?? 'armco'} barriers`,
    blurb: spec.blurb,
    bars: [
      ['Length', null, `${km} km`],
      ['Corners', null, String(corners)],
      ['Grip', null, `${Math.round(spec.grip * 100)}%`],
      ['Laps', null, String(MODES[choice.mode].laps || '—')],
    ],
  });
}

function renderRaceSpec() {
  const mode = MODES[choice.mode];
  const bars = [
    ['Laps', null, String(mode.laps || '—')],
    ['Rivals', null, String(mode.rivals)],
    ['Tyre wear', null, mode.tyres ? 'ON' : 'OFF'],
    ['Pit stops', null, mode.pit ? 'REQUIRED' : 'NO'],
  ];
  paintSpec({
    name: mode.name,
    tag: `${TRACKS[choice.track].name} · ${VISIONS[choice.vision].name}`
      + ` · ${WEATHERS[choice.weather].name}`,
    blurb: mode.hint,
    bars,
  });
}

// The career panel: what the driver has, and what they have done.
function renderCareer() {
  const wallet = game.wallet;
  const tiles = [
    ['Points', wallet.points, 'points'],
    ['Boosts', wallet.charges, 'boosts'],
    ['Races', wallet.record.races, ''],
    ['Wins', wallet.record.wins, ''],
    ['Laps', wallet.record.laps, ''],
  ];
  $('career-tiles').replaceChildren(...tiles.map(([label, value, cls]) => {
    const el = document.createElement('div');
    el.className = `tile ${cls}`.trim();
    el.innerHTML = `<span class="k">${label}</span><span class="v">${value}</span>`;
    return el;
  }));

  $('career-badges').replaceChildren(...wallet.badges().map((badge) => {
    const el = document.createElement('span');
    el.className = `badge${badge.earned ? ' earned' : ''}`;
    el.title = badge.earned ? badge.name : badge.hint;
    el.innerHTML = `<span class="dot"></span>${badge.name}`;
    return el;
  }));
}

// Any change to the setup is shown in the scene behind the panel, not only in
// the panel itself. Rebuilding a circuit is cheap but not free, so a run of
// clicks collapses into one rebuild.
let previewPending = 0;
function refreshPreview() {
  clearTimeout(previewPending);
  previewPending = setTimeout(() => {
    // Garage means the studio; every other view is about the circuit, so the
    // car stands on it under the conditions that are selected.
    if (!menu.hidden) game.preview(choice, { style: view === 'garage' ? 'studio' : 'circuit' });
    $('stage-now').innerHTML =
      `<b>${CHASSIS[choice.chassis].name}</b> on <b>${TRACKS[choice.track].name}</b>`
      + ` &middot; ${VISIONS[choice.vision].name} &middot; ${WEATHERS[choice.weather].name}`;
  }, 40);
}

// One hint line for the whole form: it describes whatever was touched last,
// which keeps the panel short enough that the buttons stay on screen.
const describe = (_, value) => {
  $('hint').textContent = value.hint ?? value.blurb ?? '';
  renderSpec();
};
const describeCar = (key, value) => describe(key, value);
function buildPickers() {
  segment('pick-mode', MODES, 'mode', (k) => MODE_ICONS[k], describe);
  segment('pick-chassis', CHASSIS, 'chassis', (k, v) => carCard(k, v), describeCar);
  segment('pick-track', TRACKS, 'track', (_, v) => circuitIcon(v), describe);
  segment('pick-vision', VISIONS, 'vision', (_, v) => visionSwatch(v), describe);
  segment('pick-weather', WEATHERS, 'weather', (_, v) => weatherSwatch(v), describe);
  // The same car picker, shown again inside the multiplayer flow.
  segment('wizard-chassis', CHASSIS, 'chassis', (k, v) => carCard(k, v),
    (_, v) => { $('wizard-car-hint').textContent = v.blurb; });
  $('hint').textContent = TRACKS[choice.track].blurb;
  $('wizard-car-hint').textContent = CHASSIS[choice.chassis].blurb;
}

// --- game ----------------------------------------------------------------
// One scoreboard for solo and for the network: rows stagger in, the winner
// gets the gold treatment, and the reader's own row is always picked out.
function renderBoard({ eyebrow, title, sub, table, payout }) {
  $('result-eyebrow').textContent = eyebrow;
  $('result-title').textContent = title;
  $('result-sub').textContent = sub ?? '';

  const body = $('result-body');
  body.replaceChildren();
  table.forEach((row, i) => {
    const li = document.createElement('li');
    li.className = 'board-row';
    li.style.setProperty('--i', i);
    if (row.you) li.classList.add('you');
    if (row.place === 1) li.classList.add('win');

    const bar = document.createElement('span');
    bar.className = 'bar';
    const place = document.createElement('span');
    place.className = 'pl';
    place.textContent = `P${row.place}`;
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.style.background = `#${(row.color ?? 0x7d8ba3).toString(16).padStart(6, '0')}`;
    const name = document.createElement('span');
    name.className = 'nm';
    name.textContent = row.name;

    const time = document.createElement('span');
    time.className = 'tm';
    time.textContent = row.finished ? formatTime(row.total) : `lap ${row.lap + 1}`;
    const best = document.createElement('small');
    best.textContent = row.best ? `best ${formatTime(row.best)}` : 'no lap set';
    time.appendChild(best);

    li.append(bar, place, chip, name, time);
    body.appendChild(li);
  });

  // What the race paid, and what that leaves in the bank.
  const purse = $('result-purse');
  if (payout) {
    purse.hidden = false;
    purse.replaceChildren();
    for (const line of payout.lines) {
      const row = document.createElement('span');
      row.className = 'purse-line';
      row.innerHTML = `<span>${line.label}</span><b>+${line.value}</b>`;
      purse.appendChild(row);
    }
    const total = document.createElement('span');
    total.className = 'purse-line total';
    total.innerHTML = `<span>Balance &middot; ${payout.charges} boost`
      + `${payout.charges === 1 ? '' : 's'} ready</span><b>${payout.balance} pts</b>`;
    purse.appendChild(total);
  } else {
    purse.hidden = true;
  }

  // Only celebrate an actual win.
  const confetti = $('confetti');
  confetti.replaceChildren();
  const won = table.some((r) => r.you && r.place === 1);
  confetti.hidden = !won;
  if (won) {
    // Team colours: crimson, white and a little gold. Anything else on this
    // screen belongs to another game.
    const colours = ['#ff3a3f', '#ffffff', '#e01b24', '#ffc94d', '#c9ced6'];
    for (let i = 0; i < 26; i++) {
      const bit = document.createElement('i');
      bit.style.left = `${Math.random() * 100}%`;
      bit.style.background = colours[i % colours.length];
      bit.style.animationDelay = `${Math.random() * 1.1}s`;
      bit.style.animationDuration = `${2.1 + Math.random() * 1.4}s`;
      confetti.appendChild(bit);
    }
  }
  results.hidden = false;
}

// Built by the boot sequence, which is also what the player is watching while
// it happens. Everything below refers to it from inside a callback, so it is
// only ever read once the sequence has made it.
let game = null;

function buildGame() {
  return new Game($('scene'), {
    onExit: showMenu,
    onFinish: (r) => {
      renderBoard({
        eyebrow: `${r.mode} · ${r.track} · ${r.vision} / ${r.weather}`,
        title: r.entries > 1 ? `P${r.place} of ${r.entries}` : 'Time trial complete',
        sub: r.best ? `Your best lap ${formatTime(r.best)}` : '',
        table: r.table,
        payout: r.payout,
      });
    },
  });
}

function showMenu() {
  menu.hidden = false;
  results.hidden = true;
  game.preview(choice);
  renderCareer();
}

function launch() {
  // Audio may only begin inside a gesture, so every entry point starts it.
  game.audio.start();
  game.audio.resume();
  menu.hidden = true;
  results.hidden = true;
  game.start(choice);
}

$('start').addEventListener('click', launch);
for (const btn of $('rail').children) {
  btn.addEventListener('click', () => setView(btn.dataset.view));
}

// Enter drops the flag from the home screen, which is what the hint on the
// button says it does.
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || menu.hidden) return;
  if (!$('wizard').hidden || !$('settings').hidden) return;
  const tag = e.target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;
  e.preventDefault();
  launch();
});

// --- multiplayer, one question at a time ---------------------------------
// The home screen is about the race. Everything personal — who you are, which
// car is yours, the join code — is asked only when joining, one step at a time.
const wizard = $('wizard');
const STEPS = ['name', 'car', 'connect', 'lobby'];
let step = 0;

const stepEl = (key) => wizard.querySelector(`[data-step="${key}"]`);

function paintWizard() {
  STEPS.forEach((key) => { stepEl(key).hidden = STEPS[step] !== key; });

  $('wizard-steps').replaceChildren(...STEPS.map((_, i) => {
    const dot = document.createElement('i');
    if (i === step) dot.className = 'on';
    else if (i < step) dot.className = 'done';
    return dot;
  }));

  const onLobby = STEPS[step] === 'lobby';
  $('wizard-back').hidden = onLobby || step === 0;
  $('wizard-next').hidden = onLobby;
  $('wizard-next').textContent = STEPS[step] === 'connect' ? 'CONNECT' : 'NEXT';
  $('ready').hidden = !onLobby;
  $('go').hidden = !onLobby;
  $('leave').hidden = !onLobby;
}

function openWizard() {
  game.audio.start();
  game.audio.resume();
  refusal = null;
  step = connected ? STEPS.indexOf('lobby') : 0;
  wizard.hidden = false;
  paintWizard();
  if (!connected) $('name').focus();
}

function closeWizard() {
  wizard.hidden = true;
}

$('join').addEventListener('click', openWizard);
$('wizard-close').addEventListener('click', closeWizard);
$('wizard-back').addEventListener('click', () => {
  step = Math.max(0, step - 1);
  paintWizard();
});

$('wizard-next').addEventListener('click', async () => {
  if (STEPS[step] !== 'connect') {
    step = Math.min(STEPS.length - 1, step + 1);
    paintWizard();
    return;
  }
  lanState.textContent = 'connecting…';
  lanState.classList.remove('bad');
  try {
    await net.connect(driverName(), choice.chassis, $('code').value.trim(), roomCode);
    connected = true;
    if (net.room) roomCode = net.room;
    showInvite();
    game.attachNet(net);
    step = STEPS.indexOf('lobby');
    paintWizard();
  } catch (err) {
    const wrongCode = /code/i.test(refusal ?? err.message);
    lanState.textContent = wrongCode ? 'wrong join code' : 'no race server here';
    lanState.classList.add('bad');
    $('lan-url').textContent = wrongCode
      ? 'Ask the host for the code shown in their server window.'
      : 'The host starts the server with "npm start", then everyone opens the address it prints.';
  }
});

const lanState = $('lan-state');
const players = $('players');

function renderRoster(roster) {
  players.replaceChildren();
  for (const p of roster) {
    const li = document.createElement('li');
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.style.background = `#${p.color.toString(16).padStart(6, '0')}`;
    const who = document.createElement('span');
    who.className = 'who' + (p.id === net.id ? ' me' : '');
    who.textContent = p.name + (p.id === net.id ? ' (you)' : '');
    const car = document.createElement('span');
    car.className = 'tick';
    car.textContent = (CHASSIS[p.chassis] ?? CHASSIS.gt).name;
    const tick = document.createElement('span');
    tick.className = 'tick' + (p.ready ? ' on' : '');
    tick.textContent = p.ready ? 'READY' : 'WAITING';
    li.append(chip, who, car, tick);
    players.appendChild(li);
  }
  lanState.textContent = `${roster.length} driver${roster.length === 1 ? '' : 's'}`;
  lanState.classList.remove('bad');
}

$('ready').addEventListener('click', () => {
  ready = !ready;
  $('ready').setAttribute('aria-pressed', String(ready));
  $('ready').textContent = ready ? 'READY ✓' : 'READY';
  net.setReady(ready);
});

$('go').addEventListener('click', () => net.start());

$('copy-invite').addEventListener('click', async () => {
  const button = $('copy-invite');
  try {
    await navigator.clipboard.writeText(inviteUrl());
  } catch {
    // Clipboard access can be refused; selecting the text still lets them copy.
    $('invite-link').select();
  }
  button.textContent = 'COPIED';
  button.classList.add('done');
  setTimeout(() => {
    button.textContent = 'COPY';
    button.classList.remove('done');
  }, 1400);
});

$('new-room').addEventListener('click', () => setRoom(makeCode(), { reconnect: true }));

$('leave').addEventListener('click', () => {
  net.close();
  connected = false;
  ready = false;
  step = 0;
  closeWizard();
  paintWizard();
});

$('again').addEventListener('click', () => {
  if (connected) {
    net.backToLobby();
    showMenu();
    openWizard();
  } else {
    launch();
  }
});

// --- settings -------------------------------------------------------------
// The mixer: one fader per family of sound, stored where the audio engine
// already looks for them so the panel and the mix can never disagree.
const MIX = [
  ['set-master', 'master'], ['set-engine', 'engine'], ['set-tyres', 'tyres'],
  ['set-env', 'env'], ['set-music', 'music'], ['set-sfx', 'sfx'], ['set-ui', 'ui'],
];
const level = (key, fallback = 1) => storedLevel(key, fallback);

const settings = {
  sound: localStorage.getItem('apex.sound') !== 'off',
  master: level('master'),
  engine: level('engine'),
  tyres: level('tyres'),
  env: level('env'),
  music: level('music', Number(localStorage.getItem('apex.music') ?? 1)),
  sfx: level('sfx', Number(localStorage.getItem('apex.sfx') ?? 1)),
  ui: level('ui'),
  quality: localStorage.getItem('apex.quality') ?? 'medium',
  shadows: localStorage.getItem('apex.shadows') !== 'off',
  camera: localStorage.getItem('apex.camera') ?? 'chase',
  touchControls: localStorage.getItem('apex.touch') ?? 'auto',
  steering: Number(localStorage.getItem('apex.steering') ?? 1),
};

function pushSettings() {
  game.audio.setEnabled(settings.sound);
  game.audio.setMasterLevel(settings.master);
  for (const [, key] of MIX) {
    if (key !== 'master') game.audio.setLevel(key, settings[key]);
  }
  game.applySettings(settings);
  game.cameraMode = Math.max(0, CAMERAS.indexOf(settings.camera));
}

function openSettings() { $('settings').hidden = false; }
$('open-settings').addEventListener('click', openSettings);
$('settings-close').addEventListener('click', () => { $('settings').hidden = true; });

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const other of document.querySelectorAll('.tab')) {
      other.setAttribute('aria-selected', String(other === tab));
    }
    for (const panel of document.querySelectorAll('.tab-panel')) {
      panel.hidden = panel.dataset.panel !== tab.dataset.tab;
    }
  });
}

// Keep the filled part of a slider in step with its value.
function paintRange(el) {
  const min = Number(el.min || 0);
  const max = Number(el.max || 100);
  const pct = ((Number(el.value) - min) / (max - min)) * 100;
  el.style.setProperty('--fill', `${pct}%`);
}

// Each control writes one field, saves it, and applies the whole set.
function bind(id, key, read, store = (v) => String(v)) {
  const el = $(id);
  const apply = () => {
    if (el.type === 'range') paintRange(el);
    settings[key] = read(el);
    localStorage.setItem(`apex.${key === 'touchControls' ? 'touch' : key}`,
      store(settings[key]));
    pushSettings();
  };
  el.addEventListener(el.type === 'range' ? 'input' : 'change', apply);
  return el;
}

$('set-sound').checked = settings.sound;
for (const [id, key] of MIX) $(id).value = String(Math.round(settings[key] * 100));
$('set-quality').value = settings.quality;
$('set-shadows').checked = settings.shadows;
$('set-camera').value = settings.camera;
$('set-touch').value = settings.touchControls;
$('set-steering').value = String(Math.round(settings.steering * 100));
for (const range of document.querySelectorAll('input[type="range"]')) paintRange(range);

bind('set-sound', 'sound', (el) => el.checked, (v) => (v ? 'on' : 'off'));
// Faders are stored by the audio engine itself, so the generic binder must not
// also write them under a different key.
for (const [id, key] of MIX) {
  const el = $(id);
  el.addEventListener('input', () => {
    paintRange(el);
    settings[key] = Number(el.value) / 100;
    pushSettings();
  });
}
bind('set-quality', 'quality', (el) => el.value);
bind('set-shadows', 'shadows', (el) => el.checked, (v) => (v ? 'on' : 'off'));
bind('set-camera', 'camera', (el) => el.value);
bind('set-touch', 'touchControls', (el) => el.value);
bind('set-steering', 'steering', (el) => Number(el.value) / 100);

net.on('roster', renderRoster);

net.on('settings', (s) => {
  Object.assign(choice, s);
  for (const field of SHARED) paintField(field, choice[field]);
  $('hint').textContent = TRACKS[choice.track].blurb;
});

net.on('countdown', (msg) => {
  game.audio.resume();
  closeWizard();
  Object.assign(choice, msg.settings ?? {});
  menu.hidden = true;
  results.hidden = true;
  game.start(choice);
});

net.on('results', (table) => {
  const rows = table.map((row) => ({ ...row, you: row.id === net.id }));
  const mine = rows.find((row) => row.you);
  renderBoard({
    eyebrow: `${TRACKS[choice.track].name} · ${VISIONS[choice.vision].name} / ${WEATHERS[choice.weather].name}`,
    title: mine ? `P${mine.place} of ${rows.length}` : 'Race result',
    sub: mine?.best ? `Your best lap ${formatTime(mine.best)}` : '',
    table: rows,
    payout: game.lastPayout,
  });
});

net.on('lobby', () => { showMenu(); openWizard(); });

net.on('denied', (msg) => { refusal = msg.reason ?? 'refused'; });

net.on('offline', () => {
  connected = false;
  ready = false;
  lanState.textContent = refusal ?? 'disconnected';
  lanState.classList.add('bad');
});

// --- boot -----------------------------------------------------------------
// Each step reports in as it finishes, so the bar on the loading screen is the
// share of the work that is really done. The order is the order the game needs
// them in: the pictures for the pickers, the circuit and the car, then the
// scene they stand in, then the mixer.
const boot = new Boot();

async function start() {
  // Getting here at all means the module and Three.js have loaded.
  boot.finished('engine');
  await boot.run('physics', () => {
    showInvite();
    paintWizard();
  });
  await boot.run('vehicle', () => {
    loadThumbs();
    buildPickers();
  });
  game = await boot.run('track', () => buildGame());
  window.game = game;
  // From here the loading screen is showing the real car in the real studio.
  boot.attach(game);
  await boot.run('environment', () => {
    game.preview(choice, { style: 'studio' });
    renderCareer();
    setView('race');
  });
  await boot.run('audio', () => pushSettings());

  await boot.finish();
  $('loading').hidden = true;
  refreshPreview();
  // An invite link means the intent is already "join this race", so the flow
  // opens at the name step instead of making them find the button.
  if (new URLSearchParams(location.search).has('room')) openWizard();
}

start().catch((error) => boot.fail(error));

// Debug handle: the game has no build step, so expose the instances for
// probing from the browser console (state, car position, env presets).
window.net = net;
window.boot = boot;
