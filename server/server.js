// Static file server plus the LAN race hub. One process serves the game and
// relays player state, so a session is a single command on one machine.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { WebSocketServer } from 'ws';
import { Hub } from './hub.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8080;
// Set APEX_PUBLIC to the address players outside this network will use, once
// the router forwards PORT to this machine.
const PUBLIC = (process.env.APEX_PUBLIC ?? '').trim();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// Only files inside the project are servable; anything resolving outside is a 403.
async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  // A health check the hosting platform can poll without loading the game.
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ ok: true, ...hub.stats }));
    return;
  }
  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.resolve(ROOT, '.' + rel);

  if (!file.startsWith(ROOT + path.sep) && file !== path.join(ROOT, 'index.html')) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    }).end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
}

const server = http.createServer(serveStatic);
const wss = new WebSocketServer({ server, path: '/ws' });
const hub = new Hub();

wss.on('connection', (socket, request) => {
  // The room is named in the socket URL, so a player is in the right race
  // before the first message is exchanged.
  const query = new URL(request.url, 'http://localhost').searchParams;
  const room = hub.room(query.get('room'));
  const player = room.connect(socket);
  socket.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    room.handle(player, msg);
  });
  const leave = () => {
    room.disconnect(player);
    hub.release(room);
  };
  socket.on('close', leave);
  socket.on('error', leave);
});

function lanAddresses() {
  return Object.values(networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Apex Drift  ·  LAN race server\n`);
  console.log(`  this machine   http://localhost:${PORT}`);
  for (const ip of lanAddresses()) console.log(`  same Wi-Fi     http://${ip}:${PORT}`);
  if (PUBLIC) {
    const url = PUBLIC.startsWith('http') ? PUBLIC : `http://${PUBLIC}:${PORT}`;
    console.log(`  over the net   ${url}`);
    console.log(`                 (only reachable once your router forwards TCP ${PORT} here)`);
  }
  if (process.env.APEX_CODE) console.log(`\n  join code      ${process.env.APEX_CODE}`);
  else if (PUBLIC) console.log(`\n  WARNING: no APEX_CODE set — anyone who reaches this port can join.`);
  console.log(`\n  Ctrl-C to stop.\n`);
});
