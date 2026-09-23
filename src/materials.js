import * as THREE from 'three';

// Every vehicle material in the game comes from here, so paint on a bus and
// paint on a hypercar obey the same rules and one change reaches all of them.
// Values follow what the surface is: metals are metallic, paint is a metallic
// base under a clear coat, glass and rubber are dielectric. Nothing is made
// shinier than the real thing to look expensive.

// Procedural detail maps are made once and shared.
let flakeMap = null;
let weaveMap = null;

// Metallic paint's sparkle: millions of tiny flakes, each tilted its own way.
// A fine random normal map under a smooth clear coat is exactly that: the base
// layer glitters, the lacquer over it stays a mirror.
function flakes() {
  if (flakeMap) return flakeMap;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const c = canvas.getContext('2d');
  const img = c.createImageData(size, size);
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < size * size; i++) {
    const nx = (rand() - 0.5) * 0.9, ny = (rand() - 0.5) * 0.9;
    const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
    img.data[i * 4] = (nx * 0.5 + 0.5) * 255;
    img.data[i * 4 + 1] = (ny * 0.5 + 0.5) * 255;
    img.data[i * 4 + 2] = nz * 255;
    img.data[i * 4 + 3] = 255;
  }
  c.putImageData(img, 0, 0);
  flakeMap = new THREE.CanvasTexture(canvas);
  flakeMap.wrapS = flakeMap.wrapT = THREE.RepeatWrapping;
  flakeMap.repeat.set(24, 24);
  flakeMap.colorSpace = THREE.NoColorSpace;
  return flakeMap;
}

// A 2x2 twill weave as a normal map: tows running alternately along and
// across, each one domed. Small and repeated many times, it reads as carbon
// fibre under the lacquer rather than a checkerboard.
function weave() {
  if (weaveMap) return weaveMap;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const c = canvas.getContext('2d');
  const img = c.createImageData(size, size);
  const tow = size / 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cell = (Math.floor(x / tow) + Math.floor(y / tow)) % 4;
      const along = cell < 2;
      const f = along ? (y % tow) / tow : (x % tow) / tow;
      const slope = Math.cos(f * Math.PI) * 0.45;
      const nx = along ? 0 : slope, ny = along ? slope : 0;
      const nz = Math.sqrt(1 - nx * nx - ny * ny);
      const i = (y * size + x) * 4;
      img.data[i] = (nx * 0.5 + 0.5) * 255;
      img.data[i + 1] = (ny * 0.5 + 0.5) * 255;
      img.data[i + 2] = nz * 255;
      img.data[i + 3] = 255;
    }
  }
  c.putImageData(img, 0, 0);
  weaveMap = new THREE.CanvasTexture(canvas);
  weaveMap.wrapS = weaveMap.wrapT = THREE.RepeatWrapping;
  weaveMap.repeat.set(10, 10);
  weaveMap.colorSpace = THREE.NoColorSpace;
  return weaveMap;
}

export const Materials = {
  // Metallic base coat under a clear coat. `map` carries the livery.
  carPaint({ color = 0xffffff, map = null, metallic = true } = {}) {
    return new THREE.MeshPhysicalMaterial({
      color: map ? 0xffffff : color, map,
      metalness: metallic ? 0.62 : 0.05, roughness: metallic ? 0.34 : 0.4,
      normalMap: metallic ? flakes() : null,
      normalScale: new THREE.Vector2(0.18, 0.18),
      clearcoat: 1, clearcoatRoughness: 0.04, envMapIntensity: 1.3,
    });
  },

  // Flat, non-metallic paint for utility bodies and painted metal parts.
  paintedMetal(color, roughness = 0.45) {
    return new THREE.MeshPhysicalMaterial({
      color, metalness: 0.15, roughness, clearcoat: 0.35, clearcoatRoughness: 0.3,
    });
  },

  carbon() {
    return new THREE.MeshPhysicalMaterial({
      color: 0x15181d, metalness: 0.25, roughness: 0.38,
      normalMap: weave(), normalScale: new THREE.Vector2(0.35, 0.35),
      clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 1.1,
    });
  },

  // Glass is a dielectric: almost clear face-on, a mirror at a glance, which
  // is what Fresnel does with an index of refraction of 1.5.
  glass(tint = 0x0e1a26, opacity = 0.72) {
    return new THREE.MeshPhysicalMaterial({
      color: tint, metalness: 0, roughness: 0.03, ior: 1.52, specularIntensity: 1,
      transparent: true, opacity, envMapIntensity: 1.8,
    });
  },

  lens(color, emissive, intensity) {
    return new THREE.MeshStandardMaterial({
      color, emissive, emissiveIntensity: intensity, metalness: 0.1, roughness: 0.12,
    });
  },

  trim() {
    return new THREE.MeshStandardMaterial({ color: 0x12161d, roughness: 0.6, metalness: 0.1 });
  },

  chrome() {
    return new THREE.MeshStandardMaterial({
      color: 0xc7ced8, metalness: 1, roughness: 0.1, envMapIntensity: 1.7,
    });
  },

  brushedMetal(color = 0x9aa3ad) {
    return new THREE.MeshStandardMaterial({ color, metalness: 1, roughness: 0.38 });
  },

  rim() {
    return new THREE.MeshStandardMaterial({
      color: 0xc2ccd8, metalness: 1, roughness: 0.2, envMapIntensity: 1.6,
    });
  },

  rubber(map = null, normalMap = null) {
    return new THREE.MeshStandardMaterial({
      color: 0x24272d, roughness: 0.92, metalness: 0,
      map, normalMap, normalScale: new THREE.Vector2(0.9, 0.9),
    });
  },

  // Iron discs darkened by pad dust; they glow when hot (see Car).
  brakeDisc() {
    return new THREE.MeshStandardMaterial({
      color: 0x3a3f46, metalness: 0.85, roughness: 0.5,
      emissive: 0xff3a10, emissiveIntensity: 0,
    });
  },

  caliper(color = 0xb4321f) {
    return new THREE.MeshPhysicalMaterial({
      color, metalness: 0.2, roughness: 0.42, clearcoat: 0.5, clearcoatRoughness: 0.25,
    });
  },

  plastic(color = 0x1a1d22, roughness = 0.55) {
    return new THREE.MeshStandardMaterial({ color, roughness, metalness: 0 });
  },

  // Rider kit: a textile suit with a slight sheen, leather gloves and boots.
  fabric(color) {
    return new THREE.MeshPhysicalMaterial({
      color, roughness: 0.78, metalness: 0, sheen: 0.6, sheenRoughness: 0.5,
      sheenColor: new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.4),
    });
  },

  leather(color = 0x15171b) {
    return new THREE.MeshPhysicalMaterial({
      color, roughness: 0.55, metalness: 0, clearcoat: 0.2, clearcoatRoughness: 0.5,
    });
  },

  archLiner() {
    return new THREE.MeshStandardMaterial({ color: 0x07090c, roughness: 1, side: THREE.BackSide });
  },
};
