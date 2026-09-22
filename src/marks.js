import * as THREE from 'three';

// Rubber left on the road. One mesh for the whole circuit, written into as a
// ring buffer: a sliding tyre appends a quad between where it was and where it
// is, and the oldest quad in the pool is the one that gets reused. Marks do not
// fade, because rubber does not fade over the course of a race — it is simply
// overwritten by the next car to put some down in the same place.
//
// This is a decal on the road, so it draws after the road, writes no depth, and
// is pulled toward the camera in depth rather than lifted off the surface: a
// mark that floats a centimetre above the asphalt shows daylight underneath it
// at a shallow angle, which is exactly the angle a racing camera looks from.
const QUADS = 1600;

export class Marks {
  constructor(scene, { capacity = QUADS } = {}) {
    this.capacity = capacity;
    this.cursor = 0;
    this.used = 0;

    this.positions = new Float32Array(capacity * 4 * 3);
    this.colors = new Float32Array(capacity * 4 * 4);
    const index = new Uint32Array(capacity * 6);
    for (let q = 0; q < capacity; q++) {
      const v = q * 4, i = q * 6;
      index[i] = v; index[i + 1] = v + 1; index[i + 2] = v + 2;
      index[i + 3] = v; index[i + 4] = v + 2; index[i + 5] = v + 3;
    }

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 4));
    this.geometry.setIndex(new THREE.BufferAttribute(index, 1));
    this.geometry.setDrawRange(0, 0);
    // The pool is spread over the whole circuit, so per-object culling would
    // have to cull all of it or none of it. None of it, then.
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);

    this.material = new THREE.MeshBasicMaterial({
      transparent: true, vertexColors: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;          // after the road, before anything above it
    this.mesh.name = 'tyre-marks';
    scene.add(this.mesh);

    // Where each emitter last put rubber down, keyed by car and wheel.
    this.last = new Map();
    this.tint = new THREE.Color(0x0b0c0f);
  }

  // Surface decides what a sliding tyre leaves: black rubber on asphalt, a
  // paler scuff on concrete, a dark smear in dirt.
  setSurface(spec) {
    const bySurface = { asphalt: 0x0b0c0f, concrete: 0x2a2b2e, dirt: 0x3a2a18 };
    this.tint.setHex(bySurface[spec?.surface] ?? 0x0b0c0f);
  }

  // Lay rubber from an emitter's previous point to this one. `width` is the
  // tyre's contact width and `strength` how hard it is sliding, which is what
  // the mark's opacity is.
  lay(key, point, across, width, strength) {
    const prev = this.last.get(key);
    if (!prev) {
      this.last.set(key, point.clone());
      return;
    }
    const step = prev.distanceTo(point);
    if (step < 0.35) return;             // one quad every third of a metre
    if (step > 12) { prev.copy(point); return; }   // teleported: start again

    const half = width / 2;
    const q = this.cursor;
    const v = q * 4 * 3;
    const p = this.positions;
    p[v]      = prev.x - across.x * half; p[v + 1]  = prev.y; p[v + 2]  = prev.z - across.z * half;
    p[v + 3]  = prev.x + across.x * half; p[v + 4]  = prev.y; p[v + 5]  = prev.z + across.z * half;
    p[v + 6]  = point.x + across.x * half; p[v + 7] = point.y; p[v + 8] = point.z + across.z * half;
    p[v + 9]  = point.x - across.x * half; p[v + 10] = point.y; p[v + 11] = point.z - across.z * half;

    const alpha = Math.min(0.72, 0.18 + strength * 0.5);
    const c = this.colors;
    for (let k = 0; k < 4; k++) {
      const o = q * 16 + k * 4;
      c[o] = this.tint.r; c[o + 1] = this.tint.g; c[o + 2] = this.tint.b; c[o + 3] = alpha;
    }

    prev.copy(point);
    this.cursor = (this.cursor + 1) % this.capacity;
    this.used = Math.min(this.capacity, this.used + 1);
    this.geometry.setDrawRange(0, this.used * 6);
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.color.needsUpdate = true;
  }

  // A car that has stopped sliding should not join its next mark to its last
  // one across half the circuit.
  release(key) {
    this.last.delete(key);
  }

  clear() {
    this.cursor = 0;
    this.used = 0;
    this.last.clear();
    this.geometry.setDrawRange(0, 0);
  }

  dispose(scene) {
    scene.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
  }
}
