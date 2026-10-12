import * as THREE from 'three';

/**
 * @file Each display's picture as one colour, for the light it throws into
 * the room.
 *
 * Spill on a floor is soft, so the picture's average is what matters: 4096
 * samples of the full-size picture, jittered so a fine pattern cannot line up
 * with them, averaged into one pixel per display and read back asynchronously.
 * The frame never waits for it, and the colour a display lights the room with
 * is a frame or two behind its picture. Mip levels are not used: they are
 * averaged in gamma, which reads a picture of fine contrast low, and halving an
 * odd size keeps only the middle.
 *
 * Each display's panel is also drawn, linear, into a tile of a mipmapped
 * atlas. The light field reads a point's colour from it, centred on the part
 * of the panel nearest the point and blurred by the point's distance, so a
 * point near the red half of a picture is lit red. Tiles are a power of two
 * and aligned, so every mip level averages within one tile.
 */

/** Displays averaged at once; more than this keep their last colour. */
const SLOTS = 16;

/** Atlas tiles across; SLOTS of them in all. Matches FIELD_PICTURE_GRID. */
const GRID = 4;

/** Atlas tile size, texels. Matches FIELD_PICTURE_TILE. */
const TILE = 128;

// The panel into its tile: (0,0) to (1,1) of the panel is read through the
// display's picture mapping, black outside the picture's bounds, four
// samples per texel.
const tileMaterial = new THREE.ShaderMaterial({
  uniforms: {
    map: { value: null },
    origin: { value: new THREE.Vector2(0, 0) },
    axisX: { value: new THREE.Vector2(1, 0) },
    axisY: { value: new THREE.Vector2(0, 1) },
    bounds: { value: new THREE.Vector4(0, 0, 1, 1) },
  },
  vertexShader: /* glsl */`
    varying vec2 vPanel;
    void main() {
      vPanel = position.xy * 0.5 + 0.5;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D map;
    uniform vec2 origin;
    uniform vec2 axisX;
    uniform vec2 axisY;
    uniform vec4 bounds;
    varying vec2 vPanel;
    vec3 at(vec2 panel) {
      vec2 uv = origin + panel.x * axisX + panel.y * axisY;
      float inside = step(bounds.x, uv.x) * step(uv.x, bounds.z)
        * step(bounds.y, uv.y) * step(uv.y, bounds.w);
      return inside * textureLod(map, uv, 0.0).rgb;
    }
    void main() {
      vec2 d = vec2(0.25 / 128.0);
      vec3 sum = at(vPanel + vec2(-d.x, -d.y)) + at(vPanel + vec2(d.x, -d.y))
        + at(vPanel + vec2(-d.x, d.y)) + at(vPanel + vec2(d.x, d.y));
      gl_FragColor = vec4(sum * 0.25, 1.0);
    }
  `,
  depthTest: false,
  depthWrite: false,
  toneMapped: false,
});
const tileQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), tileMaterial);
tileQuad.frustumCulled = false;
const tileScene = new THREE.Scene();
tileScene.add(tileQuad);

let atlas = null;
const slots = new Map();

/**
 * The texture the light field reads pictures from; null until the first
 * display lights. Shared by reference with the field's uniform.
 */
const atlasUniform = { value: null };

const material = new THREE.ShaderMaterial({
  uniforms: {
    map: { value: null },
  },
  vertexShader: /* glsl */`
    void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D map;
    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
    }
    void main() {
      vec3 sum = vec3(0.0);
      for (int y = 0; y < 64; y++) {
        for (int x = 0; x < 64; x++) {
          vec2 cell = vec2(float(x), float(y));
          vec2 jitter = vec2(hash(cell), hash(cell + 17.0));
          sum += textureLod(map, (cell + jitter) / 64.0, 0.0).rgb;
        }
      }
      gl_FragColor = vec4(sum / 4096.0, 1.0);
    }
  `,
  depthTest: false,
  depthWrite: false,
  toneMapped: false,
});
const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
quad.frustumCulled = false;
const scene = new THREE.Scene();
scene.add(quad);
const camera = new THREE.Camera();

let target = null;
const pixels = new Float32Array(SLOTS * 4);
let pending = false;
const averages = new Map();

const DisplayLight = {
  /**
   * Averages each display's picture. Starts a read when none is in flight.
   *
   * @public
   * @param {THREE.WebGLRenderer} renderer
   * @param {Array} entries `{ owner, texture }`, the decoded picture
   */
  update(renderer, entries) {
    DisplayLight.drawAtlas(renderer, entries);
    if (pending || !entries.length || !renderer.readRenderTargetPixelsAsync) return;
    if (!target) {
      target = new THREE.WebGLRenderTarget(SLOTS, 1, {
        type: THREE.FloatType, depthBuffer: false,
      });
    }
    const owners = entries.slice(0, SLOTS);
    const previous = renderer.getRenderTarget();
    const { autoClear } = renderer;
    try {
      renderer.autoClear = false;
      target.scissorTest = true;
      owners.forEach(({ texture }, k) => {
        material.uniforms.map.value = texture;
        target.viewport.set(k, 0, 1, 1);
        target.scissor.set(k, 0, 1, 1);
        renderer.setRenderTarget(target);
        renderer.render(scene, camera);
      });
    } finally {
      target.scissorTest = false;
      target.viewport.set(0, 0, SLOTS, 1);
      target.scissor.set(0, 0, SLOTS, 1);
      renderer.autoClear = autoClear;
      renderer.setRenderTarget(previous);
      material.uniforms.map.value = null;
    }
    pending = true;
    renderer.readRenderTargetPixelsAsync(target, 0, 0, SLOTS, 1, pixels).then(() => {
      owners.forEach(({ owner }, k) => {
        const colour = averages.get(owner) || new THREE.Color();
        colour.setRGB(pixels[k * 4], pixels[k * 4 + 1], pixels[k * 4 + 2]);
        averages.set(owner, colour);
      });
    }).catch(() => {}).finally(() => {
      pending = false;
    });
  },

  /**
   * Draws each display's panel into its atlas tile and rebuilds the mips
   * once, after the last tile.
   *
   * @public
   * @param {THREE.WebGLRenderer} renderer
   * @param {Array} entries `{ owner, texture, frame }`
   */
  drawAtlas(renderer, entries) {
    slots.clear();
    const owners = entries.filter((entry) => entry.frame).slice(0, SLOTS);
    if (!owners.length) return;
    if (!atlas) {
      atlas = new THREE.WebGLRenderTarget(GRID * TILE, GRID * TILE, {
        type: THREE.HalfFloatType,
        depthBuffer: false,
        minFilter: THREE.LinearMipmapLinearFilter,
        magFilter: THREE.LinearFilter,
        generateMipmaps: true,
      });
      atlasUniform.value = atlas.texture;
    }
    const previous = renderer.getRenderTarget();
    const { autoClear } = renderer;
    try {
      renderer.autoClear = false;
      atlas.scissorTest = true;
      owners.forEach(({ owner, texture, frame }, k) => {
        const x = (k % GRID) * TILE;
        const y = Math.floor(k / GRID) * TILE;
        tileMaterial.uniforms.map.value = texture;
        tileMaterial.uniforms.origin.value.copy(frame.origin);
        tileMaterial.uniforms.axisX.value.copy(frame.axisX);
        tileMaterial.uniforms.axisY.value.copy(frame.axisY);
        tileMaterial.uniforms.bounds.value.copy(frame.bounds);
        // three rebuilds a target's mips after every render into it.
        atlas.texture.generateMipmaps = k === owners.length - 1;
        atlas.viewport.set(x, y, TILE, TILE);
        atlas.scissor.set(x, y, TILE, TILE);
        renderer.setRenderTarget(atlas);
        renderer.render(tileScene, camera);
        slots.set(owner, k);
      });
    } finally {
      atlas.texture.generateMipmaps = true;
      atlas.scissorTest = false;
      atlas.viewport.set(0, 0, GRID * TILE, GRID * TILE);
      atlas.scissor.set(0, 0, GRID * TILE, GRID * TILE);
      renderer.autoClear = autoClear;
      renderer.setRenderTarget(previous);
      tileMaterial.uniforms.map.value = null;
    }
  },

  /**
   * @public
   * @param {Object} owner
   * @returns {Number} the display's atlas tile this frame, -1 for none
   */
  slotOf(owner) {
    const slot = slots.get(owner);
    return slot === undefined ? -1 : slot;
  },

  /** The atlas uniform, for the light field. */
  atlasUniform,

  /**
   * @public
   * @param {Object} owner
   * @returns {THREE.Color|null} the picture's average, linear, or null before the first read
   */
  averageOf(owner) {
    return averages.get(owner) || null;
  },

  /** @public */
  forget(owner) {
    averages.delete(owner);
    slots.delete(owner);
  },
};

export default DisplayLight;
