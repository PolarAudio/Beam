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
 * - A depth pyramid built from the surface buffer: each level holds the
 *   nearest distance under each of its cells. A ray in front of the nearest
 *   surface in a cell cannot meet anything there and skips the whole cell;
 *   otherwise it drops a level, down to single pixels. No pixel the ray could
 *   be behind is ever stepped over, so a bar three pixels wide is met on
 *   every pixel that reflects it.
 * - The frame so far, copied into a texture with mip levels, so a rough
 *   surface reads a blurred reflection: the rougher, and the further the
 *   reflected surface, the coarser the level.
 * - The environment image and its intensity, so the environment's share is
 *   worked out exactly as three's material worked it out, and taken back out
 *   where the trace finds a surface.
 *
 * The floor is the exception. A glossy surface lying in the floor plane and
 * facing up reads a mirror image instead: the scene drawn again from the
 * camera's reflection below the floor, so it holds everything above the floor
 * as seen from below -- the undersides and the lights facing the floor, which
 * the frame never shows.
 *
 * Elsewhere only what is on screen can be reflected. A ray that leaves the frame, runs
 * back towards the camera or meets nothing keeps the environment's
 * reflection; it fades to it near those limits rather than cutting.
 *
 * Displays reflect as their picture where the trace finds them, so the
 * rectangle the light field adds for them is switched off while this is on.
 */

/** Levels in the depth pyramid: cells up to 512 pixels across. */
const PYRAMID_LEVELS = 10;

/** Most cells one ray visits, at whatever level. */
const TRACE_STEPS = 160;

/** Furthest a reflection is traced, in metres. */
const MAX_DISTANCE = 40;

/** Roughness past which a surface keeps only the environment's reflection. */
const ROUGHNESS_LIMIT = 0.7;

/** Brightest a reflected pixel is taken at, in scene units. */
const FRAME_CLAMP = 32;

/**
 * Coarsest blur level a reflection reads: a spread of 512 pixels.
 *
 * High because this is the only place roughness has room to act. The level is
 * `roughness²` scaled by the projection, so the cap is reached at a roughness
 * of about a quarter, and everything above it read the same 64-pixel smear: a
 * 0.4 metal and a 0.7 one were indistinguishable, and the only way left to make
 * a rough surface duller was to take light away from it rather than spread it.
 */
const MAX_LEVEL = 9;

/**
 * What counts as a floor: a glossy object at most this thick, in metres, and
 * at least this large across, in square metres. Its top face is the plane
 * mirrored.
 */
const FLOOR_THICKNESS = 0.25;
const FLOOR_AREA = 1;

/** Frames between looks for the floor plane. */
const FLOOR_RECHECK = 30;

/** How far off the floor plane a surface may sit and still take the mirror. */
const FLOOR_TOLERANCE = 0.01;

/** How far a floor surface's normal may lean from straight up: about 6 degrees. */
const FLOOR_NORMAL_Z = 0.995;

/** The mirror image's size against the frame's. */
const MIRROR_SCALE = 0.5;

/**
 * What the mirror image keeps: everything 2 mm above the floor plane and up,
 * so the floor itself and anything below it are not in it.
 */
const MIRROR_CLIP = [new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)];

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

const PYRAMID_VERTEX = /* glsl */`
void main() {
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

/** Level 0: the distance from the camera plane to the surface at each pixel. */
const PYRAMID_BASE = new THREE.ShaderMaterial({
  glslVersion: THREE.GLSL3,
  uniforms: {
    depth: { value: null },
    projInverse: { value: new THREE.Matrix4() },
  },
  vertexShader: PYRAMID_VERTEX,
  fragmentShader: /* glsl */`
precision highp float;
uniform highp sampler2D depth;
uniform mat4 projInverse;
layout( location = 0 ) out highp vec4 nearest;
void main() {
  float d = texelFetch( depth, ivec2( gl_FragCoord.xy ), 0 ).r;
  // Nothing drawn: further than any ray reaches.
  if ( d >= 1.0 ) { nearest = vec4( 1e9 ); return; }
  // View z depends on depth alone, lens shift or not, so x and y are left at 0.
  vec4 p = projInverse * vec4( 0.0, 0.0, d * 2.0 - 1.0, 1.0 );
  nearest = vec4( -p.z / p.w );
}
`,
  depthTest: false,
  depthWrite: false,
});

/** Each further level: the nearest of the four cells under it. */
const PYRAMID_LEVEL = new THREE.ShaderMaterial({
  glslVersion: THREE.GLSL3,
  uniforms: {
    source: { value: null },
    sourceOffset: { value: new THREE.Vector2() },
    sourceLast: { value: new THREE.Vector2() },
    offset: { value: new THREE.Vector2() },
  },
  vertexShader: PYRAMID_VERTEX,
  fragmentShader: /* glsl */`
precision highp float;
uniform highp sampler2D source;
uniform vec2 sourceOffset;
uniform vec2 sourceLast;
uniform vec2 offset;
layout( location = 0 ) out highp vec4 nearest;
void main() {
  ivec2 base = ivec2( gl_FragCoord.xy - offset ) * 2;
  ivec2 last = ivec2( sourceLast );
  ivec2 at = ivec2( sourceOffset );
  // Clamped at the far edge: a level of odd size has no second cell there.
  float a = texelFetch( source, at + min( base, last ), 0 ).r;
  float b = texelFetch( source, at + min( base + ivec2( 1, 0 ), last ), 0 ).r;
  float c = texelFetch( source, at + min( base + ivec2( 0, 1 ), last ), 0 ).r;
  float e = texelFetch( source, at + min( base + ivec2( 1, 1 ), last ), 0 ).r;
  nearest = vec4( min( min( a, b ), min( c, e ) ) );
}
`,
  depthTest: false,
  depthWrite: false,
});

const FRAGMENT = /* glsl */`
uniform sampler2D surfaceNormals;
uniform sampler2D surfaceReflectances;
uniform sampler2D surfaceDepth;
uniform highp sampler2D pyramidEven;
uniform highp sampler2D pyramidOdd;
uniform vec2 pyramidOffsets[ ${PYRAMID_LEVELS} ];
uniform int pyramidTop;
uniform sampler2D frameMips;
uniform float frameLevels;
uniform bool mirrorOn;
uniform float floorHeight;
uniform sampler2D mirrorMips;
uniform highp sampler2D mirrorDepth;
uniform mat4 mirrorView;
uniform mat4 mirrorViewProj;
uniform mat4 mirrorProjInverse;
uniform vec2 mirrorSize;
uniform float mirrorLevels;
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

// The nearest surface distance in a cell of the depth pyramid. Even levels
// and odd levels are in two textures, as each level is built from the one
// before.
float nearestIn( int level, ivec2 cell ) {
  ivec2 at = cell + ivec2( pyramidOffsets[ level ] );
  return ( level & 1 ) == 0 ? texelFetch( pyramidEven, at, 0 ).r : texelFetch( pyramidOdd, at, 0 ).r;
}

// Where the ray, a pixel position pStart + pDelta * t, leaves a cell.
float cellExit( vec2 pStart, vec2 pDelta, vec2 cell, float size ) {
  vec2 bound = ( cell + step( 0.0, pDelta ) ) * size;
  float tx = abs( pDelta.x ) < 1e-6 ? 1e9 : ( bound.x - pStart.x ) / pDelta.x;
  float ty = abs( pDelta.y ) < 1e-6 ? 1e9 : ( bound.y - pStart.y ) / pDelta.y;
  return min( tx, ty );
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

  float dotNV = clamp( dot( normal, viewDir ), 0.0, 1.0 );
  vec2 fab = dfgApprox( dotNV, roughness );
  vec3 returned = reflectance.rgb * fab.x + fab.y;
  vec3 environment = environmentReflection( viewDir, normal, roughness );
  float roughFade = 1.0 - smoothstep( ${(ROUGHNESS_LIMIT * 0.7).toFixed(3)}, ${ROUGHNESS_LIMIT.toFixed(3)}, roughness );

  // On the floor plane: the mirror image at this point.
  vec3 worldPosition = ( camWorld * vec4( origin, 1.0 ) ).xyz;
  vec3 worldNormal = normalize( ( camWorld * vec4( normal, 0.0 ) ).xyz );
  // Depth loses precision with distance, so the band widens with it, and the
  // point read is where the view ray meets the plane, not the depth's guess.
  float band = ${FLOOR_TOLERANCE.toFixed(3)} + length( origin ) * 0.002;
  if ( mirrorOn && worldNormal.z > ${FLOOR_NORMAL_Z.toFixed(3)}
    && abs( worldPosition.z - floorHeight ) < band ) {
    vec3 eye = camOrtho
      ? ( camWorld * vec4( origin.xy, 0.0, 1.0 ) ).xyz
      : camWorld[ 3 ].xyz;
    vec3 sight = worldPosition - eye;
    if ( abs( sight.z ) > 1e-6 ) worldPosition = eye + sight * ( ( floorHeight - eye.z ) / sight.z );
    vec4 clip = mirrorViewProj * vec4( worldPosition, 1.0 );
    vec2 mirrorUv = clip.xy / clip.w * 0.5 + 0.5;
    if ( clip.w > 0.0 && all( greaterThanEqual( mirrorUv, vec2( 0.0 ) ) )
      && all( lessThanEqual( mirrorUv, vec2( 1.0 ) ) ) ) {
      // How far the reflected surface is from the floor along the ray, for
      // the blur; nothing drawn counts as the furthest a reflection is traced.
      vec3 floorPoint = ( mirrorView * vec4( worldPosition, 1.0 ) ).xyz;
      float seenDepth = texture( mirrorDepth, mirrorUv ).r;
      float travelled = ${MAX_DISTANCE.toFixed(1)};
      float seenZ = floorPoint.z - travelled;
      if ( seenDepth < 1.0 ) {
        vec4 p = mirrorProjInverse * vec4( mirrorUv * 2.0 - 1.0, seenDepth * 2.0 - 1.0, 1.0 );
        vec3 seen = p.xyz / p.w;
        travelled = camOrtho ? floorPoint.z - seen.z : length( seen ) - length( floorPoint );
        seenZ = seen.z;
      }
      float pixelSize = ( camOrtho ? 2.0 : 2.0 * abs( seenZ ) ) / ( proj[ 1 ][ 1 ] * mirrorSize.y );
      float spread = roughness * roughness * max( travelled, 0.0 );
      float level = clamp( log2( max( spread / pixelSize, 1.0 ) ), 0.0, min( mirrorLevels, ${MAX_LEVEL.toFixed(1)} ) );
      vec3 mirrored = textureLod( mirrorMips, mirrorUv, level ).rgb;
      outputColor.rgb = max( inputColor.rgb + roughFade * returned * ( mirrored - environment ), 0.0 );
      return;
    }
  }

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

  // Cut off where it leaves the frame.
  vec2 travel = uvEnd - uvStart;
  float reach = 1.0;
  if ( travel.x > 1e-6 ) reach = min( reach, ( 1.0 - uvStart.x ) / travel.x );
  if ( travel.x < -1e-6 ) reach = min( reach, -uvStart.x / travel.x );
  if ( travel.y > 1e-6 ) reach = min( reach, ( 1.0 - uvStart.y ) / travel.y );
  if ( travel.y < -1e-6 ) reach = min( reach, -uvStart.y / travel.y );
  reach = max( reach, 0.0 );

  // Through the depth pyramid, in pixels. Over a cell, the ray's distance
  // runs between its values where it enters and leaves, as distance along a
  // line is monotonic on screen.
  vec2 pStart = uvStart * frameSize;
  vec2 pDelta = travel * frameSize;
  // A hundredth of a pixel, to step over a cell's edge into the next one.
  float nudge = 0.01 / max( max( abs( pDelta.x ), abs( pDelta.y ) ), 1e-6 );
  float t = cellExit( pStart, pDelta, floor( pStart ), 1.0 ) + nudge;
  int cellLevel = 0;
  float hit = -1.0;
  vec2 hitPixel = vec2( 0.0 );
  float hitDistance = 0.0;
  float hitDepth = 1.0;
  for ( int i = 0; i < ${TRACE_STEPS}; i++ ) {
    if ( t >= reach ) break;
    float size = exp2( float( cellLevel ) );
    vec2 cell = floor( ( pStart + pDelta * t ) / size );
    float tOut = min( cellExit( pStart, pDelta, cell, size ), reach );
    float d0 = -mix( zStart, zEnd, t ) / mix( kStart, kEnd, t );
    float d1 = -mix( zStart, zEnd, tOut ) / mix( kStart, kEnd, tOut );
    float nearest = nearestIn( cellLevel, ivec2( cell ) );
    // In front of everything in the cell: nothing to meet, so on to the next
    // cell, a level coarser.
    if ( max( d0, d1 ) < nearest ) {
      t = tOut + nudge;
      cellLevel = min( cellLevel + 1, pyramidTop );
      continue;
    }
    if ( cellLevel > 0 ) { cellLevel--; continue; }
    // One pixel, and the ray reaches its surface. It meets it if it is no
    // further behind than the surface is thick: a centimetre for a lens face, a few for anything else. Further
    // behind, it passed behind it.
    float sheet = texelFetch( surfaceReflectances, ivec2( cell ), 0 ).a;
    float body = sheet > 0.2 && sheet < 0.3 ? 0.01 : 0.03 + nearest * 0.01;
    if ( min( d0, d1 ) <= nearest + body ) {
      hit = t;
      hitPixel = cell;
      hitDistance = nearest;
      hitDepth = surfaceDepthAt( ( cell + 0.5 ) / frameSize );
      break;
    }
    t = tOut + nudge;
  }
  if ( hit < 0.0 ) return;

  // The centre of the pixel met, so the frame is read on the surface and not
  // on its edge.
  vec2 hitUv = ( hitPixel + 0.5 ) / frameSize;
  float hitZ = -hitDistance;
  float travelled = distance( origin, viewPositionAt( hitUv, hitDepth ) );

  // Confidence: fades out near the screen's edges, as the ray turns back
  // towards the camera, and towards the roughness limit.
  vec2 edge = min( hitUv, 1.0 - hitUv );
  float weight = smoothstep( 0.0, 0.06, min( edge.x, edge.y ) );
  // A hit a few centimetres away -- a casing's recess beside its picture --
  // is finer than the frame can trace, and comes and goes from pixel to pixel.
  weight *= smoothstep( 0.02, 0.06, travelled );
  weight *= 1.0 - smoothstep( 0.25, 0.75, ray.z );
  weight *= roughFade;
  // The frame holds each surface as the camera sees it. A surface met edge-on
  // or from behind shows the ray something else -- a lens face, bright
  // head-on and dark from the side, is the worst of it -- so such a hit
  // fades out.
  vec4 hitSurface = texelFetch( surfaceNormals, ivec2( hitPixel ), 0 );
  if ( dot( hitSurface.xyz, hitSurface.xyz ) > 0.25 ) {
    weight *= smoothstep( 0.0, 0.3, dot( normalize( hitSurface.xyz ), -ray ) );
  }
  if ( weight <= 0.0 ) return;

  // A rough surface's reflection spreads with distance: a cone about as wide
  // as roughness squared, read off the mip level whose texels are that wide.
  float pixelSize = ( camOrtho ? 2.0 : 2.0 * abs( hitZ ) ) / ( proj[ 1 ][ 1 ] * frameSize.y );
  float spread = roughness * roughness * travelled;
  float level = clamp( log2( max( spread / pixelSize, 1.0 ) ), 0.0, min( frameLevels, ${MAX_LEVEL.toFixed(1)} ) );
  vec3 traced = textureLod( frameMips, hitUv, level ).rgb;

  outputColor.rgb = max( inputColor.rgb + weight * returned * ( traced - environment ), 0.0 );
}
`;

const scratchSize = new THREE.Vector2();
const mirrorPosition = new THREE.Vector3();
const mirrorQuaternion = new THREE.Quaternion();
const mirrorScale = new THREE.Vector3();
const mirrorForward = new THREE.Vector3();
const mirrorUp = new THREE.Vector3();
const mirrorTarget = new THREE.Vector3();
const floorBox = new THREE.Box3();
const floorSize = new THREE.Vector3();
const floorMatrix = new THREE.Matrix4();
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
        ['pyramidEven', new THREE.Uniform(null)],
        ['pyramidOdd', new THREE.Uniform(null)],
        ['pyramidOffsets', new THREE.Uniform(
          Array.from({ length: PYRAMID_LEVELS }, () => new THREE.Vector2()),
        )],
        ['pyramidTop', new THREE.Uniform(0)],
        ['frameMips', new THREE.Uniform(null)],
        ['frameLevels', new THREE.Uniform(0)],
        ['mirrorOn', new THREE.Uniform(false)],
        ['floorHeight', new THREE.Uniform(0)],
        ['mirrorMips', new THREE.Uniform(null)],
        ['mirrorDepth', new THREE.Uniform(null)],
        ['mirrorView', new THREE.Uniform(new THREE.Matrix4())],
        ['mirrorViewProj', new THREE.Uniform(new THREE.Matrix4())],
        ['mirrorProjInverse', new THREE.Uniform(new THREE.Matrix4())],
        ['mirrorSize', new THREE.Uniform(new THREE.Vector2(1, 1))],
        ['mirrorLevels', new THREE.Uniform(0)],
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
    this.pyramid = null;
    this.mirror = null;
    this.mirrorMips = null;
    this.mirrorCamera = null;
    /** The floor plane's height, or null with no floor; and frames to the next look. */
    this.floor = null;
    this.floorCountdown = 0;
    this.pyramidLevels = [];
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
      const mirrorWidth = Math.max(1, Math.round(width * MIRROR_SCALE));
      const mirrorHeight = Math.max(1, Math.round(height * MIRROR_SCALE));
      this.mirror = new THREE.WebGLRenderTarget(mirrorWidth, mirrorHeight, {
        type: THREE.HalfFloatType,
        depthBuffer: true,
      });
      this.mirror.depthTexture = new THREE.DepthTexture(mirrorWidth, mirrorHeight);
      this.mirrorMips = new THREE.WebGLRenderTarget(mirrorWidth, mirrorHeight, {
        type: THREE.HalfFloatType,
        minFilter: THREE.LinearMipmapLinearFilter,
        magFilter: THREE.LinearFilter,
        generateMipmaps: true,
        depthBuffer: false,
      });
      this.layoutPyramid(width, height);
    } else if (this.surfaces.width !== width || this.surfaces.height !== height) {
      this.surfaces.setSize(width, height);
      this.frameCopy.setSize(width, height);
      const mirrorWidth = Math.max(1, Math.round(width * MIRROR_SCALE));
      const mirrorHeight = Math.max(1, Math.round(height * MIRROR_SCALE));
      this.mirror.setSize(mirrorWidth, mirrorHeight);
      this.mirrorMips.setSize(mirrorWidth, mirrorHeight);
      this.layoutPyramid(width, height);
    }
    const { uniforms } = this;
    const [normals, reflectances] = this.surfaces.textures;
    uniforms.get('surfaceNormals').value = normals;
    uniforms.get('surfaceReflectances').value = reflectances;
    uniforms.get('surfaceDepth').value = this.surfaces.depthTexture;
    uniforms.get('frameMips').value = this.frameCopy.texture;
    uniforms.get('frameLevels').value = Math.floor(Math.log2(Math.max(width, height)));
    uniforms.get('frameSize').value.set(width, height);
    uniforms.get('mirrorMips').value = this.mirrorMips.texture;
    uniforms.get('mirrorDepth').value = this.mirror.depthTexture;
    uniforms.get('mirrorSize').value.set(this.mirror.width, this.mirror.height);
    uniforms.get('mirrorLevels').value = Math.floor(Math.log2(Math.max(this.mirror.width, this.mirror.height)));
  }

  /**
   * Finds the floor plane: the top face of the glossy flat objects covering
   * the most area, by height to the millimetre. Null when there are none.
   *
   * @private
   * @returns {Number|null}
   */
  findFloor() {
    const areas = new Map();
    const add = (geometry, matrix) => {
      floorBox.copy(geometry.boundingBox).applyMatrix4(matrix);
      floorBox.getSize(floorSize);
      if (floorSize.z > FLOOR_THICKNESS || floorSize.x * floorSize.y < FLOOR_AREA) return;
      const height = Math.round(floorBox.max.z * 1000);
      areas.set(height, (areas.get(height) || 0) + floorSize.x * floorSize.y);
    };
    this.scene.traverseVisible((object) => {
      if (!object.isMesh) return;
      const material = Array.isArray(object.material) ? object.material[0] : object.material;
      if (!material || !material.isMeshStandardMaterial) return;
      if (material.roughness >= ROUGHNESS_LIMIT && !material.roughnessMap) return;
      const { geometry } = object;
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      if (object.isInstancedMesh) {
        for (let k = 0; k < object.count; k++) {
          object.getMatrixAt(k, floorMatrix);
          add(geometry, floorMatrix.premultiply(object.matrixWorld));
        }
      } else {
        add(geometry, object.matrixWorld);
      }
    });
    let best = null;
    let bestArea = 0;
    areas.forEach((area, height) => {
      if (area > bestArea) {
        best = height / 1000;
        bestArea = area;
      }
    });
    return best;
  }

  /**
   * Draws the mirror image: the scene from the camera's reflection in the
   * floor plane, everything below the plane clipped away, then clamped into
   * mip levels as the frame is.
   *
   * @private
   */
  drawMirror(renderer) {
    const { scene, camera, uniforms } = this;
    if (!this.mirrorCamera || this.mirrorCamera.type !== camera.type) {
      this.mirrorCamera = camera.clone();
    }
    const mirror = this.mirrorCamera;
    // The camera's own projection, lens shift and all. The mirror camera is a
    // rotation, so its image runs left to right against the reflection's, and
    // a horizontal lens shift must point the other way to cover the view.
    mirror.projectionMatrix.copy(camera.projectionMatrix);
    mirror.projectionMatrix.elements[camera.isOrthographicCamera ? 12 : 8] *= -1;
    mirror.projectionMatrixInverse.copy(mirror.projectionMatrix).invert();
    camera.matrixWorld.decompose(mirrorPosition, mirrorQuaternion, mirrorScale);
    mirrorForward.set(0, 0, -1).applyQuaternion(mirrorQuaternion);
    mirrorUp.set(0, 1, 0).applyQuaternion(mirrorQuaternion);
    mirrorPosition.z = 2 * this.floor - mirrorPosition.z;
    mirrorForward.z *= -1;
    mirrorUp.z *= -1;
    mirror.position.copy(mirrorPosition);
    mirror.up.copy(mirrorUp);
    mirror.lookAt(mirrorTarget.copy(mirrorPosition).add(mirrorForward));
    mirror.updateMatrixWorld();

    uniforms.get('mirrorView').value.copy(mirror.matrixWorldInverse);
    uniforms.get('mirrorViewProj').value.multiplyMatrices(mirror.projectionMatrix, mirror.matrixWorldInverse);
    uniforms.get('mirrorProjInverse').value.copy(mirror.projectionMatrixInverse);

    // Editor lines, points and labels are not in the room.
    const hidden = [];
    scene.traverse((object) => {
      if (object.visible && (object.isLine || object.isPoints || object.isSprite)) {
        object.visible = false;
        hidden.push(object);
      }
    });
    const wasTarget = renderer.getRenderTarget();
    const wasClipping = renderer.clippingPlanes;
    const wasShadowUpdate = renderer.shadowMap.autoUpdate;
    try {
      MIRROR_CLIP[0].constant = -(this.floor + 0.002);
      renderer.clippingPlanes = MIRROR_CLIP;
      renderer.shadowMap.autoUpdate = false;
      renderer.setRenderTarget(this.mirror);
      renderer.clear(true, true, false);
      renderer.render(scene, mirror);
    } finally {
      renderer.clippingPlanes = wasClipping;
      renderer.shadowMap.autoUpdate = wasShadowUpdate;
      hidden.forEach((object) => { object.visible = true; });
    }
    COPY.uniforms.source.value = this.mirror.texture;
    renderer.setRenderTarget(this.mirrorMips);
    renderer.render(copyScene, copyCamera);
    renderer.setRenderTarget(wasTarget);
  }

  /**
   * Places the depth pyramid's levels. Even levels go in one texture and odd
   * in another, so a level is never drawn into the texture it is read from:
   * the first of each at the corner, the rest stacked in a column beside it.
   *
   * @private
   */
  layoutPyramid(width, height) {
    const top = Math.min(PYRAMID_LEVELS - 1, Math.ceil(Math.log2(Math.max(width, height, 2))));
    const levels = [];
    const atlases = [0, 1].map(() => ({
      width: 0, height: 0, column: 0, stacked: 0,
    }));
    let w = width;
    let h = height;
    for (let level = 0; level <= top; level++) {
      const atlas = atlases[level % 2];
      let x = 0;
      let y = 0;
      if (level < 2) {
        atlas.column = w;
        atlas.width = w;
        atlas.height = h;
      } else {
        x = atlas.column;
        y = atlas.stacked;
        atlas.stacked = y + h;
        atlas.width = Math.max(atlas.width, x + w);
        atlas.height = Math.max(atlas.height, y + h);
      }
      levels.push({
        x, y, width: w, height: h,
      });
      w = Math.ceil(w / 2);
      h = Math.ceil(h / 2);
    }
    this.pyramidLevels = levels;
    if (!this.pyramid) {
      const options = {
        type: THREE.FloatType,
        format: THREE.RedFormat,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        generateMipmaps: false,
        depthBuffer: false,
      };
      this.pyramid = [0, 1].map(() => new THREE.WebGLRenderTarget(1, 1, options));
    }
    this.pyramid.forEach((target, k) => target.setSize(atlases[k].width, atlases[k].height));
    const { uniforms } = this;
    uniforms.get('pyramidEven').value = this.pyramid[0].texture;
    uniforms.get('pyramidOdd').value = this.pyramid[1].texture;
    uniforms.get('pyramidTop').value = top;
    const offsets = uniforms.get('pyramidOffsets').value;
    levels.forEach((entry, level) => offsets[level].set(entry.x, entry.y));
  }

  /**
   * Builds the depth pyramid from the surface buffer's depth.
   *
   * @private
   */
  buildPyramid(renderer) {
    const levels = this.pyramidLevels;
    const wasTarget = renderer.getRenderTarget();
    const wasAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    try {
      PYRAMID_BASE.uniforms.depth.value = this.surfaces.depthTexture;
      PYRAMID_BASE.uniforms.projInverse.value.copy(this.camera.projectionMatrixInverse);
      levels.forEach((entry, level) => {
        const target = this.pyramid[level % 2];
        target.viewport.set(entry.x, entry.y, entry.width, entry.height);
        target.scissorTest = false;
        if (level === 0) {
          copyQuad.material = PYRAMID_BASE;
        } else {
          const source = levels[level - 1];
          const u = PYRAMID_LEVEL.uniforms;
          u.source.value = this.pyramid[(level - 1) % 2].texture;
          u.sourceOffset.value.set(source.x, source.y);
          u.sourceLast.value.set(source.width - 1, source.height - 1);
          u.offset.value.set(entry.x, entry.y);
          copyQuad.material = PYRAMID_LEVEL;
        }
        renderer.setRenderTarget(target);
        renderer.render(copyScene, copyCamera);
      });
    } finally {
      copyQuad.material = COPY;
      renderer.autoClear = wasAutoClear;
      renderer.setRenderTarget(wasTarget);
    }
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

    if (this.floorCountdown <= 0) {
      this.floor = this.findFloor();
      this.floorCountdown = FLOOR_RECHECK;
    }
    this.floorCountdown--;
    uniforms.get('mirrorOn').value = this.floor !== null;
    if (this.floor !== null) {
      uniforms.get('floorHeight').value = this.floor;
      this.drawMirror(renderer);
    }
    this.drawSurfaces(renderer);
    this.buildPyramid(renderer);

    // The frame as it stands, with mip levels for the blur.
    COPY.uniforms.source.value = inputBuffer.texture;
    const wasTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.frameCopy);
    renderer.render(copyScene, copyCamera);
    renderer.setRenderTarget(wasTarget);
  }
}
