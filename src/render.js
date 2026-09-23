import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import {
  ScreenTap, ReflectionPass, ScatterPass, ShaftsPass, ExposurePass,
} from './post.js';

// The frame is drawn once, into a linear HDR buffer, and everything a camera
// does to light happens after that: ambient occlusion grounds what touches
// what, bloom lets only genuinely bright sources spill, tone mapping turns the
// HDR buffer into a picture, and grading gives the picture its mood. Tone
// mapping lives in the output pass, so the renderer's exposure is still the
// single dial the environment turns.
//
// Why WebGL and not WebGPU: the crowd animates in an onBeforeCompile patch and
// the sky is a GLSL ShaderMaterial; WebGPURenderer runs neither, so a move
// means rewriting both in TSL and re-checking every material by eye. Until
// that is worth it, the WebGL composer carries the pipeline and the tier
// table below is the seam a WebGPU path would plug into.

// Cheapest first. Each tier is a whole budget: buffer resolution, MSAA, shadow
// map, which passes run, and how many particles the weather may spend. `ssr`
// is the number of ray-march steps for wet-road reflections (0 is off),
// `scatter` light scattered by rain and fog, `shafts` sun shafts, `exposure`
// the adapting camera.
export const TIER_KEYS = ['performance', 'low', 'medium', 'high', 'ultra'];
export const TIERS = {
  performance: {
    name: 'Performance', res: 0.7, cap: 1, samples: 0, shadow: 1024,
    ao: 0, bloom: false, grade: false, particles: 0.25,
    ssr: 0, scatter: false, shafts: false, exposure: false,
  },
  low: {
    name: 'Low', res: 0.85, cap: 1.25, samples: 2, shadow: 1024,
    ao: 0, bloom: false, grade: true, particles: 0.4,
    ssr: 0, scatter: false, shafts: false, exposure: true,
  },
  medium: {
    name: 'Medium', res: 1, cap: 1.5, samples: 4, shadow: 2048,
    ao: 0, bloom: true, grade: true, particles: 0.6,
    ssr: 0, scatter: true, shafts: false, exposure: true,
  },
  high: {
    name: 'High', res: 1, cap: 2, samples: 4, shadow: 2048,
    ao: 0.5, bloom: true, grade: true, particles: 0.85,
    ssr: 24, scatter: true, shafts: true, exposure: true,
  },
  ultra: {
    name: 'Ultra', res: 1, cap: 2, samples: 4, shadow: 4096,
    ao: 1, bloom: true, grade: true, particles: 1,
    ssr: 40, scatter: true, shafts: true, exposure: true,
  },
};

// A best guess from the GPU's name, used as the starting tier for Auto and as
// the ceiling Auto may climb to. The frame-time monitor corrects it either way.
export function detectTier(renderer, mobile) {
  const gl = renderer.getContext();
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL)
    : gl.getParameter(gl.RENDERER));
  let tier = 'medium';
  if (/swiftshader|llvmpipe|software|basic render/i.test(gpu)) tier = 'performance';
  else if (mobile) tier = 'low';
  else if (/rtx|radeon rx|radeon pro|geforce gtx 1[06-9]|apple m\d/i.test(gpu)) tier = 'high';
  else if (/intel|uhd|iris|mali|adreno/i.test(gpu)) tier = 'medium';
  return { gpu, tier };
}

// Ambient occlusion that ignores what cannot occlude: smoke, spray, skid
// marks, glass and the sky dome are transparent or write no depth, and drawing
// them into the normal buffer would put dark halos around every puff of smoke.
class GroundingAOPass extends GTAOPass {
  constructor(scene, camera, scale) {
    super(scene, camera, 1, 1);
    this.scale = scale;
  }

  setSize(width, height) {
    super.setSize(Math.max(1, Math.round(width * this.scale)),
      Math.max(1, Math.round(height * this.scale)));
  }

  overrideVisibility() {
    super.overrideVisibility();
    this.scene.traverse((node) => {
      const mat = node.material;
      if (node.isSprite || (mat && !Array.isArray(mat) && (mat.transparent || !mat.depthWrite))) {
        node.visible = false;
      }
    });
  }
}

// Display-space grade: lift and gain per channel, saturation, contrast, a
// vignette that is felt rather than seen, and grain for the cinematic camera
// only. Everything here is a small push; zero push is a neutral image.
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uLift: { value: new THREE.Vector3() },
    uGain: { value: new THREE.Vector3(1, 1, 1) },
    uSat: { value: 1 },
    uContrast: { value: 1 },
    uVignette: { value: 0 },
    uGrain: { value: 0 },
    uTime: { value: 0 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform vec3 uLift;
    uniform vec3 uGain;
    uniform float uSat;
    uniform float uContrast;
    uniform float uVignette;
    uniform float uGrain;
    uniform float uTime;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
    }

    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      vec3 col = src.rgb * uGain + uLift * (1.0 - src.rgb);
      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(luma), col, uSat);
      col = (col - 0.5) * uContrast + 0.5;
      vec2 d = vUv - 0.5;
      col *= 1.0 - uVignette * dot(d, d) * 1.6;
      if (uGrain > 0.0) col += (hash(gl_FragCoord.xy + fract(uTime) * 91.7) - 0.5) * uGrain;
      gl_FragColor = vec4(clamp(col, 0.0, 1.0), src.a);
    }`,
};

// Named looks. Shadows cool as highlights warm at golden hour; a storm drains
// colour; night keeps its blacks without crushing the road.
export const GRADES = {
  neutral: { lift: [0, 0, 0], gain: [1, 1, 1], sat: 1, contrast: 1, vignette: 0 },
  daylight: { lift: [0, 0.002, 0.006], gain: [1.01, 1, 0.99], sat: 1.04, contrast: 1.03, vignette: 0.12 },
  golden: { lift: [0, 0.004, 0.014], gain: [1.04, 1, 0.94], sat: 1.06, contrast: 1.04, vignette: 0.16 },
  night: { lift: [0, 0.004, 0.012], gain: [0.98, 1, 1.03], sat: 0.94, contrast: 1.05, vignette: 0.2 },
  neon: { lift: [0.004, 0, 0.012], gain: [1, 0.99, 1.02], sat: 1.05, contrast: 1.05, vignette: 0.2 },
  storm: { lift: [0.004, 0.008, 0.012], gain: [0.97, 1, 1.02], sat: 0.86, contrast: 1.02, vignette: 0.18 },
};

export function gradeFor(visionKey, weather) {
  if (weather.wet > 0.5 || weather.fogScale < 0.6) return 'storm';
  return { day: 'daylight', sunset: 'golden', dusk: 'night', night: 'night', neon: 'neon' }[visionKey]
    ?? 'daylight';
}

// Watches frame time, not frame rate: a steady 16.7 ms is the goal, and the 1%
// worst frames matter as much as the average. Steps are slow and sticky so the
// picture never visibly hunts between tiers.
class FramePacer {
  constructor() {
    this.times = [];
    this.window = 0;
    this.calm = 0;
    this.cooldown = 0;
    this.lastUp = -Infinity;
    this.clock = 0;
    this.avg = 0;
    this.low = 0;
  }

  // Returns -1 to step down (-2: and lower the ceiling), +1 to step up, 0 to hold.
  sample(ms, budget) {
    // A stall (tab switch, GC, a shader compiling) is not a load measurement.
    if (ms > 100) return 0;
    this.clock += ms / 1000;
    this.times.push(ms);
    if (this.times.length > 240) this.times.shift();
    this.window += ms / 1000;
    this.cooldown -= ms / 1000;
    if (this.window < 1.5) return 0;
    this.window = 0;

    const sorted = [...this.times].sort((a, b) => a - b);
    this.avg = sorted.reduce((s, v) => s + v, 0) / sorted.length;
    this.low = sorted[Math.floor(sorted.length * 0.99)] ?? this.avg;
    if (this.cooldown > 0) return 0;

    if (this.avg > budget * 1.2) {
      this.cooldown = 3;
      this.calm = 0;
      // Dropping straight back after a step up means the step was too far:
      // stay down, and do not try that tier again this session.
      return this.clock - this.lastUp < 6 ? -2 : -1;
    }
    this.calm = this.avg < budget * 1.08 && this.low < budget * 1.35 ? this.calm + 1.5 : 0;
    if (this.calm >= 10) {
      this.calm = 0;
      this.cooldown = 3;
      this.lastUp = this.clock;
      return 1;
    }
    return 0;
  }
}

export class RenderPipeline {
  constructor(renderer, scene, camera, { mobile = false, sun = null, water = null } = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.sun = sun;
    this.mobile = mobile;
    const found = detectTier(renderer, mobile);
    this.gpu = found.gpu;
    this.detected = found.tier;
    this.ceiling = found.tier === 'performance' ? 'low' : 'high';
    this.auto = true;
    this.tierKey = null;
    this.grading = true;
    this.cinematic = false;
    this.gradeKey = 'daylight';
    this.pacer = new FramePacer();
    // Dynamic resolution: Auto gives up pixels five per cent at a time before
    // it gives up a whole tier of effects, and takes them back the same way.
    this.resScale = 1;
    this.#initTimer();
    // The composer draws many times a frame; the counters cover all of them.
    renderer.info.autoReset = false;
    this.size = new THREE.Vector2(1, 1);
    this.onTier = null;
    // The road's water, shared with the road shader, for the reflection mask.
    this.water = water ?? { uStanding: { value: 0 }, uWet: { value: 0 } };
    // What the world is doing this frame, set by the game before each render.
    this.world = { wet: 0, lights: [], density: 0, sun: null, shafts: 0 };

    this.renderPass = new RenderPass(scene, camera);
    this.outputPass = new OutputPass();
    this.gradePass = new ShaderPass(GradeShader);
    this.setTier(found.tier);
  }

  get tier() { return TIERS[this.tierKey]; }

  // The tier's pixel ratio, trimmed by the dynamic resolution scale.
  #applyResolution() {
    const t = this.tier;
    const cap = this.mobile ? Math.min(1.4, t.cap) : t.cap;
    const ratio = Math.min(devicePixelRatio * t.res, cap) * this.resScale;
    if (Math.abs(ratio - this.renderer.getPixelRatio()) < 1e-3) return;
    this.renderer.setPixelRatio(ratio);
    this.#resize();
  }

  // 'auto' or a tier key. A stored value from the old three-way setting is a
  // tier key already, so saved settings keep working.
  setQuality(quality) {
    this.auto = quality === 'auto' || !TIERS[quality];
    // A chosen tier is drawn at its full resolution.
    this.resScale = 1;
    this.setTier(this.auto ? this.detected : quality);
    this.#applyResolution();
  }

  setTier(key) {
    if (!TIERS[key] || key === this.tierKey) return;
    this.tierKey = key;
    this.pacer.times.length = 0;
    const t = TIERS[key];
    this.#applyResolution();
    this.#build();
    if (this.sun) {
      this.sun.shadow.mapSize.setScalar(this.mobile ? Math.min(1024, t.shadow) : t.shadow);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    this.onTier?.(key, t);
  }

  // The composer is rebuilt on a tier change, never per frame: MSAA sample
  // count is fixed when a render target is made.
  #build() {
    const t = this.tier;
    this.composer?.renderTarget1.dispose();
    this.composer?.renderTarget2.dispose();
    for (const pass of [this.aoPass, this.bloomPass, this.ssrPass, this.scatterPass,
      this.shaftsPass, this.exposurePass]) pass?.dispose();

    // Depth is resolved into a texture only when a pass needs to read it.
    const depthPasses = t.ssr > 0 || t.scatter || t.shafts;
    const target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType, samples: t.samples,
      depthTexture: depthPasses ? new THREE.DepthTexture(1, 1) : null,
    });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.addPass(this.renderPass);
    this.tap = new ScreenTap(this.renderer);
    this.composer.addPass(this.tap);

    // Reflections are drawn before AO so the AO blend darkens them the way it
    // darkens the road they lie on.
    this.ssrPass = null;
    if (t.ssr > 0) {
      this.ssrPass = new ReflectionPass(this.scene, this.camera, this.tap,
        { steps: t.ssr, uniforms: this.water });
      this.composer.addPass(this.ssrPass);
    }

    this.aoPass = null;
    if (t.ao) {
      this.aoPass = new GroundingAOPass(this.scene, this.camera, t.ao);
      this.aoPass.blendIntensity = 0.85;
      this.aoPass.updateGtaoMaterial({
        radius: 0.6, distanceExponent: 1.5, thickness: 1, scale: 1,
        samples: t.ao >= 1 ? 16 : 10,
      });
      this.aoPass.updatePdMaterial({ radius: 6, rings: 2, samples: 12 });
      this.composer.addPass(this.aoPass);
    }

    // Light in the air goes on after AO, which must not darken a beam.
    this.scatterPass = t.scatter ? new ScatterPass(this.camera, this.tap) : null;
    if (this.scatterPass) this.composer.addPass(this.scatterPass);
    this.shaftsPass = t.shafts ? new ShaftsPass(this.camera, this.tap) : null;
    if (this.shaftsPass) this.composer.addPass(this.shaftsPass);
    // Exposure before bloom, so what blooms is what is bright after the
    // camera has adapted.
    this.exposurePass = t.exposure ? new ExposurePass() : null;
    if (this.exposurePass) this.composer.addPass(this.exposurePass);

    this.bloomPass = null;
    if (t.bloom) {
      // Threshold sits above white in the linear buffer: lamps, brake lights,
      // floodlights and the sun bloom; a white car in daylight does not.
      this.bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.28, 0.35, 1.05);
      this.composer.addPass(this.bloomPass);
    }

    this.composer.addPass(this.outputPass);
    this.composer.addPass(this.gradePass);
    this.#resize();
  }

  setSize(width, height) {
    this.size.set(width, height);
    this.renderer.setSize(width, height, false);
    this.#resize();
  }

  #resize() {
    if (!this.composer) return;
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(this.size.x, this.size.y);
  }

  setGrade(key) { this.gradeKey = GRADES[key] ? key : 'neutral'; }

  // A hard change of scene: the camera meets it at once instead of adapting.
  cut() { if (this.exposurePass) this.exposurePass.reset = true; }

  // Called once per drawn frame with the real frame time in seconds.
  render(frame = 1 / 60) {
    this.#pace(frame);
    this.#grade(frame);
    this.#worldPasses(frame);
    this.renderer.info.reset();
    const query = this.#timerBegin();
    this.composer.render(frame);
    this.#timerEnd(query);
    this.tap.release();
  }

  // Each world pass runs only when there is something for it to show: no
  // reflections on a dry road, no beams without lights and something in the
  // air to catch them, no shafts without a sun near the frame.
  #worldPasses(frame) {
    const w = this.world;
    if (this.ssrPass) {
      this.ssrPass.enabled = w.wet > 0.04;
      this.ssrPass.material.uniforms.uStrength.value = Math.min(1, w.wet * 1.4);
    }
    if (this.scatterPass) {
      this.scatterPass.enabled = w.density > 0.0005 && w.lights.length > 0;
      if (this.scatterPass.enabled) {
        this.scatterPass.setLights(w.lights);
        this.scatterPass.material.uniforms.uDensity.value = w.density;
      }
    }
    if (this.shaftsPass) {
      if (w.sun) this.shaftsPass.sun.copy(w.sun);
      if (w.sunTint) this.shaftsPass.tint.copy(w.sunTint);
      this.shaftsPass.strength = w.shafts;
      this.shaftsPass.enabled = this.shaftsPass.visible();
    }
    if (this.exposurePass) this.exposurePass.dt = frame;
  }

  #pace(frame) {
    // Always measured, so the telemetry reads true on a fixed tier too.
    const step = this.pacer.sample(frame * 1000, 1000 / 60);
    if (!step || !this.auto) return;
    let i = TIER_KEYS.indexOf(this.tierKey);
    if (step < 0) {
      if (step === -2) this.ceiling = TIER_KEYS[Math.max(0, i - 1)];
      // Pixels first, in steps small enough not to be seen.
      if (this.resScale > 0.81 && step === -1) {
        this.resScale = Math.round((this.resScale - 0.05) * 100) / 100;
        this.#applyResolution();
        return;
      }
      i = Math.max(0, i - 1);
      this.resScale = 0.9;
    } else {
      if (this.resScale < 0.999) {
        this.resScale = Math.min(1, Math.round((this.resScale + 0.05) * 100) / 100);
        this.#applyResolution();
        return;
      }
      i = Math.min(TIER_KEYS.indexOf(this.ceiling), i + 1);
    }
    this.setTier(TIER_KEYS[i]);
  }

  // GPU time for the whole frame, where the browser offers a timer query.
  // Results arrive a frame or two late and are averaged; a disjoint frame
  // (the GPU was interrupted) is thrown away rather than reported.
  #initTimer() {
    const gl = this.renderer.getContext();
    this.timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.queries = [];
    this.gpuMs = null;
  }

  #timerBegin() {
    if (!this.timer || this.queries.length > 3) return null;
    const gl = this.renderer.getContext();
    const q = gl.createQuery();
    gl.beginQuery(this.timer.TIME_ELAPSED_EXT, q);
    return q;
  }

  #timerEnd(q) {
    const gl = this.renderer.getContext();
    if (q) {
      gl.endQuery(this.timer.TIME_ELAPSED_EXT);
      this.queries.push(q);
    }
    while (this.queries.length && gl.getQueryParameter(this.queries[0], gl.QUERY_RESULT_AVAILABLE)) {
      const done = this.queries.shift();
      if (!gl.getParameter(this.timer.GPU_DISJOINT_EXT)) {
        const ms = gl.getQueryParameter(done, gl.QUERY_RESULT) / 1e6;
        this.gpuMs = this.gpuMs === null ? ms : this.gpuMs + (ms - this.gpuMs) * 0.1;
      }
      gl.deleteQuery(done);
    }
  }

  // Looks blend over about a second, so a change of weather re-grades the
  // picture the way the light itself changes, not with a cut.
  #grade(frame) {
    const u = this.gradePass.uniforms;
    const on = this.grading && this.tier.grade;
    this.gradePass.enabled = on || this.cinematic;
    const g = GRADES[on ? this.gradeKey : 'neutral'];
    const k = 1 - Math.exp(-frame * 3);
    u.uLift.value.lerp(g.liftV ??= new THREE.Vector3(...g.lift), k);
    u.uGain.value.lerp(g.gainV ??= new THREE.Vector3(...g.gain), k);
    u.uSat.value += (g.sat - u.uSat.value) * k;
    u.uContrast.value += (g.contrast - u.uContrast.value) * k;
    u.uVignette.value += (g.vignette - u.uVignette.value) * k;
    u.uGrain.value = this.cinematic ? 0.03 : 0;
    u.uTime.value += frame;
  }

  stats() {
    return {
      tier: `${this.tier.name}${this.auto ? ' (auto)' : ''}`,
      gpu: this.gpu,
      pixelRatio: `${this.renderer.getPixelRatio().toFixed(2)} (${Math.round(this.resScale * 100)}%)`,
      gpuMs: this.gpuMs,
      msaa: this.tier.samples,
      passes: this.composer.passes.filter((p) => p.enabled && p !== this.tap).length,
      active: this.composer.passes.filter((p) => p.enabled && p !== this.tap)
        .map((p) => p.constructor.name.replace(/Pass$/, '')).join(' '),
      avg: this.pacer.avg,
      low: this.pacer.low,
    };
  }
}
