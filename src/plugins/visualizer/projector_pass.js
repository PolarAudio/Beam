import * as THREE from 'three';
import { Effect, EffectAttribute, BlendFunction } from 'postprocessing';
import ProjectorDepth, {
  MAX_PROJECTIONS, PROJECTOR_NEAR, PROJECTOR_FAR,
} from './projector_depth';
import { hazeShaderPrelude, hazeUniforms } from './haze_noise';
import SceneEnv from './scene_env';
import { LUX_SCALE } from './light_field';

/**
 * @file Puts every projector's picture onto whatever the camera can see.
 *
 * A full-screen pass rather than a light, and rather than anything the scene's
 * materials know about. Three reasons, in the order they mattered:
 *
 *  - **It scales with projectors, not with materials.** Six machines on a
 *    facade cost one pass over the frame, whatever the building is made of.
 *    Patching materials would mean every mesh in the show carrying projector
 *    code it almost never uses.
 *  - **Overlap stays visible.** Two projectors covering the same stone add up
 *    and read as a hotspot, which is exactly the thing a coverage preview is
 *    for -- it is where you would blend. Anything that averaged or clamped
 *    would hide the problem being looked for.
 *  - **The frustum is ours.** Lens shift is an asymmetric frustum, and nothing
 *    in the renderer's light path can express one.
 *
 * The picture is sampled from the *same* decoded video texture every other
 * consumer reads, with the connector's rectangle as a uniform. There is no
 * render target per projector, because there is nothing to pre-render: a slice
 * of a frame is a coordinate transform, not a copy.
 *
 * **The shaft.** The same maths, walked along the view ray instead of stopping
 * at the surface: at each step, is this piece of air inside a projector's
 * frustum, and can the lens see it. So the beam in the air and the picture on
 * the wall cannot disagree -- an occluder that shadows the facade cuts the
 * shaft above it too. It reads `hazeAmount` rather than `roomHaze`, because a
 * projector lighting its own cone is a fixture, and a fixture's beam survives
 * the house coming up.
 */

/**
 * How far a surface may sit behind what the projector saw and still count.
 *
 * **In metres**, and that is the whole point. The projector's own window depth
 * is not a distance: it runs as `1 - near/d`, so a fixed slice of it is worth
 * centimetres up close and tens of metres far away -- 0.0015 with a 0.1 near
 * plane is about sixteen metres of slack at thirty, enough to light the far
 * side of a building through the one in front.
 *
 * Compared in metres, against the linearised atlas, this means what it says at
 * any distance. Ten centimetres covers the atlas's own grain on a
 * slanted facade without letting anything real through.
 *
 * @constant {Number}
 */
const DEPTH_BIAS = 0.1;

/**
 * Samples along each projector's lit stretch of a view ray, for the shaft.
 *
 * The mover beam's method: the stretch is found exactly (see frustumSpan),
 * and the samples sit at the middles of equal steps along it, the same
 * places for every pixel, so there is no dither and no grain. Each sample
 * reads the picture blurred by how much of it the step crosses, so eight
 * cover the stretch without leaving gaps between them. More than the
 * mover's four because a picture has more in it than a gobo's falloff.
 *
 * @constant {Number}
 */
const SHAFT_SAMPLES = 8;

/**
 * How far down the ray to bother marching, metres.
 *
 * Measured from the **camera**, not from the lens: it bounds the ray being
 * walked, so on a wide shot it is the eye's distance that runs out first.
 *
 * `frustumSpan` confines the march to the lit stretch whatever the reach, so
 * distance is nearly free and the cap only exists to bound the loop. Three
 * hundred metres is past any room, stage or facade, and the extinction term has
 * long since eaten the beam by then anyway.
 *
 * @constant {Number}
 */
const SHAFT_MAX = 300;

/**
 * The least blur the picture is read with in the air, as a share of the
 * slice's width.
 *
 * Light scattered off haze has bounced before it reaches the eye, so the air
 * never shows the picture as sharply as the wall does. The mover reads its
 * gobo with at least 1.5 mip levels on a 128 texel pattern, about a fiftieth
 * of the pattern's width; this is the same share of the picture, whatever
 * its resolution. What the air shows of the picture past that is set by how
 * much of it each sample's step crosses.
 *
 * @constant {Number}
 */
const SHAFT_BLUR_SHARE = 0.02;

/**
 * Nearest the lens the shaft's falloff is allowed to go, metres.
 *
 * Inverse square off a *point* is unbounded: clamped at 5 cm, a sample near
 * the lens is four hundred times one a metre away, and the few samples that
 * land close would carry a pixel's whole sum. The mover beam's BEAM_KNEE is
 * the same number for the same reason.
 *
 * Three metres, which is further out than the physics alone would justify and
 * deliberately so. A lens has area rather than being a point, so the falloff
 * has to stop somewhere; putting it here also flattens the white core that
 * otherwise sits on the first few metres of the beam, where a ray passing close
 * to the lens picks up a couple of hundred times the light of one out at the
 * building. That core reads as a blown highlight and hides the colour, which is
 * the one thing a shaft is there to show.
 *
 * @constant {Number}
 */
const SHAFT_NEAR = 3.0;

/**
 * How much coarser the shaft reads the haze field than the room air does.
 * 1 is the room's own scale, as the mover beam reads it: with the samples at
 * fixed places along the stretch, the field's features pass through the
 * shaft instead of turning into grain.
 */
const SHAFT_FIELD_SCALE = 1.0;

/**
 * How much of the frame is edge rather than picture, in the air.
 *
 * A projector's frame is fairly hard, and on a wall it should be. In haze
 * scattering carries light a little sideways out of the frustum, so the
 * boundary is a short gradient, a twelfth of the frame's half-width from each
 * side. The picture read blurred by the step does the rest where a ray
 * crosses the edge at a slant.
 *
 * Applied to the shaft only. The blend ramps are the user's business and this
 * multiplies alongside them rather than replacing them.
 *
 * @constant {Number}
 */
const SHAFT_EDGE = 0.08;

/**
 * Extra mip levels per metre travelled from the lens.
 *
 * Scattering is cumulative: every metre of haze mixes a little more of each
 * direction into its neighbours, so a beam carries its picture recognisably for
 * the first few metres and is a soft coloured glow by the far end. A fixed blur
 * cannot say that -- it makes the whole shaft equally vague, including the part
 * nearest the lens where the structure really is still there.
 *
 * At roughly a tenth of a level per metre, thirty metres adds three levels on
 * top of the base, which on a 4K frame is the difference between reading the
 * picture and reading its average.
 *
 * @constant {Number}
 */
const SHAFT_BLUR_PER_METRE = 0.1;

/**
 * How fast the beam is eaten by the air it is lighting, per metre per unit haze.
 *
 * Beer-Lambert: the shaft pays extinction as well as gaining in-scatter, or it
 * keeps its strength far past where a real beam has been absorbed into the
 * room. Tied to haze density because it
 * is the same air doing both -- thicker haze scatters more light towards the
 * eye *and* swallows the beam sooner, which is why a heavily hazed room has
 * short fat beams rather than long ones.
 *
 * Note this is on top of the inverse square, not instead of it.
 *
 * @constant {Number}
 */
const SHAFT_FADE_PER_METRE = 0.06;

/**
 * Scattering, from lux in the air to something the tone curve can use.
 *
 * Lower than the physics alone would suggest -- deliberately. A shaft is what
 * the haze happens to pick up, not the subject: the picture on the building is
 * what a coverage preview is for, and a beam bright enough to compete with it
 * is in the way. At 0.5 the cone's 99th percentile sits at 245 out of 255 -- a
 * white core with the colour boiled out of it.
 *
 * There is no separate control for this and there should not be: the haze
 * density scales it and the projector's own dimmer scales it, which is the
 * same pair of things that would move a real beam.
 *
 * @constant {Number}
 */
const SHAFT_GAIN = 0.02;

/**
 * How much of the haze's forward scattering the shaft shows, 0..1: 0 the
 * same from every angle, 1 the phase function's full ceiling. Set by eye.
 *
 * @constant {Number}
 */
const SHAFT_SCATTER_AMOUNT = 0.37;

/**
 * One sampler per projection, and the reads that pick one by index.
 *
 * Each projector shows its own input, so the pass takes a picture per slot.
 * The shading language cannot index an array of samplers with a loop
 * variable, so the samplers are named and chosen by a chain of comparisons.
 * The index is the same for every fragment of a projection, so the branch is
 * uniform and a mipmapped read inside it keeps its derivatives.
 *
 * @constant {String}
 */
const PICTURE_SLOTS = (() => {
  const slots = Array.from({ length: MAX_PROJECTIONS }, (_, k) => k);
  const declare = slots.map((k) => `uniform sampler2D picture${k};`).join('\n  ');
  const lod = slots.map((k) => `if (i == ${k}) return textureLod(picture${k}, uv, lod);`).join('\n    ');
  const grad = slots.map((k) => `if (i == ${k}) return textureGrad(picture${k}, uv, dx, dy);`).join('\n    ');
  return `
  ${declare}
  uniform float hasPicture[SLOTS];
  uniform vec2 pictureSize[SLOTS];

  /** Where a point of projection i's frame reads its input's texture. */
  vec2 pictureUv(int i, vec2 frame) {
    vec3 f = vec3(frame, 1.0);
    return vec2(dot(pictureRowX[i], f), dot(pictureRowY[i], f));
  }

  /** 1 where projection i's input holds picture, 0 in a fitted picture's bars. */
  float pictureInside(int i, vec2 uv) {
    vec4 b = pictureBounds[i];
    return step(b.x, uv.x) * step(uv.x, b.z) * step(b.y, uv.y) * step(uv.y, b.w);
  }

  /** Projection i's picture at an explicit level of detail. */
  vec4 pictureLod(int i, vec2 uv, float lod) {
    ${lod}
    return vec4(1.0);
  }

  /**
   * Projection i's picture with its gradients given. Inside the loop over
   * projections a read that takes its own derivatives is one the compiler
   * cannot vouch for, so they are worked out from the surface instead.
   */
  vec4 pictureGrad(int i, vec2 uv, vec2 dx, vec2 dy) {
    ${grad}
    return vec4(1.0);
  }
`;
})();

const FRAGMENT = /* glsl */`
  uniform mat4 projInverse;
  uniform mat4 camWorld;
  uniform sampler2D depthAtlas;
  uniform sampler2D surfaceAlbedo;

  /** Lux on a matte surface to its luminance: rho E / pi. */
  const float INV_PI = 0.3183098862;
  uniform vec4 litRect[SLOTS];
  uniform bool hasAlbedo;
  uniform mat4 lensMatrix[SLOTS];
  uniform vec3 pictureRowX[SLOTS];
  uniform vec3 pictureRowY[SLOTS];
  uniform vec4 pictureBounds[SLOTS];
  uniform vec4 atlasTile[SLOTS];
  uniform vec3 emission[SLOTS];
  uniform vec3 lensPos[SLOTS];
  uniform vec4 blendEdges[SLOTS];
  uniform vec3 camPos;
  uniform bool camOrtho;
  uniform float hazeMetres;
  uniform float drift;
  uniform float hazeDensity;
  uniform int liveCount;
  uniform float scatterAmount;
${PICTURE_SLOTS}

  /**
   * How much of the picture survives this far in from an edge.
   *
   * Linear, and that is not a simplification: two machines ramping across the
   * same overlap carry t and 1-t, and this pass adds light the way projectors
   * do, so a linear pair sums to exactly one everywhere in the seam. A curve
   * would be the right answer for a real projector's gamma and black level;
   * here it would only make the join wrong.
   */
  float blendRamp(float inset, float width) {
    return width <= 0.0 ? 1.0 : clamp(inset / width, 0.0, 1.0);
  }

  /**
   * The air's density at a point, on the field every other renderer uses.
   *
   * One octave, not the two the ambient pass runs: this is called for every
   * sample of every projector's stretch, and the second octave's job is to make
   * still room air churn -- a shaft is already moving because the picture in
   * it is.
   */
  float shaftField(vec3 world) {
    // Read coarser than the room air is. A step down a long shaft is over a
    // metre, and the field's features are a couple of metres, so sampling it at
    // its own scale draws a fresh uncorrelated value every step -- twenty-four
    // independent draws per pixel, each pixel offset differently by the dither,
    // which is grain by construction and no amount of steps fixes it cheaply.
    // Integrating a long path physically averages the fine structure away, so
    // reading the low-frequency shape is both quieter and truer.
    vec3 coord = world / max(hazeMetres * SHAFT_FIELD_SCALE, 0.01);
    float field = abs(noiseAt(coord + vec3(drift, 0.0, 0.0))) * HAZE_FIELD_GAIN;
    return mix(1.0, field, 0.3);
  }

  /**
   * Window depth from the atlas, back to metres along the projector's axis.
   *
   * The inverse of the perspective divide the tile was drawn through. Without
   * it every comparison happens in a space where distance is not linear and no
   * single tolerance can be right at both ends of the room.
   */
  float linearDepth(float window) {
    float ndc = window * 2.0 - 1.0;
    return (2.0 * PROJ_NEAR * PROJ_FAR)
      / (PROJ_FAR + PROJ_NEAR - ndc * (PROJ_FAR - PROJ_NEAR));
  }

  /**
   * What one projector puts into the air at a point of its lit stretch.
   *
   * The mover beam's sample: inside the frustum and seen by the lens, through
   * the blend, the picture read at this point of the frame, the light falling
   * off from the lens and eaten by the haze on the way. next is where the next
   * sample sits; the picture is read blurred by how much of the frame the step
   * between them crosses, so a ray running along the throw keeps the picture's
   * structure and one cutting across it reads its average.
   */
  vec3 shaftSample(int i, vec3 world, vec3 next) {
    vec4 lens = lensMatrix[i] * vec4(world, 1.0);
    if (lens.w <= 0.0001) return vec3(0.0);

    // The sides of the frustum only, not its near plane: that sits half a
    // metre out for the depth map's precision, and the light leaves the glass.
    // Nothing nearer than it is in the depth map, so air there counts as seen.
    vec3 ndc = lens.xyz / lens.w;
    if (any(greaterThan(abs(ndc.xy), vec2(1.0))) || ndc.z > 1.0) return vec3(0.0);

    vec2 frame = ndc.xy * 0.5 + 0.5;
    vec4 tile = atlasTile[i];
    float seen = unpackRGBAToDepth(texture2D(depthAtlas, tile.xy + frame * tile.zw));
    // Both sides in metres. lens.w already is one; the atlas holds window
    // depth, so it gets undone with the same near and far the tile was drawn
    // with -- see PROJECTOR_NEAR.
    if (lens.w > linearDepth(seen) + DEPTH_BIAS) return vec3(0.0);

    vec4 edges = blendEdges[i];
    float blend = blendRamp(frame.x, edges.x)
      * blendRamp(1.0 - frame.x, edges.y)
      * blendRamp(frame.y, edges.z)
      * blendRamp(1.0 - frame.y, edges.w);

    // How far this piece of air is from the lens, along the throw.
    float travelled = lens.w;

    // How much of the picture the step to the next sample crosses, in the
    // slice's texels. An explicit level, because this runs inside a loop with
    // early exits, where derivatives are undefined.
    vec4 lensNext = lensMatrix[i] * vec4(next, 1.0);
    vec2 frameNext = lensNext.xy / max(lensNext.w, 0.0001) * 0.5 + 0.5;
    vec2 at = pictureUv(i, frame);
    float span = length((pictureUv(i, frameNext) - at) * pictureSize[i]);
    // Texels across the frame's width, after the crop, scale and turn.
    float across = pictureSize[i].x * length(vec2(pictureRowX[i].x, pictureRowY[i].x));
    float floorLod = log2(max(across * SHAFT_BLUR_SHARE, 1.0)) + travelled * SHAFT_BLUR_PER_METRE;
    float lod = max(floorLod, log2(max(span, 1.0)));
    vec3 colour = mix(vec3(1.0), pictureLod(i, at, lod).rgb * pictureInside(i, at), hasPicture[i]);
    // Black is white over the contrast, over the whole frame; the soft edge
    // dims only the picture above it.
    float black = emission[i].z;
    colour = black + (1.0 - black) * colour * blend;

    // The frame's own edge, a short gradient: scattering carries a little
    // light sideways out of the frustum.
    vec2 toEdge = min(frame, 1.0 - frame);
    float soft = smoothstep(0.0, SHAFT_EDGE, toEdge.x) * smoothstep(0.0, SHAFT_EDGE, toEdge.y);

    // Inverse square from the lens, flat within the knee, as the mover beam's.
    float lux = emission[i].x / max(travelled * travelled, SHAFT_NEAR * SHAFT_NEAR);
    // Absorbed by the room on the way out. Thicker haze eats it sooner.
    float survives = exp(-travelled * SHAFT_FADE_PER_METRE * hazeDensity);
    return colour * lux * emission[i].y * soft * survives;
  }

  /**
   * Where along the view ray a projector's frustum begins and ends.
   *
   * Clipped in homogeneous clip space against the six planes of the unit cube,
   * which is exact for an asymmetric frustum and costs six dot products -- far
   * cheaper than the samples it saves. The near plane is swapped for one a
   * centimetre in front of the lens, so the stretch begins at the glass.
   *
   * This is what makes the march worth anything. Spreading the steps over the
   * whole ray spends nearly all of them on empty air: a pixel with no geometry
   * behind it marched seventy metres to catch a cone perhaps ten across, so two
   * or three samples carried the whole answer and neighbouring pixels disagreed.
   * Confining them to the lit span puts every sample where the light is.
   */
  bool frustumSpan(int i, vec3 origin, vec3 dir, float maxT, out float near, out float far) {
    vec4 a = lensMatrix[i] * vec4(origin, 1.0);
    vec4 b = lensMatrix[i] * vec4(origin + dir * maxT, 1.0);

    // The sides are those of the part of the frame that holds picture, so a
    // cropped or fitted picture gets every sample, not a share of them.
    vec4 lit = litRect[i] * 2.0 - 1.0;
    vec4 planes[6];
    planes[0] = vec4(1.0, 0.0, 0.0, -lit.x);
    planes[1] = vec4(-1.0, 0.0, 0.0, lit.z);
    planes[2] = vec4(0.0, 1.0, 0.0, -lit.y);
    planes[3] = vec4(0.0, -1.0, 0.0, lit.w);
    planes[4] = vec4(0.0, 0.0, 1.0, 1.0);
    planes[5] = vec4(0.0, 0.0, -1.0, 1.0);

    float lo = 0.0;
    float hi = 1.0;
    for (int p = 0; p < 6; p++) {
      float da = dot(planes[p], a);
      float db = dot(planes[p], b);
      // In place of the near plane, the lens itself: a centimetre in front of
      // the glass, so the shaft starts where the light does.
      if (p == 4) {
        da = a.w - 0.01;
        db = b.w - 0.01;
      }
      if (da < 0.0 && db < 0.0) return false;
      if (da < 0.0) lo = max(lo, da / (da - db));
      else if (db < 0.0) hi = min(hi, da / (da - db));
    }
    if (hi <= lo) return false;
    near = lo * maxT;
    far = hi * maxT;
    return true;
  }

  void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {

    if (liveCount == 0) {
      outputColor = vec4(0.0, 0.0, 0.0, inputColor.a);
      return;
    }

    // The world point this pixel is looking at, rebuilt from the depth buffer --
    // the same reconstruction the ambient haze does.
    //
    // **Not skipped when nothing was drawn.** An empty pixel has no surface to
    // light, but it has air in it, and a beam crossing open sky is the normal
    // case for a projector on a building. Returning early here would glue the
    // shaft to the floor: it would only survive where some surface happened to
    // lie behind it. With depth at 1.0 this lands on the far plane, which is
    // exactly the ray the march wants.
    bool hasSurface = depth < 1.0;
    vec4 clip = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    vec4 viewPos = projInverse * clip;
    viewPos /= viewPos.w;
    vec3 world = (camWorld * viewPos).xyz;
    // The eye this pixel's ray starts from. In orthographic every ray runs
    // along the view from its own point on the camera's plane.
    vec3 camForward = -normalize(camWorld[2].xyz);
    vec3 eye = camOrtho ? world - camForward * dot(world - camPos, camForward) : camPos;

    // The surface's facing, from how the reconstructed position moves across
    // the screen. A projector's picture falls off with the angle it strikes at,
    // and on a building that is most of what tells one wall from the next.
    vec3 worldDx = dFdx(world);
    vec3 worldDy = dFdy(world);
    vec3 surfaceNormal = normalize(cross(worldDx, worldDy));
    // Turned to face the eye. The cross product's sign follows the triangle's
    // winding on screen, not the surface's outside, and every surface we can
    // see faces us -- so this makes the sign mean something.
    if (dot(surfaceNormal, eye - world) < 0.0) surfaceNormal = -surfaceNormal;

    vec3 total = vec3(0.0);
    if (hasSurface) {

    for (int i = 0; i < SLOTS; i++) {
      if (i >= liveCount) break;

      // Masked rather than branched. A texture read inside per-pixel control
      // flow has undefined derivatives -- the compiler says so -- and the
      // picture needs its mip chain, so every fragment takes the same path and
      // the rejections become multipliers.
      vec4 lens = lensMatrix[i] * vec4(world, 1.0);
      // A projector throws forwards only.
      float inFront = step(0.0001, lens.w);
      vec3 ndc = lens.xyz / max(lens.w, 0.0001);
      float widest = max(max(abs(ndc.x), abs(ndc.y)), abs(ndc.z));
      float inside = inFront * step(widest, 1.0);

      vec2 frame = clamp(ndc.xy * 0.5 + 0.5, 0.0, 1.0);

      // Does the projector actually see this point, or is something in the way?
      vec4 tile = atlasTile[i];
      float seen = unpackRGBAToDepth(texture2D(depthAtlas, tile.xy + frame * tile.zw));
      float visible = step(lens.w, linearDepth(seen) + DEPTH_BIAS);

      // Where the neighbouring pixels land in this projector's frame, for the
      // picture's gradients: the level a hardware read would pick.
      vec4 lensDx = lensMatrix[i] * vec4(world + worldDx, 1.0);
      vec4 lensDy = lensMatrix[i] * vec4(world + worldDy, 1.0);
      vec2 frameDx = clamp(lensDx.xy / max(lensDx.w, 0.0001) * 0.5 + 0.5, 0.0, 1.0) - frame;
      vec2 frameDy = clamp(lensDy.xy / max(lensDy.w, 0.0001) * 0.5 + 0.5, 0.0, 1.0) - frame;
      // The picture after the projector's own crop, scale and turn; the
      // gradients go through the same map's linear part.
      vec2 at = pictureUv(i, frame);
      mat2 turn = mat2(pictureRowX[i].x, pictureRowY[i].x, pictureRowX[i].y, pictureRowY[i].y);
      vec3 colour = mix(vec3(1.0), pictureGrad(i, at, turn * frameDx, turn * frameDy).rgb
        * pictureInside(i, at), hasPicture[i]);

      // Illuminance falls with the square of the distance because the same
      // lumens are spread over a bigger picture -- that is the projector's own
      // throw maths, not an invented falloff. Emission carries lumens and the
      // lens shape; the distance is whatever the geometry turned out to be.
      float throwDistance = max(lens.w, 0.05);
      float lux = emission[i].x / (throwDistance * throwDistance);

      // Straight on is full value, edge on is nothing, facing away is nothing at
      // all -- measured to the lens, which is what lights this surface.
      //
      // Signed, not the magnitude, and no floor: the magnitude would light a
      // wall that faces away as brightly as one that faces the lens, and a
      // floor would put light on every surface in the frustum whatever its
      // angle. The winding is known -- we are looking at this surface, so its
      // outward normal is the one pointing back at the camera, and from there
      // the sign means something.
      vec3 toLens = normalize(lensPos[i] - world);
      float facing = max(dot(surfaceNormal, toLens), 0.0);

      // Soft edge. Applied on the projector's own frame, which is where a real
      // blend lives -- it is the machine dimming its own picture towards an
      // edge, not something happening out on the wall.
      vec4 edges = blendEdges[i];
      float blend = blendRamp(frame.x, edges.x)
        * blendRamp(1.0 - frame.x, edges.y)
        * blendRamp(frame.y, edges.z)
        * blendRamp(1.0 - frame.y, edges.w);

      // Black is white over the contrast, over the whole frame; the soft edge
      // dims only the picture above it, which is why blended overlaps show a
      // brighter black.
      float black = emission[i].z;
      vec3 lit = black + (1.0 - black) * colour * blend;
      total += lit * lux * INV_PI * emission[i].y * facing * inside * visible;
    }
    // A surface returns the projected light in proportion to its colour.
    if (hasAlbedo) total *= texture2D(surfaceAlbedo, uv).rgb;
    }

    // The shaft, the mover beam's way: for each projector, the stretch of the
    // view ray inside its frustum, found exactly and ended by the surface, and
    // a few samples at the middles of equal steps along it. The sum is the
    // light along the stretch, so a ray that only grazes the frustum carries
    // little and one down its length carries a lot. The haze throws more of
    // it at the eye the more the projector faces the camera, by the same
    // phase function and amount as the movers.
    if (hazeDensity > 0.0) {
      vec3 ray = world - eye;
      float reach = min(length(ray), SHAFT_MAX);
      vec3 direction = normalize(ray);

      vec3 scattered = vec3(0.0);
      for (int i = 0; i < SLOTS; i++) {
        if (i >= liveCount) break;
        float near;
        float far;
        if (!frustumSpan(i, eye, direction, reach, near, far)) continue;
        float stride = (far - near) / float(SHAFT_SAMPLES);
        vec3 lit = vec3(0.0);
        for (int k = 0; k < SHAFT_SAMPLES; k++) {
          float t = near + (float(k) + 0.5) * stride;
          vec3 at = eye + direction * t;
          vec3 light = shaftSample(i, at, at + direction * stride);
          if (light.r + light.g + light.b > 0.0) lit += light * shaftField(at);
        }
        vec3 throwDir = normalize(eye + direction * (near + far) * 0.5 - lensPos[i]);
        float phase = hazePhase(dot(throwDir, -direction), scatterAmount);
        scattered += lit * stride * phase;
      }
      total += scattered * hazeDensity * SHAFT_GAIN;
    }

    outputColor = vec4(total, inputColor.a);
  }
`;

class ProjectorEffect extends Effect {
  /**
   * @param {Object} camera the scene camera, for rebuilding world position
   */
  constructor(camera) {
    const lensMatrix = [];
    const pictureRowX = [];
    const pictureRowY = [];
    const pictureBounds = [];
    const atlasTile = [];
    const emission = [];
    const lensPos = [];
    const blendEdges = [];
    const pictureSize = [];
    const litRect = [];
    for (let i = 0; i < MAX_PROJECTIONS; i += 1) {
      litRect.push(new THREE.Vector4(0, 0, 1, 1));
      pictureSize.push(new THREE.Vector2(1, 1));
      lensMatrix.push(new THREE.Matrix4());
      pictureRowX.push(new THREE.Vector3(1, 0, 0));
      pictureRowY.push(new THREE.Vector3(0, 1, 0));
      pictureBounds.push(new THREE.Vector4(0, 0, 1, 1));
      const tile = ProjectorDepth.tileUv(i);
      atlasTile.push(new THREE.Vector4(tile.x, tile.y, tile.width, tile.height));
      emission.push(new THREE.Vector3(0, 0, 0));
      lensPos.push(new THREE.Vector3());
      blendEdges.push(new THREE.Vector4(0, 0, 0, 0));
    }

    super('ProjectorEffect', hazeShaderPrelude() + FRAGMENT, {
      blendFunction: BlendFunction.ADD,
      // Without this the pass has no depth buffer, and every projector would
      // paint the sky as readily as the building.
      attributes: EffectAttribute.DEPTH,
      defines: new Map([
        ['SLOTS', `${MAX_PROJECTIONS}`],
        ['DEPTH_BIAS', DEPTH_BIAS.toFixed(4)],
        ['PROJ_NEAR', PROJECTOR_NEAR.toFixed(4)],
        ['PROJ_FAR', PROJECTOR_FAR.toFixed(1)],
        ['SHAFT_SAMPLES', `${SHAFT_SAMPLES}`],
        ['SHAFT_MAX', SHAFT_MAX.toFixed(1)],
        ['SHAFT_GAIN', SHAFT_GAIN.toFixed(3)],
        ['SHAFT_BLUR_SHARE', SHAFT_BLUR_SHARE.toFixed(4)],
        ['SHAFT_NEAR', SHAFT_NEAR.toFixed(3)],
        ['SHAFT_FIELD_SCALE', SHAFT_FIELD_SCALE.toFixed(3)],
        ['SHAFT_EDGE', SHAFT_EDGE.toFixed(3)],
        ['SHAFT_BLUR_PER_METRE', SHAFT_BLUR_PER_METRE.toFixed(4)],
        ['SHAFT_FADE_PER_METRE', SHAFT_FADE_PER_METRE.toFixed(4)],
      ]),
      uniforms: new Map([
        ['projInverse', new THREE.Uniform(new THREE.Matrix4())],
        ['camWorld', new THREE.Uniform(new THREE.Matrix4())],
        ...Array.from({ length: MAX_PROJECTIONS }, (_, k) => [`picture${k}`, new THREE.Uniform(null)]),
        ['hasPicture', new THREE.Uniform(new Array(MAX_PROJECTIONS).fill(0))],
        ['pictureSize', new THREE.Uniform(pictureSize)],
        ['depthAtlas', new THREE.Uniform(null)],
        ['surfaceAlbedo', new THREE.Uniform(null)],
        ['litRect', new THREE.Uniform(litRect)],
        ['hasAlbedo', new THREE.Uniform(false)],
        ['lensMatrix', new THREE.Uniform(lensMatrix)],
        ['pictureRowX', new THREE.Uniform(pictureRowX)],
        ['pictureRowY', new THREE.Uniform(pictureRowY)],
        ['pictureBounds', new THREE.Uniform(pictureBounds)],
        ['atlasTile', new THREE.Uniform(atlasTile)],
        ['emission', new THREE.Uniform(emission)],
        ['lensPos', new THREE.Uniform(lensPos)],
        ['blendEdges', new THREE.Uniform(blendEdges)],
        ['liveCount', new THREE.Uniform(0)],
        ['scatterAmount', new THREE.Uniform(SHAFT_SCATTER_AMOUNT)],
        ['camPos', new THREE.Uniform(new THREE.Vector3())],
        ['camOrtho', new THREE.Uniform(false)],
        ['hazeMetres', new THREE.Uniform(SceneEnv.hazeScale)],
        ['drift', new THREE.Uniform(0)],
        ['hazeDensity', new THREE.Uniform(0)],
        // Shared by reference with every other renderer: one volume, one
        // cycling amount, so the air a shaft lights is the air the beams light.
        ...Object.entries(hazeUniforms()).map(([name, uniform]) => [name, uniform]),
      ]),
    });

    this.camera = camera;
    this.projections = [];
    this.elapsed = 0;
  }

  /**
   * Hands the pass what to draw this frame.
   *
   * Called from the render loop rather than pulled from here, because the
   * projections come from the fixture layer and the pass has no business
   * reaching into it.
   *
   * @public
   * @param {Array} projections each `{ lensMatrix, rect, lumensPerArea, gain,
   *   picture }`, picture the decoded texture of the projector's input or null
   */
  setProjections(projections) {
    this.projections = projections || [];
  }

  /**
   * The surface colour for this frame, from `SurfaceAlbedo`, or null.
   *
   * @public
   * @param {THREE.Texture|null} texture
   */
  setAlbedo(texture) {
    this.uniforms.get('surfaceAlbedo').value = texture || null;
    this.uniforms.get('hasAlbedo').value = !!texture;
  }

  /**
   * @public
   */
  update(renderer, inputBuffer, deltaTime) {
    this.elapsed += deltaTime || 0;

    const { uniforms, camera } = this;
    if (camera) {
      camera.updateMatrixWorld();
      uniforms.get('projInverse').value.copy(camera.projectionMatrixInverse);
      uniforms.get('camWorld').value.copy(camera.matrixWorld);
      uniforms.get('camPos').value.setFromMatrixPosition(camera.matrixWorld);
      uniforms.get('camOrtho').value = !!camera.isOrthographicCamera;
    }

    // `hazeAmount`, not `roomHaze`: a projector lighting its own cone is a
    // fixture, and a fixture's beam stays when the house lights come up.
    uniforms.get('hazeDensity').value = SceneEnv.hazeAmount;
    uniforms.get('hazeMetres').value = SceneEnv.hazeScale;
    // The same drift convention the beams and the ambient air use.
    uniforms.get('drift').value = this.elapsed * SceneEnv.hazeDriftRate;

    const live = this.projections.slice(0, MAX_PROJECTIONS);
    uniforms.get('liveCount').value = live.length;
    // Each slot its own projector's picture; an empty slot holds nothing.
    const hasPicture = uniforms.get('hasPicture').value;
    const pictureSize = uniforms.get('pictureSize').value;
    for (let i = 0; i < MAX_PROJECTIONS; i += 1) {
      const picture = (live[i] && live[i].picture) || null;
      uniforms.get(`picture${i}`).value = picture;
      hasPicture[i] = picture ? 1 : 0;
      const image = picture && picture.image;
      pictureSize[i].set((image && image.width) || 1, (image && image.height) || 1);
    }
    uniforms.get('depthAtlas').value = ProjectorDepth.texture();

    const matrices = uniforms.get('lensMatrix').value;
    const rowsX = uniforms.get('pictureRowX').value;
    const rowsY = uniforms.get('pictureRowY').value;
    const bounds = uniforms.get('pictureBounds').value;
    const emission = uniforms.get('emission').value;
    const lensPos = uniforms.get('lensPos').value;
    const blendEdges = uniforms.get('blendEdges').value;
    const litRect = uniforms.get('litRect').value;
    live.forEach((projection, i) => {
      const { blend } = projection;
      blendEdges[i].set(blend.left, blend.right, blend.bottom, blend.top);
      lensPos[i].setFromMatrixPosition(projection.camera.matrixWorld);
      matrices[i].copy(projection.lensMatrix);
      const map = projection.pictureMap;
      rowsX[i].set(map.rowX[0], map.rowX[1], map.rowX[2]);
      rowsY[i].set(map.rowY[0], map.rowY[1], map.rowY[2]);
      bounds[i].set(map.bounds[0], map.bounds[1], map.bounds[2], map.bounds[3]);
      // With no picture the whole frame is lit white.
      const lit = projection.picture && map.lit ? map.lit : [0, 0, 1, 1];
      litRect[i].set(lit[0], lit[1], lit[2], lit[3]);
      // x carries the lumens, y the dimmer and shutter folded together. Kept
      // apart so a dimmed machine still reads as the same machine.
      // z the black level, a fraction of white.
      emission[i].set(projection.lumensPerArea * LUX_SCALE, projection.gain, projection.black || 0);
    });
  }
}

export default ProjectorEffect;
