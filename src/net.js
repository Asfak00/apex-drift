// Client half of the LAN link. Owns the socket and nothing else: it turns
// server messages into events and throttles outbound car state.
const SEND_HZ = 20;

export class Net {
  constructor() {
    this.socket = null;
    this.id = null;
    this.roster = [];
    this.settings = null;
    this.state = 'offline';
    this.listeners = new Map();
    this.lastSend = 0;
  }

  get online() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  on(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
    return this;
  }

  #emit(type, payload) {
    for (const fn of this.listeners.get(type) ?? []) fn(payload);
  }

  // Resolves once the server has acknowledged the join, rejects if the socket
  // never opens — the menu uses that to fall back to single player.
  connect(name, chassis, code = '', room = '') {
    return new Promise((resolve, reject) => {
      // The room is named in the socket URL; over HTTPS this is automatically
      // a secure socket, which is what a hosted deployment needs.
      const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
      const query = room ? `?room=${encodeURIComponent(room)}` : '';
      const url = `${scheme}://${location.host}/ws${query}`;
      let settled = false;
      const socket = new WebSocket(url);
      this.socket = socket;

      const fail = (reason) => {
        if (settled) return;
        settled = true;
        this.state = 'offline';
        reject(new Error(reason));
      };

      socket.addEventListener('open',
        () => socket.send(JSON.stringify({ t: 'join', name, chassis, code })));
      socket.addEventListener('error', () => fail('connection failed'));
      socket.addEventListener('close', () => {
        this.state = 'offline';
        this.#emit('offline');
        fail('connection closed');
      });

      socket.addEventListener('message', (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }

        switch (msg.t) {
          case 'denied':
            fail(msg.reason ?? 'refused');
            this.#emit('denied', msg);
            break;
          case 'welcome':
            this.id = msg.id;
            this.room = msg.room ?? '';
            this.settings = msg.settings;
            this.roster = msg.roster;
            this.state = msg.state;
            if (!settled) { settled = true; resolve(this); }
            this.#emit('roster', msg.roster);
            this.#emit('settings', msg.settings);
            break;
          case 'roster':
            this.roster = msg.roster;
            if (msg.state) this.state = msg.state;
            this.#emit('roster', msg.roster);
            break;
          case 'settings':
            this.settings = msg.settings;
            this.#emit('settings', msg.settings);
            break;
          case 'countdown':
            this.state = 'countdown';
            this.roster = msg.roster ?? this.roster;
            this.settings = msg.settings ?? this.settings;
            this.#emit('countdown', msg);
            break;
          case 'go':
            this.state = 'racing';
            this.#emit('go', msg);
            break;
          case 'lap-flash':
            this.#emit('lap-flash', msg);
            break;
          case 'snap':
            this.#emit('snap', msg.cars);
            break;
          case 'results':
            this.state = 'finished';
            this.#emit('results', msg.results);
            break;
          case 'lobby':
            this.state = 'lobby';
            this.roster = msg.roster ?? this.roster;
            this.#emit('lobby', msg);
            break;
        }
      });
    });
  }

  send(payload) {
    if (this.online) this.socket.send(JSON.stringify(payload));
  }

  setSettings(settings) { this.send({ t: 'settings', ...settings }); }
  setChassis(chassis) { this.send({ t: 'chassis', chassis }); }
  setReady(ready) { this.send({ t: 'ready', ready }); }
  start() { this.send({ t: 'start' }); }
  backToLobby() { this.send({ t: 'lobby' }); }
  reportLap(lap, best) { this.send({ t: 'lap', lap, best }); }
  reportFinish(total, best) { this.send({ t: 'finish', total, best }); }

  // Called every frame; only the throttled frames reach the wire.
  pushState(car, now) {
    if (!this.online || now - this.lastSend < 1000 / SEND_HZ) return;
    this.lastSend = now;
    const p = car.position;
    this.send({
      t: 'state',
      lap: car.lap,
      s: [
        +p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2),
        +car.yaw.toFixed(3), +car.speed.toFixed(1), +car.steer.toFixed(2),
      ],
    });
  }

  close() {
    this.socket?.close();
    this.socket = null;
  }
}
