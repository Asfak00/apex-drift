import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { PUDDLE_GLSL, REFLECT_LAYER } from './track-condition.js';

// Screen-space passes that need to know how far away each pixel is: wet-road
// reflections, light scattered by rain and fog, sun shafts, and a camera that
// adapts its exposure. They read the depth the scene pass resolved, which the
// tap below hands round for the rest of the frame.

const VERT = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

// View-space position from a depth sample, shared by every pass here.
const DEPTH_GLSL = `
  #include <packing>
  uniform mat4 uInvProj;
  uniform float uNear;
  uniform float uFar;
  vec3 viewPosAt(vec2 uv, float depth) {
    vec4 v = uInvProj * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    return v.xyz / v.w;
  }
  float viewZAt(float depth) { return perspectiveDepthToViewZ(depth, uNear, uFar); }`;

function depthUniforms() {
  return {
    uInvProj: { value: new THREE.Matrix4() },
    uNear: { value: 0.5 },
    uFar: { value: 2200 },
  };
}

function syncCamera(uniforms, camera) {
  uniforms.uInvProj.value.copy(camera.projectionMatrixInverse);
  uniforms.uNear.value = camera.near;
  uniforms.uFar.value = camera.far;
}

// --- tap ---------------------------------------------------------------------
// Runs straight after the scene pass. Keeps a handle on the buffer that holds
// the frame's colour and depth, and stops every later render call this frame
// (the AO normals, the reflection mask) from drawing the shadow maps again.
export class ScreenTap extends Pass {
  constructor(renderer) {
    super();
    this.needsSwap = false;
    this.renderer = renderer;
    this.depth = null;
    this.color = null;
  }

  render(renderer, writeBuffer, readBuffer) {
    this.depth = readBuffer.depthTexture;
    this.color = readBuffer.texture;
    renderer.shadowMap.autoUpdate = false;
  }

  // Called once the composer is done with the frame.
  release() { this.renderer.shadowMap.autoUpdate = true; }
}

// --- wet-road reflections ------------------------------------------------------
// The road is drawn once more, into a small mask: its view-space normal, how
// reflective it is (wet surface, and puddles most of all), and its own depth,
// so a pixel where a car stands on the road is known not to be road. Each
// road pixel then marches its reflected ray through the depth buffer and
// takes the colour of what it hits. Rough wet asphalt smears the reflection
// down the screen, the way lights stretch across a wet road; a puddle is a
// sharp mirror. Where the ray finds nothing the sky probe the road already
// reflects is left alone.
const MASK_VERT = `
  attribute vec4 aRubber;
  varying vec3 vViewPos;
  varying vec3 vViewNormal;
  varying vec2 vWaterXZ;
  varying vec4 vRubber;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWaterXZ = world.xz;
    vRubber = aRubber;
    vec4 view = viewMatrix * world;
    vViewPos = view.xyz;
    vViewNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * view;
  }`;

const MASK_FRAG = `
  uniform float uStanding;
  uniform float uWet;
  varying vec3 vViewPos;
  varying vec3 vViewNormal;
  varying vec2 vWaterXZ;
  varying vec4 vRubber;
  ${PUDDLE_GLSL}
  void main() {
    float puddle = puddleAt(vWaterXZ, vRubber.x, vRubber.w, uStanding);
    float reflective = clamp(uWet * 0.5 + puddle * 0.9, 0.0, 1.0);
    vec3 n = normalize(vViewNormal);
    gl_FragColor = vec4(n.xy * 0.5 + 0.5, reflective, -vViewPos.z);
  }`;

const SSR_FRAG = `
  uniform sampler2D tColor;
  uniform sampler2D tDepth;
  uniform sampler2D tMask;
  uniform mat4 uProj;
  uniform float uStrength;
  varying vec2 vUv;
  ${DEPTH_GLSL}

  vec2 project(vec3 p) {
    vec4 c = uProj * vec4(p, 1.0);
    return c.xy / c.w * 0.5 + 0.5;
  }

  void main() {
    vec4 base = texture2D(tColor, vUv);
    vec4 m = texture2D(tMask, vUv);
    gl_FragColor = base;
    if (m.b < 0.01) return;
    float depth = texture2D(tDepth, vUv).x;
    vec3 P = viewPosAt(vUv, depth);
    // Something is standing on this piece of road: not ours to reflect.
    if (abs(-P.z - m.a) > max(0.25, m.a * 0.02)) return;

    vec3 N = vec3(m.rg * 2.0 - 1.0, 0.0);
    N.z = sqrt(max(0.0, 1.0 - dot(N.xy, N.xy)));
    vec3 V = normalize(P);
    vec3 R = normalize(reflect(V, N));
    // Water's Fresnel: little straight down, most of the sky at a glance.
    float F = 0.02 + 0.98 * pow(1.0 - clamp(dot(-V, N), 0.0, 1.0), 5.0);

    vec3 pos = P + N * 0.05;
    float stepLen = max(0.15, -P.z * 0.02);
    vec2 hit = vec2(-1.0);
    float travelled = 0.0;
    for (int i = 0; i < SSR_STEPS; i++) {
      pos += R * stepLen;
      vec2 uv = project(pos);
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || pos.z > -uNear) break;
      float sceneZ = viewZAt(texture2D(tDepth, uv).x);
      float behind = sceneZ - pos.z;
      if (behind > 0.0 && behind < stepLen * 2.0 + 0.2) {
        vec3 a = pos - R * stepLen;
        vec3 b = pos;
        for (int k = 0; k < 5; k++) {
          vec3 mid = (a + b) * 0.5;
          if (viewZAt(texture2D(tDepth, project(mid)).x) - mid.z > 0.0) b = mid; else a = mid;
        }
        hit = project(b);
        travelled = float(i) / float(SSR_STEPS);
        // A ray that reaches the sky found nothing the probe does not show.
        if (texture2D(tDepth, hit).x > 0.99995) hit = vec2(-1.0);
        break;
      }
      stepLen *= 1.12;
    }
    if (hit.x < 0.0) return;

    // Rough water smears the reflection vertically; a puddle keeps it sharp.
    float spread = (1.0 - m.b) * 0.025;
    vec3 c = texture2D(tColor, hit).rgb * 0.4
      + (texture2D(tColor, hit + vec2(0.0, spread)).rgb
        + texture2D(tColor, hit - vec2(0.0, spread)).rgb) * 0.2
      + (texture2D(tColor, hit + vec2(0.0, spread * 2.0)).rgb
        + texture2D(tColor, hit - vec2(0.0, spread * 2.0)).rgb) * 0.1;
    c = min(c, vec3(12.0));
    vec2 edge = smoothstep(0.0, 0.08, hit) * smoothstep(0.0, 0.08, 1.0 - hit);
    float fade = edge.x * edge.y * (1.0 - travelled * travelled)
      * (1.0 - smoothstep(0.0, 0.4, R.z));
    gl_FragColor = vec4(base.rgb + c * m.b * F * fade * uStrength, base.a);
  }`;

export class ReflectionPass extends Pass {
  constructor(scene, camera, tap, { steps = 24, uniforms }) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.tap = tap;
    this.road = null;
    this.mask = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
    this.maskMaterial = new THREE.ShaderMaterial({
      vertexShader: MASK_VERT, fragmentShader: MASK_FRAG,
      uniforms: { uStanding: uniforms.uStanding, uWet: uniforms.uWet },
    });
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: SSR_FRAG,
      defines: { SSR_STEPS: steps },
      uniforms: {
        tColor: { value: null },
        tDepth: { value: null },
        tMask: { value: null },
        uProj: { value: new THREE.Matrix4() },
        uStrength: { value: 1 },
        ...depthUniforms(),
      },
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
    this.clear = new THREE.Color();
  }

  setSize(width, height) { this.mask.setSize(width, height); }

  #drawMask(renderer) {
    const { scene, camera } = this;
    const layers = camera.layers.mask;
    const background = scene.background;
    const override = scene.overrideMaterial;
    const clearAlpha = renderer.getClearAlpha();
    renderer.getClearColor(this.clear);
    camera.layers.set(REFLECT_LAYER);
    scene.background = null;
    scene.overrideMaterial = this.maskMaterial;
    renderer.setRenderTarget(this.mask);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, camera);
    scene.overrideMaterial = override;
    scene.background = background;
    camera.layers.mask = layers;
    renderer.setClearColor(this.clear, clearAlpha);
  }

  render(renderer, writeBuffer, readBuffer) {
    this.#drawMask(renderer);
    const u = this.material.uniforms;
    u.tColor.value = readBuffer.texture;
    u.tDepth.value = this.tap.depth;
    u.tMask.value = this.mask.texture;
    u.uProj.value.copy(this.camera.projectionMatrix);
    syncCamera(u, this.camera);
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose() {
    this.mask.dispose();
    this.material.dispose();
    this.maskMaterial.dispose();
    this.quad.dispose();
  }
}

// --- light scattered in the air ------------------------------------------------
// Headlight beams in rain, brake lights glowing through spray, lamps in fog.
// Single scattering from each light along the view ray, solved in closed form
// for the inverse-square falloff: sampling the ray uniformly in the angle it
// subtends at the light weights every sample equally, so a handful of samples
// is enough to apply the spotlight cone and the phase function. Density comes
// from the weather: clear night air barely shows a beam, fog shows it all.
const MAX_LIGHTS = 12;

const SCATTER_FRAG = `
  #define MAX_LIGHTS ${MAX_LIGHTS}
  uniform sampler2D tColor;
  uniform sampler2D tDepth;
  uniform int uCount;
  uniform vec3 uPos[MAX_LIGHTS];
  uniform vec3 uDir[MAX_LIGHTS];
  uniform vec3 uColor[MAX_LIGHTS];
  uniform vec3 uCone[MAX_LIGHTS];     // cos outer, cos inner, range
  uniform float uDensity;
  uniform float uG;
  varying vec2 vUv;
  ${DEPTH_GLSL}

  float phase(float cosTheta) {
    float g2 = uG * uG;
    return (1.0 - g2) / (12.566 * pow(1.0 + g2 - 2.0 * uG * cosTheta, 1.5));
  }

  void main() {
    vec4 base = texture2D(tColor, vUv);
    gl_FragColor = base;
    float depth = texture2D(tDepth, vUv).x;
    vec3 P = viewPosAt(vUv, depth);
    float L = min(length(P), 180.0);
    vec3 dir = normalize(P);
    vec3 sum = vec3(0.0);
    for (int i = 0; i < MAX_LIGHTS; i++) {
      if (i >= uCount) break;
      vec3 lp = uPos[i];
      float tc = dot(lp, dir);
      float h = max(length(lp - dir * tc), 0.12);
      float a0 = atan(-tc, h);
      float a1 = atan(L - tc, h);
      if (a1 - a0 < 1e-4) continue;
      float acc = 0.0;
      for (int k = 0; k < 6; k++) {
        float th = mix(a0, a1, (float(k) + 0.5) / 6.0);
        vec3 s = dir * (tc + h * tan(th));
        vec3 toS = s - lp;
        float dist = length(toS);
        toS /= max(dist, 1e-3);
        float cone = uCone[i].x < -1.5 ? 1.0
          : smoothstep(uCone[i].x, uCone[i].y, dot(toS, uDir[i]));
        float reach = 1.0 - smoothstep(uCone[i].z * 0.6, uCone[i].z, dist);
        acc += cone * reach * phase(dot(toS, -dir));
      }
      sum += uColor[i] * ((a1 - a0) / h) * (acc / 6.0);
    }
    gl_FragColor = vec4(base.rgb + min(sum * uDensity, vec3(20.0)), base.a);
  }`;

export class ScatterPass extends Pass {
  constructor(camera, tap) {
    super();
    this.camera = camera;
    this.tap = tap;
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: SCATTER_FRAG,
      uniforms: {
        tColor: { value: null },
        tDepth: { value: null },
        uCount: { value: 0 },
        uPos: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector3()) },
        uDir: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector3(0, 0, -1)) },
        uColor: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector3()) },
        uCone: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector3(-2, -1, 60)) },
        uDensity: { value: 0 },
        // Raindrops and fog droplets scatter mostly forward, but enough to the
        // side and back that a beam reads from behind the car.
        uG: { value: 0.35 },
        ...depthUniforms(),
      },
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
    this.tmp = new THREE.Vector3();
  }

  // `lights` in world space: { position, direction, hasDir, color (linear rgb,
  // already scaled by intensity), cosOuter, cosInner, range }. A light without
  // a direction shines every way.
  setLights(lights) {
    const u = this.material.uniforms;
    const view = this.camera.matrixWorldInverse;
    const count = Math.min(MAX_LIGHTS, lights.length);
    for (let i = 0; i < count; i++) {
      const l = lights[i];
      const spot = l.hasDir ?? !!l.direction;
      u.uPos.value[i].copy(l.position).applyMatrix4(view);
      if (spot) u.uDir.value[i].copy(l.direction).transformDirection(view);
      u.uColor.value[i].copy(l.color);
      u.uCone.value[i].set(spot ? l.cosOuter : -2, spot ? l.cosInner : -1, l.range);
    }
    u.uCount.value = count;
  }

  render(renderer, writeBuffer, readBuffer) {
    const u = this.material.uniforms;
    u.tColor.value = readBuffer.texture;
    u.tDepth.value = this.tap.depth;
    syncCamera(u, this.camera);
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose() {
    this.material.dispose();
    this.quad.dispose();
  }
}

// --- sun shafts ------------------------------------------------------------------
// Light from a low sun through gaps in trees and stands. Bright sky that is
// not blocked by anything is gathered at half resolution, smeared toward the
// sun, and added back: where something stands between the sun and the camera
// there is no sky behind it, so the gaps are what shine.
const SHAFT_MASK_FRAG = `
  uniform sampler2D tColor;
  uniform sampler2D tDepth;
  uniform vec2 uSun;
  uniform float uAspect;
  varying vec2 vUv;
  void main() {
    float sky = step(0.99995, texture2D(tDepth, vUv).x);
    vec3 c = texture2D(tColor, vUv).rgb;
    // Only the sun and the glare round it are bright enough to throw a
    // shaft; the rest of a bright sky is not a light source.
    float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float bright = clamp((luma - 1.5) / 6.0, 0.0, 1.0);
    vec2 d = (vUv - uSun) * vec2(uAspect, 1.0);
    float near = exp(-dot(d, d) * 16.0);
    gl_FragColor = vec4(c / max(luma, 1e-3) * bright * sky * near, 1.0);
  }`;

const SHAFT_BLUR_FRAG = `
  uniform sampler2D tMask;
  uniform vec2 uSun;
  varying vec2 vUv;
  void main() {
    vec2 delta = (vUv - uSun) / 48.0 * 0.9;
    vec2 uv = vUv;
    vec3 sum = vec3(0.0);
    float weight = 1.0;
    for (int i = 0; i < 48; i++) {
      sum += texture2D(tMask, uv).rgb * weight;
      weight *= 0.965;
      uv -= delta;
    }
    gl_FragColor = vec4(sum / 14.0, 1.0);
  }`;

const SHAFT_ADD_FRAG = `
  uniform sampler2D tColor;
  uniform sampler2D tShafts;
  uniform vec3 uTint;
  uniform float uStrength;
  varying vec2 vUv;
  void main() {
    vec4 base = texture2D(tColor, vUv);
    gl_FragColor = vec4(base.rgb + texture2D(tShafts, vUv).rgb * uTint * uStrength, base.a);
  }`;

export class ShaftsPass extends Pass {
  constructor(camera, tap) {
    super();
    this.camera = camera;
    this.tap = tap;
    this.sun = new THREE.Vector3(0, 1, 0);
    this.tint = new THREE.Vector3(1, 0.9, 0.75);
    this.strength = 0;
    const opts = { type: THREE.HalfFloatType, depthBuffer: false };
    this.maskTarget = new THREE.WebGLRenderTarget(1, 1, opts);
    this.blurTarget = new THREE.WebGLRenderTarget(1, 1, opts);
    const shared = { uSun: { value: new THREE.Vector2() } };
    this.maskMat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: SHAFT_MASK_FRAG,
      uniforms: { tColor: { value: null }, tDepth: { value: null }, uAspect: { value: 1 }, ...shared },
      depthTest: false, depthWrite: false,
    });
    this.blurMat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: SHAFT_BLUR_FRAG,
      uniforms: { tMask: { value: this.maskTarget.texture }, ...shared },
      depthTest: false, depthWrite: false,
    });
    this.addMat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: SHAFT_ADD_FRAG,
      uniforms: {
        tColor: { value: null },
        tShafts: { value: this.blurTarget.texture },
        uTint: { value: this.tint },
        uStrength: { value: 0 },
      },
      depthTest: false, depthWrite: false,
    });
    this.quad = new FullScreenQuad(null);
    this.sunUv = shared.uSun.value;
    this.clip = new THREE.Vector3();
  }

  setSize(width, height) {
    const w = Math.max(1, Math.round(width / 2)), h = Math.max(1, Math.round(height / 2));
    this.maskTarget.setSize(w, h);
    this.blurTarget.setSize(w, h);
    this.maskMat.uniforms.uAspect.value = width / Math.max(1, height);
  }

  // Worth drawing only when the sun is up and somewhere near the frame.
  visible() {
    if (this.strength <= 0.001) return false;
    const c = this.clip.copy(this.camera.position).addScaledVector(this.sun, 1000)
      .project(this.camera);
    const behind = this.clip.z > 1;
    this.sunUv.set(c.x * 0.5 + 0.5, c.y * 0.5 + 0.5);
    return !behind && Math.abs(c.x) < 1.6 && Math.abs(c.y) < 1.6;
  }

  render(renderer, writeBuffer, readBuffer) {
    this.maskMat.uniforms.tColor.value = readBuffer.texture;
    this.maskMat.uniforms.tDepth.value = this.tap.depth;
    this.quad.material = this.maskMat;
    renderer.setRenderTarget(this.maskTarget);
    this.quad.render(renderer);
    this.quad.material = this.blurMat;
    renderer.setRenderTarget(this.blurTarget);
    this.quad.render(renderer);
    this.addMat.uniforms.tColor.value = readBuffer.texture;
    this.addMat.uniforms.uStrength.value = this.strength;
    this.quad.material = this.addMat;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose() {
    this.maskTarget.dispose();
    this.blurTarget.dispose();
    this.maskMat.dispose();
    this.blurMat.dispose();
    this.addMat.dispose();
    this.quad.dispose();
  }
}

// --- adaptive exposure ------------------------------------------------------------
// A camera does not see a bright sky and a dark stand at one exposure. The
// frame's mean log luminance is measured on the GPU into a single pixel and
// followed at two speeds: quickly, the way an eye or a camera reacts, and
// slowly, as a reference for how this scene is lit. Exposure moves with the
// difference between the two, limited to about half a stop either way, so a
// sudden change of light is met and then eased back to the authored look.
const LUM_FRAG = `
  uniform sampler2D tColor;
  uniform sampler2D tPrev;
  uniform float uFast;
  uniform float uSlow;
  uniform float uReset;
  varying vec2 vUv;
  void main() {
    float sum = 0.0;
    float weight = 0.0;
    for (int y = 0; y < 8; y++) {
      for (int x = 0; x < 8; x++) {
        vec2 uv = (vec2(float(x), float(y)) + 0.5) / 8.0;
        // The middle of the frame is what the eye is on.
        vec2 d = uv - 0.5;
        float w = 1.0 - dot(d, d) * 1.6;
        vec3 c = texture2D(tColor, uv).rgb;
        sum += log(max(dot(c, vec3(0.2126, 0.7152, 0.0722)), 1e-4)) * w;
        weight += w;
      }
    }
    float now = sum / weight;
    vec2 prev = texture2D(tPrev, vec2(0.5)).rg;
    vec2 next = uReset > 0.5 ? vec2(now) : vec2(mix(prev.r, now, uFast), mix(prev.g, now, uSlow));
    gl_FragColor = vec4(next, 0.0, 1.0);
  }`;

const EXPOSE_FRAG = `
  uniform sampler2D tColor;
  uniform sampler2D tLum;
  uniform float uRange;
  varying vec2 vUv;
  void main() {
    vec2 lum = texture2D(tLum, vec2(0.5)).rg;
    float stops = clamp((lum.g - lum.r) * 0.6, -uRange, uRange);
    vec4 base = texture2D(tColor, vUv);
    gl_FragColor = vec4(base.rgb * exp(stops), base.a);
  }`;

export class ExposurePass extends Pass {
  constructor() {
    super();
    const opts = { type: THREE.HalfFloatType, depthBuffer: false };
    this.lum = [new THREE.WebGLRenderTarget(1, 1, opts), new THREE.WebGLRenderTarget(1, 1, opts)];
    this.flip = 0;
    this.reset = true;
    this.dt = 1 / 60;
    this.lumMat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: LUM_FRAG,
      uniforms: {
        tColor: { value: null }, tPrev: { value: null },
        uFast: { value: 0.1 }, uSlow: { value: 0.01 }, uReset: { value: 1 },
      },
      depthTest: false, depthWrite: false,
    });
    this.exposeMat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: EXPOSE_FRAG,
      uniforms: { tColor: { value: null }, tLum: { value: null }, uRange: { value: 0.35 } },
      depthTest: false, depthWrite: false,
    });
    this.quad = new FullScreenQuad(null);
  }

  render(renderer, writeBuffer, readBuffer) {
    const prev = this.lum[this.flip];
    const next = this.lum[1 - this.flip];
    const u = this.lumMat.uniforms;
    u.tColor.value = readBuffer.texture;
    u.tPrev.value = prev.texture;
    // Eyes take in a bright scene faster than they open up to a dark one.
    u.uFast.value = 1 - Math.exp(-this.dt * 2.2);
    u.uSlow.value = 1 - Math.exp(-this.dt / 12);
    u.uReset.value = this.reset ? 1 : 0;
    this.reset = false;
    this.quad.material = this.lumMat;
    renderer.setRenderTarget(next);
    this.quad.render(renderer);
    this.flip = 1 - this.flip;

    this.exposeMat.uniforms.tColor.value = readBuffer.texture;
    this.exposeMat.uniforms.tLum.value = next.texture;
    this.quad.material = this.exposeMat;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose() {
    for (const t of this.lum) t.dispose();
    this.lumMat.dispose();
    this.exposeMat.dispose();
    this.quad.dispose();
  }
}
