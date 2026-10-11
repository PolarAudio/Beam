import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import Shapers, { SHAPER_GLSL } from './shapers';

RectAreaLightUniformsLib.init();

/**
 * What one unit of light-field intensity is worth, in candela.
 *
 * The field has no physical unit of its own. It is pinned to a discharge
 * mover of about twenty thousand lumens in a fifteen degree cone, which
 * writes 100; every fixture puts its candela into these units, so a strobe
 * and a small LED spot light a floor in proportion to what they really emit.
 */
const REFERENCE_INTENSITY = 100;
const REFERENCE_LUMENS = 20000;
const REFERENCE_CONE_DEGREES = 15;
const REFERENCE_HALF_ANGLE = (REFERENCE_CONE_DEGREES / 2) * (Math.PI / 180);
const REFERENCE_SOLID_ANGLE = 2 * Math.PI * (1 - Math.cos(REFERENCE_HALF_ANGLE));
const CANDELA_PER_UNIT = (REFERENCE_LUMENS / REFERENCE_SOLID_ANGLE) / REFERENCE_INTENSITY;

/**
 * Linear scene units per lux. The one calibration constant for light landing
 * on a surface, and a real one, shared by the projector and every fixture in
 * the field.
 *
 * Everything else about a light's brightness is computed rather than chosen.
 * A projector's illuminance is lumens over the area the lens makes at that
 * distance; a fixture's is its candela over the distance squared. Both are
 * numbers a designer already thinks in -- a dark venue is one to five lux,
 * street lighting ten to twenty, a mapping rig on a facade fifty to a hundred
 * and fifty, a mover's pool hundreds.
 *
 * Only the last step needs a decision: lux to a value the tone curve can eat.
 * This is it, the camera's exposure, and it is the only number here set by
 * looking.
 *
 * Anchored on a reference rig, the one to check against if this ever drifts:
 * a 10000-lumen machine, throw ratio 1.5, 1920x1200, twenty-seven
 * metres off a church. That is a 17 x 10.5 m image at **about 60 lux**, which
 * at this value reads as a projection that clearly owns the facade against a
 * dark venue -- which is what sixty lux on a wall at night looks like.
 */
const LUX_SCALE = 0.022;

/**
 * What the render buffer holds: luminance in cd/m2 times this. A matte
 * surface of reflectance rho under E lux has luminance rho E / pi, so it reads
 * rho E LUX_SCALE / pi -- what three's Lambert term gives a light whose
 * intensity is in these units. The camera's exposure undoes this factor; see
 * `exposureForEV` in visualizer.js.
 */
const SCENE_PER_NIT = LUX_SCALE;

/**
 * A light-field unit as a three.js light intensity: candela into scene
 * units, so that with an inverse-square falloff a surface receives its lux
 * times `LUX_SCALE`, the same scale a projected picture lands at.
 */
const SCENE_INTENSITY_PER_UNIT = CANDELA_PER_UNIT * LUX_SCALE;

/**
 * @file Every fixture's light, in a texture rather than a uniform array.
 *
 * three puts each light into a fixed-size uniform array that is compiled into
 * every lit fragment shader. A spot light costs about five fragment uniform
 * vectors, a GPU commonly offers 1024, and a rig of 198 movers therefore did
 * not merely run slowly -- `MeshStandardMaterial` stopped linking:
 *
 *     THREE.WebGLProgram: Shader Error 1282 - VALIDATE_STATUS false
 *     FRAGMENT shader uniforms count exceeds MAX_FRAGMENT_UNIFORM_VECTORS(1024)
 *
 * A program that will not link draws nothing, so every body, floor and object
 * disappeared at once while the unlit beam cap carried on. An arena rig runs
 * to several hundred movers, so that ceiling is not one to manage -- a pool of
 * "real" lights chosen per frame would have to pick winners, and picking
 * winners is what makes lights pop on and off as the camera moves.
 *
 * So the lights stop being uniforms. Their parameters live in a float texture,
 * three texels each, and the shader reads them with `texelFetch`. What limits
 * the count is texture size, which is thousands, and nothing has to be chosen.
 *
 * **This is half of the job.** The loop here still visits every light for every
 * fragment, so cost is O(lights x pixels) and it will not stay comfortable at
 * several hundred. The next step is to bin lights into clusters of the view
 * frustum so a fragment reads only the handful that can reach it; the data is
 * already in the shape that wants. Correct first, then fast.
 *
 * **Shadows come from the fixtures' own depth tiles, not from three.** A
 * moving head already draws what its lens sees into a tile of the mover
 * depth atlas so its beam can stop at a surface; the same tile says whether
 * a surface point is the first thing the lens sees, which is a shadow map.
 * A source that has a tile passes it in its record, and the loop drops the
 * light on any point past the tile's surface. One depth from one camera
 * serves the beam and the pool, so they cannot disagree about where the
 * light stops. Heads that cast a three shadow keep a real `THREE.SpotLight`
 * and three's own path, capped as before.
 */

/**
 * How many texels one light occupies.
 *
 * Eleven:
 *
 *   0: position.xyz, range
 *   1: direction.xyz, cosine of how far out the light can reach: the cone's
 *      outer edge, widened by the lens's blur for a light with a tile
 *   2: colour.rgb (already scaled by intensity), cosine of the penumbra
 *   3: the depth tile's rect in the atlas, x y width height
 *   4: the tile camera's x axis, world; tangent of its half fov
 *   5: the tile camera's y axis, world; 1 when the light has a tile, else 0
 *   6: the tile camera's origin, world; the inner cone over the field
 *   7: the gobos in the beam, two of (texture layer, angle)
 *   8: the prism in the beam: facets, angle, spread (facets under 2 is
 *      none); w the gobo defocus from the focus, in baked blur levels
 *   9: the colour past a colour wheel split, rgb scaled by intensity; w the
 *      split, 0 none
 *  10: how far the iris is open, 1 fully to 0 closed; the lens radius, m;
 *      1 / focus distance, 1/m, 0 infinity; cosine of the cone's outer edge.
 *      An iris of -1 marks an area light, a display: the lens radius is then
 *      the radius of a disc of the panel's area
 *  11: the light's row of the shaper table, -1 for no blades
 *
 * An area light uses texels 7 and 8, which it has no gobo or prism for, for
 * its rectangle: the half-width and half-height vectors, world.
 *
 * `direction` is stored three's way round -- `normalize(position - target)`,
 * pointing back up the beam rather than along it -- so that the angle test
 * here is the same arithmetic as `getSpotLightInfo`, and a surface lit through
 * this path matches one lit by a real `SpotLight`.
 *
 * Texels 3 to 10 are only read once a fragment has passed the range and cone
 * tests, so a light that cannot reach a fragment costs the same as before.
 *
 * @constant {Number}
 */
const TEXELS_PER_LIGHT = 12;

/** Lights the texture holds before it is grown. Doubles on demand. */
const INITIAL_CAPACITY = 128;

/**
 * A hard stop, well past any rig, so a bug that never stops adding lights is
 * refused rather than allowed to allocate until the renderer dies.
 *
 * @constant {Number}
 */
const MAX_LIGHTS = 4096;

/** Sources asked for their light each frame. See `register`. */
const sources = [];

let capacity = INITIAL_CAPACITY;
let data = new Float32Array(capacity * TEXELS_PER_LIGHT * 4);
let texture = null;

/**
 * Scratch a source fills in, reused for every light so that reading the field
 * allocates nothing per frame.
 */
const record = {
  position: new THREE.Vector3(),
  direction: new THREE.Vector3(),
  color: new THREE.Color(),
  intensity: 1,
  range: 60,
  cosOuter: Math.cos(Math.PI / 4),
  cosInner: Math.cos(Math.PI / 8),
  /** Whether the fields below are set; cleared before every source reads. */
  hasTile: false,
  tile: new THREE.Vector4(),
  tileOrigin: new THREE.Vector3(),
  axisX: new THREE.Vector3(),
  axisY: new THREE.Vector3(),
  tanHalf: 1,
  /** The inner cone over the field, where the pool's falloff starts. */
  inner: 0.5,
  /** Two gobos as (texture layer, angle); layer 0 is open. */
  gobo: new THREE.Vector4(),
  /** The prism as (facets, angle, spread, 0); facets under 2 is none. */
  prism: new THREE.Vector4(),
  /** The colour past a colour wheel split, and the split, 0 none. */
  colorB: new THREE.Color(),
  split: 0,
  /** The lens radius, m, and 1 / its focus distance, 1/m; 0 no blur. */
  lensRadius: 0,
  invFocus: 0,
  /** The cosine of the light's reach past its cone, null for the cone itself. */
  cosReach: null,
  /** How far the iris is open, 1 fully to 0 closed. */
  iris: 1,
  /** The light's row of the shaper table, -1 for no blades. */
  shaperRow: -1,
  /** An area light's half-width and half-height, world; read when iris is -1. */
  rectX: new THREE.Vector3(),
  rectY: new THREE.Vector3(),
};

/**
 * What every lit material needs to read the field.
 *
 * Shared by reference across materials, so writing the count once here reaches
 * all of them.
 */
const uniforms = {
  lightField: { value: null },
  lightFieldCount: { value: 0 },
  // Sources write candela on the lux scale; light falls as the inverse square.
  lightFieldDecay: { value: 2 },
  // The haze's extinction per metre on the way from a lens to a surface;
  // 0 with no haze. The beam in the air pays the same on its own path.
  lightFieldExtinction: { value: 0 },
  // The mover depth atlas, set by `Light.renderDepth` each frame.
  lightFieldDepth: { value: null },
  lightFieldDepthFar: { value: 1 },
  lightFieldDepthBias: { value: 0.05 },
  lightFieldDepthTile: { value: 128 },
  // 1 softens the depth tile's shadows by the lens's size, 0 keeps them hard.
  lightFieldSoftShadow: { value: 1 },
  // The gobo patterns, one atlas, set with the depth atlas.
  lightFieldGobo: { value: null },
  // Every light's framing blades; see shapers.js.
  lightFieldShapers: { value: Shapers.texture },
  // The rectangle-light tables three's own RectAreaLight reads; half float is
  // filterable on every WebGL2 device.
  lightFieldLtc1: { value: THREE.UniformsLib.LTC_HALF_1 },
  lightFieldLtc2: { value: THREE.UniformsLib.LTC_HALF_2 },
};

/** Builds the texture, or rebuilds it after the store has grown. */
function rebuildTexture() {
  if (texture) texture.dispose();
  texture = new THREE.DataTexture(
    data,
    TEXELS_PER_LIGHT,
    capacity,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  // Nearest, and never mipmapped: these are numbers rather than an image, and
  // an interpolated light is a light that does not exist.
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  uniforms.lightField.value = texture;
}

rebuildTexture();

/**
 * The loop appended to every lit material.
 *
 * Written against three's own helpers -- `getSpotAttenuation`,
 * `getDistanceAttenuation` and `RE_Direct` -- rather than a lighting model of
 * its own, so what this adds is what a `SpotLight` would have added. The two
 * early exits are what keep it survivable before clustering exists: a fragment
 * outside a light's range, or outside its cone, does no shading work for it.
 *
 * @constant {String}
 */
const FIELD_LIGHT_CHUNK = /* glsl */`
#if defined( RE_Direct )
{
  IncidentLight fieldLight;
  for ( int i = 0; i < lightFieldCount; i ++ ) {
    vec4 packedPosition = texelFetch( lightField, ivec2( 0, i ), 0 );
    vec4 packedDirection = texelFetch( lightField, ivec2( 1, i ), 0 );
    vec4 packedColor = texelFetch( lightField, ivec2( 2, i ), 0 );

    vec3 lightPosition = ( viewMatrix * vec4( packedPosition.xyz, 1.0 ) ).xyz;
    vec3 toLight = lightPosition - geometryPosition;
    float lightDistance = length( toLight );
    if ( lightDistance > packedPosition.w ) continue;

    fieldLight.direction = toLight / lightDistance;
    vec3 spotDirection = normalize( ( viewMatrix * vec4( packedDirection.xyz, 0.0 ) ).xyz );
    float angleCos = dot( fieldLight.direction, spotDirection );
    if ( angleCos <= packedDirection.w ) continue;

    float attenuation = getDistanceAttenuation( lightDistance, packedPosition.w, lightFieldDecay )
      * exp( -lightFieldExtinction * lightDistance );
    if ( attenuation <= 0.0 ) continue;
    // A colour wheel split: how much of this point's light is the far colour.
    float farShare = 0.0;
    vec3 farColor = packedColor.rgb;

    // An area light -- a display -- is a matte rectangle; its colour is its
    // luminance times its area. A standard material integrates it over the
    // rectangle below, so a glossy surface reflects its shape. Any other
    // material takes it as a disc of the same area, radius R, falling as
    // cos / (d^2 + R^2), so a surface at its face receives pi times its
    // luminance and one far off sees a point.
    vec4 packedLens = texelFetch( lightField, ivec2( 10, i ), 0 );
    bool areaLight = packedLens.x < -0.5;
    if ( areaLight ) {
      attenuation = exp( -lightFieldExtinction * lightDistance );
#ifndef STANDARD
      attenuation *= angleCos / ( lightDistance * lightDistance + packedLens.y * packedLens.y );
#endif
    }

    // The pool's shape, and whether this point is the first thing the
    // light's lens sees. A light with a depth tile carries its beam frame:
    // the tile was drawn from a camera at the tile origin looking down the
    // beam, up along the beam's y, so the point's place in the aperture is
    // its offset from that origin resolved on the beam's axes, all in view
    // space since the view transform is rigid. That place gives the pool's
    // shape -- falloff, gobos, prism copies -- the same way the beam in the
    // air computes it, so the two cannot disagree. For the shadow the point
    // is first pushed off its surface along the normal by a texel and a half
    // at its distance, so a surface does not shadow itself where a tile
    // texel spans a stretch of it. A light without a tile keeps three's
    // cone falloff.
    vec4 packedAxisY = texelFetch( lightField, ivec2( 5, i ), 0 );
    if ( packedAxisY.w > 0.5 ) {
      vec4 packedTile = texelFetch( lightField, ivec2( 3, i ), 0 );
      vec4 packedAxisX = texelFetch( lightField, ivec2( 4, i ), 0 );
      vec4 packedOrigin = texelFetch( lightField, ivec2( 6, i ), 0 );
      vec3 tileAxisX = normalize( ( viewMatrix * vec4( packedAxisX.xyz, 0.0 ) ).xyz );
      vec3 tileAxisY = normalize( ( viewMatrix * vec4( packedAxisY.xyz, 0.0 ) ).xyz );
      vec3 tileAxisZ = cross( tileAxisX, tileAxisY );
      vec3 tileOrigin = ( viewMatrix * vec4( packedOrigin.xyz, 1.0 ) ).xyz;
      vec3 offset = geometryPosition - tileOrigin;
      float along = dot( offset, tileAxisZ );
      if ( along <= 0.0 ) continue;
      if ( !areaLight ) {
        vec4 packedGobo = texelFetch( lightField, ivec2( 7, i ), 0 );
        vec4 packedPrism = texelFetch( lightField, ivec2( 8, i ), 0 );
        // The aperture coordinate is measured against the field's own tangent:
        // the outer cone's, which a prism widens by its spread, taken back out.
        // Not the tile's, which also holds the lens's blur.
        float drawnSpread = abs( packedPrism.x ) >= 2.0 ? 1.0 + packedPrism.z : 1.0;
        float cosOuter = max( packedLens.w, 1e-4 );
        float tanField = sqrt( max( 1.0 - cosOuter * cosOuter, 0.0 ) ) / cosOuter / drawnSpread;
        vec2 aperture = vec2( dot( offset, tileAxisX ), dot( offset, tileAxisY ) ) / ( along * tanField );
        vec4 packedColorB = texelFetch( lightField, ivec2( 9, i ), 0 );
        // The lens's blur at this surface, in field radii: the lens radius times
        // how far the surface is from the focus, over the field's radius here.
        float blur = packedLens.y * abs( 1.0 - along * packedLens.z ) / max( along * tanField, 1e-5 );
        float shaperRow = texelFetch( lightField, ivec2( 11, i ), 0 ).x;
        vec2 sides = fieldStencil( aperture, packedOrigin.w, packedGobo, packedPrism, packedColorB.w, packedLens.x, blur, shaperRow );
        float shape = sides.x + sides.y;
        if ( shape <= 0.0 ) continue;
        attenuation *= shape;
        farShare = sides.y / shape;
        farColor = packedColorB.rgb;
      }

      float texel = 2.0 * along * packedAxisX.w / lightFieldDepthTile;
      vec3 lifted = offset + geometryNormal * ( texel * 1.5 );
      float alongLifted = dot( lifted, tileAxisZ );
      // Slope allowance. Lifting along the normal is enough where the beam
      // meets a surface head-on, but at a grazing angle the lift hardly
      // changes the distance along the beam while the surface's own depth
      // changes by a texel's width times the tangent of the angle across one
      // tile texel -- so neighbouring texels passed and failed alternately and
      // a low pool on the floor was cut into stair-steps. Capped, so a shadow
      // cast at a grazing angle still starts near what casts it.
      float facing = abs( dot( geometryNormal, normalize( offset ) ) );
      float slope = sqrt( max( 1.0 - facing * facing, 0.0 ) ) / max( facing, 0.05 );
      float allowance = lightFieldDepthBias + min( texel * 1.5 * slope, texel * 8.0 );
      vec2 ndc = vec2( -dot( lifted, tileAxisX ), dot( lifted, tileAxisY ) ) / ( alongLifted * packedAxisX.w );
      if ( all( lessThan( abs( ndc ), vec2( 1.0 ) ) ) ) {
        float seen = fieldDepthAt( packedTile, ndc );
        bool blocked = alongLifted > seen + allowance;
        if ( lightFieldSoftShadow > 0.5 && packedLens.y > 0.0 ) {
          float lit = fieldSoftShadow(
            packedTile, ndc, blocked ? seen : -1.0, lifted, geometryNormal,
            tileAxisX, tileAxisY, tileAxisZ, packedAxisX.w, packedLens.y, texel
          );
          if ( lit <= 0.0 ) continue;
          attenuation *= lit;
        } else if ( blocked ) {
          continue;
        }
      }
    } else if ( !areaLight ) {
      // The cone's own edge, not the reach the cone test above allowed for.
      float cosOuter = packedLens.w;
      attenuation *= getSpotAttenuation( cosOuter, packedColor.w, angleCos );
      if ( attenuation <= 0.0 ) continue;
    }

#ifdef STANDARD
    // The rectangle by linearly transformed cosines, as three's RectAreaLight:
    // diffuse and specular integrated over its corners, wound so its normal
    // faces the lit side. attenuation holds only extinction and shadow here.
    if ( areaLight ) {
      vec3 rectX = ( viewMatrix * vec4( texelFetch( lightField, ivec2( 7, i ), 0 ).xyz, 0.0 ) ).xyz;
      vec3 rectY = ( viewMatrix * vec4( texelFetch( lightField, ivec2( 8, i ), 0 ).xyz, 0.0 ) ).xyz;
      vec3 rectCoords[ 4 ];
      rectCoords[ 0 ] = lightPosition + rectX - rectY;
      rectCoords[ 1 ] = lightPosition - rectX - rectY;
      rectCoords[ 2 ] = lightPosition - rectX + rectY;
      rectCoords[ 3 ] = lightPosition + rectX + rectY;
      vec3 luminance = packedColor.rgb * attenuation / max( 4.0 * length( rectX ) * length( rectY ), 1e-6 );
      vec2 ltcUv = LTC_Uv( geometryNormal, geometryViewDir, material.roughness );
      vec4 ltc1 = texture2D( lightFieldLtc1, ltcUv );
      vec4 ltc2 = texture2D( lightFieldLtc2, ltcUv );
      mat3 ltcInverse = mat3( vec3( ltc1.x, 0.0, ltc1.y ), vec3( 0.0, 1.0, 0.0 ), vec3( ltc1.z, 0.0, ltc1.w ) );
      vec3 fresnel = material.specularColor * ltc2.x + ( vec3( 1.0 ) - material.specularColor ) * ltc2.y;
      reflectedLight.directSpecular += luminance * fresnel
        * LTC_Evaluate( geometryNormal, geometryViewDir, geometryPosition, ltcInverse, rectCoords );
      reflectedLight.directDiffuse += luminance * material.diffuseColor
        * LTC_Evaluate( geometryNormal, geometryViewDir, geometryPosition, mat3( 1.0 ), rectCoords );
      continue;
    }
#endif
    fieldLight.color = mix( packedColor.rgb, farColor, farShare ) * attenuation;
    fieldLight.visible = true;
    RE_Direct( fieldLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
  }
}
#endif
`;

/** Declarations the chunk needs, added beside three's own light uniforms. */
const FIELD_PARS_CHUNK = /* glsl */`
uniform sampler2D lightField;
uniform int lightFieldCount;
uniform float lightFieldDecay;
uniform float lightFieldExtinction;
uniform sampler2D lightFieldDepth;
uniform float lightFieldDepthFar;
uniform float lightFieldDepthBias;
uniform float lightFieldDepthTile;
uniform float lightFieldSoftShadow;
uniform sampler2D lightFieldGobo;
uniform sampler2D lightFieldShapers;
uniform sampler2D lightFieldLtc1;
uniform sampler2D lightFieldLtc2;
${SHAPER_GLSL}

// Soft shadows. The lens is a disc, not a point: a surface point sees the part
// of it no blocker hides, and that share is the light it gets. Seen from the
// lens centre, a blocker at distance d hides the lens from a point at z across
// an angle of R (1/d - 1/z), so that is how wide the depth tile is read around
// the point. The search for blockers allows for one as near as SHADOW_NEAR;
// both reads are capped at SHADOW_MAX_TEXELS of the tile.
#define FIELD_SHADOW_SEARCH 8
#define FIELD_SHADOW_FILTER 16
#define FIELD_SHADOW_NEAR 0.5
#define FIELD_SHADOW_MAX_TEXELS 12.0

// The distance along the beam to the first thing the lens sees at ndc.
float fieldDepthAt( vec4 tile, vec2 ndc ) {
  vec2 inside = clamp( ndc, vec2( -1.0 + 1.0 / lightFieldDepthTile ), vec2( 1.0 - 1.0 / lightFieldDepthTile ) );
  vec2 uv = tile.xy + ( inside * 0.5 + 0.5 ) * tile.zw;
  return unpackRGBAToDepth( texture2D( lightFieldDepth, uv ) ) * lightFieldDepthFar;
}

// Sample i of n spread evenly over the unit disc, the pattern turned by a
// per-pixel angle so the few samples blur into grain rather than stripes.
vec2 fieldDisc( int i, int n, float turn ) {
  float r = sqrt( ( float( i ) + 0.5 ) / float( n ) );
  float a = float( i ) * 2.39996323 + turn;
  return r * vec2( cos( a ), sin( a ) );
}

// Whether the surface, extended as a plane, is behind the tile at ndc. The
// plane through the point, not the point's own distance, so a floor seen at a
// slant does not shadow itself across the width of the read.
bool fieldPlaneBlocked( vec4 tile, vec2 ndc, vec3 lifted, vec3 normal, vec3 ax, vec3 ay, vec3 az, float tanHalf, float allowance, inout float seen ) {
  seen = fieldDepthAt( tile, ndc );
  vec3 ray = az - ndc.x * tanHalf * ax + ndc.y * tanHalf * ay;
  float facing = dot( ray, normal );
  float plane = dot( lifted, normal );
  float along = dot( lifted, az );
  float receiver = abs( facing ) > 1e-4 ? plane / facing : along;
  if ( receiver <= 0.0 ) receiver = along;
  return receiver > seen + allowance;
}

// The share of the lens the point sees, 0 to 1. centreBlocker is the depth
// seen at the point itself when that blocks it, else negative.
float fieldSoftShadow( vec4 tile, vec2 ndc, float centreBlocker, vec3 lifted, vec3 normal, vec3 ax, vec3 ay, vec3 az, float tanHalf, float lensRadius, float texel ) {
  float z = dot( lifted, az );
  float lensNdc = lensRadius / tanHalf;
  float texelNdc = 2.0 / lightFieldDepthTile;
  float maxNdc = FIELD_SHADOW_MAX_TEXELS * texelNdc;
  float allowance = lightFieldDepthBias + texel * 1.5;

  float searchNdc = min( lensNdc * max( 1.0 / FIELD_SHADOW_NEAR - 1.0 / z, 0.0 ), maxNdc );
  float blockerSum = 0.0;
  float blockers = 0.0;
  if ( centreBlocker >= 0.0 ) { blockerSum += centreBlocker; blockers += 1.0; }
  float seen;
  // Interleaved gradient noise.
  float turn = 6.28318531 * fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
  for ( int i = 0; i < FIELD_SHADOW_SEARCH; i++ ) {
    if ( fieldPlaneBlocked( tile, ndc + fieldDisc( i, FIELD_SHADOW_SEARCH, turn ) * searchNdc, lifted, normal, ax, ay, az, tanHalf, allowance, seen ) ) {
      blockerSum += seen;
      blockers += 1.0;
    }
  }
  if ( blockers == 0.0 ) return 1.0;
  if ( blockers > float( FIELD_SHADOW_SEARCH ) ) return 0.0;

  float d = blockerSum / blockers;
  float radius = clamp( lensNdc * ( 1.0 / d - 1.0 / z ), 0.5 * texelNdc, maxNdc );
  float lit = 0.0;
  for ( int i = 0; i < FIELD_SHADOW_FILTER; i++ ) {
    if ( !fieldPlaneBlocked( tile, ndc + fieldDisc( i, FIELD_SHADOW_FILTER, turn ) * radius, lifted, normal, ax, ay, az, tanHalf, allowance, seen ) ) lit += 1.0;
  }
  return lit / float( FIELD_SHADOW_FILTER );
}

// How much of the light a prism lets through, as in the beam shader.
#define FIELD_PRISM_TRANSMISSION 0.88

// Where a prism puts its k-th copy: round a circle of the spread's radius,
// or for a linear prism in a row along its angle, the outermost at the spread.
vec2 fieldPrismOffset( int k, int facets, bool linear, float angle, float spread ) {
  if ( linear ) {
    float t = float( k ) / float( facets - 1 ) * 2.0 - 1.0;
    return spread * t * vec2( cos( angle ), sin( angle ) );
  }
  float a = angle + 6.2831853 * float( k ) / float( facets );
  return spread * vec2( cos( a ), sin( a ) );
}

// The most facets a prism is drawn with.
#define FIELD_PRISM_FACETS 8
// The gobo atlas is a grid of this many patterns across, as gobo_library.js.
#define FIELD_GOBO_GRID 16.0

// A gobo's stencil at a point of the aperture, (0,0) the axis and 1 the
// field's radius; 1 where light passes. Pattern 0 is open and skips the
// read. The pattern is rotated about the axis by the gobo's angle and spans
// the field; its cell in the atlas is by index, row-major. One read returns
// the three baked blur levels, sharp in red, soft in blue, and the focus
// blur, 0 to 2, blends between them. An explicit level, never an implicit
// one: this runs inside a loop over lights with early exits, and
// derivatives in divergent control flow are undefined.
float fieldGobo( vec2 p, vec2 patternAngle, float defocus ) {
  if ( patternAngle.x < 0.5 ) return 1.0;
  float c = cos( -patternAngle.y );
  float s = sin( -patternAngle.y );
  vec2 q = clamp( vec2( c * p.x - s * p.y, s * p.x + c * p.y ) * 0.5 + 0.5, 0.002, 0.998 );
  float index = floor( patternAngle.x + 0.5 );
  vec2 cell = vec2( mod( index, FIELD_GOBO_GRID ), floor( index / FIELD_GOBO_GRID ) );
  vec3 levels = textureLod( lightFieldGobo, ( cell + q ) / FIELD_GOBO_GRID, 0.0 ).rgb;
  float v = mix( mix( levels.r, levels.g, clamp( defocus, 0.0, 1.0 ) ), levels.b,
    clamp( defocus - 1.0, 0.0, 1.0 ) );
  // Past the softest level, frost: on to the pattern's mean inside the hole,
  // from the mip at one texel per cell, over the share of the cell the round
  // aperture covers.
  float wash = clamp( defocus - 2.0, 0.0, 1.0 );
  if ( wash > 0.0 ) {
    float lod = log2( float( textureSize( lightFieldGobo, 0 ).x ) / FIELD_GOBO_GRID );
    float mean = textureLod( lightFieldGobo, ( cell + 0.5 ) / FIELD_GOBO_GRID, lod ).r / 0.7238;
    v = mix( v, min( mean, 1.0 ), wash );
  }
  return v;
}

// The pool's shape at a point of the aperture: the falloff from the inner
// cone to the field, through every gobo in the beam. With a prism, the mean
// of that over the prism's displaced copies.
// How much of a point of the aperture lies past a colour wheel split, 0 the
// near colour and 1 the far: a straight boundary entering from one side,
// through the middle at a half slot, as soft as the focus makes the gobo.
float fieldSplit( vec2 p, float split, float defocus ) {
  if ( split <= 0.0 ) return 0.0;
  float line = 1.0 - 2.0 * split;
  float soft = 0.02 + 0.12 * defocus;
  return smoothstep( line - soft, line + soft, p.x );
}

// The pool's shape at a point of the aperture, per colour: light on the near
// side of any colour split, and past it. The falloff from the inner cone to
// the field, through every gobo in the beam; with a prism, the mean over the
// prism's displaced copies, split included.
// A gobo wheel turns on its own centre, as in the beam shader: every wheel is
// taken as 100 mm across, slots 38 mm out, gobos 25 mm across, so the slot
// circle is 3.04 field radii from the centre and one slot is a turn of
// 0.7759 rad, holes 2.3 field radii apart.
#define FIELD_GOBO_WHEEL_RADIUS 3.04
#define FIELD_GOBO_STEP 0.7759

// Where a point of the gate falls in a gobo the wheel has turned by turn
// radians away from the gate: carried round the wheel's centre, so shifted
// along an arc and turned by the same angle. The shaft is at +y in the gate,
// below the optical axis in the projected image, as in the beam shader.
vec2 fieldGoboOnWheel( vec2 p, float turn ) {
  vec2 centre = vec2( 0.0, FIELD_GOBO_WHEEL_RADIUS );
  vec2 d = p - centre;
  float c = cos( turn );
  float s = sin( turn );
  return vec2( c * d.x + s * d.y, -s * d.x + c * d.y ) + centre;
}

// Every gobo in the beam at a point of the aperture. A wheel between two
// slots carries the fraction of the way it has gone in the first pattern
// number: the old gobo turns out of the gate on the wheel and the next turns
// in, each through its own round hole.
float fieldGobos( vec2 p, vec4 gobo, float defocus ) {
  float frac = fract( gobo.x );
  if ( frac <= 0.0 ) {
    return fieldGobo( p, gobo.xy, defocus ) * fieldGobo( p, gobo.zw, defocus );
  }
  float soft = 0.02 + 0.08 * defocus;
  vec2 pa = fieldGoboOnWheel( p, frac * FIELD_GOBO_STEP );
  vec2 pb = fieldGoboOnWheel( p, -( 1.0 - frac ) * FIELD_GOBO_STEP );
  float holeA = 1.0 - smoothstep( 1.0 - soft, 1.0, length( pa ) );
  float holeB = 1.0 - smoothstep( 1.0 - soft, 1.0, length( pb ) );
  return holeA * fieldGobo( pa, vec2( floor( gobo.x ), gobo.y ), defocus )
    + holeB * fieldGobo( pb, gobo.zw, defocus );
}

// How much of a point of the aperture the iris lets through: a circle of
// its radius, cropping without shrinking the gobo, edge softened by focus.
float fieldIris( vec2 p, float iris, float defocus ) {
  if ( iris >= 0.999 ) return 1.0;
  float soft = 0.01 + 0.06 * defocus;
  return 1.0 - smoothstep( iris - soft, iris + 0.001, length( p ) );
}

// The field's edge through the lens's blur, at a distance r from the axis
// in field radii. The image of the gate is a disc of radius 1, and the blur
// spreads each point of it over a disc of radius blur: light is full out to
// |1 - blur|, gone at 1 + blur, and where the blur is wider than the image,
// near the lens, spread that much thinner, so the light through every slice
// of the beam is the same. The inner cone softens the image's own edge.
float fieldEdge( float r, float inner, float blur ) {
  float height = blur > 1.0 ? 1.0 / ( blur * blur ) : 1.0;
  float lo = abs( 1.0 - blur ) - ( 1.0 - inner );
  return height * ( 1.0 - smoothstep( lo, 1.0 + blur, r ) );
}

// The lens's blur as gobo blur levels. The atlas bakes a cell of 128 px,
// two field radii across, at Gaussian sigmas of 0, 2.5 and 7 px, as
// gobo_library.js; a blur disc of radius b field radii is a sigma of about
// half its 64 b px.
float fieldBlurLevels( float blur ) {
  float sigma = 32.0 * blur;
  return sigma < 2.5 ? sigma / 2.5 : 1.0 + min( ( sigma - 2.5 ) / 4.5, 1.0 );
}

vec2 fieldStencil( vec2 p, float inner, vec4 gobo, vec4 prism, float split, float iris, float blur, float shaperRow ) {
  int facets = int( abs( prism.x ) );
  bool linear = prism.x < 0.0;
  // The gobo is as soft as the frost or the lens makes it, whichever is more.
  float defocus = max( prism.w, fieldBlurLevels( blur ) );
  // Framing blades sit in the gate with the gobos.
  float bladeSoft = 0.01 + 0.06 * defocus;
  if ( facets < 2 ) {
    float v = fieldEdge( length( p ), inner, blur )
      * fieldGobos( p, gobo, defocus )
      * fieldIris( p, iris, defocus )
      * shaperMask( lightFieldShapers, shaperRow, p, bladeSoft );
    float far = fieldSplit( p, split, defocus );
    return vec2( v * ( 1.0 - far ), v * far );
  }
  vec2 sum = vec2( 0.0 );
  for ( int k = 0; k < FIELD_PRISM_FACETS; k ++ ) {
    if ( k >= facets ) break;
    vec2 q = p - fieldPrismOffset( k, facets, linear, prism.y, prism.z );
    float v = fieldEdge( length( q ), inner, blur )
      * fieldGobos( q, gobo, defocus )
      * fieldIris( q, iris, defocus )
      * shaperMask( lightFieldShapers, shaperRow, q, bladeSoft );
    float far = fieldSplit( q, split, defocus );
    sum += vec2( v * ( 1.0 - far ), v * far );
  }
  return sum * ( FIELD_PRISM_TRANSMISSION / float( facets ) );
}
`;

const LightField = {
  /** @type {Object} the uniforms every receiving material shares */
  uniforms,

  /**
   * Adds a source of light.
   *
   * A source implements `readLight(record)`, filling the record and answering
   * whether it is contributing anything at all this frame -- a head with its
   * shutter shut or its intensity at zero says no and costs nothing further.
   *
   * @public
   * @param {Object} source
   */
  register(source) {
    if (source && !sources.includes(source)) sources.push(source);
  },

  /**
   * @public
   * @param {Object} source
   */
  unregister(source) {
    const at = sources.indexOf(source);
    if (at > -1) sources.splice(at, 1);
  },

  /**
   * Makes room for `needed` lights, growing the store if it must.
   *
   * @public
   * @param {Number} needed
   * @returns {Boolean} whether there is room
   */
  ensureCapacity(needed) {
    if (needed <= capacity) return true;
    if (needed > MAX_LIGHTS) return false;
    while (capacity < needed) capacity *= 2;
    const grown = new Float32Array(capacity * TEXELS_PER_LIGHT * 4);
    grown.set(data);
    data = grown;
    rebuildTexture();
    return true;
  },

  /**
   * Packs every contributing light into the texture. Called once per frame.
   *
   * @public
   * @returns {Number} how many lights are live
   */
  update() {
    let count = 0;
    for (let i = 0; i < sources.length; i += 1) {
      if (count >= MAX_LIGHTS) break;
      // A source without a tile need not know the field exists, and one
      // without optics leaves the beam open.
      record.hasTile = false;
      record.gobo.set(0, 0, 0, 0);
      record.prism.set(0, 0, 0, 0);
      record.split = 0;
      record.iris = 1;
      record.lensRadius = 0;
      record.invFocus = 0;
      record.cosReach = null;
      record.shaperRow = -1;
      if (sources[i].readLight(record)) {
        LightField.ensureCapacity(count + 1);
        const at = count * TEXELS_PER_LIGHT * 4;
        data[at] = record.position.x;
        data[at + 1] = record.position.y;
        data[at + 2] = record.position.z;
        data[at + 3] = record.range;

        data[at + 4] = record.direction.x;
        data[at + 5] = record.direction.y;
        data[at + 6] = record.direction.z;
        data[at + 7] = record.cosReach !== null ? record.cosReach : record.cosOuter;

        data[at + 8] = record.color.r * record.intensity;
        data[at + 9] = record.color.g * record.intensity;
        data[at + 10] = record.color.b * record.intensity;
        data[at + 11] = record.cosInner;

        data[at + 12] = record.tile.x;
        data[at + 13] = record.tile.y;
        data[at + 14] = record.tile.z;
        data[at + 15] = record.tile.w;

        data[at + 16] = record.axisX.x;
        data[at + 17] = record.axisX.y;
        data[at + 18] = record.axisX.z;
        data[at + 19] = record.tanHalf;

        data[at + 20] = record.axisY.x;
        data[at + 21] = record.axisY.y;
        data[at + 22] = record.axisY.z;
        data[at + 23] = record.hasTile ? 1 : 0;

        data[at + 24] = record.tileOrigin.x;
        data[at + 25] = record.tileOrigin.y;
        data[at + 26] = record.tileOrigin.z;
        data[at + 27] = record.inner;

        const area = record.iris < 0;
        data[at + 28] = area ? record.rectX.x : record.gobo.x;
        data[at + 29] = area ? record.rectX.y : record.gobo.y;
        data[at + 30] = area ? record.rectX.z : record.gobo.z;
        data[at + 31] = area ? 0 : record.gobo.w;

        data[at + 32] = area ? record.rectY.x : record.prism.x;
        data[at + 33] = area ? record.rectY.y : record.prism.y;
        data[at + 34] = area ? record.rectY.z : record.prism.z;
        data[at + 35] = area ? 0 : record.prism.w;

        const far = record.split > 0 ? record.colorB : record.color;
        data[at + 36] = far.r * record.intensity;
        data[at + 37] = far.g * record.intensity;
        data[at + 38] = far.b * record.intensity;
        data[at + 39] = record.split;

        data[at + 40] = record.iris;
        data[at + 41] = record.lensRadius;
        data[at + 42] = record.invFocus;
        data[at + 43] = record.cosOuter;

        data[at + 44] = record.shaperRow;
        data[at + 45] = 0;
        data[at + 46] = 0;
        data[at + 47] = 0;
        count += 1;
      }
    }
    uniforms.lightFieldCount.value = count;
    // Uploaded whole. Rows past `count` are left stale rather than cleared,
    // which costs nothing: the shader never reads past the count.
    texture.needsUpdate = true;
    return count;
  },

  /**
   * Teaches one material to read the field.
   *
   * Idempotent, and safe on a material that already has an `onBeforeCompile`
   * of its own -- the existing one is kept and run first.
   *
   * @public
   * @param {THREE.Material} material
   * @returns {THREE.Material} the same material
   */
  receive(material) {
    if (!material || material.userData.readsLightField) return material;
    material.userData.readsLightField = true;
    const existing = material.onBeforeCompile;

    material.onBeforeCompile = (shader, renderer) => {
      if (existing) existing(shader, renderer);
      Object.assign(shader.uniforms, uniforms);
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <lights_pars_begin>',
        `#include <lights_pars_begin>\n${FIELD_PARS_CHUNK}`,
      );
      // Appended where three has finished its own direct lights and before it
      // adds the indirect ones, which is the one place `directLight`,
      // `material` and `reflectedLight` are all in scope.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <lights_fragment_end>',
        `${FIELD_LIGHT_CHUNK}\n#include <lights_fragment_end>`,
      );
    };

    // Materials compiled differently must not share a program. Everything
    // patched here is patched the same way, so one extra key covers them all.
    const previousKey = material.customProgramCacheKey;
    material.customProgramCacheKey = () => `lightfield:${previousKey ? previousKey.call(material) : ''}`;
    material.needsUpdate = true;
    return material;
  },
};

export default LightField;
export {
  REFERENCE_LUMENS,
  CANDELA_PER_UNIT,
  REFERENCE_INTENSITY,
  LUX_SCALE,
  SCENE_PER_NIT,
  SCENE_INTENSITY_PER_UNIT,
};
