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
- `APEX_PUBLIC` — an address to print in the startup banner. It is also used as
  the canonical origin in the social share tags; without it the tags follow the
  address each request arrives on.

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
| `A` `D` / `←` `→` | Steer (ramped: ~0.18 s to full lock, ~0.11 s back to centre) |
| `Space` | Handbrake (breaks rear grip for drifts) |
| `C` | Cycle camera: chase, hood, cinematic |
| `V` | Cycle vision: Day, Sunset, Dusk, Night, Neon |
| `B` | Cycle weather: Clear, Rain, Storm, Fog, Snow |
| `Shift` | Boost (costs a charge) |
| `1` `2` `3` | Pick the next tyre compound: soft, medium, hard |
| `T` | Call a pit stop, or wave one off |
| `P` | Hand the car to the pit lane and back again |
| `M` | Mute |
| `R` | Respawn on the racing line |
| `Esc` | Back to menu |

On a phone or tablet the on-screen controls appear automatically: drag anywhere
on the left pad to steer, gas and brake on the right, with boost and handbrake
above them. Steering has a small dead zone and an expo curve, so a slight thumb
movement is a slight correction and full lock lives at the edge of the travel;
once the thumb passes full travel the origin follows it, so lock can always be
wound back off without lifting.

While those controls are up the HUD rearranges itself around them: the dial
gives up the bottom-right corner to the pedals and becomes one strip across the
top with speed, gear, boost and tyres, the camera and menu buttons move to the
free edge, and nothing overlaps the thumbs. On a narrow screen the strip takes
the top edge on its own and the rest of the HUD starts below it.

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

## Steering

A key is all or nothing and a car's wheel is not, so the key axis is ramped —
about 0.18 s to full lock, 0.11 s back to centre. A tap is a correction, a held
arrow still reaches the stop immediately enough to catch a corner.

The input is then shaped before it becomes an angle, and how much angle full
input is worth was retuned. The tyre curve is steep near the centre, so a linear
input spent almost all of the grip in the first third of the travel and the rest
of it did nothing: at 180 km/h, a third of the input already asked for 93% of
peak grip. Worse, full lock asked 1.4× past the peak of the curve, where force
is falling away — so holding the arrow key down turned *less* sharply than
holding three quarters of it. Full input must be the strongest input.

Now the request is raised to a power before it is scaled by the lock, the lock
itself stops just past the peak rather than well beyond it, and the wheel itself
moves faster (6.8 rad/s, up from 4.6). Mechanical grip and downforce were both
raised with it, so there is more corner to reach. Measured on a car holding
lock for three seconds, degrees of heading turned:

| | ⅓ input | ⅔ input | full |
|---|---|---|---|
| 220 km/h | 122 | 149 | 144 |
| 180 km/h | 115 | 146 | 141 |
| 120 km/h | 105 | 152 | 146 |

Before the change every one of those cells sat between 98 and 113 whatever the
input was. The AI's corner-speed estimate takes a margin off the new grip rather
than assuming all of it, so it still laps every weather with no time off the
road.

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
| Grand Stadium | Asphalt | 27 m | 100% | Concrete blocks |

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

Spectators are people, not bollards. Each one is built from two legs and two
shoes, a torso with shoulders across the top of it, two arms hung from those
shoulders with hands on the ends, a neck, a head and hair — and a cap on about
a third of them. Heights, skin tones, hair, shirts, trousers and sleeve length
all vary per figure, and the stance is jittered so no two stand identically.

They move on the GPU. Every figure carries a phase, and one patched vertex
shader reads it to give each of them their own tempo as well as their own
timing, bob the body, lean it toward the track, and swing the arms from the
shoulder — about a third clap in front of them instead of throwing both arms
up, which is what a stand actually looks like. Nothing is written per frame
except two uniforms, so five thousand people cost no more CPU than fifty. They
do not cast shadows (a second pass over that many figures is not worth it) but
they do take them, so the ones under the stand roof are lit as if it were
there.

They react to the race: an overtake, a lap, a pit stop or the flag lifts both
what they are doing and what they sound like.

**Grand Stadium** is a closed arena ringed by tiered galleries: twelve rows of
terracing on both sides of the whole loop, roofed and posted, with six
floodlight masts over it. It holds about 5,600 people (scaled down on a phone,
which draws the same crowd with fewer triangles each rather than fewer people).
Seven in ten are seated in the galleries and the rest are on the ground, packed
four rows deep against the fence the whole way round.

### What a crowd sounds like

Noise shaped like a thousand voices at once. Three resonances in the range a
voice occupies — a chest band near 260 Hz, a vowel formant that drifts the way
a crowd's does, and a bright roar band that comes up only when they are
actually shouting — over a slow swell, because a crowd is never at a constant
volume. A big crowd also finds things to shout about on its own every few
seconds, on top of the cheers the race itself triggers. All of it scales with
how many people the circuit holds, so Grand Stadium is loud over the engine and
Canyon Run is nearly silent.

## Modes

- **Race** — 3 laps against 3 AI drivers on softs. Position scores on laps, then
  on distance round the current lap.
- **Grand Prix** — 54 laps against 5 drivers, with tyre wear and a pit lane. The
  field starts spread across the compounds, and nobody finishes on one set.
- **Time Trial** — empty circuit, chase your own best lap. No wear.
- **Free Roam** — no flag and no clock; swap skies and weather freely.

## Tyres and the pit lane

Three compounds, the way a race weekend uses them:

| Compound | Grip | Wear | In the wet |
|---|---|---|---|
| **S** Soft | +10% | 2.00× | Worst |
| **M** Medium | baseline | 1.00× | baseline |
| **H** Hard | −8% | 0.55× | Best |

Soft is the grippiest set on any surface and hard the least, always — the water
penalty changes how much each keeps, never the order. Measured on a car holding
a corner at 180 km/h, degrees of heading turned in three seconds:

| | soft | medium | hard |
|---|---|---|---|
| Dry | 159 | 145 | 134 |
| Rain | 138 | 128 | 119 |

Water also *slows* wear rather than adding to it: a wet track is cool and keeps
the tyre off its limit, so a set lasts about a third longer in the rain than in
the dry. What the rain changes is the reason to run a harder set, which is that
it is still there twenty laps later.

A set has a life, and grip falls as that life is spent: about seventy per cent
of the compound's own grip by the time it is gone, with the last tenth falling
away faster than the rest — the cliff a driver feels before they see it. A worn
set is slow, not undriveable: the stop has to be a decision, not a rescue. Cornering
load spends life, and wheelspin and locked brakes spend far more of it, so a
clumsy driver stops sooner than a tidy one. Dirt eats rubber faster than asphalt.

Every circuit has a pit lane along the start/finish straight, outside the
barrier line, with a wall, a working box and the garages behind it. The lane is
open for the whole race in any mode that wears tyres: **taking the lane and
pulling up on the box is the call.** Pick the compound with `1`/`2`/`3` (or the
**S M H** buttons on the HUD) and it is what the crew fits, whether or not you
told the pit wall first. `T` and **BOX** still announce a stop, which is useful
for knowing what you asked for, but nothing waits on it. A limiter holds the car
to 80 km/h down the lane, and stopping on the box holds it there while the crew
works. The AI runs the same strategy on the same lane — it calls a stop before
the cliff, not after it, and fits whatever compound will see the rest of the
race out.

### One button for the whole stop

**ENTER PIT LANE** on the HUD, **PIT** on a phone, or `P`. It calls the stop if
one has not been called, then hands the car to the lane: from the pit entry it
drives itself down at the limit and pulls up square on the box, which is the
same line the AI drives — one description of how a car gets from the entry to
the box, used by both. Touching the throttle, the brake or the wheel takes the
car straight back, and the assist releases itself the moment the stop is done.

### The crew

Eight of them, in team colours, waiting at the wall with two spare wheels at
their feet whenever there is a car in the pit lane. When one stops on the box
they come over the line and take a position each: a wheel man at every corner,
a jack man at each end, a fuel man at the flank, and the lollipop man in front
of the car with the board down where the driver can read it.

The stop is a timeline, and every part of it is on screen: the jacks go under
and the car rises 13 cm, the wheel men crouch and the old wheels come off the
hubs and out to the side, the new set goes on — which is the moment the
compound actually changes, so the sidewall colour and the grip change together
— the car drops, the board lifts, and they walk back to the wall.

They are built as real jointed figures rather than the instanced, shader-posed
bodies in the grandstand: hips, chest, shoulders, elbows, knees, helmet and
visor, posed in JavaScript. Eight figures can afford the joints where five
thousand cannot. They are drawn only while a car is in the pit lane's stretch
of the circuit, which is the only place they can be seen from — the rest of the
race costs nothing at all.

The sidewall band on each wheel carries the compound's colour, so which set a
car is on is readable from the chase camera as well as from the HUD.

## Visions and weather

Vision sets time of day: sky gradient, sun angle and colour, fog band,
tone-mapping exposure, and whether headlights come on. Weather multiplies on
top: grip, fog compression, light level, particle field, and road wetness.
They combine, so Night + Storm is a different drive from Day + Clear — the
two systems never branch against each other.

Grip runs from 100% (Clear) down to 73% (Snow). Leaving the tarmac costs grip
again, and the HUD grip readout reflects both at once.

What the weather sets is what the *road* gives back, not what the car can use.
The engine can only push as hard as the rear tyres can grip, and the brakes only
as hard as all four can: both are clamped to the load under them before anything
reaches the car. Without that clamp a wet car took full acceleration while
spending grip it was never making, which left the driving axle nothing for the
corner — every corner in the rain became a slide. With it, a lap of a snow-bound
circuit goes from one lap at 26 km/h average, nine seconds of it off the road,
to four clean laps at 152.

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
src/tyres.js       compounds, tyre life and the grip that falls with it
src/crowd.js       instanced spectators and their vertex-shader animation
src/pit-crew.js    the eight-strong crew, the jacks, and the wheel change
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
