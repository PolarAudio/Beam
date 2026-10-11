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
 */

/** Displays averaged at once; more than this keep their last colour. */
const SLOTS = 16;

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
  },
};

export default DisplayLight;
