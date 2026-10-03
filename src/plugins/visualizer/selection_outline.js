import * as THREE from 'three';
import { Effect, BlendFunction } from 'postprocessing';

/**
 * @file The selection outline: an orange line round whatever is selected,
 * which is otherwise drawn exactly as it is unselected.
 *
 * Each frame the selected things are drawn flat into a mask, and the outline
 * effect paints the band just outside the mask's edge. A part hidden behind
 * other geometry is left out of the mask, so the line follows what can be
 * seen, as a modelling program's does.
 *
 * Renderers say what is selected in one of two ways. A plain object, a
 * projector's body or a bar's box, is outlined through `setOutlined` with the
 * meshes that stand for it. The lights' bodies are instanced, a hundred heads
 * in one mesh, so they cannot be named one by one; their meshes carry a
 * per-slot `highlight` attribute, and `addInstancedSource` hands the outline
 * those meshes, of which it draws only the slots marked.
 */

/** The outline's colour, as sRGB; three takes it to linear. */
const OUTLINE_COLOUR = '#ff8c1a';

/** How far the line reaches out from the edge, in pixels. */
const OUTLINE_WIDTH = 2;

/**
 * How far behind the visible surface, in metres, a selected surface may be
 * and still count as seen: the depth it is tested against is a resolved,
 * multisampled buffer, which is not exactly its own depth.
 */
const DEPTH_TOLERANCE = 0.05;

const MASK_VERTEX = /* glsl */`
  #ifdef USE_HIGHLIGHT
    attribute float highlight;
    varying float vSelected;
  #endif

  void main() {
    vec4 local = vec4(position, 1.0);
    #ifdef USE_INSTANCING
      local = instanceMatrix * local;
    #endif
    #ifdef USE_HIGHLIGHT
      vSelected = highlight;
    #endif
    gl_Position = projectionMatrix * modelViewMatrix * local;
  }
`;

const MASK_FRAGMENT = /* glsl */`
  #include <packing>

  uniform sampler2D sceneDepth;
  uniform bool hasDepth;
  uniform vec2 resolution;
  uniform float cameraNear;
  uniform float cameraFar;
  uniform float tolerance;

  #ifdef USE_HIGHLIGHT
    varying float vSelected;
  #endif

  void main() {
    #ifdef USE_HIGHLIGHT
      if (vSelected < 0.5) discard;
    #endif
    // Hidden behind something else: not part of what is seen.
    if (hasDepth) {
      float stored = texture2D(sceneDepth, gl_FragCoord.xy / resolution).x;
      if (stored > 0.0 && stored < 1.0) {
        float seen = perspectiveDepthToViewZ(stored, cameraNear, cameraFar);
        float here = perspectiveDepthToViewZ(gl_FragCoord.z, cameraNear, cameraFar);
        if (here < seen - tolerance) discard;
      }
    }
    gl_FragColor = vec4(1.0);
  }
`;

// The library prefixes an effect's uniform names wherever they occur in the
// merged shader, so these are names no other effect uses.
const OUTLINE_FRAGMENT = /* glsl */`
  uniform sampler2D outlineMask;
  uniform vec3 outlineColour;
  uniform vec2 outlineTexel;
  uniform bool outlineActive;

  // Whether a pixel is part of the selection. The mask leaves odd single
  // pixels out along the selection's own inner edges, where one part stands
  // in front of another and the resolved scene depth at that pixel is the
  // nearer part's; a pixel the mask missed but that its neighbours mostly
  // cover is taken as covered, so those gaps are not outlined. A real opening
  // is wider than a pixel and keeps its line.
  bool outlineCovered(vec2 uv) {
    if (texture2D(outlineMask, uv).r > 0.5) return true;
    int around = 0;
    for (int x = -1; x <= 1; x++) {
      for (int y = -1; y <= 1; y++) {
        if (x == 0 && y == 0) continue;
        if (texture2D(outlineMask, uv + vec2(float(x), float(y)) * outlineTexel).r > 0.5) around++;
      }
    }
    return around >= 5;
  }

  void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
    outputColor = inputColor;
    if (!outlineActive || outlineCovered(uv)) return;
    // Inside the reach of the mask's edge: the line.
    float edge = 0.0;
    for (int x = -OUTLINE_REACH; x <= OUTLINE_REACH; x++) {
      for (int y = -OUTLINE_REACH; y <= OUTLINE_REACH; y++) {
        if (x * x + y * y > OUTLINE_REACH * OUTLINE_REACH + 1) continue;
        edge = max(edge, texture2D(outlineMask, uv + vec2(float(x), float(y)) * outlineTexel).r);
      }
    }
    outputColor = vec4(mix(inputColor.rgb, outlineColour, edge), inputColor.a);
  }
`;

/** Shared by every mask material. */
const maskUniforms = {
  sceneDepth: { value: null },
  hasDepth: { value: false },
  resolution: { value: new THREE.Vector2(1, 1) },
  cameraNear: { value: 0.1 },
  cameraFar: { value: 1000 },
  tolerance: { value: DEPTH_TOLERANCE },
};

const maskMaterial = (highlight) => new THREE.ShaderMaterial({
  vertexShader: MASK_VERTEX,
  fragmentShader: MASK_FRAGMENT,
  uniforms: maskUniforms,
  defines: highlight ? { USE_HIGHLIGHT: '' } : {},
  side: THREE.DoubleSide,
  depthTest: false,
  depthWrite: false,
});

/** For a plain mesh, all of it. */
const PLAIN_MASK = maskMaterial(false);
/** For an instanced mesh with a `highlight` attribute, the slots marked. */
const HIGHLIGHT_MASK = maskMaterial(true);

/** Things outlined by name, each with the meshes that stand for it. */
const outlined = new Map();
/** Functions answering the instanced meshes to draw by their `highlight`. */
const instancedSources = [];

/**
 * Outlines a thing, or stops.
 *
 * @public
 * @param {Object} owner whatever is selected, a key
 * @param {Boolean} state
 * @param {Array<THREE.Mesh>} [meshes] what stands for it; required to outline
 */
export function setOutlined(owner, state, meshes = []) {
  if (state && meshes.length) outlined.set(owner, meshes);
  else outlined.delete(owner);
}

/**
 * Adds instanced meshes drawn by their per-slot `highlight` attribute.
 *
 * @public
 * @param {Function} source answering an array of InstancedMesh, empty when
 *   nothing of the source's is selected
 */
export function addInstancedSource(source) {
  if (!instancedSources.includes(source)) instancedSources.push(source);
}

/**
 * Hands the mask the depth of what is seen, so a part behind something
 * else is left out.
 *
 * @public
 * @param {THREE.DepthTexture} texture the composer's scene depth
 * @param {THREE.Camera} camera for its near and far planes
 */
export function setSceneDepth(texture, camera) {
  maskUniforms.sceneDepth.value = texture;
  maskUniforms.hasDepth.value = !!texture;
  maskUniforms.cameraNear.value = camera.near;
  maskUniforms.cameraFar.value = camera.far;
}

/** Scratch for the renderer state the mask render borrows. */
const clearColour = new THREE.Color();

export class SelectionOutlineEffect extends Effect {
  /**
   * @param {THREE.Camera} camera the view the outline is drawn for
   */
  constructor(camera) {
    super('SelectionOutlineEffect', OUTLINE_FRAGMENT, {
      blendFunction: BlendFunction.NORMAL,
      defines: new Map([['OUTLINE_REACH', String(OUTLINE_WIDTH)]]),
      uniforms: new Map([
        ['outlineMask', new THREE.Uniform(null)],
        ['outlineColour', new THREE.Uniform(new THREE.Color(OUTLINE_COLOUR))],
        ['outlineTexel', new THREE.Uniform(new THREE.Vector2(1, 1))],
        ['outlineActive', new THREE.Uniform(false)],
      ]),
    });
    this.camera = camera;
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      depthBuffer: false,
      type: THREE.UnsignedByteType,
    });
    this.uniforms.get('outlineMask').value = this.target.texture;
  }

  /**
   * Draws this frame's mask: every outlined thing, flat, where it is seen.
   * Nothing selected costs nothing.
   *
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.WebGLRenderTarget} inputBuffer
   */
  update(renderer, inputBuffer) {
    const instanced = instancedSources.flatMap((source) => source());
    const active = outlined.size > 0 || instanced.length > 0;
    this.uniforms.get('outlineActive').value = active;
    if (!active) return;

    const { width, height } = inputBuffer;
    if (this.target.width !== width || this.target.height !== height) {
      this.target.setSize(width, height);
      this.uniforms.get('outlineTexel').value.set(1 / width, 1 / height);
    }
    maskUniforms.resolution.value.set(width, height);

    const previousTarget = renderer.getRenderTarget();
    const previousAlpha = renderer.getClearAlpha();
    renderer.getClearColor(clearColour);
    const { autoClear } = renderer;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);

    // Drawn on its own, a mesh ignores its parents' visibility; a hidden
    // fixture, or a part of one that is switched off, has no outline.
    const shown = (object) => {
      for (let o = object; o; o = o.parent) if (!o.visible) return false;
      return true;
    };
    const draw = (mesh, material) => {
      if (!shown(mesh)) return;
      const own = mesh.material;
      mesh.material = material;
      renderer.render(mesh, this.camera);
      mesh.material = own;
    };
    outlined.forEach((meshes) => meshes.forEach((mesh) => draw(mesh, PLAIN_MASK)));
    instanced.forEach((mesh) => draw(mesh, HIGHLIGHT_MASK));

    renderer.setRenderTarget(previousTarget);
    renderer.setClearColor(clearColour, previousAlpha);
    renderer.autoClear = autoClear;
  }

  dispose() {
    this.target.dispose();
    super.dispose();
  }
}
