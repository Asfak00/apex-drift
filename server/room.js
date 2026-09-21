// The room owns everything every client must agree on: who is here, what the
// conditions are, and when the race starts and ends. Car positions are relayed
// as the sender reports them — this is a party racer on a trusted LAN, not a
// refereed competition, so there is no server-side physics or anti-cheat.

const COLORS = [0x4de3b0, 0xff5f5f, 0xffc94d, 0x6f9cff, 0xff8ae2, 0x8ef26a, 0xffffff, 0xff9a52];
const COUNTDOWN_MS = 4000;
const SNAPSHOT_HZ = 20;
const MAX_NAME = 14;

const cleanName = (raw, fallback) => {
  const s = String(raw ?? '').replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, MAX_NAME);
  return s || fallback;
};

// Optional shared code. Empty means an open room, which is fine on a home
// network and is not fine on a port forwarded to the internet.
const JOIN_CODE = (process.env.APEX_CODE ?? '').trim();

export class Room {
  constructor(code = 'MAIN') {
    this.code = code;
    this.players = new Map();
    this.nextId = 1;
    this.settings = { mode: 'race', vision: 'day', weather: 'clear', track: 'apex' };
    this.state = 'lobby';          // lobby | countdown | racing | finished
    this.finishOrder = [];
    this.timer = null;
  }

  // Driven by the hub's clock, so rooms do not each carry their own timer.
  tick() {
    this.#broadcastSnapshot();
  }

  get empty() {
    return this.players.size === 0;
  }

  // --- connection lifecycle ---------------------------------------------
  get requiresCode() { return JOIN_CODE.length > 0; }

  connect(socket) {
    const id = this.nextId++;
    const player = {
      id, socket,
      name: `Racer ${id}`,
      color: COLORS[(id - 1) % COLORS.length],
      chassis: 'gt',
      ready: false,
      joined: false,
      lap: 0, best: null, finished: false, finishTime: null,
      transform: null,
    };
    this.players.set(id, player);
    this.#send(player, {
      t: 'welcome', id, room: this.code, settings: this.settings, state: this.state,
      roster: this.roster(), needsCode: this.requiresCode,
    });
    return player;
  }

  disconnect(player) {
    if (!this.players.delete(player.id)) return;
    this.finishOrder = this.finishOrder.filter((p) => p !== player.id);
    this.#broadcastRoster();
    if (this.state !== 'lobby' && this.#racers().length === 0) this.#toLobby();
  }

  roster() {
    return [...this.players.values()].filter((p) => p.joined).map((p) => ({
      id: p.id, name: p.name, color: p.color, ready: p.ready, chassis: p.chassis,
      lap: p.lap, best: p.best, finished: p.finished, finishTime: p.finishTime,
    }));
  }

  #racers() {
    return [...this.players.values()].filter((p) => p.joined);
  }

  // --- inbound messages --------------------------------------------------
  handle(player, msg) {
    switch (msg.t) {
      case 'join': {
        if (JOIN_CODE && String(msg.code ?? '').trim() !== JOIN_CODE) {
          this.#send(player, { t: 'denied', reason: 'wrong join code' });
          player.socket.close();
          return;
        }
        player.name = cleanName(msg.name, `Racer ${player.id}`);
        if (typeof msg.chassis === 'string') player.chassis = msg.chassis;
        player.joined = true;
        this.#broadcastRoster();
        break;
      }
      case 'settings': {
        if (this.state !== 'lobby') break;
        const { mode, vision, weather, track } = msg;
        this.settings = {
          mode: mode ?? this.settings.mode,
          vision: vision ?? this.settings.vision,
          weather: weather ?? this.settings.weather,
          track: track ?? this.settings.track,
        };
        this.#broadcast({ t: 'settings', settings: this.settings, by: player.name });
        break;
      }
      case 'chassis': {
        // The car is the player's own choice, unlike the shared conditions.
        if (typeof msg.chassis === 'string') player.chassis = msg.chassis;
        this.#broadcastRoster();
        break;
      }
      case 'ready': {
        player.ready = !!msg.ready;
        this.#broadcastRoster();
        break;
      }
      case 'start': {
        if (this.state === 'lobby' && player.joined) this.#startCountdown(player);
        break;
      }
      case 'state': {
        // Hot path: store only, the snapshot tick does the fan-out.
        player.transform = msg.s;
        if (typeof msg.lap === 'number') player.lap = msg.lap;
        break;
      }
      case 'lap': {
        player.lap = msg.lap;
        if (typeof msg.best === 'number' && (player.best == null || msg.best < player.best)) {
          player.best = msg.best;
        }
        this.#broadcastRoster();
        // Tell the rest of the field, so a lap is an event and not just a
        // number that quietly changes on someone else's screen.
        this.#broadcast({
          t: 'lap-flash', id: player.id, name: player.name, color: player.color, lap: player.lap,
        }, player);
        break;
      }
      case 'finish': {
        if (player.finished || this.state !== 'racing') break;
        player.finished = true;
        player.finishTime = msg.total;
        if (typeof msg.best === 'number') player.best = msg.best;
        this.finishOrder.push(player.id);
        this.#broadcastRoster();
        if (this.#racers().every((p) => p.finished)) this.#finishRace();
        break;
      }
      case 'lobby': {
        if (this.state === 'finished') this.#toLobby();
        break;
      }
    }
  }

  // --- race lifecycle ----------------------------------------------------
  #startCountdown(by) {
    this.state = 'countdown';
    for (const p of this.#racers()) {
      p.lap = 0; p.best = null; p.finished = false; p.finishTime = null;
    }
    this.finishOrder = [];
    const startAt = Date.now() + COUNTDOWN_MS;
    this.#broadcast({
      t: 'countdown', startAt, ms: COUNTDOWN_MS,
      settings: this.settings, by: by.name, roster: this.roster(),
    });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.state = 'racing';
      this.#broadcast({ t: 'go', at: Date.now() });
    }, COUNTDOWN_MS);
  }

  #finishRace() {
    this.state = 'finished';
    clearTimeout(this.timer);
    this.#broadcast({ t: 'results', results: this.results() });
  }

  results() {
    const byId = (id) => this.players.get(id);
    const done = this.finishOrder.map(byId).filter(Boolean);
    const rest = this.#racers()
      .filter((p) => !p.finished)
      .sort((a, b) => b.lap - a.lap);
    return [...done, ...rest].map((p, i) => ({
      place: i + 1, id: p.id, name: p.name, color: p.color,
      total: p.finishTime, best: p.best, lap: p.lap, finished: p.finished,
    }));
  }

  #toLobby() {
    this.state = 'lobby';
    clearTimeout(this.timer);
    for (const p of this.#racers()) p.ready = false;
    this.#broadcast({ t: 'lobby', settings: this.settings, roster: this.roster() });
  }

  // --- outbound ----------------------------------------------------------
  #send(player, payload) {
    if (player.socket.readyState === 1) player.socket.send(JSON.stringify(payload));
  }

  #broadcast(payload, except = null) {
    const data = JSON.stringify(payload);
    for (const p of this.players.values()) {
      if (p !== except && p.socket.readyState === 1) p.socket.send(data);
    }
  }

  #broadcastRoster() {
    this.#broadcast({ t: 'roster', roster: this.roster(), state: this.state });
  }

  // Each client gets every car but its own, so nobody fights its own echo.
  #broadcastSnapshot() {
    const moving = this.#racers().filter((p) => p.transform);
    if (moving.length < 2) return;
    for (const viewer of moving) {
      const cars = [];
      for (const p of moving) {
        if (p === viewer) continue;
        cars.push({ id: p.id, s: p.transform, lap: p.lap });
      }
      if (cars.length) this.#send(viewer, { t: 'snap', cars });
    }
  }
}
