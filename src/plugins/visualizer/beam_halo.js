/**
 * @file The light the beams scatter a second time: the glow in the air
 * beside a beam.
 *
 * A beam is drawn from single scattering -- light leaving the lens, scattered
 * once by the haze towards the eye. That alone leaves the air one centimetre
 * outside the cone black, and where two beams cross, the stretch where only
 * one of them falls off towards its edge reads as a dark line beside the
 * bright overlap. Real haze scatters the beam's light again: the air beside
 * a real beam is lit, and crossing beams show no line.
 *
 * The beam scatters sigma of its light per metre, in every direction. Treated
 * as a line source, that lights the air at a distance rho with sigma P / 4 rho;
 * the air scatters it again with sigma. Seen in projection, the second
 * scattering spreads each beam's single-scattered light over the screen with
 * a kernel
 *
 *     K(rho) = sigma e^(-sigma rho) / (2 pi rho)
 *
 * in metres at the beam's distance -- one over rho, and gone where the haze
 * has absorbed what was scattered. Its integral is 1 - e^(-sigma rho): the
 * glow carries the share of the light the haze scatters again, nothing set
 * by eye. One over rho is a sum of normalised Gaussians, equal weight per
 * unit of width, so the kernel is built from a chain of blur levels, each
 * weighted by the stretch of widths it stands for and the extinction at its
 * width.
 *
 * The source is the beams drawn a second time with the isotropic phase --
 * the halo is lit by all the light the beam scatters, not by what happens to
 * head for the eye -- into a target a quarter of the frame's size, where it
 * costs a sixteenth of the beams. Its alpha carries luminance times distance,
 * so every level knows how far away the light it holds is and how many
 * metres one of its texels spans. Pools, LEDs, lasers and projectors are not
 * in it; it touches the beams' air and nothing else.
 *
 * The kernel is cut off at the rig's reach: light scattered out of a beam
 * that meets a wall before it is scattered again lights the wall, not the
 * air. Beam has no walls to ask, so the reach is taken from the rig itself,
 * half the span of its lights plus a margin, which is the room a rig is in
 * more often than not.
 */
import * as THREE from 'three';
import { Effect, BlendFunction } from 'postprocessing';
import Light, { HAZE_SCATTER_AT_FULL } from './light';
import SceneEnv from './scene_env';

/** The source's size against the frame's, per side. */
const HALO_SOURCE_DIVISOR = 4;

/** Levels stop halving once the smaller side would drop below this, in texels. */
const HALO_SMALLEST_SIDE = 4;

/** The halo's reach beyond half the rig's span, and its least, in metres. */
const HALO_REACH_MARGIN = 2;
const HALO_REACH_MIN = 3;

const QUAD_VERTEX = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/**
 * Halves a level: four bilinear reads at the corners of the destination
 * texel, a 4 x 4 box of the level above. Colour and alpha both, so the
 * luminance-weighted distance averages with the light it belongs to.
 */
const DOWN_FRAGMENT = /* glsl */`
  uniform sampler2D source;
  uniform vec2 texel;
  varying vec2 vUv;
  void main() {
    vec4 sum = texture2D(source, vUv + vec2(-texel.x, -texel.y))
      + texture2D(source, vUv + vec2(texel.x, -texel.y))
      + texture2D(source, vUv + vec2(-texel.x, texel.y))
      + texture2D(source, vUv + vec2(texel.x, texel.y));
    gl_FragColor = sum * 0.25;
  }
`;

/**
 * One step of the sum, coarsest level first: this level's light weighted by
 * the stretch of kernel widths it stands for, plus everything coarser,
 * brought up with a tent filter so no level's texels show.
 */
const UP_FRAGMENT = /* glsl */`
  uniform sampler2D level;
  uniform sampler2D coarser;
  uniform bool hasCoarser;
  uniform vec2 coarserTexel;
  uniform float levelPixels;   // full-frame pixels one texel of this level spans
  uniform float firstLevel;    // 1 for the finest level, which stands for widths from 0
  uniform float sigma;         // scattering coefficient, per metre
  uniform bool ortho;
  uniform float metresPerPixelPerMetre;  // perspective: metres per full-frame pixel, per metre of distance
  uniform float metresPerPixel;          // orthographic: metres per full-frame pixel
  uniform float reach;                   // where the room ends the kernel, metres
  varying vec2 vUv;

  vec3 tent(vec2 uv) {
    vec2 t = coarserTexel;
    vec3 sum = texture2D(coarser, uv).rgb * 4.0;
    sum += (texture2D(coarser, uv + vec2(t.x, 0.0)).rgb
      + texture2D(coarser, uv - vec2(t.x, 0.0)).rgb
      + texture2D(coarser, uv + vec2(0.0, t.y)).rgb
      + texture2D(coarser, uv - vec2(0.0, t.y)).rgb) * 2.0;
    sum += texture2D(coarser, uv + t).rgb
      + texture2D(coarser, uv - t).rgb
      + texture2D(coarser, uv + vec2(t.x, -t.y)).rgb
      + texture2D(coarser, uv + vec2(-t.x, t.y)).rgb;
    return sum / 16.0;
  }

  void main() {
    vec4 here = texture2D(level, vUv);
    float luminance = dot(here.rgb, vec3(0.2126, 0.7152, 0.0722));
    vec3 sum = hasCoarser ? tent(vUv) : vec3(0.0);
    if (luminance > 1e-6) {
      float distance = here.a / luminance;
      float perPixel = ortho ? metresPerPixel : metresPerPixelPerMetre * distance;
      // The level's width in metres where its light is, the stretch of widths
      // it stands for (half its width, the next finer level holding the
      // rest; the finest one all of it), and the extinction at that width.
      float width = levelPixels * perPixel;
      float stretch = width * mix(0.5, 1.0, firstLevel);
      // sqrt(2 / pi): a normalised Gaussian of width s, summed over s with
      // unit weight, is 1 / (2 pi rho) times this.
      float weight = sigma * 0.7978845608 * stretch * exp(-sigma * width)
        * (1.0 - smoothstep(0.6 * reach, reach, width));
      sum += here.rgb * weight;
    }
    gl_FragColor = vec4(sum, 1.0);
  }
`;

/** Adds the summed halo to the frame. */
const COMPOSITE_FRAGMENT = /* glsl */`
  uniform sampler2D halo;
  uniform float strength;
  void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
    outputColor = vec4(texture2D(halo, uv).rgb * strength, 1.0);
  }
`;

function target(width, height) {
  return new THREE.WebGLRenderTarget(width, height, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
  });
}

/**
 * @class BeamHaloEffect
 * @classdesc Adds the beams' second scattering to the frame.
 * @extends Effect
 */
export default class BeamHaloEffect extends Effect {
  /**
   * @param {THREE.Camera} camera the camera the scene is rendered with
   */
  constructor(camera) {
    super('BeamHaloEffect', COMPOSITE_FRAGMENT, {
      blendFunction: BlendFunction.ADD,
      uniforms: new Map([
        ['halo', new THREE.Uniform(null)],
        ['strength', new THREE.Uniform(0)],
      ]),
    });
    this.camera = camera;
    /** Off draws nothing and costs nothing, for comparing and as a rollback. */
    this.on = true;
    this.levels = [];
    this.sums = [];
    this.quadScene = new THREE.Scene();
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
    this.downMaterial = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERTEX,
      fragmentShader: DOWN_FRAGMENT,
      uniforms: { source: { value: null }, texel: { value: new THREE.Vector2() } },
      depthTest: false,
      depthWrite: false,
    });
    this.upMaterial = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERTEX,
      fragmentShader: UP_FRAGMENT,
      uniforms: {
        level: { value: null },
        coarser: { value: null },
        hasCoarser: { value: false },
        coarserTexel: { value: new THREE.Vector2() },
        levelPixels: { value: 1 },
        firstLevel: { value: 0 },
        sigma: { value: 0 },
        ortho: { value: false },
        metresPerPixelPerMetre: { value: 0 },
        metresPerPixel: { value: 0 },
        reach: { value: HALO_REACH_MIN },
      },
      depthTest: false,
      depthWrite: false,
    });
  }

  /**
   * Builds the level chain for a frame of this size, once per size.
   *
   * @private
   */
  fit(width, height) {
    const w = Math.max(1, Math.round(width / HALO_SOURCE_DIVISOR));
    const h = Math.max(1, Math.round(height / HALO_SOURCE_DIVISOR));
    if (this.levels.length && this.levels[0].width === w && this.levels[0].height === h) return;
    this.freeLevels();
    let lw = w;
    let lh = h;
    do {
      this.levels.push(target(lw, lh));
      this.sums.push(target(lw, lh));
      lw = Math.max(1, Math.floor(lw / 2));
      lh = Math.max(1, Math.floor(lh / 2));
    } while (Math.min(lw, lh) >= HALO_SMALLEST_SIDE);
  }

  /**
   * Per-frame: draws the source, halves it down the chain and sums the
   * levels back up, so the composite reads one texture.
   *
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.WebGLRenderTarget} inputBuffer
   */
  update(renderer, inputBuffer) {
    const sigma = SceneEnv.hazeEnabled ? HAZE_SCATTER_AT_FULL * SceneEnv.hazeAmount : 0;
    const strength = this.uniforms.get('strength');
    if (!this.on || sigma <= 0 || !this.camera) {
      strength.value = 0;
      return;
    }
    this.fit(inputBuffer.width, inputBuffer.height);
    const source = this.levels[0];
    const fragScale = inputBuffer.height / source.height;
    if (!Light.renderHaloSource(renderer, this.camera, source, fragScale)) {
      strength.value = 0;
      return;
    }

    this.quad.material = this.downMaterial;
    for (let i = 1; i < this.levels.length; i++) {
      const from = this.levels[i - 1];
      this.downMaterial.uniforms.source.value = from.texture;
      this.downMaterial.uniforms.texel.value.set(1 / from.width, 1 / from.height);
      renderer.setRenderTarget(this.levels[i]);
      renderer.render(this.quadScene, this.quadCamera);
    }

    const u = this.upMaterial.uniforms;
    const cam = this.camera;
    u.sigma.value = sigma;
    u.reach.value = BeamHaloEffect.reach();
    u.ortho.value = !!cam.isOrthographicCamera;
    if (cam.isOrthographicCamera) {
      u.metresPerPixel.value = (cam.top - cam.bottom) / cam.zoom / inputBuffer.height;
    } else {
      u.metresPerPixelPerMetre.value = (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2))
        / cam.zoom / inputBuffer.height;
    }
    this.quad.material = this.upMaterial;
    for (let i = this.levels.length - 1; i >= 0; i--) {
      const level = this.levels[i];
      u.level.value = level.texture;
      u.hasCoarser.value = i < this.levels.length - 1;
      if (u.hasCoarser.value) {
        const coarser = this.sums[i + 1];
        u.coarser.value = coarser.texture;
        u.coarserTexel.value.set(1 / coarser.width, 1 / coarser.height);
      }
      u.levelPixels.value = inputBuffer.height / level.height;
      u.firstLevel.value = i === 0 ? 1 : 0;
      renderer.setRenderTarget(this.sums[i]);
      renderer.render(this.quadScene, this.quadCamera);
    }

    this.uniforms.get('halo').value = this.sums[0].texture;
    strength.value = 1;
  }

  /**
   * How far the halo's light can travel before the room stops it, in
   * metres: half the span of the rig's lights plus a margin.
   *
   * @private
   * @returns {Number}
   */
  static reach() {
    const lo = new THREE.Vector3(Infinity, Infinity, Infinity);
    const hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    let any = false;
    Light.eachSelectable((handle, position) => {
      lo.min(position);
      hi.max(position);
      any = true;
    });
    if (!any) return HALO_REACH_MIN;
    return Math.max(HALO_REACH_MIN, lo.distanceTo(hi) / 2 + HALO_REACH_MARGIN);
  }

  /** Frees the level chain. */
  freeLevels() {
    this.levels.forEach((t) => t.dispose());
    this.sums.forEach((t) => t.dispose());
    this.levels = [];
    this.sums = [];
  }

  /** Frees the level chain and the effect. */
  dispose() {
    this.freeLevels();
    this.downMaterial.dispose();
    this.upMaterial.dispose();
    this.quad.geometry.dispose();
    super.dispose();
  }
}
