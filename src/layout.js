import * as THREE from 'three';

// A circuit can be written as a driving script instead of a set of control
// points: go straight for 140 m, turn right 90 degrees on a 34 m radius, and so
// on. Straights come out dead straight and corners come out at a true constant
// radius, which is what makes a town read as streets rather than as a racing
// loop that happens to be square.
//
//   ['straight', metres]
//   ['right' | 'left', degrees, radius]
//   ['cross']                  crossroads at the cursor, both sides
//   ['tee', 'left' | 'right']  side road leaving one side
//
// Heading is measured the same way the cars measure yaw: 0 points down +Z, and
// a right turn increases it.

const SAMPLE_STEP = 3.5;   // metres between centreline samples

const forward = (h) => new THREE.Vector3(Math.sin(h), 0, Math.cos(h));

export function buildLayout(segments) {
  const points = [];
  const tangents = [];
  const junctions = [];
  let x = 0, z = 0, heading = 0;

  const emit = () => {
    points.push(new THREE.Vector3(x, 0, z));
    tangents.push(forward(heading));
  };

  for (const [kind, a, b] of segments) {
    if (kind === 'cross' || kind === 'tee') {
      junctions.push({
        position: new THREE.Vector3(x, 0, z),
        heading,
        sides: kind === 'cross' ? [-1, 1] : [a === 'left' ? -1 : 1],
        index: points.length,
      });
      continue;
    }

    if (kind === 'straight') {
      const steps = Math.max(1, Math.round(a / SAMPLE_STEP));
      const run = a / steps;
      for (let i = 0; i < steps; i++) {
        emit();
        x += Math.sin(heading) * run;
        z += Math.cos(heading) * run;
      }
      continue;
    }

    // Corner: walk the arc in equal chords so the radius stays constant.
    const dir = kind === 'right' ? 1 : -1;
    const sweep = (a * Math.PI) / 180;
    const radius = b;
    const steps = Math.max(2, Math.round((radius * sweep) / SAMPLE_STEP));
    const dTheta = (dir * sweep) / steps;
    const chord = 2 * radius * Math.sin(Math.abs(dTheta) / 2);
    for (let i = 0; i < steps; i++) {
      emit();
      const mid = heading + dTheta / 2;
      x += Math.sin(mid) * chord;
      z += Math.cos(mid) * chord;
      heading += dTheta;
    }
  }

  // A circuit has to come back to where it started. Report the error rather
  // than silently shipping a track with a step in it.
  const gap = Math.hypot(x - points[0].x, z - points[0].z);
  const turn = Math.abs(((heading / (Math.PI * 2)) % 1 + 1) % 1);
  const closed = gap < 6 && (turn < 0.02 || turn > 0.98);

  return { points, tangents, junctions, closure: { gap, heading, closed } };
}

// Centre the layout on the origin so every circuit sits in the same place.
export function centre(layout) {
  const box = new THREE.Box3().setFromPoints(layout.points);
  const mid = box.getCenter(new THREE.Vector3());
  mid.y = 0;
  for (const p of layout.points) p.sub(mid);
  for (const j of layout.junctions) j.position.sub(mid);
  return layout;
}

// One centreline sampler for both kinds of circuit. The track builds geometry
// from it; the menu draws circuit thumbnails from it. Neither needs to know
// which kind of description it came from.
export function sampleCentreline(spec, count) {
  if (!spec.segments) {
    const curve = new THREE.CatmullRomCurve3(
      spec.points.map(([x, z]) => new THREE.Vector3(x, 0, z)),
      true, 'catmullrom', 0.5,
    );
    const points = [], tangents = [];
    for (let i = 0; i < count; i++) {
      const t = i / count;
      points.push(curve.getPointAt(t));
      tangents.push(curve.getTangentAt(t).setY(0).normalize());
    }
    return { points, tangents, junctions: [] };
  }

  const layout = centre(buildLayout(spec.segments));
  const raw = layout.points;
  const n = raw.length;
  const runs = [0];
  for (let i = 1; i <= n; i++) runs.push(runs[i - 1] + raw[i % n].distanceTo(raw[i - 1]));
  const total = runs[n];

  const points = [], tangents = [];
  let cursor = 0;
  for (let i = 0; i < count; i++) {
    const target = (i / count) * total;
    while (cursor < n - 1 && runs[cursor + 1] < target) cursor += 1;
    const span = runs[cursor + 1] - runs[cursor];
    const k = span > 1e-6 ? (target - runs[cursor]) / span : 0;
    points.push(raw[cursor].clone().lerp(raw[(cursor + 1) % n], k));
    tangents.push(
      layout.tangents[cursor].clone()
        .lerp(layout.tangents[(cursor + 1) % n], k).setY(0).normalize(),
    );
  }
  return { points, tangents, junctions: layout.junctions, closure: layout.closure };
}
