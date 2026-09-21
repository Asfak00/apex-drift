import * as THREE from 'three';
import { VISIONS, WEATHERS } from './config.js';

const SKY_VERT = `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const SKY_FRAG = `
  uniform vec3 uTop;
  uniform vec3 uHorizon;
  uniform float uStars;
  varying vec3 vDir;

  float hash(vec3 p) {
    return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  }
  void main() {
    float h = clamp(vDir.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 col = mix(uHorizon, uTop, pow(h, 0.7));
    if (uStars > 0.01 && vDir.y > 0.0) {
      vec3 cell = floor(vDir * 240.0);
      float s = step(0.9975, hash(cell));
      col += s * uStars * vDir.y;
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
        uStars: { value: 0 },
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

    this.skyMat.uniforms.uTop.value.setHex(v.sky);
    this.skyMat.uniforms.uHorizon.value.setHex(v.horizon);
    this.skyMat.uniforms.uStars.value = visionKey === 'night' ? 0.9 : visionKey === 'neon' ? 0.4 : 0;

    this.sun.color.setHex(v.sunColor);
    this.sun.intensity = v.sunI * w.lightScale;
    this.sun.position.set(...v.sun).multiplyScalar(300);
    this.sun.castShadow = w.fogScale > 0.4 && v.sunI > 0.5;

    this.hemi.color.setHex(v.ambient);
    this.hemi.intensity = v.ambI * w.lightScale;

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

    const snowy = weatherKey === 'snow';
    const tint = new THREE.Color(v.groundTint);
    this.track.groundMaterial.color.setHex(snowy ? 0xdfe9f2 : base.ground).lerp(tint, snowy ? 0 : 0.45);
    this.track.hillMaterial.color.setHex(snowy ? 0xcbd9e6 : base.hills).lerp(tint, snowy ? 0 : 0.4);
    // Windows and street lamps only carry light once the sun is off them.
    const lit = v.lights ? 1 : 0;
    if (this.track.buildingMaterial) {
      this.track.buildingMaterial.emissiveIntensity = lit * (0.9 + (1 - w.lightScale) * 0.5);
    }
    if (this.track.lampMaterial) {
      this.track.lampMaterial.emissiveIntensity = lit ? 2.6 : 0.25;
    }
    this.track.pylonMaterial.emissiveIntensity = v.lights ? 2.6 : 0.8;
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
    this.scene.environmentIntensity = 0.55 + this.weather.lightScale * 0.45;
  }

  update(dt, camera, clock) {
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
