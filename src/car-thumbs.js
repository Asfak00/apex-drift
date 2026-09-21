import * as THREE from 'three';
import { buildBody } from './car.js';
import { CHASSIS } from './config.js';

// The picker shows the actual car, not a drawing of one: each chassis is built
// with the same mesh code the race uses and rendered once to an image. One
// throwaway renderer, disposed immediately, so the game's own context is never
// disturbed and no extra WebGL context is kept alive.
export function renderChassisThumbs(width = 240, height = 150) {
  const renderer = new THREE.WebGLRenderer({
    antialias: true, alpha: true, preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(width, height, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;

  const scene = new THREE.Scene();
  const key = new THREE.DirectionalLight(0xfff3e0, 3.1);
  key.position.set(4, 6, 5);
  const rim = new THREE.DirectionalLight(0x9fd8ff, 1.5);
  rim.position.set(-5, 3, -4);
  scene.add(key, rim, new THREE.HemisphereLight(0xcfe4ff, 0x20262e, 1.15));

  // A small probe so the paint and the chrome have something to reflect.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const probeScene = new THREE.Scene();
  probeScene.add(new THREE.Mesh(
    new THREE.SphereGeometry(10, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0x6f8bb0, side: THREE.BackSide }),
  ));
  const probe = pmrem.fromScene(probeScene, 0, 0.1, 40);
  scene.environment = probe.texture;

  const camera = new THREE.PerspectiveCamera(30, width / height, 0.1, 100);
  const thumbs = {};

  for (const [key2, chassis] of Object.entries(CHASSIS)) {
    const built = buildBody(chassis.color, chassis.body, chassis);
    built.group.rotation.y = -0.72;   // three-quarter view
    scene.add(built.group);

    const reach = chassis.body.length * 1.42;
    camera.position.set(reach * 0.78, chassis.body.roof + 1.55, reach * 0.86);
    camera.lookAt(0, chassis.body.ride + 0.2, 0);
    renderer.render(scene, camera);
    thumbs[key2] = renderer.domElement.toDataURL('image/png');

    scene.remove(built.group);
    built.group.traverse((node) => {
      node.geometry?.dispose();
      const mat = node.material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
    });
  }

  probe.dispose();
  pmrem.dispose();
  renderer.dispose();
  renderer.forceContextLoss();
  return thumbs;
}
