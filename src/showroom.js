import * as THREE from 'three';

// The car on show between races. A racing menu puts the car in a studio, not
// on the grid in daylight: a dark room, a turntable, two soft sources and a
// crimson rim light behind it. What sells it is the reflections, so the room
// is also rendered into an environment probe and the paint reflects the panels
// that are lighting it.
//
// Everything here is built once and reused; showing the room is a matter of
// turning the circuit off and this on.
export class Showroom {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.group = new THREE.Group();
    this.group.name = 'showroom';
    this.group.visible = false;

    // Floor: dark and wide enough that its edge is never in frame. Polished
    // rather than mirrored — a floor that reflects the soft boxes sharply puts
    // a row of bright rectangles under the car, so this one carries a sheen
    // and a soft pool of light instead.
    this.floorMat = new THREE.MeshStandardMaterial({
      color: 0x0a0b0e, roughness: 0.42, metalness: 0.45,
      envMapIntensity: 1.1,
    });
    const floor = new THREE.Mesh(new THREE.CircleGeometry(90, 64), this.floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.group.add(floor);

    // The turntable the car stands on: a low plinth with a lit crimson rim.
    const plinth = new THREE.Mesh(
      new THREE.CylinderGeometry(4.6, 4.9, 0.22, 64),
      new THREE.MeshStandardMaterial({
        color: 0x14161b, roughness: 0.42, metalness: 0.5, envMapIntensity: 1.1,
      }),
    );
    plinth.position.y = -0.11;
    plinth.receiveShadow = true;
    this.ringMat = new THREE.MeshStandardMaterial({
      color: 0x2a0508, emissive: 0xe01b24, emissiveIntensity: 2.4, roughness: 0.4,
    });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(4.78, 0.045, 8, 96), this.ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = -0.01;
    this.group.add(plinth, ring);

    // Key light from high and ahead, fill from the other side and lower, and a
    // rim behind the car to pick its shoulder line out of the dark.
    this.key = new THREE.SpotLight(0xfff4e6, 620, 46, Math.PI / 5.2, 0.55, 1.4);
    this.key.position.set(-7.5, 11.5, 9.5);
    this.key.castShadow = true;
    this.key.shadow.mapSize.setScalar(1024);
    this.key.shadow.camera.near = 2;
    this.key.shadow.camera.far = 40;
    this.key.shadow.bias = -0.0008;

    this.fill = new THREE.SpotLight(0xbfd4ff, 190, 42, Math.PI / 4.4, 0.7, 1.4);
    this.fill.position.set(9, 6.5, -6);

    this.rim = new THREE.SpotLight(0xff2a33, 300, 34, Math.PI / 5, 0.6, 1.5);
    this.rim.position.set(1.5, 3.4, -10.5);

    this.ambient = new THREE.HemisphereLight(0x2a2f3a, 0x05060a, 0.5);
    this.group.add(this.key, this.key.target, this.fill, this.fill.target,
      this.rim, this.rim.target, this.ambient);

    scene.add(this.group);

    // The room as an environment probe. Four emissive panels around a dark box
    // is what a photographic studio looks like to a reflective surface.
    this.probeScene = new THREE.Scene();
    const shell = new THREE.Mesh(
      new THREE.BoxGeometry(64, 28, 64),
      new THREE.MeshBasicMaterial({ color: 0x07080b, side: THREE.BackSide }),
    );
    this.probeScene.add(shell);
    const panel = (color, intensity, position, rotation, size) => {
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(size[0], size[1]),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity) }),
      );
      mesh.position.set(...position);
      mesh.rotation.set(...rotation);
      this.probeScene.add(mesh);
    };
    // Two soft boxes overhead, one large source to the left, a crimson strip
    // behind: the same rig as the real lights, so the reflections agree with
    // the shading.
    panel(0xffffff, 2.6, [0, 13, 3], [Math.PI / 2, 0, 0], [30, 16]);
    panel(0xffffff, 1.7, [0, 13, -12], [Math.PI / 2, 0, 0], [26, 12]);
    panel(0xdfe9ff, 2.1, [-22, 6, 2], [0, Math.PI / 2, 0], [26, 13]);
    panel(0xff2b33, 1.8, [4, 3.4, -24], [0, 0, 0], [22, 4]);
    panel(0xbfd4ff, 1.0, [22, 5, -2], [0, -Math.PI / 2, 0], [20, 10]);
  }

  // Built on first use: a probe costs a render, and a player who never opens
  // the menu should not pay for one.
  #probe() {
    if (this.probeTexture) return this.probeTexture;
    this.pmrem ??= new THREE.PMREMGenerator(this.renderer);
    this.target = this.pmrem.fromScene(this.probeScene, 0.09);
    this.probeTexture = this.target.texture;
    return this.probeTexture;
  }

  // Turn the room on around a car. Whatever the scene was lighting itself with
  // is put back by hide().
  show(car) {
    const at = car.renderPosition;
    this.group.position.set(at.x, at.y - 0.02, at.z);
    for (const light of [this.key, this.fill, this.rim]) {
      light.target.position.set(0, 0.7, 0);
    }
    this.group.visible = true;

    this.saved = {
      environment: this.scene.environment,
      environmentIntensity: this.scene.environmentIntensity,
      fog: this.scene.fog,
      background: this.scene.background,
    };
    this.scene.environment = this.#probe();
    this.scene.environmentIntensity = 1;
    // A studio has no weather and no horizon: the room is the whole world.
    this.scene.fog = new THREE.Fog(0x05060a, 26, 120);
    this.scene.background = new THREE.Color(0x05060a);
  }

  hide() {
    if (!this.group.visible) return;
    this.group.visible = false;
    if (!this.saved) return;
    this.scene.environment = this.saved.environment;
    this.scene.environmentIntensity = this.saved.environmentIntensity;
    this.scene.fog = this.saved.fog;
    this.scene.background = this.saved.background;
    this.saved = null;
  }

  get active() { return this.group.visible; }

  // The rim light pulses very slightly, which is the only motion in the room
  // besides the turntable and keeps a still frame from looking like a freeze.
  update(dt, time) {
    if (!this.group.visible) return;
    this.ringMat.emissiveIntensity = 2.1 + Math.sin(time * 1.6) * 0.35;
  }

  dispose() {
    this.hide();
    this.scene.remove(this.group);
    this.target?.dispose();
    this.pmrem?.dispose();
  }
}
