import { Room } from './room.js';

// One server can host many races at once. A connection names its room in the
// WebSocket URL, and a room lives only as long as someone is in it — which is
// what makes an invite link mean "come to my race" rather than "come to the
// one race this server has".

import { normaliseCode, DEFAULT_ROOM } from '../src/room-code.js';

const SNAPSHOT_HZ = 20;

export class Hub {
  constructor() {
    this.rooms = new Map();
    // One clock for every room, rather than a timer per room that has to be
    // remembered and cleared.
    this.timer = setInterval(() => {
      for (const room of this.rooms.values()) room.tick();
    }, 1000 / SNAPSHOT_HZ);
    this.timer.unref?.();
  }

  room(code) {
    const key = normaliseCode(code);
    if (!this.rooms.has(key)) this.rooms.set(key, new Room(key));
    return this.rooms.get(key);
  }

  // Called after a disconnect: an empty room is closed so its state does not
  // outlive the people who made it.
  release(room) {
    if (room.empty && room.code !== DEFAULT_ROOM) this.rooms.delete(room.code);
  }

  get stats() {
    return {
      rooms: this.rooms.size,
      players: [...this.rooms.values()].reduce((n, r) => n + r.players.size, 0),
    };
  }
}
