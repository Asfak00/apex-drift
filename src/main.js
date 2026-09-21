import { MODES, VISIONS, WEATHERS, CHASSIS, TRACKS, CAMERAS } from './config.js';
import { Game } from './game.js';
import { formatTime } from './hud.js';
import { Net } from './net.js';
import {
  LOGO, MODE_ICONS, visionSwatch, weatherSwatch, carIcon, circuitIcon,
} from './ui-icons.js';
import { renderChassisThumbs } from './car-thumbs.js';
import { makeCode, normaliseCode, DEFAULT_ROOM } from './room-code.js';

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

// Real renders of the real meshes, made once at start-up. If the throwaway
// context cannot be created, the drawn silhouettes still carry the picker.
let carThumbs = {};
try {
  carThumbs = renderChassisThumbs();
} catch (err) {
  console.warn('car previews unavailable, using drawn icons', err);
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
    if (!menu.hidden) game.preview(choice);
    $('stage-now').innerHTML =
      `<b>${CHASSIS[choice.chassis].name}</b> on <b>${TRACKS[choice.track].name}</b>`
      + ` &middot; ${VISIONS[choice.vision].name} &middot; ${WEATHERS[choice.weather].name}`;
  }, 40);
}

// One hint line for the whole form: it describes whatever was touched last,
// which keeps the panel short enough that the buttons stay on screen.
const describe = (_, value) => { $('hint').textContent = value.hint ?? value.blurb ?? ''; };
segment('pick-mode', MODES, 'mode', (k) => MODE_ICONS[k], describe);
segment('pick-chassis', CHASSIS, 'chassis', (k, v) => carCard(k, v), describe);
segment('pick-track', TRACKS, 'track', (_, v) => circuitIcon(v), describe);
segment('pick-vision', VISIONS, 'vision', (_, v) => visionSwatch(v), describe);
segment('pick-weather', WEATHERS, 'weather', (_, v) => weatherSwatch(v), describe);
// The same car picker, shown again inside the multiplayer flow.
segment('wizard-chassis', CHASSIS, 'chassis', (k, v) => carCard(k, v),
  (_, v) => { $('wizard-car-hint').textContent = v.blurb; });
$('hint').textContent = TRACKS[choice.track].blurb;
$('wizard-car-hint').textContent = CHASSIS[choice.chassis].blurb;

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
    const colours = ['#4de3b0', '#ffc94d', '#6f9cff', '#ff5f5f', '#8ef26a'];
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

const game = new Game($('scene'), {
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
const settings = {
  sound: localStorage.getItem('apex.sound') !== 'off',
  music: Number(localStorage.getItem('apex.music') ?? 1),
  sfx: Number(localStorage.getItem('apex.sfx') ?? 1),
  quality: localStorage.getItem('apex.quality') ?? 'medium',
  shadows: localStorage.getItem('apex.shadows') !== 'off',
  camera: localStorage.getItem('apex.camera') ?? 'chase',
  touchControls: localStorage.getItem('apex.touch') ?? 'auto',
  steering: Number(localStorage.getItem('apex.steering') ?? 1),
};

function pushSettings() {
  game.audio.setEnabled(settings.sound);
  game.audio.setMusicLevel(settings.music);
  game.audio.setSfxLevel(settings.sfx);
  game.applySettings(settings);
  game.cameraMode = Math.max(0, CAMERAS.indexOf(settings.camera));
}

$('open-settings').addEventListener('click', () => { $('settings').hidden = false; });
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
$('set-music').value = String(Math.round(settings.music * 100));
$('set-sfx').value = String(Math.round(settings.sfx * 100));
$('set-quality').value = settings.quality;
$('set-shadows').checked = settings.shadows;
$('set-camera').value = settings.camera;
$('set-touch').value = settings.touchControls;
$('set-steering').value = String(Math.round(settings.steering * 100));
for (const range of document.querySelectorAll('input[type="range"]')) paintRange(range);

bind('set-sound', 'sound', (el) => el.checked, (v) => (v ? 'on' : 'off'));
bind('set-music', 'music', (el) => Number(el.value) / 100);
bind('set-sfx', 'sfx', (el) => Number(el.value) / 100);
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

$('loading').hidden = true;
showInvite();
renderCareer();
paintWizard();
pushSettings();
refreshPreview();

// Debug handle: the game has no build step, so expose the instance for probing
// from the browser console (state, car position, env presets).
window.game = game;
window.net = net;

// Arriving on an invite link means the intent is already "join this race", so
// the flow opens at the name step instead of making them find the button.
if (new URLSearchParams(location.search).has('room')) openWizard();
