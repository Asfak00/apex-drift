import * as THREE from 'three';

// Procedural surfaces. Every map a surface needs comes out of one height field,
// so the aggregate that shows up in the normal map is the same aggregate that
// shows up in the colour: that agreement is what stops a road reading as a
// tinted plane with noise sprinkled over it.
//
// Everything here is drawn once per circuit on a canvas the size of a couple of
// metres of road, then tiled in real units. A browser game cannot afford
// photographic tarmac, and does not need it — it needs the right scale.

const SIZE = 512;

function canvas(size = SIZE) {
  const el = document.createElement('canvas');
  el.width = el.height = size;
  return el;
}

// Value noise, tileable, built by bilinear interpolation of a coarse lattice.
// Several octaves of it read as a surface rather than as television static.
function valueNoise(size, cells, seed = Math.random) {
  const grid = new Float32Array(cells * cells);
  for (let i = 0; i < grid.length; i++) grid[i] = seed();
  const out = new Float32Array(size * size);
  const step = cells / size;
  const smooth = (t) => t * t * (3 - 2 * t);
  for (let y = 0; y < size; y++) {
    const gy = y * step, y0 = Math.floor(gy), fy = smooth(gy - y0);
    for (let x = 0; x < size; x++) {
      const gx = x * step, x0 = Math.floor(gx), fx = smooth(gx - x0);
      const x1 = (x0 + 1) % cells, y1 = (y0 + 1) % cells;
      const a = grid[y0 * cells + x0], b = grid[y0 * cells + x1];
      const c = grid[y1 * cells + x0], d = grid[y1 * cells + x1];
      out[y * size + x] = (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
    }
  }
  return out;
}

function octaves(size, spec) {
  const out = new Float32Array(size * size);
  let total = 0;
  for (const [cells, weight] of spec) {
    const layer = valueNoise(size, cells);
    for (let i = 0; i < out.length; i++) out[i] += layer[i] * weight;
    total += weight;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

// Chippings: small hard grains scattered through the binder. Drawn as discs
// into the height field because that is what they are — lumps that catch light
// on one side, which a noise field alone never produces.
function scatterGrains(height, size, { count, radius, depth }) {
  for (let n = 0; n < count; n++) {
    const cx = Math.random() * size, cy = Math.random() * size;
    const r = radius * (0.5 + Math.random());
    const lift = depth * (0.4 + Math.random() * 0.6);
    const r2 = r * r;
    for (let y = Math.floor(cy - r); y <= cy + r; y++) {
      for (let x = Math.floor(cx - r); x <= cx + r; x++) {
        const d2 = (x - cx) ** 2 + (y - cy) ** 2;
        if (d2 > r2) continue;
        const i = ((y + size) % size) * size + ((x + size) % size);
        height[i] += lift * (1 - d2 / r2);
      }
    }
  }
}

// Sobel of the height field, written as a tangent-space normal map.
function normalMapFrom(height, size, strength) {
  const el = canvas(size);
  const ctx = el.getContext('2d');
  const image = ctx.createImageData(size, size);
  const d = image.data;
  const at = (x, y) => height[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      d[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      d[i + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
      d[i + 2] = (1 / len) * 255;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  const tex = new THREE.CanvasTexture(el);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

function greyTexture(size, values, colorSpace = null) {
  const el = canvas(size);
  const ctx = el.getContext('2d');
  const image = ctx.createImageData(size, size);
  const d = image.data;
  for (let i = 0; i < values.length; i++) {
    const v = Math.max(0, Math.min(255, Math.round(values[i] * 255)));
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
    d[i * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  const tex = new THREE.CanvasTexture(el);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  if (colorSpace) tex.colorSpace = colorSpace;
  return tex;
}

// How a surface is made, in the units the surface is actually made of.
const RECIPES = {
  // Hot-rolled asphalt: fine binder, hard chippings, a tar seam or two, and
  // patches where it has been cut open and filled again.
  asphalt: {
    tile: 6,
    base: [[4, 0.55], [16, 0.3], [64, 0.15]],
    grains: { count: 4800, radius: 1.5, depth: 0.32 },
    grainContrast: 0.13,
    patchCount: 4,
    patchContrast: 0.055,
    seams: 2,
    roughness: [0.97, 0.13],   // base, how much the grain smooths it
    normalStrength: 8,
  },
  // Poured concrete: flatter, paler, slab joints instead of seams.
  concrete: {
    tile: 5,
    base: [[6, 0.6], [24, 0.4]],
    grains: { count: 1400, radius: 1.4, depth: 0.2 },
    grainContrast: 0.09,
    patchCount: 3,
    patchContrast: 0.04,
    seams: 1,
    roughness: [0.94, 0.1],
    normalStrength: 6,
  },
  // Graded dirt: no binder at all, so the grain is the surface.
  dirt: {
    tile: 4,
    base: [[3, 0.5], [10, 0.32], [40, 0.18]],
    grains: { count: 2400, radius: 3.0, depth: 0.6 },
    grainContrast: 0.22,
    patchCount: 6,
    patchContrast: 0.1,
    seams: 0,
    roughness: [1, 0.06],
    normalStrength: 20,
  },
};

// The three maps a road surface needs, plus the size in metres they tile at.
// `map` modulates around white so the circuit keeps its own colour.
export function roadMaps(kind = 'asphalt') {
  const spec = RECIPES[kind] ?? RECIPES.asphalt;
  const size = SIZE;
  const height = octaves(size, spec.base);
  scatterGrains(height, size, spec.grains);

  // Patches and seams belong to the colour, not to the shape: a filled cut is
  // level with the road, it is just a different batch of tarmac.
  const patch = new Float32Array(size * size);
  const pel = canvas(size);
  const pc = pel.getContext('2d');
  pc.fillStyle = '#808080';
  pc.fillRect(0, 0, size, size);
  for (let i = 0; i < spec.patchCount; i++) {
    const x = Math.random() * size, y = Math.random() * size;
    const r = size * (0.08 + Math.random() * 0.16);
    const g = pc.createRadialGradient(x, y, 0, x, y, r);
    const dark = Math.random() < 0.5;
    g.addColorStop(0, dark ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.4)');
    g.addColorStop(1, 'rgba(128,128,128,0)');
    pc.fillStyle = g;
    pc.fillRect(x - r, y - r, r * 2, r * 2);
  }
  for (let i = 0; i < spec.seams; i++) {
    pc.strokeStyle = 'rgba(20,20,20,0.55)';
    pc.lineWidth = 2 + Math.random() * 2;
    pc.beginPath();
    const x = Math.random() * size;
    pc.moveTo(x, 0);
    pc.lineTo(x + (Math.random() - 0.5) * 40, size);
    pc.stroke();
  }
  const pdata = pc.getImageData(0, 0, size, size).data;
  for (let i = 0; i < patch.length; i++) patch[i] = pdata[i * 4] / 255 - 0.5;

  const albedo = new Float32Array(size * size);
  const rough = new Float32Array(size * size);
  for (let i = 0; i < albedo.length; i++) {
    const h = Math.min(1, Math.max(0, height[i]));
    albedo[i] = 1 + (h - 0.5) * spec.grainContrast + patch[i] * 2 * spec.patchContrast;
    rough[i] = spec.roughness[0] - h * spec.roughness[1];
  }

  return {
    tile: spec.tile,
    // Mean sits just under white so the circuit's own colour still drives the
    // hue: a map centred on mid grey would halve every road in the game.
    map: greyTexture(size, albedo.map((v) => v * 0.88), THREE.SRGBColorSpace),
    roughnessMap: greyTexture(size, rough),
    normalMap: normalMapFrom(height, size, spec.normalStrength),
  };
}

// Grass, gravel or sand for the verges and the outfield. Coarser and cheaper
// than the road: it is only ever seen from a car going past it.
export function terrainMaps(kind = 'grass') {
  const size = 256;
  const spec = kind === 'sand'
    ? { base: [[4, 0.6], [18, 0.4]], grains: { count: 900, radius: 2.4, depth: 0.35 }, contrast: 0.18 }
    : { base: [[6, 0.3], [18, 0.36], [48, 0.34]], grains: { count: 1600, radius: 2.2, depth: 0.32 }, contrast: 0.12 };
  const height = octaves(size, spec.base);
  scatterGrains(height, size, spec.grains);
  const albedo = new Float32Array(size * size);
  const rough = new Float32Array(size * size);
  for (let i = 0; i < albedo.length; i++) {
    const h = Math.min(1, Math.max(0, height[i]));
    albedo[i] = (1 + (h - 0.5) * spec.contrast) * 0.88;
    rough[i] = 1 - h * 0.1;
  }
  return {
    tile: kind === 'sand' ? 9 : 7,
    map: greyTexture(size, albedo, THREE.SRGBColorSpace),
    roughnessMap: greyTexture(size, rough),
    normalMap: normalMapFrom(height, size, 14),
  };
}

// A grid of windows, most of them dark. Only lit once the sun is off them, via
// the material's emissive intensity.
export function windowTexture() {
  const size = 128;
  const el = canvas(size);
  const c = el.getContext('2d');
  c.fillStyle = '#000000';
  c.fillRect(0, 0, size, size);
  const cols = 6, rows = 8;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (Math.random() < 0.45) continue;
      c.fillStyle = Math.random() < 0.25 ? '#ffd9a0' : '#ffeccb';
      c.fillRect(
        (x + 0.28) * (size / cols), (y + 0.24) * (size / rows),
        (size / cols) * 0.44, (size / rows) * 0.4,
      );
    }
  }
  const tex = new THREE.CanvasTexture(el);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// The painted face of a racing kerb: white and red bands with the paint worn
// thin where cars have been over it.
export function kerbTexture() {
  const w = 128, h = 128;
  const el = canvas(w);
  const c = el.getContext('2d');
  for (let i = 0; i < 2; i++) {
    c.fillStyle = i === 0 ? '#e9eef5' : '#c8352f';
    c.fillRect(0, (h / 2) * i, w, h / 2);
  }
  // Worn paint: the binder shows through in patches, heaviest on the edges.
  c.globalAlpha = 0.5;
  for (let i = 0; i < 260; i++) {
    const r = 1 + Math.random() * 4;
    c.fillStyle = Math.random() < 0.6 ? '#4a4a4c' : '#8d8d90';
    c.beginPath();
    c.arc(Math.random() * w, Math.random() * h, r, 0, Math.PI * 2);
    c.fill();
  }
  c.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(el);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Tyre tread: circumferential grooves with a block pattern cut across them.
// Applied around the carcass, so it is the tread that catches light on a
// wheel that is turning, not a smooth black cylinder.
export function treadMaps() {
  const size = 128;
  const el = canvas(size);
  const c = el.getContext('2d');
  c.fillStyle = '#2a2d33';
  c.fillRect(0, 0, size, size);
  // Grooves run around the tyre: vertical in this map, since v wraps the
  // circumference on a cylinder.
  c.fillStyle = '#0a0c10';
  for (const x of [0.16, 0.5, 0.84]) c.fillRect(x * size - 3, 0, 6, size);
  // Blocks across the shoulders.
  for (let i = 0; i < 16; i++) {
    c.fillRect(0, (i / 16) * size, size * 0.1, size * 0.03);
    c.fillRect(size * 0.9, ((i + 0.5) / 16) * size, size * 0.1, size * 0.03);
  }
  const map = new THREE.CanvasTexture(el);
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;
  map.repeat.set(1, 6);

  // The same pattern as height, so the grooves read as cut into the rubber.
  const height = new Float32Array(size * size);
  const d = c.getImageData(0, 0, size, size).data;
  for (let i = 0; i < height.length; i++) height[i] = d[i * 4] / 255;
  const normalMap = normalMapFrom(height, size, 10);
  normalMap.repeat.set(1, 6);
  return { map, normalMap };
}
