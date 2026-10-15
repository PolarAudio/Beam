import * as THREE from 'three';

/**
 * @file The colour of every surface the camera sees, as a screen-sized
 * texture.
 *
 * The projector and laser passes add their light after the scene is drawn, so
 * they have no material to read. This draws the scene once more with each lit
 * material replaced by its diffuse colour, unlit, and the passes multiply the
 * light they add by it: a grey wall returns less of the picture than a white
 * one.
 *
 * Drawn only while a projector is throwing or a laser is in the scene.
 */

/** Unlit stand-ins for lit materials, by source material. */
const standIns = new WeakMap();

/** What an opaque unlit surface reflects: nothing it is not already emitting. */
const BLACK = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide });

const scratchSize = new THREE.Vector2();
const previousColour = new THREE.Color();

function isLit(material) {
  return !!(material.isMeshStandardMaterial || material.isMeshLambertMaterial
    || material.isMeshPhongMaterial || material.isMeshToonMaterial);
}

/**
 * The stand-in for one material, brought up to date with it.
 *
 * @param {THREE.Material} material
 * @returns {THREE.Material|null} null when the surface is not drawn
 */
function standInFor(material) {
  if (!material || !material.visible) return null;
  if (!isLit(material)) {
    // Beams, glows, gizmos and anything else transparent are not surfaces.
    // Shader materials may place their geometry themselves, which a stand-in
    // would not reproduce.
    if (material.transparent || !material.depthWrite) return null;
    return material.isMeshBasicMaterial ? BLACK : null;
  }
  let standIn = standIns.get(material);
  if (!standIn) {
    standIn = new THREE.MeshBasicMaterial();
    standIns.set(material, standIn);
  }
  standIn.color.copy(material.color);
  // A metal's colour is its reflection; its diffuse part is what is left.
  if (material.isMeshStandardMaterial) standIn.color.multiplyScalar(1 - (material.metalness || 0));
  standIn.map = material.map || null;
  standIn.alphaMap = material.alphaMap || null;
  standIn.alphaTest = material.alphaTest;
  standIn.vertexColors = material.vertexColors;
  standIn.side = material.side;
  standIn.transparent = material.transparent;
  standIn.opacity = material.opacity;
  standIn.depthWrite = material.depthWrite;
  standIn.depthTest = material.depthTest;
  return standIn;
}

const SurfaceAlbedo = {
  target: null,

  /**
   * Draws the albedo of what `camera` sees into a target the size of the
   * drawing buffer.
   *
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   * @returns {THREE.Texture}
   */
  render(renderer, scene, camera) {
    renderer.getDrawingBufferSize(scratchSize);
    const width = Math.max(1, Math.floor(scratchSize.x));
    const height = Math.max(1, Math.floor(scratchSize.y));
    if (!this.target) {
      this.target = new THREE.WebGLRenderTarget(width, height, {
        type: THREE.HalfFloatType,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
      });
    } else if (this.target.width !== width || this.target.height !== height) {
      this.target.setSize(width, height);
    }

    const swapped = [];
    const hidden = [];
    scene.traverse((object) => {
      if (!object.visible) return;
      if (object.isLine || object.isPoints || object.isSprite) {
        object.visible = false;
        hidden.push(object);
        return;
      }
      if (!object.isMesh) return;
      const { material } = object;
      if (Array.isArray(material)) {
        const list = material.map((entry) => standInFor(entry) || BLACK);
        swapped.push([object, material]);
        object.material = list;
        return;
      }
      const standIn = standInFor(material);
      if (!standIn) {
        object.visible = false;
        hidden.push(object);
        return;
      }
      swapped.push([object, material]);
      object.material = standIn;
    });

    const wasTarget = renderer.getRenderTarget();
    const wasBackground = scene.background;
    const wasOverride = scene.overrideMaterial;
    const wasAlpha = renderer.getClearAlpha();
    renderer.getClearColor(previousColour);
    const wasToneMapping = renderer.toneMapping;
    const wasShadowUpdate = renderer.shadowMap.autoUpdate;
    try {
      scene.background = null;
      scene.overrideMaterial = null;
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.shadowMap.autoUpdate = false;
      renderer.setClearColor(0x000000, 0);
      renderer.setRenderTarget(this.target);
      renderer.clear(true, true, false);
      renderer.render(scene, camera);
    } finally {
      renderer.setRenderTarget(wasTarget);
      renderer.setClearColor(previousColour, wasAlpha);
      renderer.toneMapping = wasToneMapping;
      renderer.shadowMap.autoUpdate = wasShadowUpdate;
      scene.background = wasBackground;
      scene.overrideMaterial = wasOverride;
      swapped.forEach(([object, material]) => { object.material = material; });
      hidden.forEach((object) => { object.visible = true; });
    }
    return this.target.texture;
  },
};

export default SurfaceAlbedo;
