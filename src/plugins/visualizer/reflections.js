import * as THREE from 'three';
import { Effect, EffectAttribute, BlendFunction } from 'postprocessing';
import LightField from './light_field';

/**
 * @file Screen-space reflections: glossy surfaces reflect what the frame
 * shows.
 *
 * Every standard material reflects the room's environment image. That has
 * none of the scene in it, so a glossy floor showed no cube, no pool and no
 * picture. This traces each glossy pixel's mirror ray through the frame's
 * depth and, where it meets a surface, takes the frame's colour there in
 * place of the environment's share of the reflection.
 *
 * Three things go into it each frame:
 *
 * - A surface buffer: the scene drawn once more with every standard material
 *   replaced by one that writes its view-space normal and roughness, and its
 *   reflectance at normal incidence. Any other material reflects nothing.
 *   The trace runs against this buffer's depth, not the frame's: lens faces
 *   write no depth in the frame, so they are drawn here, and a ray meets the
 *   lens rather than the head behind it with the glow painted over it.
 * - The frame so far, copied into a texture with mip levels, so a rough
 *   surface reads a blurred reflection: the rougher, and the further the
 *   reflected surface, the coarser the level.
 * - The environment image and its intensity, so the environment's share is
 *   worked out exactly as three's material worked it out, and taken back out
 *   where the trace finds a surface.
 *
 * Only what is on screen can be reflected. A ray that leaves the frame, runs
 * back towards the camera or meets nothing keeps the environment's
 * reflection; it fades to it near those limits rather than cutting.
 *
 * Displays reflect as their picture where the trace finds them, so the
 * rectangle the light field adds for them is switched off while this is on.
 */

/** Steps along the ray across the screen, and halvings to refine a hit. */
const TRACE_STEPS = 80;
const REFINE_STEPS = 6;

/** Furthest a reflection is traced, in metres. */
const MAX_DISTANCE = 40;

/** Roughness past which a surface keeps only the environment's reflection. */
const ROUGHNESS_LIMIT = 0.7;

/** Brightest a reflected pixel is taken at, in scene units. */
const FRAME_CLAMP = 32;

/** Coarsest blur level a reflection reads: a spread of 64 pixels. */
const MAX_LEVEL = 6;

/** The surface buffer's clear: no normal, nothing reflected. */
const CLEAR = new THREE.Color(0, 0, 0);

const SURFACE_VERTEX = /* glsl */`
#include <common>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
uniform mat3 mapTransform;
out vec3 vViewNormal;
out vec2 vMapUv;
void main() {
  #include <beginnormal_vertex>
  #include <morphnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <defaultnormal_vertex>
  vViewNormal = normalize( transformedNormal );
  #include <begin_vertex>
  #include <morphtarget_vertex>
  #include <skinning_vertex>
  #include <project_vertex>
  vMapUv = ( mapTransform * vec3( uv, 1.0 ) ).xy;
}
`;

const SURFACE_FRAGMENT = /* glsl */`
precision highp float;
uniform vec3 color;
uniform float roughness;
uniform float metalness;
uniform sampler2D map;
uniform sampler2D roughnessMap;
uniform sampler2D metalnessMap;
uniform bool hasMap;
uniform bool hasRoughnessMap;
uniform bool hasMetalnessMap;
in vec3 vViewNormal;
in vec2 vMapUv;
layout( location = 0 ) out highp vec4 surfaceNormal;
layout( location = 1 ) out highp vec4 surfaceReflectance;
void main() {
  vec3 normal = normalize( vViewNormal );
  if ( !gl_FrontFacing ) normal = -normal;
  float rough = roughness;
  float metal = metalness;
  // glTF packs roughness in green and metalness in blue, often in one image.
  if ( hasRoughnessMap ) rough *= texture( roughnessMap, vMapUv ).g;
  if ( hasMetalnessMap ) metal *= texture( metalnessMap, vMapUv ).b;
  vec3 albedo = color;
  if ( hasMap ) albedo *= texture( map, vMapUv ).rgb;
  // The floor three's standard material puts under roughness.
  rough = clamp( rough, 0.0525, 1.0 );
  surfaceNormal = vec4( normal, rough );
  surfaceReflectance = vec4( mix( vec3( 0.04 ), albedo, metal ), 1.0 );
}
`;

/** The surface material for each standard material, by source material. */
const surfaceMaterials = new WeakMap();

const identity3 = new THREE.Matrix3();

function surfaceMaterialFor(source) {
  let material = surfaceMaterials.get(source);
  if (!material) {
    material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: SURFACE_VERTEX,
      fragmentShader: SURFACE_FRAGMENT,
      uniforms: {
        color: { value: new THREE.Color() },
        roughness: { value: 1 },
        metalness: { value: 0 },
        map: { value: null },
        roughnessMap: { value: null },
        metalnessMap: { value: null },
        hasMap: { value: false },
        hasRoughnessMap: { value: false },
        hasMetalnessMap: { value: false },
        mapTransform: { value: new THREE.Matrix3() },
      },
    });
    surfaceMaterials.set(source, material);
  }
  const u = material.uniforms;
  u.color.value.copy(source.color);
  u.roughness.value = source.roughness;
  u.metalness.value = source.metalness;
  u.map.value = source.map || null;
  u.roughnessMap.value = source.roughnessMap || null;
  u.metalnessMap.value = source.metalnessMap || null;
  u.hasMap.value = !!source.map;
  u.hasRoughnessMap.value = !!source.roughnessMap;
  u.hasMetalnessMap.value = !!source.metalnessMap;
  // One transform for all three: glTF and the shapes share one set of
  // coordinates across a material's images.
  const lead = source.map || source.roughnessMap || source.metalnessMap;
  if (lead) {
    if (lead.matrixAutoUpdate) lead.updateMatrix();
    u.mapTransform.value.copy(lead.matrix);
  } else {
    u.mapTransform.value.copy(identity3);
  }
  material.side = source.side;
  return material;
}

/**
 * A surface that reflects nothing: its normal, so a ray that meets it edge-on
 * fades, and no reflectance.
 */
const NOT_REFLECTIVE = new THREE.ShaderMaterial({
  glslVersion: THREE.GLSL3,
  vertexShader: /* glsl */`
#include <common>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
out vec3 vViewNormal;
void main() {
  #include <beginnormal_vertex>
  #include <morphnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <defaultnormal_vertex>
  vViewNormal = normalize( transformedNormal );
  #include <begin_vertex>
  #include <morphtarget_vertex>
  #include <skinning_vertex>
  #include <project_vertex>
}
`,
  fragmentShader: /* glsl */`
precision highp float;
in vec3 vViewNormal;
layout( location = 0 ) out highp vec4 surfaceNormal;
layout( location = 1 ) out highp vec4 surfaceReflectance;
void main() {
  // A geometry without normals writes none, and its hits are taken as they are.
  if ( dot( vViewNormal, vViewNormal ) < 1e-8 ) {
    surfaceNormal = vec4( 0.0, 0.0, 0.0, 1.0 );
    surfaceReflectance = vec4( 0.0 );
    return;
  }
  vec3 normal = normalize( vViewNormal );
  if ( !gl_FrontFacing ) normal = -normal;
  surfaceNormal = vec4( normal, 1.0 );
  // Alpha 0.25 marks a sheet with no thickness: see THIN_TARGET.
#ifdef THIN
  surfaceReflectance = vec4( 0.0, 0.0, 0.0, 0.25 );
#else
  surfaceReflectance = vec4( 0.0 );
#endif
}
`,
  side: THREE.DoubleSide,
});

/**
 * A lens face: a disc with no thickness, drawn over the head behind it. A ray
 * that passes more than a centimetre behind it carries on, rather than taking
 * the glow painted over whatever is just behind.
 */
const THIN_TARGET = NOT_REFLECTIVE.clone();
THIN_TARGET.defines = { THIN: '' };

/**
 * What a mesh draws in the surface buffer.
 *
 * @param {THREE.Material} material
 * @returns {THREE.Material|null} null when it is not drawn at all
 */
function standInFor(material) {
  if (!material || !material.visible) return null;
  // Beams, glows and anything else see-through are not surfaces, except what
  // asks to be met: a lens face.
  if (material.transparent || !material.depthWrite) {
    return material.userData.reflectionTarget ? THIN_TARGET : null;
  }
  if (material.isMeshStandardMaterial) return surfaceMaterialFor(material);
  // Opaque but not a standard material, a display's screen among them: it
  // hides what is behind it and reflects nothing.
  return NOT_REFLECTIVE;
}

const COPY = new THREE.ShaderMaterial({
  uniforms: { source: { value: null } },
  defines: { FRAME_CLAMP: FRAME_CLAMP.toFixed(1) },
  vertexShader: /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`,
  fragmentShader: /* glsl */`
uniform sampler2D source;
varying vec2 vUv;
void main() {
  // Clamped before the mip levels are built: a lens face is a thousand times
  // white, and one in a coarse level floods everything averaged with it.
  vec4 c = texture2D( source, vUv );
  float peak = max( c.r, max( c.g, c.b ) );
  gl_FragColor = vec4( c.rgb * min( 1.0, FRAME_CLAMP / max( peak, 1e-6 ) ), c.a );
}
`,
  depthTest: false,
  depthWrite: false,
});
const copyScene = new THREE.Scene();
const copyQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), COPY);
copyQuad.frustumCulled = false;
copyScene.add(copyQuad);
const copyCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

const FRAGMENT = /* glsl */`
uniform sampler2D surfaceNormals;
uniform sampler2D surfaceReflectances;
uniform sampler2D surfaceDepth;
uniform sampler2D frameMips;
uniform float frameLevels;
uniform mat4 proj;
uniform mat4 projInverse;
uniform mat4 camWorld;
uniform bool camOrtho;
uniform float cameraNearPlane;
uniform vec2 frameSize;
uniform float envIntensity;
uniform mat3 envRotation;
uniform sampler2D envMap;

#ifdef ENVMAP_TYPE_CUBE_UV
${THREE.ShaderChunk.cube_uv_reflection_fragment}
#endif

vec3 viewPositionAt( vec2 uv, float depth ) {
  vec4 p = projInverse * vec4( uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0 );
  return p.xyz / p.w;
}

float surfaceDepthAt( vec2 uv ) {
  return texture( surfaceDepth, uv ).r;
}

float viewZAt( vec2 uv ) {
  return viewPositionAt( uv, surfaceDepthAt( uv ) ).z;
}

// three's split-sum fit for how much of a reflection a surface returns.
vec2 dfgApprox( float dotNV, float roughness ) {
  const vec4 c0 = vec4( -1.0, -0.0275, -0.572, 0.022 );
  const vec4 c1 = vec4( 1.0, 0.0425, 1.04, -0.04 );
  vec4 r = roughness * c0 + c1;
  float a004 = min( r.x * r.x, exp2( -9.28 * dotNV ) ) * r.x + r.y;
  return vec2( -1.04, 1.04 ) * a004 + r.zw;
}

// The environment's reflection exactly as three's standard material reads it.
vec3 environmentReflection( vec3 viewDir, vec3 normal, float roughness ) {
#ifdef ENVMAP_TYPE_CUBE_UV
  vec3 reflected = reflect( -viewDir, normal );
  reflected = normalize( mix( reflected, normal, roughness * roughness ) );
  vec3 world = normalize( ( camWorld * vec4( reflected, 0.0 ) ).xyz );
  return textureCubeUV( envMap, envRotation * world, roughness ).rgb * envIntensity;
#else
  return vec3( 0.0 );
#endif
}

// A per-pixel offset, so the steps do not band. Fixed, not moved each frame:
// with nothing to average frames together, a moving one would shimmer.
float stepJitter( vec2 pixel ) {
  return fract( 52.9829189 * fract( dot( pixel, vec2( 0.06711056, 0.00583715 ) ) ) );
}

void mainImage( const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor ) {
  outputColor = inputColor;
  vec4 reflectance = texture( surfaceReflectances, uv );
  if ( reflectance.a < 0.5 || depth >= 1.0 ) return;
  vec4 surface = texture( surfaceNormals, uv );
  float roughness = surface.w;
  if ( roughness >= ${ROUGHNESS_LIMIT.toFixed(3)} ) return;
  vec3 normal = normalize( surface.xyz );

  vec3 origin = viewPositionAt( uv, depth );
  // The surface buffer saw something else here: a lens face over it.
  float surfaceZ = viewPositionAt( uv, surfaceDepthAt( uv ) ).z;
  if ( abs( surfaceZ - origin.z ) > 0.02 + abs( origin.z ) * 0.01 ) return;
  vec3 viewDir = camOrtho ? vec3( 0.0, 0.0, 1.0 ) : normalize( -origin );
  vec3 ray = reflect( -viewDir, normal );

  // Stopped short of the near plane: a point behind it has no place on screen.
  float span = ${MAX_DISTANCE.toFixed(1)};
  if ( !camOrtho && ray.z > 0.0 ) {
    span = min( span, ( -cameraNearPlane - origin.z ) / ray.z * 0.99 );
  }
  if ( span <= 0.0 ) return;
  // Lifted off the surface, so it does not find itself on the first step.
  vec3 start = origin + normal * 0.01;
  vec3 end = start + ray * span;

  vec4 clipStart = proj * vec4( start, 1.0 );
  vec4 clipEnd = proj * vec4( end, 1.0 );
  float kStart = 1.0 / clipStart.w;
  float kEnd = 1.0 / clipEnd.w;
  vec2 uvStart = clipStart.xy * kStart * 0.5 + 0.5;
  vec2 uvEnd = clipEnd.xy * kEnd * 0.5 + 0.5;
  // Depth along the ray is interpolated as z / w, which is linear on screen.
  float zStart = start.z * kStart;
  float zEnd = end.z * kEnd;

  // Cut off where it leaves the frame, so every step lands on screen and the
  // steps are as short as the ray allows: a long step jumps a thin surface on
  // some pixels and lands on it on their neighbours.
  vec2 travel = uvEnd - uvStart;
  float reach = 1.0;
  if ( travel.x > 1e-6 ) reach = min( reach, ( 1.0 - uvStart.x ) / travel.x );
  if ( travel.x < -1e-6 ) reach = min( reach, -uvStart.x / travel.x );
  if ( travel.y > 1e-6 ) reach = min( reach, ( 1.0 - uvStart.y ) / travel.y );
  if ( travel.y < -1e-6 ) reach = min( reach, -uvStart.y / travel.y );
  reach = max( reach, 0.0 );

  float jitter = stepJitter( gl_FragCoord.xy );
  float before = 0.0;
  float beforeZ = start.z;
  float beforeBehind = -1.0;
  float hit = -1.0;
  for ( int i = 1; i <= ${TRACE_STEPS}; i++ ) {
    float t = ( float( i ) - 1.0 + jitter ) / float( ${TRACE_STEPS} );
    // Shortest near the surface, where contact reflections need them, and
    // no longer than about 1/50 of the way at the far end.
    t = t * sqrt( t ) * reach;
    vec2 at = mix( uvStart, uvEnd, t );
    float rayZ = mix( zStart, zEnd, t ) / mix( kStart, kEnd, t );
    float sceneDepth = surfaceDepthAt( at );
    if ( sceneDepth >= 1.0 ) { before = t; beforeZ = rayZ; beforeBehind = -1.0; continue; }
    float sceneZ = viewPositionAt( at, sceneDepth ).z;
    float behind = sceneZ - rayZ;
    // How far behind a surface the ray can be and still be meeting it: a
    // little for any surface, a centimetre for a lens face, and as much as
    // this step went in depth.
    float sheet = texture( surfaceReflectances, at ).a;
    float body = sheet > 0.2 && sheet < 0.3 ? 0.01 : 0.03 + abs( rayZ ) * 0.01;
    float thickness = max( body, abs( rayZ - beforeZ ) * 1.5 );
    // A candidate when the ray is just behind a surface, or went from in front
    // of the surfaces to behind one in this step however deep it landed: a
    // step into a solid casing is still a step that met it. Which it was is
    // settled at the crossing below.
    if ( behind > 0.0 && ( behind < thickness || beforeBehind <= 0.0 ) ) {
      // The first surface the step crossed, which on a long step may be a thin
      // one in front of what it landed on -- a display's bezel before its
      // picture -- found in short steps, then halved down to.
      float lo = before;
      float hi = t;
      for ( int j = 1; j <= 8; j++ ) {
        float sub = mix( before, t, float( j ) / 8.0 );
        vec2 m = mix( uvStart, uvEnd, sub );
        float mz = mix( zStart, zEnd, sub ) / mix( kStart, kEnd, sub );
        if ( viewZAt( m ) - mz > 0.0 ) { hi = sub; break; }
        lo = sub;
      }
      for ( int j = 0; j < ${REFINE_STEPS}; j++ ) {
        float mid = 0.5 * ( lo + hi );
        vec2 m = mix( uvStart, uvEnd, mid );
        float mz = mix( zStart, zEnd, mid ) / mix( kStart, kEnd, mid );
        if ( viewZAt( m ) - mz > 0.0 ) hi = mid; else lo = mid;
      }
      // At the crossing the ray is on the surface it met. Still far behind
      // it, the crossing was an edge: the ray went behind something and on.
      vec2 crossing = mix( uvStart, uvEnd, hi );
      float crossingZ = mix( zStart, zEnd, hi ) / mix( kStart, kEnd, hi );
      if ( viewZAt( crossing ) - crossingZ < body ) {
        hit = hi;
        break;
      }
    }
    before = t;
    beforeZ = rayZ;
    beforeBehind = behind;
  }
  if ( hit < 0.0 ) return;

  vec2 hitUv = mix( uvStart, uvEnd, hit );
  float hitZ = mix( zStart, zEnd, hit ) / mix( kStart, kEnd, hit );
  // Measured, not span x hit: hit is a fraction of the way across the screen,
  // which perspective makes no fraction of the way in space.
  float travelled = distance( origin, viewPositionAt( hitUv, surfaceDepthAt( hitUv ) ) );

  // Confidence: fades out near the screen's edges, as the ray turns back
  // towards the camera, and towards the roughness limit.
  vec2 edge = min( hitUv, 1.0 - hitUv );
  float weight = smoothstep( 0.0, 0.06, min( edge.x, edge.y ) );
  // A hit a few centimetres away -- a casing's recess beside its picture --
  // is finer than the frame can trace, and comes and goes from pixel to pixel.
  weight *= smoothstep( 0.02, 0.06, travelled );
  weight *= 1.0 - smoothstep( 0.25, 0.75, ray.z );
  weight *= 1.0 - smoothstep( ${(ROUGHNESS_LIMIT * 0.7).toFixed(3)}, ${ROUGHNESS_LIMIT.toFixed(3)}, roughness );
  // The frame holds each surface as the camera sees it. A surface met edge-on
  // or from behind shows the ray something else -- a lens face, bright
  // head-on and dark from the side, is the worst of it -- so such a hit
  // fades out.
  vec4 hitSurface = texture( surfaceNormals, hitUv );
  float hitSurfaceZ = viewPositionAt( hitUv, surfaceDepthAt( hitUv ) ).z;
  bool hitKnown = dot( hitSurface.xyz, hitSurface.xyz ) > 0.25
    && abs( hitSurfaceZ - hitZ ) < 0.05 + abs( hitZ ) * 0.02;
  if ( hitKnown ) weight *= smoothstep( 0.0, 0.3, dot( normalize( hitSurface.xyz ), -ray ) );
  if ( weight <= 0.0 ) return;

  // A rough surface's reflection spreads with distance: a cone about as wide
  // as roughness squared, read off the mip level whose texels are that wide.
  float pixelSize = ( camOrtho ? 2.0 : 2.0 * abs( hitZ ) ) / ( proj[ 1 ][ 1 ] * frameSize.y );
  float spread = roughness * roughness * travelled;
  float level = clamp( log2( max( spread / pixelSize, 1.0 ) ), 0.0, min( frameLevels, ${MAX_LEVEL.toFixed(1)} ) );
  vec3 traced = textureLod( frameMips, hitUv, level ).rgb;

  float dotNV = clamp( dot( normal, viewDir ), 0.0, 1.0 );
  vec2 fab = dfgApprox( dotNV, roughness );
  vec3 returned = reflectance.rgb * fab.x + fab.y;
  vec3 environment = environmentReflection( viewDir, normal, roughness );

  outputColor.rgb = max( inputColor.rgb + weight * returned * ( traced - environment ), 0.0 );
}
`;

const scratchSize = new THREE.Vector2();
const previousClear = new THREE.Color();
const rotationEuler = new THREE.Euler();
const rotationMatrix = new THREE.Matrix4();

/**
 * @class ReflectionsEffect
 * @classdesc Screen-space reflections on glossy standard materials.
 * @extends Effect
 */
export default class ReflectionsEffect extends Effect {
  /**
   * @param {THREE.Scene} scene the scene the frame is drawn from
   * @param {THREE.Camera} camera the camera the scene is rendered with
   */
  constructor(scene, camera) {
    super('ReflectionsEffect', FRAGMENT, {
      attributes: EffectAttribute.DEPTH,
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map([
        ['surfaceNormals', new THREE.Uniform(null)],
        ['surfaceReflectances', new THREE.Uniform(null)],
        ['surfaceDepth', new THREE.Uniform(null)],
        ['frameMips', new THREE.Uniform(null)],
        ['frameLevels', new THREE.Uniform(0)],
        ['proj', new THREE.Uniform(new THREE.Matrix4())],
        ['projInverse', new THREE.Uniform(new THREE.Matrix4())],
        ['camWorld', new THREE.Uniform(new THREE.Matrix4())],
        ['camOrtho', new THREE.Uniform(false)],
        ['cameraNearPlane', new THREE.Uniform(0.1)],
        ['frameSize', new THREE.Uniform(new THREE.Vector2(1, 1))],
        ['envIntensity', new THREE.Uniform(0)],
        ['envRotation', new THREE.Uniform(new THREE.Matrix3())],
        ['envMap', new THREE.Uniform(null)],
      ]),
    });
    this.scene = scene;
    this.camera = camera;
    this.surfaces = null;
    this.frameCopy = null;
    /** The environment the shader was built for, by its height. */
    this.envHeight = -1;
    this.on = true;
  }

  /**
   * Turns reflections on or off. Off, the displays' rectangle reflection
   * comes back.
   *
   * @param {Boolean} on
   */
  setOn(on) {
    this.on = !!on;
    LightField.uniforms.lightFieldAreaSpecular.value = this.on ? 0 : 1;
    if (this.pass) this.pass.enabled = this.on;
  }

  /** @private */
  ensureTargets(width, height) {
    if (!this.surfaces) {
      this.surfaces = new THREE.WebGLRenderTarget(width, height, {
        count: 2,
        type: THREE.HalfFloatType,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        depthBuffer: true,
      });
      this.surfaces.depthTexture = new THREE.DepthTexture(width, height);
      this.frameCopy = new THREE.WebGLRenderTarget(width, height, {
        type: THREE.HalfFloatType,
        minFilter: THREE.LinearMipmapLinearFilter,
        magFilter: THREE.LinearFilter,
        generateMipmaps: true,
        depthBuffer: false,
      });
    } else if (this.surfaces.width !== width || this.surfaces.height !== height) {
      this.surfaces.setSize(width, height);
      this.frameCopy.setSize(width, height);
    }
    const { uniforms } = this;
    const [normals, reflectances] = this.surfaces.textures;
    uniforms.get('surfaceNormals').value = normals;
    uniforms.get('surfaceReflectances').value = reflectances;
    uniforms.get('surfaceDepth').value = this.surfaces.depthTexture;
    uniforms.get('frameMips').value = this.frameCopy.texture;
    uniforms.get('frameLevels').value = Math.floor(Math.log2(Math.max(width, height)));
    uniforms.get('frameSize').value.set(width, height);
  }

  /**
   * Draws the surface buffer: every surface's normal, roughness and
   * reflectance.
   *
   * @private
   */
  drawSurfaces(renderer) {
    const { scene, camera } = this;
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
        swapped.push([object, material]);
        object.material = material.map((entry) => standInFor(entry) || NOT_REFLECTIVE);
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
    renderer.getClearColor(previousClear);
    const wasShadowUpdate = renderer.shadowMap.autoUpdate;
    try {
      scene.background = null;
      scene.overrideMaterial = null;
      renderer.shadowMap.autoUpdate = false;
      renderer.setClearColor(CLEAR, 0);
      renderer.setRenderTarget(this.surfaces);
      renderer.clear(true, true, false);
      renderer.render(scene, camera);
    } finally {
      renderer.setRenderTarget(wasTarget);
      renderer.setClearColor(previousClear, wasAlpha);
      renderer.shadowMap.autoUpdate = wasShadowUpdate;
      scene.background = wasBackground;
      scene.overrideMaterial = wasOverride;
      swapped.forEach(([object, material]) => { object.material = material; });
      hidden.forEach((object) => { object.visible = true; });
    }
  }

  /**
   * Builds the shader for the environment in use: its size is baked into the
   * lookup as constants, as three does.
   *
   * @private
   */
  followEnvironment() {
    const env = this.scene.environment;
    const { uniforms } = this;
    const usable = env && env.mapping === THREE.CubeUVReflectionMapping && env.image;
    const height = usable ? env.image.height : 0;
    if (height !== this.envHeight) {
      this.envHeight = height;
      if (usable) {
        const maxMip = Math.log2(height) - 2;
        const texelHeight = 1.0 / height;
        const texelWidth = 1.0 / (3 * Math.max(2 ** maxMip, 7 * 16));
        this.defines.set('ENVMAP_TYPE_CUBE_UV', '1');
        this.defines.set('CUBEUV_TEXEL_WIDTH', texelWidth.toFixed(10));
        this.defines.set('CUBEUV_TEXEL_HEIGHT', texelHeight.toFixed(10));
        this.defines.set('CUBEUV_MAX_MIP', `${maxMip.toFixed(1)}`);
      } else {
        this.defines.delete('ENVMAP_TYPE_CUBE_UV');
        this.defines.delete('CUBEUV_TEXEL_WIDTH');
        this.defines.delete('CUBEUV_TEXEL_HEIGHT');
        this.defines.delete('CUBEUV_MAX_MIP');
      }
      this.setChanged();
    }
    uniforms.get('envMap').value = usable ? env : null;
    uniforms.get('envIntensity').value = usable ? this.scene.environmentIntensity : 0;
    // As three turns the scene's environment for its materials.
    rotationEuler.copy(this.scene.environmentRotation);
    rotationEuler.x *= -1;
    rotationEuler.y *= -1;
    rotationEuler.z *= -1;
    uniforms.get('envRotation').value.setFromMatrix4(rotationMatrix.makeRotationFromEuler(rotationEuler));
  }

  /**
   * Per-frame refresh: the surface buffer, the frame's mip levels, the
   * camera and the environment.
   *
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.WebGLRenderTarget} inputBuffer
   */
  update(renderer, inputBuffer) {
    if (!this.on) return;
    renderer.getDrawingBufferSize(scratchSize);
    const width = Math.max(1, inputBuffer ? inputBuffer.width : Math.floor(scratchSize.x));
    const height = Math.max(1, inputBuffer ? inputBuffer.height : Math.floor(scratchSize.y));
    this.ensureTargets(width, height);

    const { uniforms, camera } = this;
    camera.updateMatrixWorld();
    uniforms.get('proj').value.copy(camera.projectionMatrix);
    uniforms.get('projInverse').value.copy(camera.projectionMatrixInverse);
    uniforms.get('camWorld').value.copy(camera.matrixWorld);
    uniforms.get('camOrtho').value = !!camera.isOrthographicCamera;
    uniforms.get('cameraNearPlane').value = camera.near;
    this.followEnvironment();

    this.drawSurfaces(renderer);

    // The frame as it stands, with mip levels for the blur.
    COPY.uniforms.source.value = inputBuffer.texture;
    const wasTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.frameCopy);
    renderer.render(copyScene, copyCamera);
    renderer.setRenderTarget(wasTarget);
  }
}
