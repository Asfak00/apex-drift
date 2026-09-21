# Apex Drift

A Three.js circuit racer. No build step, no npm install — Three.js loads from a
CDN through an import map, so the whole game is static files.

## Run

```bash
cd ~/Documents/apex-drift
npm install
npm start
```

The server prints the addresses it is listening on and serves both the game and
the LAN race hub. Open the `localhost` address on this machine.

## Putting it online

The game is one Node process that serves both the files and the WebSocket, so
anywhere that runs Node and keeps a socket open will host it. It needs a real
server — a static host (GitHub Pages, Netlify drop, plain S3) will serve the
game but multiplayer will not work, because there is nothing to relay between
players.

Free options that support WebSockets, in the order I would try them:

| Host | How |
|---|---|
| **Render** | Push to GitHub, New → Web Service, pick the repo. `render.yaml` configures it. Free instances sleep when idle, so the first visit after a quiet spell takes a few seconds to wake. |
| **Fly.io** | `fly launch --no-deploy` then `fly deploy`. Uses the `Dockerfile`; `fly.toml` is already set up with a health check. |
| **Koyeb / Railway** | Both detect the `Dockerfile` and need no extra configuration. |

Whatever you pick, the only requirements are already handled: the server reads
`PORT` from the environment, binds `0.0.0.0`, and answers `/healthz` with the
room and player count. Over HTTPS the client automatically opens a secure
`wss://` socket, so nothing needs changing for a real domain.

Optional environment variables:

- `APEX_CODE` — require a join code. Worth setting for a public deployment.
- `APEX_PUBLIC` — an address to print in the startup banner.

## Invite links

Every race is a room. Open the lobby and you get a link like:

```text
https://your-app.onrender.com/?room=KYCRT
```

Send it to anyone. Opening it drops them straight into the join flow for that
room — name, car, go — with no code to type and nothing to find. **New private
room** generates a fresh code and updates the link.

Without a room in the address everyone lands in the server's shared room, which
is what two people on one Wi-Fi expect. Rooms are created when the first player
arrives and closed when the last one leaves.

## Race on your Wi-Fi

Everyone on the same network opens the **same Wi-Fi address** the server
printed (for example `http://192.168.0.155:8080`), types a driver name, and
presses **RACE ON THIS WI-FI**. The lobby shows every driver, the car each one
picked, and who is ready. Any driver can press **START RACE**; the server runs
the countdown so all screens drop the flag together.

The circuit, mode, sky and weather are shared by the lobby — change one and it
changes for everyone. The car is each driver's own choice. Other players appear
on track with their name floating above the roof and a coloured dot on the
minimap. When everyone is across the line, the server ranks the field by finish
order and both screens show the same result table.

This is a party racer on a network you trust: there is no password and no
server-side refereeing, so anyone who can reach the address can join.

## Setup screen

The first screen is the game: the car, circuit, sky and weather you pick are
rendered live behind the panel, so choosing and seeing are the same act. The
picker cards are real too — each car thumbnail is a render of the actual mesh
the race uses, and each circuit thumbnail is that circuit's real centreline.

The gear button opens settings (audio levels and mute, quality, shadows,
default camera, on-screen controls, steering sensitivity). Everything persists.

Multiplayer asks for your name, your car and the join code one step at a time,
so none of it clutters the home screen.

## Controls

| Key | Action |
|---|---|
| `W` / `↑` | Throttle |
| `S` / `↓` | Brake, then reverse |
| `A` `D` / `←` `→` | Steer |
| `Space` | Handbrake (breaks rear grip for drifts) |
| `C` | Cycle camera: chase, hood, cinematic |
| `V` | Cycle vision: Day, Sunset, Dusk, Night, Neon |
| `B` | Cycle weather: Clear, Rain, Storm, Fog, Snow |
| `Shift` | Boost (costs a charge) |
| `M` | Mute |
| `R` | Respawn on the racing line |
| `Esc` | Back to menu |

On a phone or tablet the on-screen controls appear automatically: drag anywhere
on the left pad to steer, gas and brake on the right, with boost and handbrake
above them.

## Boost and points

Every driver starts with **10 free boosts**. After those are gone a boost costs
**25 points**, and points are earned by racing: 60/40/25 for a podium (15 for
finishing otherwise), 10 per lap, 20 for setting a best lap, and 5 per overtake.
A boost costs one charge on the press and then runs its reserve for as long as
you hold it. The HUD shows the reserve bar and how many charges you can afford;
the scoreboard shows what the race paid.

## Controls, and how to boost

Boost is on screen during every race — the amber **BOOST** button under the
dial, or the `Shift` key, or `A` on a gamepad. It greys out when you have no
charges left. A gamepad steers properly analogue: left stick for steering,
triggers for throttle and brake.

## Driving model

Physics is a bicycle model with slip-angle tyres, not a steering angle written
straight into the car's heading. Each axle's lateral force follows a rising,
peaking, falling curve of its slip angle, under a load that shifts forward
under braking and back under power. Yaw is a state the tyres act on, so the car
turns in, settles, and runs wide progressively instead of snapping round. The
rear axle carries slightly more grip than the front, the way road cars are set
up, so at the limit it washes wide and stays pointing forwards.

Full steering lock means "as hard as this car can turn at this speed", not a
fixed wheel angle. A tyre makes its peak force at only a few degrees of slip,
so a fixed lock asks for six times too much angle at speed and the car simply
ploughs. The limit is computed from the grip available plus the slip the front
tyre needs, which is why the car pulls the same ~1.15 g at 80 km/h and at
250 km/h.

It runs on a fixed 1/120 s step with render interpolation, so handling is
identical at 30 fps and 144 fps — verified, not assumed.

## Cars

| Chassis | Character |
|---|---|
| Coupe | Balanced baseline. Neutral and forgiving. |
| GT | Most power, most mass. Fastest in a straight line, lazy in slow corners. |
| Rally | Tall and short. Keeps the most grip on dirt. |
| Prototype | Light, low, huge grip — and unforgiving once it steps out. |

Every chassis scales the same physics baseline (power, mass, grip, steering
lock, brakes) and drives the mesh proportions, so each one looks like what it
drives like. There is no per-car physics path.

## Circuits

| Circuit | Surface | Road width | Grip | Edged by |
|---|---|---|---|---|
| Apex Ring | Asphalt | 29 m | 100% | Armco |
| Canyon Run | Concrete | 23 m | 95% | Concrete blocks |
| Dust Bowl | Dirt | 34 m | 72% | Nothing — run as wide as you dare |
| Old Town | Asphalt | 22 m | 97% | Bollards |
| Green Lane | Asphalt | 18 m | 93% | Fences |
| Dock Quarter | Asphalt | 21 m | 96% | Concrete blocks |
| Harbour Mile | Asphalt | 26 m | 98% | Concrete blocks |

Surface grip multiplies with the weather, so Dust Bowl in the snow is a very
different proposition from Apex Ring in the dry.

Circuits are described two ways. The four racing loops are control points fed
through a closed Catmull-Rom curve. **Old Town** and **Green Lane** are written
as driving scripts instead — `['straight', 184], ['right', 90, 28], ['cross']` —
so their straights are dead straight, their corners are a true constant radius,
and their crossroads land where the script says. Both descriptions resample onto
the same centreline table, so nothing downstream knows the difference.

Scenery is solid. Buildings, trees, hills and lamp posts stop a car rather than
swallowing it, and each circuit carries a few hundred collision volumes in a
spatial grid. Each circuit also has its own music, and each car its own engine
note.

Circuits are populated: spectators gather at the slow corners, a town has lit
windows, pavements and street lamps, a village has fences, trees, cattle and a
river through the fields.

## Modes

- **Race** — 3 laps against 3 AI drivers. Position scores on laps, then on
  distance round the current lap.
- **Time Trial** — empty circuit, chase your own best lap.
- **Free Roam** — no flag and no clock; swap skies and weather freely.

## Visions and weather

Vision sets time of day: sky gradient, sun angle and colour, fog band,
tone-mapping exposure, and whether headlights come on. Weather multiplies on
top: grip, fog compression, light level, particle field, and road wetness.
They combine, so Night + Storm is a different drive from Day + Clear — the
two systems never branch against each other.

Grip runs from 100% (Clear) down to 55% (Snow). Leaving the tarmac costs
grip again, and the HUD grip readout reflects both at once.

## Simulation

Physics runs on a fixed 1/120 s step with the renderer interpolating between
the last two states, so handling is identical on a 60 Hz laptop and a 144 Hz
monitor — only the smoothness changes. A long stall (a backgrounded tab) is
dropped rather than paid back in one burst.

## Layout

```
Dockerfile         one container for any host that takes one
render.yaml        Render service definition
fly.toml           Fly.io app definition
index.html         shell, HUD markup, import map
style.css          HUD, gauge, menus, responsive rules
src/config.js      every tunable: car baseline, chassis, circuits, visions, weathers, modes, boost
src/layout.js      driving scripts to centrelines, shared by the track and the menu
src/wallet.js      boost charges and points, and the rules for both
src/audio.js       synthesised music, engine, impacts, pass-bys
src/effects.js     pooled tyre smoke and impact debris
src/touch.js       on-screen controls for phones
src/ui-icons.js    logo, option icons, circuit thumbnails
src/car-thumbs.js  one-off renders of each chassis for the picker
src/track.js       circuit spline, road mesh, kerbs, barriers, scenery, queries
src/car.js         car mesh, arcade physics, AI driver, remote car, name tags
src/environment.js sky shader, lights, fog, precipitation, lightning
src/hud.js         HUD DOM, SVG gauge, canvas minimap
src/input.js       keyboard axes and one-shot actions
src/net.js         WebSocket client, outbound state throttling
src/game.js        state machine, cameras, laps, standings, fixed-step loop
src/main.js        menu and lobby wiring, boot
src/room-code.js   room code alphabet and validation, shared with the server
server/server.js   static file server, health check, WebSocket upgrade
server/hub.js      routes each connection to its room; closes empty ones
server/room.js     roster, shared settings, countdown, finish order
```

The track is built from 16 authored control points fed through a closed
Catmull-Rom curve, sampled 900 times. That sample table is the single source
of truth: the road ribbon, kerbs, barriers, grid slots, AI racing line,
minimap outline, and the nearest-point projection used by physics and
standings all read from it.

## Debugging

The game instance is exposed as `window.game` in the browser console — useful
for probing state without a build step:

```js
game.state                       // 'countdown' | 'racing' | 'finished'
game.player.kmh                  // live speed
game.standings().map(c => c.name)
game.track.project(game.player.position)   // { t, lateral, onRoad, ... }
```
