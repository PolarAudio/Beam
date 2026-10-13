import * as THREE from 'three';
import SceneObjects from './scene_objects';

/**
 * @file A hidden-line drawing of the scene's objects from an orthographic
 * camera, for the patch sheet's views.
 *
 * The objects are drawn twice into float targets, once as view normals and
 * once as depth, from proxies that share the live geometry and instance
 * matrices. Lines are where coverage, depth or normal change from one pixel
 * to the next, so only what the camera sees is drawn and curved silhouettes
 * come out as well as creases.
 */

/** Faces meeting at more than this, in degrees, draw a line. */
const CREASE_DEG = 25;
/** A step in depth, in metres, past which two neighbouring pixels draw a line. */
const DEPTH_STEP_M = 0.02;
/** Fill of a covered pixel: white, a little see-through so the grid shows. */
const FILL = [255, 255, 255, 205];
const INK = [26, 26, 26, 255];

/**
 * Proxies for every placed object's instanced meshes, drawn with `material`.
 *
 * @param {THREE.Material} material
 * @returns {THREE.Scene}
 */
function proxyScene(material) {
  const scene = new THREE.Scene();
  SceneObjects.pickObjects().forEach((live) => {
    if (!live.isInstancedMesh || !live.count) return;
    live.updateMatrixWorld(true);
    const proxy = new THREE.InstancedMesh(live.geometry, material, live.count);
    proxy.instanceMatrix = live.instanceMatrix;
    proxy.count = live.count;
    proxy.matrixAutoUpdate = false;
    proxy.matrix.copy(live.matrixWorld);
    proxy.frustumCulled = false;
    scene.add(proxy);
  });
  scene.updateMatrixWorld(true);
  return scene;
}

/**
 * The orthographic camera for a layout.
 *
 * @param {Object} layout see `drawObjects`
 * @returns {THREE.OrthographicCamera}
 */
function cameraFor(layout) {
  const forward = new THREE.Vector3(...layout.forward);
  const up = new THREE.Vector3(...layout.up);
  const right = forward.clone().cross(up);
  const cu = (layout.minU + layout.maxU) / 2;
  const cv = (layout.minV + layout.maxV) / 2;
  const halfU = (layout.maxU - layout.minU) / 2;
  const halfV = (layout.maxV - layout.minV) / 2;
  // Placed a metre before the nearest point, looking along `forward`.
  const back = layout.minD - 1;
  const far = layout.maxD - back + 1;
  const camera = new THREE.OrthographicCamera(-halfU, halfU, halfV, -halfV, 0.01, far);
  camera.position.copy(right.multiplyScalar(cu)).addScaledVector(up, cv)
    .addScaledVector(forward, back);
  camera.up.copy(up);
  camera.lookAt(camera.position.clone().add(forward));
  camera.updateMatrixWorld(true);
  return camera;
}

/**
 * Draws the scene's objects as a hidden-line drawing.
 *
 * @public
 * @param {Object} layout
 * @param {Array<Number>} layout.forward view direction, world
 * @param {Array<Number>} layout.up up on the page, world
 * @param {Number} layout.minU left edge, metres along forward x up
 * @param {Number} layout.maxU
 * @param {Number} layout.minV bottom edge, metres along up
 * @param {Number} layout.maxV
 * @param {Number} layout.minD nearest point of the scene, metres along forward
 * @param {Number} layout.maxD farthest point
 * @param {Number} layout.pixelsWide image width
 * @param {Number} layout.pixelsHigh image height
 * @returns {Object} `{ dataUrl, depthAt(u, v) }`; depthAt gives metres along
 *   forward to the nearest surface there, or Infinity over nothing
 */
function drawObjects(layout) {
  const width = Math.max(1, Math.round(layout.pixelsWide));
  const height = Math.max(1, Math.round(layout.pixelsHigh));
  const canvas = document.createElement('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true });
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  renderer.setClearColor(0x000000, 0);
  const target = new THREE.WebGLRenderTarget(width, height, {
    type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
  });
  const camera = cameraFor(layout);
  const normalMaterial = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide });
  const depthMaterial = new THREE.MeshDepthMaterial({
    side: THREE.DoubleSide, depthPacking: THREE.BasicDepthPacking,
  });
  const normals = new Float32Array(width * height * 4);
  const depths = new Float32Array(width * height * 4);
  try {
    const read = (material, out) => {
      const scene = proxyScene(material);
      renderer.setRenderTarget(target);
      renderer.clear();
      renderer.render(scene, camera);
      renderer.readRenderTargetPixels(target, 0, 0, width, height, out);
    };
    read(normalMaterial, normals);
    read(depthMaterial, depths);
  } finally {
    renderer.setRenderTarget(null);
    target.dispose();
    normalMaterial.dispose();
    depthMaterial.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
  }

  // Depth in metres from the camera; read rows run bottom to top.
  const span = camera.far - camera.near;
  const covered = (i) => normals[i * 4 + 3] > 0.5;
  const depth = (i) => camera.near + (1 - depths[i * 4]) * span;
  const cosCrease = Math.cos(THREE.MathUtils.degToRad(CREASE_DEG));
  const normalDot = (i, j) => {
    let dot = 0;
    for (let c = 0; c < 3; c += 1) {
      dot += (normals[i * 4 + c] * 2 - 1) * (normals[j * 4 + c] * 2 - 1);
    }
    return dot;
  };
  const edge = new Uint8Array(width * height);
  const mark = (i) => { edge[i] = 1; };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const pairs = [];
      if (x + 1 < width) pairs.push(i + 1);
      if (y + 1 < height) pairs.push(i + width);
      pairs.forEach((j) => {
        if (covered(i) !== covered(j)) {
          mark(covered(i) ? i : j);
        } else if (covered(i) && normalDot(i, j) < cosCrease) {
          mark(i);
          mark(j);
        }
      });
      // A step in depth: the second difference, so a sloping face is no edge.
      if (covered(i)) {
        const steps = [[1, x > 0 && x + 1 < width], [width, y > 0 && y + 1 < height]];
        steps.forEach(([step, inside]) => {
          if (!inside || !covered(i - step) || !covered(i + step)) return;
          const bend = depth(i - step) + depth(i + step) - 2 * depth(i);
          if (Math.abs(bend) > DEPTH_STEP_M) mark(i);
        });
      }
    }
  }

  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const context = out.getContext('2d');
  const image = context.createImageData(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const o = ((height - 1 - y) * width + x) * 4;
      let colour = null;
      if (edge[i]) colour = INK;
      else if (covered(i)) colour = FILL;
      if (colour) image.data.set(colour, o);
    }
  }
  context.putImageData(image, 0, 0);

  const depthAt = (u, v) => {
    const x = Math.floor(((u - layout.minU) / (layout.maxU - layout.minU)) * width);
    const y = Math.floor(((v - layout.minV) / (layout.maxV - layout.minV)) * height);
    if (x < 0 || y < 0 || x >= width || y >= height) return Infinity;
    const i = y * width + x;
    // Metres along forward, measured from the same origin as `minD`.
    return covered(i) ? layout.minD - 1 + depth(i) : Infinity;
  };
  return { dataUrl: out.toDataURL('image/png'), depthAt };
}

export default { drawObjects };
