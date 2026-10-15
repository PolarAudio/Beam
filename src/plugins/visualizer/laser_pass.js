import * as THREE from 'three';
import { Effect, EffectAttribute, BlendFunction } from 'postprocessing';
import { SCENE_PER_NIT } from './light_field';
import { FIGURE_CANDELA, FIGURE_PIXEL } from './laser_figure';

/**
 * @file Puts every laser's figure onto whatever the camera can see.
 *
 * The beam in the air is geometry, built in `laser.js` -- a fan of triangles
 * through the haze. This is the other half: where those beams land, the figure
 * has to appear *on* the stone. Two different questions, and they want two
 * different answers. A shaft through haze is a volume, best drawn as one; a
 * line painted across a facade is a picture, best projected.
 *
 * A full-screen pass rather than anything the scene's materials know about, for
 * the reasons `projector_pass` sets out at length and which apply unchanged
 * here: it scales with fixtures rather than with materials, overlapping lasers
 * add up and read as a hotspot the way real light does, and the frustum is ours
 * to define.
 *
 * **It reads two atlases, and they are not interchangeable.** The figure atlas
 * says *what* the laser is drawing at each point of its field; the depth atlas
 * says *how far away the first surface is* in that direction. The figure alone
 * would paint straight through the building onto whatever stood behind it --
 * light does not do that, and the depth test is what stops it. Both are tiled
 * the same way and read with the same frame coordinate, so one projection does
 * for both.
 *
 * The depth atlas here is the laser's own, which holds **linear metres over
 * far** rather than window depth -- so the comparison is a subtraction in
 * metres instead of undoing a perspective divide. See `projector_depth.js` for
 * why the laser's tiles are packed that way.
 *
 * **Photometric, as the projector is.** The figure atlas holds luminous
 * intensity, so a surface at distance d facing the aperture at angle a gets
 * I cos a / d^2 lux and shows rho E / pi cd/m2 for its colour rho.
 */

/** As many lasers as the atlases have tiles. */
const SLOTS = 16;

/**
 * How far past the first surface a fragment may sit and still count as lit.
 *
 * In metres, because the laser atlas is linear: a floor of this, plus what one
 * depth texel spans on the surface. A texel covers `texelTan` metres per metre
 * of distance, and a surface turned away from the aperture by angle a changes
 * depth by tan(a) times that across it -- at a glancing angle, more than any
 * fixed allowance, which cut whole texels out of the figure. Capped where a
 * surface is so nearly edge-on that it gets almost no light anyway.
 */
const DEPTH_BIAS = 0.08;
const DEPTH_SLOPE_MAX = 10.0;

const FRAGMENT = /* glsl */`
  uniform mat4 projInverse;
  uniform mat4 camWorld;
  uniform vec3 camPos;
  uniform bool camOrtho;
  uniform sampler2D figureAtlas;
  uniform sampler2D depthAtlas;
  uniform mat4 laserMatrix[SLOTS];
  uniform vec4 depthTile[SLOTS];
  uniform vec4 figureTile[SLOTS];
  uniform vec3 laserPos[SLOTS];
  uniform float texelTan[SLOTS];
  uniform float laserFar;
  uniform sampler2D surfaceAlbedo;
  uniform bool hasAlbedo;
  uniform int liveCount;
  uniform int hasAtlas;

  void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
    // No surface, nothing to paint. Unlike the projector pass this has no shaft
    // to march: the beam in the air is real geometry, drawn before this runs, so
    // empty sky genuinely has nothing to add here.
    if (liveCount == 0 || hasAtlas == 0 || depth >= 1.0) {
      outputColor = vec4(0.0, 0.0, 0.0, inputColor.a);
      return;
    }

    // The world point this pixel is looking at, rebuilt from the depth buffer.
    vec4 clip = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    vec4 viewPos = projInverse * clip;
    viewPos /= viewPos.w;
    vec3 world = (camWorld * viewPos).xyz;
    // The eye this pixel's ray starts from. In orthographic every ray runs
    // along the view from its own point on the camera's plane.
    vec3 camForward = -normalize(camWorld[2].xyz);
    vec3 eye = camOrtho ? world - camForward * dot(world - camPos, camForward) : camPos;

    // The surface's facing, from how the reconstructed position moves across
    // the screen, turned to face the eye -- the cross product's sign follows
    // screen winding, not the surface's outside.
    vec3 surfaceNormal = normalize(cross(dFdx(world), dFdy(world)));
    if (dot(surfaceNormal, eye - world) < 0.0) surfaceNormal = -surfaceNormal;

    vec3 total = vec3(0.0);
    for (int i = 0; i < SLOTS; i++) {
      if (i >= liveCount) break;

      // Masked rather than branched, for the reason the projector pass gives:
      // a texture read inside per-pixel control flow has undefined derivatives.
      vec4 lc = laserMatrix[i] * vec4(world, 1.0);
      float inFront = step(0.0001, lc.w);
      vec3 ndc = lc.xyz / max(lc.w, 0.0001);
      float widest = max(max(abs(ndc.x), abs(ndc.y)), abs(ndc.z));
      float inside = inFront * step(widest, 1.0);

      vec2 frame = clamp(ndc.xy * 0.5 + 0.5, 0.0, 1.0);

      vec3 toLaser = laserPos[i] - world;
      float distance2 = max(dot(toLaser, toLaser), 0.0025);
      float lambert = max(dot(surfaceNormal, normalize(toLaser)), 0.0);

      // Can this laser actually see the point, or is the building in the way?
      // Both sides in metres: lc.w is distance along the throw, and the tile
      // holds distance over far.
      vec4 dt = depthTile[i];
      float seen = unpackRGBAToDepth(texture2D(depthAtlas, dt.xy + frame * dt.zw)) * laserFar;
      float slope = min(sqrt(max(1.0 - lambert * lambert, 0.0)) / max(lambert, 1e-3), DEPTH_SLOPE_MAX);
      float bias = DEPTH_BIAS + lc.w * texelTan[i] * slope;
      float visible = step(lc.w, seen + bias);

      // The luminous intensity it sends that way, in kilocandela. It already
      // carries the dimmer, the shutter and the RGB balance -- it was written
      // from the same points the beams were built from.
      // Read half a texel inside the tile: on its border the filter would take
      // the neighbouring tile, another laser's figure, as a line at the edge.
      vec4 ft = figureTile[i];
      vec2 figureAt = clamp(frame, vec2(FIGURE_HALF_TEXEL), vec2(1.0 - FIGURE_HALF_TEXEL));
      vec3 intensity = texture2D(figureAtlas, ft.xy + figureAt * ft.zw).rgb * FIGURE_CANDELA;

      // Lux: intensity over the square of the distance from the aperture, by
      // the cosine of the angle the surface turns from it.
      total += intensity * lambert / distance2 * inside * visible;
    }

    // A matte surface shows rho E / pi: its colour times the lux, spread over
    // the hemisphere.
    vec3 albedo = hasAlbedo ? texture2D(surfaceAlbedo, uv).rgb : vec3(1.0);
    outputColor = vec4(total * albedo * SCENE_PER_WHITE_LUX, inputColor.a);
  }
`;

/**
 * The pass that paints every laser's figure onto the scene.
 */
class LaserEffect extends Effect {
  /** @param {Object} camera the scene camera the frame was drawn with */
  constructor(camera) {
    const laserMatrix = [];
    const depthTile = [];
    const figureTile = [];
    const laserPos = [];
    const texelTan = [];
    for (let i = 0; i < SLOTS; i += 1) {
      texelTan.push(0);
      laserMatrix.push(new THREE.Matrix4());
      depthTile.push(new THREE.Vector4(0, 0, 1, 1));
      figureTile.push(new THREE.Vector4(0, 0, 1, 1));
      laserPos.push(new THREE.Vector3());
    }

    super('LaserEffect', FRAGMENT, {
      blendFunction: BlendFunction.ADD,
      // Without this the pass has no depth buffer, and there would be no
      // surface to put a figure on.
      attributes: EffectAttribute.DEPTH,
      defines: new Map([
        ['SLOTS', `${SLOTS}`],
        ['DEPTH_BIAS', DEPTH_BIAS.toFixed(4)],
        ['DEPTH_SLOPE_MAX', DEPTH_SLOPE_MAX.toFixed(1)],
        ['FIGURE_CANDELA', FIGURE_CANDELA.toFixed(1)],
        // Half a figure texel, as a share of the tile: FIGURE_PIXEL spans the
        // tile's -1..1, so a texel is half of it in 0..1.
        ['FIGURE_HALF_TEXEL', (FIGURE_PIXEL / 4).toFixed(8)],
        // A white matte surface's scene value per lux: SCENE_PER_NIT / pi.
        ['SCENE_PER_WHITE_LUX', (SCENE_PER_NIT / Math.PI).toFixed(8)],
      ]),
      uniforms: new Map([
        ['projInverse', new THREE.Uniform(new THREE.Matrix4())],
        ['camWorld', new THREE.Uniform(new THREE.Matrix4())],
        ['camPos', new THREE.Uniform(new THREE.Vector3())],
        ['camOrtho', new THREE.Uniform(false)],
        ['figureAtlas', new THREE.Uniform(null)],
        ['depthAtlas', new THREE.Uniform(null)],
        ['laserMatrix', new THREE.Uniform(laserMatrix)],
        ['depthTile', new THREE.Uniform(depthTile)],
        ['figureTile', new THREE.Uniform(figureTile)],
        ['laserPos', new THREE.Uniform(laserPos)],
        ['texelTan', new THREE.Uniform(texelTan)],
        ['laserFar', new THREE.Uniform(120)],
        ['surfaceAlbedo', new THREE.Uniform(null)],
        ['hasAlbedo', new THREE.Uniform(false)],
        ['liveCount', new THREE.Uniform(0)],
        ['hasAtlas', new THREE.Uniform(0)],
      ]),
    });

    this.camera = camera;
    this.lasers = [];
    this.figureTexture = null;
    this.depthTexture = null;
    this.far = 120;
  }

  /**
   * Hands the pass what to paint this frame.
   *
   * Pushed from the render loop rather than pulled from here, because the
   * lasers come from the fixture layer and the pass has no business reaching
   * into it.
   *
   * @public
   * @param {Array} lasers each `{ matrix, depthTile, figureTile, position,
   *   texelTan }`, the last how wide a depth texel is per metre of distance
   * @param {Object} figureTexture the figure atlas
   * @param {Object} depthTexture the laser depth atlas
   * @param {Number} far the range the depth atlas was packed against
   */
  setLasers(lasers, figureTexture, depthTexture, far) {
    this.lasers = lasers || [];
    this.figureTexture = figureTexture || null;
    this.depthTexture = depthTexture || null;
    if (far) this.far = far;
  }

  /**
   * The surface colour for this frame, from `SurfaceAlbedo`, or null for
   * white.
   *
   * @public
   * @param {Object|null} texture
   */
  setAlbedo(texture) {
    this.uniforms.get('surfaceAlbedo').value = texture || null;
    this.uniforms.get('hasAlbedo').value = !!texture;
  }

  /**
   * @public
   * @param {Object} renderer
   * @param {Object} inputBuffer
   * @param {Number} deltaTime
   */
  // eslint-disable-next-line no-unused-vars
  update(renderer, inputBuffer, deltaTime) {
    const { uniforms, camera } = this;
    if (camera) {
      uniforms.get('projInverse').value.copy(camera.projectionMatrixInverse);
      uniforms.get('camWorld').value.copy(camera.matrixWorld);
      uniforms.get('camPos').value.setFromMatrixPosition(camera.matrixWorld);
      uniforms.get('camOrtho').value = !!camera.isOrthographicCamera;
    }

    const live = this.lasers.slice(0, SLOTS);
    uniforms.get('liveCount').value = live.length;
    uniforms.get('figureAtlas').value = this.figureTexture;
    uniforms.get('depthAtlas').value = this.depthTexture;
    uniforms.get('laserFar').value = this.far;
    uniforms.get('hasAtlas').value = this.figureTexture && this.depthTexture ? 1 : 0;

    const matrices = uniforms.get('laserMatrix').value;
    const depthTiles = uniforms.get('depthTile').value;
    const figureTiles = uniforms.get('figureTile').value;
    const positions = uniforms.get('laserPos').value;
    const texelTans = uniforms.get('texelTan').value;

    live.forEach((laser, i) => {
      matrices[i].copy(laser.matrix);
      const dt = laser.depthTile;
      const ft = laser.figureTile;
      depthTiles[i].set(dt.x, dt.y, dt.width, dt.height);
      figureTiles[i].set(ft.x, ft.y, ft.width, ft.height);
      positions[i].copy(laser.position);
      texelTans[i] = laser.texelTan;
    });
  }
}

export default LaserEffect;
