import * as THREE from 'three';

// Pooled billboard puffs. Sliding tyres and car-to-car hits both spend from the
// same pool, so the cost is bounded no matter how untidy the driving gets.
const POOL = 120;

// Water off a wet road is almost white and very short-lived.
const SPRAY = new THREE.Color(0xdfe9f4);

function puffTexture() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const c = canvas.getContext('2d');
  const grad = c.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,0.85)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.32)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = grad;
  c.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'effects';
    scene.add(this.group);

    const map = puffTexture();
    this.puffs = Array.from({ length: POOL }, () => {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map, transparent: true, depthWrite: false, opacity: 0,
      }));
      sprite.visible = false;
      this.group.add(sprite);
      return { sprite, life: 0, ttl: 1, velocity: new THREE.Vector3(), spin: 0, grow: 1 };
    });
    this.cursor = 0;
    this.tint = new THREE.Color(0xd8d8d8);
    this.dustTint = new THREE.Color(0x8f7f5a);
  }

  // Surface decides what a spinning tyre throws up, and what the verge beside
  // it throws up when the car puts a wheel on it.
  setSurface(spec) {
    const bySurface = { asphalt: 0xb9c3cf, concrete: 0xc8ccd2, dirt: 0xb08b55 };
    this.tint.setHex(bySurface[spec?.surface] ?? 0xb9c3cf);
    this.dustTint.setHex(spec?.surface === 'dirt' ? 0xc0a06a : 0x8f7f5a);
  }

  #take() {
    const puff = this.puffs[this.cursor];
    this.cursor = (this.cursor + 1) % POOL;
    return puff;
  }

  spawn(position, {
    strength = 1, spread = 0.6, rise = 1.2, size = 1.1, ttl = 0.8, color = null,
  } = {}) {
    const p = this.#take();
    p.sprite.position.copy(position);
    p.sprite.material.color.copy(color ?? this.tint);
    p.sprite.material.opacity = Math.min(0.75, 0.2 + strength * 0.5);
    p.sprite.scale.setScalar(size * (0.6 + strength * 0.6));
    p.sprite.visible = true;
    p.velocity.set(
      (Math.random() - 0.5) * spread,
      rise * (0.5 + Math.random() * 0.8),
      (Math.random() - 0.5) * spread,
    );
    p.life = 0;
    p.ttl = ttl;
    p.grow = 1 + strength * 1.6;
    p.spin = (Math.random() - 0.5) * 2;
  }

  // What comes off the tyres. Three things happen at the back of a car, and
  // the surface and the weather decide which: rubber smoke when a dry tyre is
  // past the limit, spray off a wet road at any speed, and dust when a wheel
  // is off the sealed surface altogether.
  tyreSmoke(car, dt, wet = 0) {
    const slide = car.slide ?? 0;
    const sliding = slide > 1.6 && car.kmh > 14;
    const offRoad = !car.onRoad && car.kmh > 22;
    const spraying = wet > 0.2 && car.kmh > 30;
    if (!sliding && !offRoad && !spraying) return;

    const slip = sliding ? Math.min(1, (slide - 1.6) / 9) : 0;
    // A wet road puts water in the air instead of rubber, so hard sliding on
    // one makes less smoke, not more.
    const smoke = slip * (1 - wet * 0.7);
    const spray = spraying ? Math.min(1, (car.kmh - 30) / 150) * wet : 0;
    const dust = offRoad ? Math.min(1, (car.kmh - 22) / 90) : 0;
    const rate = smoke * 40 + spray * 26 + dust * 30 + (sliding ? 8 : 0);

    // Rate follows how hard it is working, not the frame rate.
    this.budget = (this.budget ?? 0) + dt * rate;
    while (this.budget >= 1) {
      this.budget -= 1;
      const rear = car.renderForward.multiplyScalar(-car.chassis.body.length * 0.32);
      const side = (Math.random() < 0.5 ? -1 : 1) * car.chassis.body.width * 0.45;
      const at = car.renderPosition.clone().add(rear);
      at.x += Math.cos(car.renderYaw) * side;
      at.z -= Math.sin(car.renderYaw) * side;
      at.y -= 0.45;

      // Whichever source is strongest is what this puff is made of.
      if (dust >= smoke && dust >= spray) {
        this.spawn(at, {
          strength: dust, size: 1.15, ttl: 0.6 + dust * 0.5, rise: 0.7,
          color: this.dustTint, spread: 1.1,
        });
      } else if (spray > smoke) {
        this.spawn(at, {
          strength: spray * 0.8, size: 0.85, ttl: 0.34, rise: 0.45,
          color: SPRAY, spread: 1.6,
        });
      } else {
        this.spawn(at, { strength: smoke, size: 1.3, ttl: 0.75 + smoke * 0.5, rise: 0.9 });
      }
    }
  }

  // A hit throws debris both ways along the contact normal.
  impact(position, strength) {
    const n = Math.round(3 + strength * 7);
    for (let i = 0; i < n; i++) {
      this.spawn(position, {
        strength, spread: 3.2, rise: 2.4, size: 0.7, ttl: 0.5,
        color: new THREE.Color(0xffd08a),
      });
    }
  }

  update(dt) {
    for (const p of this.puffs) {
      if (!p.sprite.visible) continue;
      p.life += dt;
      if (p.life >= p.ttl) {
        p.sprite.visible = false;
        p.sprite.material.opacity = 0;
        continue;
      }
      const k = p.life / p.ttl;
      p.sprite.position.addScaledVector(p.velocity, dt);
      p.velocity.multiplyScalar(1 - dt * 1.6);
      p.sprite.scale.setScalar(p.sprite.scale.x + p.grow * dt);
      p.sprite.material.opacity = (1 - k) * 0.6;
      p.sprite.material.rotation += p.spin * dt;
    }
  }
}
