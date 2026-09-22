import * as THREE from 'three';
import { VISIONS, WEATHERS } from './config.js';

const SKY_VERT = `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

// Sky, in the order the eye reads it: a gradient from the zenith down through
// the haze that collects at the horizon, the sun and the glow around it, a
// layer of cloud that thins overhead and stacks up at the horizon, and stars.
// All of it is driven by the same sun direction the scene is lit by, so the
// bright part of the sky is the part the shadows point away from.
const SKY_FRAG = `
  uniform vec3 uTop;
  uniform vec3 uHorizon;
  uniform vec3 uSunColor;
  uniform vec3 uSunDir;
  uniform float uStars;
  uniform float uClouds;
  uniform float uHaze;
  uniform float uTime;
  varying vec3 vDir;

  float hash(vec3 p) {
    return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  }

  float noise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = hash(i);
    float n100 = hash(i + vec3(1.0, 0.0, 0.0));
    float n010 = hash(i + vec3(0.0, 1.0, 0.0));
    float n110 = hash(i + vec3(1.0, 1.0, 0.0));
    float n001 = hash(i + vec3(0.0, 0.0, 1.0));
    float n101 = hash(i + vec3(1.0, 0.0, 1.0));
    float n011 = hash(i + vec3(0.0, 1.0, 1.0));
    float n111 = hash(i + vec3(1.0, 1.0, 1.0));
    return mix(
      mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
      mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
  }

  float fbm(vec3 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.02; a *= 0.5; }
    return v;
  }

  void main() {
    vec3 dir = normalize(vDir);
    float up = clamp(dir.y, -1.0, 1.0);
    float h = clamp(up * 0.5 + 0.5, 0.0, 1.0);
    vec3 col = mix(uHorizon, uTop, pow(h, 0.62));

    // Haze thickens toward the horizon along the line of sight.
    float band = pow(1.0 - clamp(abs(up) * 1.6, 0.0, 1.0), 3.0);
    col = mix(col, uHorizon, band * uHaze);

    // Sun: a hard disc inside a wide glow, warmed toward the horizon.
    float toSun = max(dot(dir, normalize(uSunDir)), 0.0);
    col += uSunColor * pow(toSun, 900.0) * 6.0;
    col += uSunColor * pow(toSun, 9.0) * 0.30;
    col += uSunColor * pow(toSun, 2.2) * 0.07;

    if (uStars > 0.001 && up > 0.0) {
      vec3 cell = floor(dir * 260.0);
      float s = step(0.9976, hash(cell));
      col += s * uStars * up * (0.6 + 0.4 * hash(cell + 3.0));
    }

    if (uClouds > 0.001 && up > 0.005) {
      // Flattened dome: the same cloud deck seen at a shallower angle near the
      // horizon, which is what stacks it up into a bank there. The lattice has
      // to be several cells across the visible sky or the whole deck lands
      // inside one cell and comes out a flat wash.
      vec3 p = dir / max(up, 0.05);
      // The deck drifts, slowly. It is the only thing moving in an empty sky,
      // and without it a still frame of the menu looks like a photograph.
      float deck = fbm(p * 3.2 + vec3(uTime * 0.012, 0.0, uTime * 0.005));
      // More cover pulls the threshold down, so an overcast sky closes up
      // rather than growing brighter patches.
      float cover = smoothstep(0.62 - uClouds * 0.34, 0.86 - uClouds * 0.3, deck);
      cover *= smoothstep(0.0, 0.1, up) * min(1.0, uClouds * 1.35);
      // Lit on top and on the sun side, dark underneath — and a heavy deck is
      // darker than a few fair-weather clouds.
      float heavy = smoothstep(0.35, 0.95, uClouds);
      vec3 lit = mix(uHorizon * 0.95, uSunColor, 0.3) + uSunColor * pow(toSun, 3.0) * 0.35;
      vec3 shade = mix(uHorizon, uTop, 0.35) * mix(0.68, 0.3, heavy);
      col = mix(col, mix(shade, lit, clamp(deck * 1.2 - 0.15, 0.0, 1.0)), cover);
    }

    gl_FragColor = vec4(col, 1.0);
  }`;

// One field of falling particles, reused for rain and snow by swapping geometry.
class Precipitation {
  constructor(scene) {
    this.scene = scene;
    this.area = new THREE.Vector3(180, 90, 180);
    this.kind = null;
    this.object = null;
  }

  build(kind, count) {
    this.dispose();
    if (!kind || count === 0) { this.kind = null; return; }

    this.count = count;
    this.origins = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      this.origins[i * 3]     = (Math.random() - 0.5) * this.area.x;
      this.origins[i * 3 + 1] = Math.random() * this.area.y;
      this.origins[i * 3 + 2] = (Math.random() - 0.5) * this.area.z;
    }

    if (kind === 'rain') {
      // Two vertices per drop so each one renders as a motion streak.
      const pos = new Float32Array(count * 6);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      this.object = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
        color: 0xaec8e8, transparent: true, opacity: 0.42,
      }));
      this.fallSpeed = 58;
      this.streak = 1.7;
    } else {
      const pos = new Float32Array(count * 3);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      this.object = new THREE.Points(geo, new THREE.PointsMaterial({
        color: 0xf2f7ff, size: 0.42, transparent: true, opacity: 0.8,
        sizeAttenuation: true, depthWrite: false,
      }));
      this.fallSpeed = 7;
      this.streak = 0;
    }
    this.object.frustumCulled = false;
    this.kind = kind;
    this.time = 0;
    this.scene.add(this.object);
  }

  // The field rides with the camera and wraps, so it never runs out.
  update(dt, camera, wind) {
    if (!this.object) return;
    this.time += dt;
    const arr = this.object.geometry.attributes.position.array;
    const { x: ax, y: ay, z: az } = this.area;
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    const drift = wind * 26;

    for (let i = 0; i < this.count; i++) {
      const o = i * 3;
      let px = this.origins[o];
      let py = this.origins[o + 1] - this.fallSpeed * this.time;
      let pz = this.origins[o + 2];

      py = ((py % ay) + ay) % ay;
      const sway = this.kind === 'snow'
        ? Math.sin(this.time * 0.9 + i) * 1.8
        : 0;
      px += drift * (py / ay) + sway;
      pz += drift * 0.35 * (py / ay);

      const wx = cx + (((px % ax) + ax * 1.5) % ax) - ax / 2;
      const wz = cz + (((pz % az) + az * 1.5) % az) - az / 2;
      const wy = cy - 12 + py;

      if (this.streak) {
        const v = i * 6;
        arr[v] = wx;     arr[v + 1] = wy;                 arr[v + 2] = wz;
        arr[v + 3] = wx + wind * this.streak;
        arr[v + 4] = wy - this.streak * 2.4;
        arr[v + 5] = wz;
      } else {
        arr[o] = wx; arr[o + 1] = wy; arr[o + 2] = wz;
      }
    }
    this.object.geometry.attributes.position.needsUpdate = true;
  }

  dispose() {
    if (!this.object) return;
    this.scene.remove(this.object);
    this.object.geometry.dispose();
    this.object.material.dispose();
    this.object = null;
  }
}

export class Environment {
  constructor(scene, renderer, track) {
    this.scene = scene;
    this.renderer = renderer;
    this.track = track;

    this.skyMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false,
      uniforms: {
        uTop: { value: new THREE.Color(0x87b6e8) },
        uHorizon: { value: new THREE.Color(0xd8e6f4) },
        uSunColor: { value: new THREE.Color(0xfff4e0) },
        uSunDir: { value: new THREE.Vector3(0.45, 0.85, 0.3) },
        uStars: { value: 0 },
        uClouds: { value: 0.25 },
        uHaze: { value: 0.5 },
        uTime: { value: 0 },
      },
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1400, 24, 16), this.skyMat);
    this.sky.frustumCulled = false;
    scene.add(this.sky);

    this.sun = new THREE.DirectionalLight(0xffffff, 2.4);
    this.sun.castShadow = true;
    // A tight, high-resolution shadow frustum around the action is what makes
    // the cars sit on the road instead of hovering over it.
    this.sun.shadow.mapSize.setScalar(
      matchMedia('(pointer: coarse)').matches ? 1024 : 2048);
    this.sun.shadow.camera.near = 20;
    this.sun.shadow.camera.far = 520;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.6;
    const c = this.sun.shadow.camera;
    c.left = -95; c.right = 95; c.top = 95; c.bottom = -95;
    c.updateProjectionMatrix();
    scene.add(this.sun, this.sun.target);

    this.hemi = new THREE.HemisphereLight(0xc8dcf0, 0x30402e, 1.0);
    scene.add(this.hemi);

    scene.fog = new THREE.Fog(0xbcd4ec, 120, 620);
    this.precip = new Precipitation(scene);

    // Paint and chrome need something to reflect. The sky is rendered into a
    // prefiltered probe whenever the conditions change, which is what stops the
    // cars reading as flat blocks.
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileEquirectangularShader();
    this.envScene = new THREE.Scene();
    this.envScene.add(new THREE.Mesh(new THREE.SphereGeometry(12, 24, 16), this.skyMat));

    // One dial for everything that scales with how much the device can spend.
    this.quality = matchMedia('(pointer: coarse)').matches ? 0.4 : 1;
    this.flash = 0;
    this.nextStrike = 4 + Math.random() * 8;
    this.visionKey = 'day';
    this.weatherKey = 'clear';
  }

  // Circuits are swapped between races; the environment re-tints the new one.
  setTrack(track) {
    this.track = track;
    this.apply(this.visionKey, this.weatherKey);
  }

  get vision() { return VISIONS[this.visionKey]; }
  get weather() { return WEATHERS[this.weatherKey]; }
  get grip() { return this.weather.grip; }

  apply(visionKey, weatherKey) {
    this.visionKey = visionKey;
    this.weatherKey = weatherKey;
    const v = VISIONS[visionKey];
    const w = WEATHERS[weatherKey];

    // Weather takes the light out of the sky itself, not only out of the sun:
    // a storm over a bright blue dome reads as rain on a sunny day.
    const gloom = 0.42 + 0.58 * w.lightScale;
    this.skyMat.uniforms.uTop.value.setHex(v.sky).multiplyScalar(gloom);
    this.skyMat.uniforms.uHorizon.value.setHex(v.horizon).multiplyScalar(gloom);
    this.skyMat.uniforms.uSunColor.value.setHex(v.sunColor);
    this.skyMat.uniforms.uSunDir.value.set(...v.sun).normalize();
    this.skyMat.uniforms.uStars.value = visionKey === 'night' ? 0.9 : visionKey === 'neon' ? 0.4 : 0;
    // Weather is what the sky is made of: cloud cover and how far the haze
    // reaches are the same numbers that set the fog and the light.
    this.skyMat.uniforms.uClouds.value = Math.min(1, (v.clouds ?? 0.22) + (1 - w.fogScale) * 0.9);
    this.skyMat.uniforms.uHaze.value = Math.min(1, 0.35 + (1 - w.fogScale) * 0.65);

    this.sun.color.setHex(v.sunColor);
    this.sun.intensity = v.sunI * w.lightScale;
    this.sun.position.set(...v.sun).multiplyScalar(300);
    this.sun.castShadow = w.fogScale > 0.4 && v.sunI > 0.5;

    this.hemi.color.setHex(v.ambient);
    // A night circuit is lit — by floodlights, by the city behind it, by the
    // cars themselves. Whatever the numbers say, the ambient never falls below
    // what it takes to see the road: an unlit track is not atmosphere, it is a
    // driver who cannot see where the corner goes.
    const floor = v.lights ? 0.46 : 0.1;
    this.hemi.intensity = Math.max(v.ambI * w.lightScale, floor);

    // Weather compresses the fog band that the vision established.
    this.scene.fog.color.setHex(v.fog);
    this.scene.fog.near = v.fogNear * w.fogScale;
    this.scene.fog.far = v.fogFar * w.fogScale;
    this.renderer.toneMappingExposure = v.exposure;

    // Wet surfaces go darker and glossier; snow lightens the verges. Each
    // circuit keeps its own base colours and the vision only tints them, so a
    // dirt road still reads as dirt at night.
    const base = this.track.baseColors;
    const dirt = this.track.spec.surface === 'dirt';
    const road = this.track.roadMaterial;
    road.roughness = (dirt ? 1 : 0.92) - w.wet * (dirt ? 0.35 : 0.62);
    road.metalness = (dirt ? 0 : 0.02) + w.wet * (dirt ? 0.18 : 0.42);
    road.color.setHex(base.road).multiplyScalar(1 - w.wet * 0.3);
    // A dry road takes almost nothing from the sky; a wet one is a mirror of
    // it. This is what makes rain read as water rather than as a dark tint.
    road.envMapIntensity = 0.25 + w.wet * 1.5;
    // Standing water fills the texture of the surface, so the aggregate stops
    // showing through as the road gets wetter. Without this the reflection
    // breaks up into sparkle on every chipping.
    road.normalScale?.setScalar((dirt ? 1.1 : 0.7) * (1 - w.wet * 0.78));
    if (this.track.edgeMaterial) this.track.edgeMaterial.roughness = 0.72 - w.wet * 0.45;

    const snowy = weatherKey === 'snow';
    const tint = new THREE.Color(v.groundTint);
    // How far the time of day is allowed to push the ground's colour. A green
    // tint belongs on a grass verge; on desert dirt or a rock cutting it turns
    // the whole outfield olive, so those keep almost all of their own colour.
    const arid = this.track.spec.surface === 'dirt' || this.track.spec.scenery === 'canyon';
    const mix = arid ? 0.14 : 0.45;
    this.track.groundMaterial.color.setHex(snowy ? 0xdfe9f2 : base.ground)
      .lerp(tint, snowy ? 0 : mix);
    this.track.hillMaterial.color.setHex(snowy ? 0xcbd9e6 : base.hills)
      .lerp(tint, snowy ? 0 : mix * 0.9);
    // Windows and street lamps only carry light once the sun is off them.
    const lit = v.lights ? 1 : 0;
    if (this.track.buildingMaterial) {
      this.track.buildingMaterial.emissiveIntensity = lit * (0.9 + (1 - w.lightScale) * 0.5);
    }
    if (this.track.lampMaterial) {
      this.track.lampMaterial.emissiveIntensity = lit ? 2.6 : 0.25;
    }
    this.track.pylonMaterial.emissiveIntensity = v.lights ? 2.6 : 0.8;
    if (this.track.signMaterial) {
      this.track.signMaterial.emissiveIntensity = v.lights ? 1.4 : 0.35;
    }
    if (this.track.floodMaterial) {
      this.track.floodMaterial.emissiveIntensity = v.lights ? 3.4 : 1.6;
    }
    if (this.track.barrierMaterial) {
      this.track.barrierMaterial.emissiveIntensity = v.lights ? 1.2 : 0.25;
    }

    this.precip.build(w.particle, Math.round(w.count * this.quality));
    this.lightsOn = v.lights || w.fogScale < 0.45;
    this.#refreshProbe();
  }

  // Rebuilt only when the sky itself changes, never per frame.
  #refreshProbe() {
    this.probe?.dispose();
    this.probe = this.pmrem.fromScene(this.envScene, 0, 0.1, 60);
    this.scene.environment = this.probe.texture;
    // The sky probe is the only thing lighting surfaces that face away from
    // the sun, so it keeps a floor as well.
    this.scene.environmentIntensity = Math.max(0.42, 0.55 + this.weather.lightScale * 0.45);
  }

  update(dt, camera, clock) {
    this.skyMat.uniforms.uTime.value += dt;
    this.sky.position.copy(camera.position);
    this.sun.target.position.copy(camera.position);
    this.sun.position.copy(camera.position).add(
      new THREE.Vector3(...this.vision.sun).multiplyScalar(300),
    );
    this.precip.update(dt, camera, this.weather.wind);

    if (this.weather.lightning) {
      this.nextStrike -= dt;
      if (this.nextStrike <= 0) {
        this.flash = 1;
        this.nextStrike = 3.5 + Math.random() * 9;
      }
      if (this.flash >= 1) this.onStrike?.();
      if (this.flash > 0) {
        this.flash = Math.max(0, this.flash - dt * 3.4);
        const pulse = this.flash * this.flash;
        this.hemi.intensity = this.vision.ambI * this.weather.lightScale + pulse * 3.2;
        this.scene.fog.color.lerpColors(
          new THREE.Color(this.vision.fog), new THREE.Color(0xdfe9ff), pulse * 0.8,
        );
      }
    }
  }
}
