import { sampleCentreline } from './layout.js';

// Every option in the menu carries a picture of what it is. Car silhouettes are
// drawn from the same body proportions the 3D chassis uses, and circuit
// thumbnails are drawn from the same centreline the track is built from, so a
// menu icon can never disagree with what the option actually loads.

const svg = (body, box = '0 0 48 32') =>
  `<svg viewBox="${box}" class="opt-icon" aria-hidden="true">${body}</svg>`;

export const MODE_ICONS = {
  race: svg(`
    <path d="M10 4v26" class="s"/>
    <path d="M13 6h9v5h-9zM22 11h9v5h-9zM13 11h9v5h-9z" class="f2"/>
    <path d="M22 6h9v5h-9zM13 16h9v5h-9zM22 16h9v5h-9z" class="f1"/>`),
  trial: svg(`
    <circle cx="24" cy="18" r="10" class="s"/>
    <path d="M24 12v6l4 3" class="s"/>
    <path d="M20 5h8" class="s"/>`),
  roam: svg(`
    <circle cx="24" cy="16" r="11" class="s"/>
    <path d="M29 11l-3 8-8 3 3-8z" class="f1"/>`),
};

const hex = (n) => `#${n.toString(16).padStart(6, '0')}`;

function swatch(width = 160, height = 100) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return { canvas, c: canvas.getContext('2d'), width, height };
}

const asImage = (canvas) => `<img class="opt-shot" src="${canvas.toDataURL()}" alt="" />`;

// A vision card is a small picture of that sky, painted from the same colours
// the scene uses: the gradient, where the sun sits, and the ground it lights.
export function visionSwatch(spec) {
  const { canvas, c, width, height } = swatch();
  const horizon = height * 0.66;

  const sky = c.createLinearGradient(0, 0, 0, horizon);
  sky.addColorStop(0, hex(spec.sky));
  sky.addColorStop(1, hex(spec.horizon));
  c.fillStyle = sky;
  c.fillRect(0, 0, width, horizon);

  if (spec.name === 'Night' || spec.name === 'Neon') {
    c.fillStyle = 'rgba(255,255,255,.85)';
    for (let i = 0; i < 34; i++) {
      const x = Math.random() * width;
      const y = Math.random() * horizon * 0.85;
      c.fillRect(x, y, 1.2, 1.2);
    }
  }

  // Sun or moon, placed from the scene's own light direction.
  const [sx, sy] = spec.sun;
  const px = width * (0.5 + sx * 0.42);
  const py = horizon - Math.max(0.04, sy) * horizon * 0.82;
  const glow = c.createRadialGradient(px, py, 0, px, py, height * 0.5);
  glow.addColorStop(0, hex(spec.sunColor));
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  c.globalAlpha = Math.min(0.85, 0.28 + spec.sunI * 0.25);
  c.fillStyle = glow;
  c.fillRect(0, 0, width, horizon);
  c.globalAlpha = 1;
  c.fillStyle = hex(spec.sunColor);
  c.beginPath();
  c.arc(px, py, spec.sunI > 1 ? 9 : 7, 0, Math.PI * 2);
  c.fill();

  const ground = c.createLinearGradient(0, horizon, 0, height);
  ground.addColorStop(0, hex(spec.groundTint));
  ground.addColorStop(1, hex(spec.fog));
  c.fillStyle = ground;
  c.fillRect(0, horizon, width, height - horizon);

  // A hint of road, so the card reads as a place and not a paint chip.
  c.fillStyle = 'rgba(20,24,32,.72)';
  c.beginPath();
  c.moveTo(width * 0.36, horizon);
  c.lineTo(width * 0.64, horizon);
  c.lineTo(width * 0.94, height);
  c.lineTo(width * 0.06, height);
  c.closePath();
  c.fill();
  return asImage(canvas);
}

// A weather card shows the same road under that weather: how far you can see,
// how dark it gets, and what is falling.
export function weatherSwatch(spec) {
  const { canvas, c, width, height } = swatch();
  const horizon = height * 0.66;

  const sky = c.createLinearGradient(0, 0, 0, horizon);
  const dark = spec.lightScale;
  sky.addColorStop(0, `rgb(${70 * dark + 18},${104 * dark + 22},${150 * dark + 28})`);
  sky.addColorStop(1, `rgb(${150 * dark + 40},${172 * dark + 44},${196 * dark + 48})`);
  c.fillStyle = sky;
  c.fillRect(0, 0, width, horizon);

  if (spec.name === 'Clear') {
    c.fillStyle = '#fff3d0';
    c.beginPath();
    c.arc(width * 0.74, horizon * 0.34, 9, 0, Math.PI * 2);
    c.fill();
  } else {
    c.fillStyle = `rgba(${210 * dark + 30},${216 * dark + 32},${226 * dark + 36},.9)`;
    for (const [x, y, r] of [[0.3, 0.3, 17], [0.45, 0.26, 21], [0.6, 0.32, 15], [0.75, 0.28, 18]]) {
      c.beginPath();
      c.arc(width * x, horizon * y, r, 0, Math.PI * 2);
      c.fill();
    }
  }

  c.fillStyle = `rgb(${74 * dark + 26},${96 * dark + 30},${64 * dark + 26})`;
  c.fillRect(0, horizon, width, height - horizon);
  c.fillStyle = 'rgba(20,24,32,.72)';
  c.beginPath();
  c.moveTo(width * 0.36, horizon);
  c.lineTo(width * 0.64, horizon);
  c.lineTo(width * 0.94, height);
  c.lineTo(width * 0.06, height);
  c.closePath();
  c.fill();

  if (spec.particle === 'rain') {
    c.strokeStyle = 'rgba(200,222,246,.75)';
    c.lineWidth = 1.3;
    for (let i = 0; i < 60; i++) {
      const x = Math.random() * width;
      const y = Math.random() * height;
      c.beginPath();
      c.moveTo(x, y);
      c.lineTo(x + 2.5, y + 9);
      c.stroke();
    }
  }
  if (spec.particle === 'snow') {
    c.fillStyle = 'rgba(255,255,255,.9)';
    for (let i = 0; i < 54; i++) {
      c.beginPath();
      c.arc(Math.random() * width, Math.random() * height, 1.5, 0, Math.PI * 2);
      c.fill();
    }
  }
  if (spec.lightning) {
    c.strokeStyle = '#ffe9a8';
    c.lineWidth = 2.2;
    c.beginPath();
    c.moveTo(width * 0.26, 10);
    c.lineTo(width * 0.2, horizon * 0.5);
    c.lineTo(width * 0.27, horizon * 0.5);
    c.lineTo(width * 0.19, horizon * 0.92);
    c.stroke();
  }
  // Visibility: the tighter the fog band, the less of the road survives.
  const haze = 1 - spec.fogScale;
  if (haze > 0.05) {
    const fog = c.createLinearGradient(0, horizon * 0.35, 0, height);
    fog.addColorStop(0, `rgba(216,226,238,${0.1 + haze * 0.72})`);
    fog.addColorStop(1, `rgba(216,226,238,${haze * 0.2})`);
    c.fillStyle = fog;
    c.fillRect(0, horizon * 0.35, width, height - horizon * 0.35);
  }
  return asImage(canvas);
}

// A side-on silhouette generated from the chassis body block. A taller roof, a
// longer nose and a bigger wing really do come out looking like their car.
export function carIcon(chassis) {
  const b = chassis.body;
  const L = 40, x0 = 4, ground = 26;
  const wheel = (2.9 + b.ride * 2.6);
  const sill = ground - wheel * 0.72;              // bottom of the bodywork
  const belt = sill - 3.4 - b.ride * 1.6;          // top of the wings
  const roof = belt - (b.roof + 0.2) * 5.2;        // roof line
  const nose = 0.10 + (b.nose - 0.85) * 0.06;      // longer nose pushes the screen back
  const glassFront = x0 + L * (0.34 + nose);
  const glassBack = x0 + L * (0.66 + nose * 0.4);
  const wing = b.wing * 3.1;

  return svg(`
    <path d="M${x0} ${sill}
      L${x0 + 1.4} ${belt + 1.2}
      L${glassFront - L * 0.13} ${belt}
      L${glassFront} ${roof} L${glassBack} ${roof}
      L${glassBack + L * 0.16} ${belt}
      L${x0 + L} ${belt + 1.4} L${x0 + L} ${sill} Z" class="f1"/>
    <path d="M${glassFront + 0.9} ${roof + 1.1} L${glassBack - 0.9} ${roof + 1.1}
      L${glassBack + L * 0.11} ${belt - 0.6} L${glassFront - L * 0.09} ${belt - 0.6} Z"
      class="f2"/>
    <path d="M${x0 + L - 1} ${belt - wing} h${Math.max(2.6, wing * 1.5)} v1.6
      h${-Math.max(2.6, wing * 1.5)} z" class="f1"/>
    <circle cx="${x0 + L * 0.25}" cy="${ground - wheel * 0.15}" r="${wheel}" class="s"/>
    <circle cx="${x0 + L * 0.77}" cy="${ground - wheel * 0.15}" r="${wheel}" class="s"/>`);
}

// The circuit card is the real centreline drawn as a road: the circuit's own
// tarmac colour over its own ground, with the start line marked.
export function circuitIcon(spec) {
  const { canvas, c, width, height } = swatch(160, 110);
  const { points } = sampleCentreline(spec, 260);

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
  }
  const pad = 16;
  const span = Math.max(maxX - minX, maxZ - minZ) || 1;
  const k = Math.min(width - pad * 2, height - pad * 2) / span;
  const ox = width / 2 - ((minX + maxX) / 2) * k;
  const oz = height / 2 - ((minZ + maxZ) / 2) * k;
  const at = (p) => [p.x * k + ox, p.z * k + oz];

  c.fillStyle = hex(spec.ground);
  c.fillRect(0, 0, width, height);

  const trace = () => {
    c.beginPath();
    points.forEach((p, i) => {
      const [x, y] = at(p);
      if (i) c.lineTo(x, y); else c.moveTo(x, y);
    });
    c.closePath();
  };

  c.lineJoin = c.lineCap = 'round';
  // Verge, then the road itself, then the centre line.
  trace();
  c.strokeStyle = 'rgba(0,0,0,.28)';
  c.lineWidth = 13;
  c.stroke();
  trace();
  c.strokeStyle = hex(spec.road);
  c.lineWidth = 10;
  c.stroke();
  trace();
  c.strokeStyle = 'rgba(232,238,247,.5)';
  c.lineWidth = 1;
  c.setLineDash([3, 5]);
  c.stroke();
  c.setLineDash([]);

  const [sx, sy] = at(points[0]);
  c.fillStyle = '#4de3b0';
  c.beginPath();
  c.arc(sx, sy, 4, 0, Math.PI * 2);
  c.fill();
  c.strokeStyle = 'rgba(5,8,15,.8)';
  c.lineWidth = 1.4;
  c.stroke();
  return asImage(canvas);
}

export const LOGO = `
<svg viewBox="0 0 320 78" class="logo" role="img" aria-label="Apex Drift">
  <defs>
    <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#4de3b0"/><stop offset="1" stop-color="#8ef26a"/>
    </linearGradient>
  </defs>
  <g transform="translate(4 6)">
    <path d="M33 4 L60 62 H44 L33 36 L22 62 H6 Z" fill="url(#lg)"/>
    <path d="M33 22 L44 48 H22 Z" fill="#05080f" opacity=".85"/>
    <path d="M2 50a34 34 0 0 1 62-20" fill="none" stroke="url(#lg)"
      stroke-width="3.5" stroke-linecap="round" opacity=".55"/>
  </g>
  <text x="80" y="42" class="logo-word">APEX</text>
  <text x="182" y="42" class="logo-word accent">DRIFT</text>
  <text x="81" y="62" class="logo-sub">CIRCUIT · STREET · DIRT</text>
</svg>`;
