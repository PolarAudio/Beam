import * as THREE from 'three';
import ModelInstancer from './model_instancer';
import SceneEnv from './scene_env';
// TODO: find a way for the linter to acces vite's '?' syntax
import VOLUMETRIC_BEAM_VERTEX_SHADER from './shaders/beam.vertex.glsl?raw';
import VOLUMETRIC_BEAM_FRAGMENT_SHADER from './shaders/beam.fragment.glsl?raw';
import Shutter, { SHUTTER_MODES } from './shutter';
import { kelvinToRgb } from '../../models/DMX/colour_temperature';
import { hazeShaderPrelude, hazeUniforms } from './haze_noise';
import LightField, {
  CANDELA_PER_UNIT, REFERENCE_INTENSITY, REFERENCE_LUMENS, SCENE_INTENSITY_PER_UNIT,
} from './light_field';
import { castsContactShadow } from './contact_shadows';
import { DepthAtlas } from './projector_depth';
import {
  goboTexture, goboLayerFor, goboImageCell, GOBO_BLUR_LEVELS,
} from './gobo_library';
import BodyFinish from './body_finish';
import {
  prismFromText, PRISM_DEFAULT_FACETS, PRISM_MAX_FACETS,
} from '../../models/DMX/gdtf/name_rules';

/**
 * A light's casing: dark grey with a satin, part-metallic finish. Pure black,
 * or anything near it, gives every face the same black and a light a
 * silhouette with no shape; the room's light reflected along curves and
 * edges is how a black fixture shows its shape, so the finish carries enough
 * gloss and metal to catch it. Measured on a close view under the house
 * lights: body median 14/255 with edges to 57, against 5 with edges to 15
 * for the old pure black. The emissive floor is small, enough that an unlit
 * head does not vanish in a black room and not so much that it flattens the
 * shading.
 */
const MODEL_FINISH = new BodyFinish({
  colour: '#4a4e53',
  roughness: 0.35,
  metalness: 0.5,
  lift: 0.12,
});
const MODEL_MATERIAL = MODEL_FINISH.material().clone();
MODEL_MATERIAL.side = THREE.DoubleSide;
MODEL_MATERIAL.clippingPlanes = true;

MODEL_MATERIAL.onBeforeCompile = (shader) => {
  // the rest is the same
  shader.vertexShader = shader.vertexShader.replace(
    '#define STANDARD\n',
    `#define STANDARD
         attribute float highlight;
         varying float vHighlight;`,
  );
  shader.vertexShader = shader.vertexShader.replace(
    '#include <clipping_planes_vertex>\n\t',
    '#include <clipping_planes_vertex>\nvHighlight = highlight;\n',
  );
  shader.fragmentShader = shader.fragmentShader.replace(
    'varying vec3 vViewPosition;\n',
    'varying vec3 vViewPosition;\nvarying float vHighlight;\n',
  );
  shader.fragmentShader = shader.fragmentShader.replace(
    'totalEmissiveRadiance = emissive;\n',
    'totalEmissiveRadiance = vHighlight == 0.0 ? emissive : vec3(.42,.42,.44);\n',
  );
  MODEL_MATERIAL.userData.shader = shader;
};

/**
 * How many lights the instanced buffers hold before they are grown.
 *
 * A starting size, not a limit: the buffers double when a light would not fit.
 * Three's `setMatrixAt` writes through `matrix.toArray(array, i)`, where an
 * out-of-range typed-array write is silently dropped, and a `count` above the
 * capacity allocated degenerates the whole instanced draw -- *every* head
 * vanishes, not just the extra one.
 *
 * An arena rig runs to several hundred movers, and the geometry side of one
 * is cheap -- these are six instanced
 * draws whatever the count. What does not scale is the `SpotLight` each light
 * carries, and that is a separate problem from this one: a light outside the
 * lighting budget still has a body and a beam to draw, and they belong here.
 *
 * @constant {Number}
 */
const INITIAL_CAPACITY = 128;

/** How many the buffers hold right now. Grows by doubling; never shrinks. */
let capacity = INITIAL_CAPACITY;
const vector_cam = new THREE.Vector3();
const vector_beam = new THREE.Vector3();
const vector_beam_pos = new THREE.Vector3();
const vector_cam_pos = new THREE.Vector3();
/** When `update` last ran, in the visualizer's seconds; null before the first frame. */
let lastUpdateTime = null;
/** Scratch for reading a light's aim while packing the light field. */
const vector_light_target = new THREE.Vector3();

const BEAM_RESOLUTION = 100;
const BEAM_SEGMENTS = 1;
const BEAM_LENGTH = 100;
const BEAM_TOP_RADIUS = 0.09;

/**
 * How bright an unlit lens is: dark glass, not a hole in the head.
 *
 * @constant {Number}
 */
const LENS_DARK = 0.05;
/** Scratch for the lens colour write. */
const lensColor = new THREE.Color();
const BEAM_MAX_ANGLE = 45;

/**
 * How fast a wheel travels from slot to slot when a new one is chosen, in
 * slots a second: about 0.13 s a slot, so passing several takes
 * proportionally longer, as a real wheel's motor does. It takes the shorter
 * way round.
 */
const WHEEL_SLOTS_PER_SECOND = 7.5;

/**
 * Colours for colour-wheel slots a profile names but gives no value, by the
 * word in the name. Checked in order, so "minus green" wins over "green" and
 * "pink" over "red". Gel numbers are not looked up: the word is what the
 * profile's author chose to describe it by.
 */
const GEL_WORDS = [
  ['minus green', [1, 0.72, 1]],
  ['uv', [0.35, 0, 1]],
  ['ultraviolet', [0.35, 0, 1]],
  ['congo', [0.3, 0, 0.8]],
  ['lavender', [0.75, 0.55, 1]],
  ['violet', [0.55, 0.1, 1]],
  ['purple', [0.6, 0, 1]],
  ['magenta', [1, 0, 1]],
  ['pink', [1, 0.45, 0.7]],
  ['red', [1, 0, 0]],
  ['amber', [1, 0.6, 0]],
  ['orange', [1, 0.45, 0]],
  ['yellow', [1, 1, 0]],
  ['lime', [0.6, 1, 0]],
  ['green', [0, 1, 0]],
  ['turquoise', [0, 1, 0.8]],
  ['cyan', [0, 1, 1]],
  ['light blue', [0.4, 0.7, 1]],
  ['blue', [0, 0.2, 1]],
  ['white', [1, 1, 1]],
];

/**
 * The colour a colour-wheel slot puts in the beam, or null for white.
 *
 * The profile's own value first. Failing that, a colour temperature: the
 * slot's `colorTemperature`, or a Kelvin figure in a CTO, CTB or CTC name,
 * the first when the name gives a range. Failing that, the colour word in
 * its name. A slot with nothing to go on is white.
 *
 * @param {Object} slot an OFL wheel slot of type Color
 * @returns {THREE.Color|null}
 */
function gelColour(slot) {
  if (!slot || slot.type !== 'Color') return null;
  if (slot.colors && slot.colors.length) {
    const colour = new THREE.Color(slot.colors[0]);
    // A measured filter lets through its share of the light: its colour is
    // scaled so its luminance is that share of white's.
    if (slot.transmission > 0) {
      const luminance = 0.2126 * colour.r + 0.7152 * colour.g + 0.0722 * colour.b;
      if (luminance > 0) colour.multiplyScalar(slot.transmission / luminance);
    }
    return colour;
  }
  const kelvin = parseFloat(slot.colorTemperature)
    || parseFloat((/(\d{4,5})\s*-?\s*\d*\s*K\b/i.exec(slot.name || '') || [])[1])
    || parseFloat((/\bCT[OBC]\b\D*(\d{4,5})/i.exec(slot.name || '') || [])[1]);
  if (kelvin) return new THREE.Color(...kelvinToRgb(kelvin));
  const name = String(slot.name || '').toLowerCase();
  const word = GEL_WORDS.find(([w]) => new RegExp(`\\b${w}\\b`).test(name));
  return word ? new THREE.Color(...word[1]) : null;
}

/**
 * How blurred a gobo is with the focus wound fully out, in the atlas's baked
 * blur levels: the softest there is.
 */
const GOBO_DEFOCUS_MAX = GOBO_BLUR_LEVELS - 1;

/**
 * The penumbra a focus channel sweeps, fully in to fully out. Not from the
 * profile: OFL states no edge softness, so these are Beam's. Focused is
 * nearly a hard edge, as a well-focused spot throws; out is soft to the
 * middle of the radius.
 */
const PENUMBRA_FOCUSED = 0.05;
const PENUMBRA_DEFOCUSED = 1.0;

/**
 * How much wider full frost makes the beam: the field's half angle times
 * 1 plus this. Profiles do not say; frost turns a spot into a wash, and
 * half as wide again is Beam's figure.
 */
const FROST_WIDEN = 0.5;

/**
 * What each beam can see from its lens, packed into one texture.
 *
 * A tile per head, drawn from a camera at the beam's origin looking down
 * its axis. The fragment shader projects each of a ray's chord samples into
 * the tile and drops the ones past the first surface the lens sees, which
 * is what stops a beam at a wall and darkens the air behind a cube in it.
 *
 * Sixteen by sixteen tiles of 128 pixels: a cut against a truss needs far
 * less resolution than a laser figure on a wall, and 256 slots cover a rig
 * of hundreds. A light past the last slot gets no tile and stops at the
 * floor plane alone. Depth is linear distance over `far`, which is the
 * drawn cone's length.
 *
 * The near plane is half a metre, not a token 0.1: the camera sits on the
 * lens face, and the head's own model stands a few centimetres in front of
 * it around the lens opening. Drawn into the tile, that bezel shadowed the
 * pool into its own eight-sided silhouette. Nothing in a rig sits within
 * half a metre of a lens, and samples that close read as lit anyway.
 */
const MOVER_DEPTH = new DepthAtlas({
  columns: 16, rows: 16, tile: 128, near: 0.5, far: BEAM_LENGTH * 1.5, linear: true,
});

/**
 * How many tiles may be redrawn in one frame.
 *
 * One head panning dirties the scene for every tile, so a chase across two
 * hundred lights would otherwise be two hundred passes a frame. The atlas
 * draws the most important ones first and the rest keep their last drawing
 * until their turn; a beam with a stale tile is briefly wrong only where it
 * cuts a truss.
 */
const DEPTH_TILE_BUDGET = 4;

/**
 * How much wider than the beam's own cone its tile looks, as a ratio of the
 * half-angle's tangent.
 *
 * The cone starts at the lens ring rather than at a point, so close to the
 * lens its edge sits outside the stated angle. Samples that fall outside the
 * tile are taken as lit; the margin keeps that to the first metre or so.
 */
const DEPTH_FOV_MARGIN = 1.2;

/** Metres a sample may sit past the tile's surface and still count as lit. */
const DEPTH_BIAS = 0.05;

/**
 * The tile camera's frame in the beam's: it looks down the beam's +z, so
 * its -z is that, and its x is turned to keep the frame right-handed.
 */
const depthBasis = new THREE.Matrix4().makeBasis(
  new THREE.Vector3(-1, 0, 0),
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, 0, -1),
);
const depthScale = new THREE.Vector3(1, 1, 1);

/** Beams stop at surfaces. A diagnostic switch, never stored. */
let occlusionEnabled = true;

/**
 * The haze's scattering coefficient at full haze, per metre.
 *
 * Full haze is a thick stage haze with 10 m visibility. Visibility is where
 * contrast falls to 2 %, so the coefficient is ln(50) / 10 m; a lower haze
 * setting scales it linearly. The same coefficient sets how much light the
 * air scatters out of a beam towards the eye and how fast the beam is
 * eaten on its way.
 */
const HAZE_SCATTER_AT_FULL = Math.log(50) / 10;

/**
 * The beam fragment shader, with the scene's haze configuration prepended.
 *
 * The mode, the field and its constants live in `haze_noise.js` and reach every
 * renderer through the same prelude, so a beam and an LED glow cannot end up
 * scattering through different air.
 *
 * @constant {String}
 */
const BEAM_FRAGMENT_SHADER = hazeShaderPrelude() + VOLUMETRIC_BEAM_FRAGMENT_SHADER;

const SPOTLIGHT_PHYSICALLY_CORRECT_DISTANCE = 0;
/**
 * The pool's light at full for the reference light, in scene units: its
 * candela on the lux scale the projector uses, so with the inverse-square
 * falloff below a pool lands at its real illuminance. The beam in the air
 * reads `lit` and is unaffected.
 */
const SPOTLIGHT_PHYSICALLY_CORRECT_INTENSITY = REFERENCE_INTENSITY * SCENE_INTENSITY_PER_UNIT;

/**
 * Lumens per watt of fixture power, for a profile that states power but not
 * output: the median of the library's moving heads that state both.
 *
 * @constant {Number}
 */
const LUMENS_PER_WATT = 22;

/**
 * The efficacy a stated lumen figure has to fall inside to be believed.
 * Profiles converted from other formats carry lux or candela under
 * `lumens` -- 695400 lm from 620 W, 451 lm from 400 W -- and either would
 * make a light blinding or black.
 *
 * @constant {Array<Number>}
 */
const PLAUSIBLE_LUMENS_PER_WATT = [5, 150];

/** Light spreads as the inverse square of the distance. */
const SPOTLIGHT_PHYSICALLY_CORRECT_DECAY = 2.0;
/**
 * The pool's penumbra for a fixture without a focus channel. A focus
 * channel sweeps its own range, `PENUMBRA_DEFOCUSED` to `PENUMBRA_FOCUSED`.
 *
 * Shapes the beam in the air as well, through `writeBeamProfile`. Half:
 * a plateau to the middle of the radius, a slope from there to the edge.
 * At 1.2 the plateau was only the inner fifth and two overlapping pools
 * summed to a saddle the eye drew as dark curves along each rim; a wide
 * plateau adds flat, which is what two blurred discs do in an image editor.
 */
const SPOTLIGHT_PHYSICALLY_CORRECT_PENUMBRA = 0.5;
/** Per-light shadow map resolution. Every casting light costs one depth pass. */
const SPOTLIGHT_SHADOW_MAP_SIZE = 512;
const SPOTLIGHT_SHADOW_NEAR = 0.5;
const SPOTLIGHT_SHADOW_FAR = 60;

/**
 * How far a light reaches, in metres.
 *
 * Not `distance = 0`, which three reads as unbounded. That is fine for a
 * handful of lights and impossible for hundreds: a light with infinite reach
 * cannot be culled, by the range test in the light field or by frustum
 * clusters. Sixty metres is what the shadow
 * camera already assumed, and past it a moving head is not lighting anything a
 * viewer can see.
 *
 * @constant {Number}
 */
const SPOTLIGHT_RANGE = 60;
const SPOTLIGHT_SHADOW_BIAS = -0.0005;
const SPOTLIGHT_SHADOW_NORMAL_BIAS = 0.02;

const DEFAULT_COLOR_TEMP = 8000;

const SLOT_TYPES = {
  OPEN: 'Open',
  COLOR: 'Color',
  GOBO: 'Gobo',
};

let position_buffer_attribute = new THREE.InstancedBufferAttribute(
  new Float32Array(capacity * 3),
  3,
);
let direction_buffer_attribute = new THREE.InstancedBufferAttribute(
  new Float32Array(capacity * 3),
  3,
);
let intensity_buffer_attribute = new THREE.InstancedBufferAttribute(
  new Float32Array(capacity),
  1,
);
let color_buffer_attribute = new THREE.InstancedBufferAttribute(
  new Float32Array(capacity * 3),
  3,
);
let emissive_buffer_attribute = new THREE.InstancedBufferAttribute(
  new Float32Array(capacity),
  1,
);
/**
 * Per instance: x the half-angle of the field, y unused, z the inner cone
 * over the field (see `writeBeamProfile`).
 *
 * The shader declares this `vec3`, and the buffer must supply all three: a
 * missing component reads as the 0.0 WebGL fills it with.
 */
let angle_buffer_attribute = new THREE.InstancedBufferAttribute(
  new Float32Array(capacity * 3),
  3,
);
/**
 * The depth-slot-and-iris pairs for `count` lights: no tile, iris open.
 *
 * @param {Number} count
 * @returns {Float32Array}
 */
function slotIrisArray(count) {
  const array = new Float32Array(count * 2);
  for (let i = 0; i < count; i += 1) {
    array[i * 2] = -1;
    array[i * 2 + 1] = 1;
  }
  return array;
}
/**
 * Per instance: x the atlas slot holding this beam's depth tile, or -1 for a
 * beam without one, written by `renderDepth` every frame; y how far the iris
 * is open, 1 fully to 0 closed, written by `writeOptics`.
 *
 * Two quantities in one attribute because a GPU gives a shader a fixed
 * number of per-vertex inputs, and the beam is at the limit: this one works
 * out to 14 active inputs, the instance matrix taking four. A fifteenth,
 * the colour split, stopped the beam compiling at all.
 */
let depth_slot_attribute = new THREE.InstancedBufferAttribute(
  slotIrisArray(capacity),
  2,
);
/**
 * Per instance: the gobos in the beam, two layers of (texture layer, angle
 * in radians). Layer 0 is open. Written by `writeOptics` whenever a wheel
 * moves or spins.
 */
let gobo_attribute = new THREE.InstancedBufferAttribute(
  new Float32Array(capacity * 4),
  4,
);
/**
 * Per instance: the colour on the far side of a colour wheel split, rgb, and
 * w the split's position, 0 for no split to 1 for fully the second colour.
 * Written by `recomputeBeamColor`.
 */
let color_b_attribute = new THREE.InstancedBufferAttribute(
  new Float32Array(capacity * 4),
  4,
);
/**
 * Per instance: the prism in the beam as (facets, angle in radians, spread
 * as a fraction of the field's radius, gobo defocus); facets below 2 is no
 * prism.
 */
let prism_attribute = new THREE.InstancedBufferAttribute(
  new Float32Array(capacity * 4),
  4,
);

const baseGeo = new THREE.InstancedBufferGeometry();
const yokeGeo = new THREE.InstancedBufferGeometry();
const headGeo = new THREE.InstancedBufferGeometry();
const beamGeo = new THREE.InstancedBufferGeometry();
const targetGeo = new THREE.InstancedBufferGeometry();
const boundingBoxGeo = new THREE.InstancedBufferGeometry();

/** What a hidden head's slot is drawn with: nothing, at the origin. */
const COLLAPSED = new THREE.Matrix4().makeScale(0, 0, 0);

let baseMesh;
let yokeMesh;
let headMesh;
let beamMesh;
let capMesh;
let boundingBoxMesh;

let camera_handle = null;
let scene_handle = null;

const instances = [];

/** Scratch for the selection walk; read inside the callback. */
const selectionMatrix = new THREE.Matrix4();
const selectionOrigin = new THREE.Vector3();

/**
 * How many fixtures may cast a shadow at once.
 *
 * Each shadow-casting light costs one fragment texture image unit, and a GPU
 * offers few of them -- 16 is common. Past that the standard material's
 * program fails to validate and everything drawn with it stops rendering, the
 * floor most visibly. Half the pool is kept back for the maps materials
 * themselves need, which leaves this.
 *
 * Exported because the limit is a fact about the renderer but has to be
 * enforced where the choice is made.
 *
 * @constant {Number} MAX_SHADOW_CASTERS
 */
export const MAX_SHADOW_CASTERS = 8;

let instanceCount = 0;

/**
 * A hard stop, so a runaway count fails loudly instead of eating memory.
 *
 * Well above any real rig -- an arena show runs to several hundred movers --
 * and here only so that a bug that never stops adding lights is visible rather
 * than fatal.
 *
 * @constant {Number}
 */
const ABSOLUTE_MAX_INSTANCES = 4096;

/**
 * The same attribute, holding `capacity` instances, with what it held copied in.
 *
 * @param {THREE.InstancedBufferAttribute} attribute
 * @returns {THREE.InstancedBufferAttribute}
 */

function grownAttribute(attribute) {
  const array = new Float32Array(capacity * attribute.itemSize);
  array.set(attribute.array);
  const grown = new THREE.InstancedBufferAttribute(array, attribute.itemSize);
  grown.setUsage(attribute.usage);
  grown.needsUpdate = true;
  return grown;
}

/**
 * The same mesh, holding `capacity` instances, with its matrices carried over.
 *
 * An `InstancedMesh` cannot be resized, so this is a new one on the same
 * geometry and material -- neither of which is disposed, both being shared.
 * The old mesh's own `dispose` frees just its instance buffers.
 *
 * @param {THREE.InstancedMesh} mesh
 * @returns {THREE.InstancedMesh}
 */

function grownMesh(mesh) {
  const grown = new THREE.InstancedMesh(mesh.geometry, mesh.material, capacity);
  grown.instanceMatrix.array.set(mesh.instanceMatrix.array);
  grown.instanceMatrix.setUsage(mesh.instanceMatrix.usage);
  grown.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) {
    grown.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(capacity * 3).fill(LENS_DARK),
      3,
    );
    grown.instanceColor.array.set(mesh.instanceColor.array);
    grown.instanceColor.setUsage(mesh.instanceColor.usage);
    grown.instanceColor.needsUpdate = true;
  }
  grown.count = mesh.count;
  grown.frustumCulled = mesh.frustumCulled;
  grown.castShadow = mesh.castShadow;
  grown.receiveShadow = mesh.receiveShadow;
  // Layers too, or a rig that grows past its capacity quietly stops casting
  // contact shadows at the 129th light.
  grown.layers.mask = mesh.layers.mask;
  if (scene_handle) {
    scene_handle.remove(mesh);
    scene_handle.add(grown);
  }
  mesh.dispose();
  return grown;
}

/**
 * Colour each additive emitter contributes at full, as linear RGB.
 *
 * Matched on the whole OFL colour name rather than its first letter: 'Cold
 * White' and 'Cyan' share one, as do 'UV' and nothing else useful. Approximate
 * by intent -- this is a sandbox visualiser, not a spectrometer.
 *
 * White is absent because it takes the fixture's own white point, which moves
 * with colour temperature control.
 *
 * @constant {Object}
 */
const EMITTER_TINTS = {
  red: [1, 0, 0],
  green: [0, 1, 0],
  blue: [0, 0, 1],
  amber: [1, 0.6, 0],
  lime: [0.75, 1, 0],
  uv: [0.35, 0, 0.85],
  indigo: [0.3, 0, 0.9],
};

/**
 * Subtractive emitters, and the additive component each one removes.
 *
 * @constant {Object}
 */
const SUBTRACTIVE_EMITTERS = {
  cyan: 0,
  magenta: 1,
  yellow: 2,
};

/** Emitters that emit the fixture's white point rather than a fixed hue. */
const WHITE_EMITTERS = ['white', 'warmwhite', 'coldwhite', 'coolwhite'];

/** Half-extent of a light's selection box, in metres, at the model's own size. */
const SELECTION_HALF_EXTENT = 0.51;
/** Scratch box for measuring one part of a light against the world. */
const partBounds = new THREE.Box3();

/**
 * Bounds on how far a body may be scaled from the shipped model. Library
 * dimensions are hand-typed, and a slipped digit must not produce a light the
 * size of a truck or a matchbox.
 *
 * @constant {Number}
 */
const BODY_SCALE_MIN = 0.2;
const BODY_SCALE_MAX = 3;

/**
 * Where the lens face sits along the head's axis in the shipped model, metres
 * from the tilt pivot. The lens cap and the beam start here.
 *
 * @constant {Number}
 */
const LENS_FACE_OFFSET = 0.255;

/**
 * The shipped model's height, and how far its base reaches below the origin,
 * measured from the geometry once it is loaded. A profile's physical height is
 * scaled against the first; the second keeps a scaled base on the floor.
 */
let modelHeight = 0;
let modelBaseDepth = 0;

/** Scratch for rebuilding the beam's frame from the scaled head's. */
const beamScale = new THREE.Vector3(1, 1, 1);
const rigidPosition = new THREE.Vector3();
const rigidQuaternion = new THREE.Quaternion();
const rigidScale = new THREE.Vector3();
const rigidMatrix = new THREE.Matrix4();
const beamAxis = new THREE.Vector3();

/** Scratch corner, reused while growing a selection box. */
const boundsCorner = new THREE.Vector3();

/**
 * Where the beam geometry starts along its own axis, metres from its origin:
 * the shipped model's lens face, built into the cylinder.
 *
 * @constant {Number}
 */
const BEAM_START = 0.258;

/** A GDTF body is drawn hanging; Beam stands a light up: half a turn about X. */
const UPRIGHT = new THREE.Matrix4().makeRotationX(Math.PI);

/** The pick box's geometry: 0.5 x 0.5 x 0.8, centred 0.15 below the origin. */
const PICK_BOX_SIZE = new THREE.Vector3(0.5, 0.5, 0.8);
const PICK_BOX_CENTRE = new THREE.Vector3(0, 0, -0.15);

/** Scratch for a GDTF head's pick box. */
const pickScratch = new THREE.Matrix4();

/** Writes a matrix into an object's position, rotation and scale. */
function setLocal(object, matrix) {
  matrix.decompose(object.position, object.quaternion, object.scale);
}

/**
 * The instanced meshes of each GDTF body in the scene, by body: one per part
 * that has geometry, a highlight attribute, and the slots in use. Every light
 * of one fixture type shares its type's body, so a hundred of them are three
 * draws, as the shipped body's are.
 */
const bodySets = new Map();

/** How many lights a body's meshes hold before they are grown. */
const BODY_INITIAL_CAPACITY = 16;

/**
 * A body's instanced part, holding `count` slots, with what an older one held.
 *
 * @param {THREE.InstancedBufferGeometry} geometry
 * @param {Number} count
 * @param {THREE.InstancedMesh} [old]
 * @returns {THREE.InstancedMesh}
 */
function bodyMesh(geometry, count, old) {
  const mesh = new THREE.InstancedMesh(geometry, MODEL_MATERIAL, count);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  for (let i = 0; i < count; i += 1) mesh.setMatrixAt(i, COLLAPSED);
  if (old) mesh.instanceMatrix.array.set(old.instanceMatrix.array);
  mesh.instanceMatrix.needsUpdate = true;
  mesh.frustumCulled = false;
  // As the shipped body: bodies block light, take shadow, stain the floor.
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  castsContactShadow(mesh);
  return mesh;
}

/**
 * The meshes for a body, built the first time a light of its type is placed.
 *
 * @param {Object} body from `gdtf_body.js`
 * @returns {Object} `{ meshes, highlight, capacity, used, free }`
 */
function bodySetFor(body) {
  let set = bodySets.get(body);
  if (set) return set;
  set = {
    meshes: {},
    highlight: new THREE.InstancedBufferAttribute(new Float32Array(BODY_INITIAL_CAPACITY), 1),
    capacity: BODY_INITIAL_CAPACITY,
    used: 0,
    free: [],
  };
  ['base', 'yoke', 'head'].forEach((part) => {
    if (!body[part]) return;
    const geometry = new THREE.InstancedBufferGeometry();
    THREE.BufferGeometry.prototype.copy.call(geometry, body[part]);
    geometry.setAttribute('highlight', set.highlight);
    set.meshes[part] = bodyMesh(geometry, set.capacity);
    scene_handle.add(set.meshes[part]);
  });
  bodySets.set(body, set);
  return set;
}

/**
 * A slot in a body's meshes, growing them when they are full.
 *
 * @param {Object} set from `bodySetFor`
 * @returns {Number}
 */
function claimBodySlot(set) {
  if (set.free.length) return set.free.pop();
  const slot = set.used;
  set.used += 1;
  if (set.used > set.capacity) {
    set.capacity *= 2;
    const highlight = new THREE.InstancedBufferAttribute(new Float32Array(set.capacity), 1);
    highlight.array.set(set.highlight.array);
    set.highlight = highlight;
    Object.keys(set.meshes).forEach((part) => {
      const old = set.meshes[part];
      old.geometry.setAttribute('highlight', highlight);
      const grown = bodyMesh(old.geometry, set.capacity, old);
      scene_handle.remove(old);
      old.dispose();
      scene_handle.add(grown);
      set.meshes[part] = grown;
    });
  }
  return slot;
}

/**
 * A light in the scene: its lens and beam, the light it throws, everything in
 * its light path -- zoom, focus, iris, frost, colour, wheels, gobos, prisms,
 * strobe -- and the body it sits in. A light on its own stands still, its beam
 * leaving its body where the file puts the lens; a moving head is a light on a
 * yoke, see `moving_head.js`.
 *
 * Every light is one slot in the instanced meshes and buffers below, its `id`.
 *
 * @class Light
 */
class Light {
  /**
   * Creates a light.
   * @param {Object} [data={
   *     minAngle: 0.0,
   *     maxAngle: 10.0,
   *     color: 'white',
   *     colorTemp: DEFAULT_COLOR_TEMP,
   *     intensity: 0.0,
   *     wheels: {},
   *     colorWheel: [],
   *     goboSpeed: { min: 1, max: 60 },
   *     prismSpeed: { min: 1, max: 120 },
   *     prismSpread: 0.6
   *   }]
   * @memberof Light
   */
  constructor(data = {
    minAngle: 0.0,
    maxAngle: 10.0,
    color: 'white',
    colorTemp: DEFAULT_COLOR_TEMP,
    intensity: 0.0,
    wheels: {},
    colorWheel: [],
  }) {
    // Room first, then the id. The buffers are shared, so a light taking an id
    // they cannot hold does not lose itself -- it loses every light. Refused
    // rather than half-built: past the absolute limit there is no id that can
    // be handed out without standing on somebody else's.
    if (!Light.ensureCapacity(instanceCount + 1)) {
      throw new Error(`Cannot place more than ${ABSOLUTE_MAX_INSTANCES} lights`);
    }
    this._id = instanceCount++;
    // Before anything can read it. The buffer is zero-filled, and zero is a
    // legitimate inner cone meaning "all falloff, no core" -- so a fixture
    // without a focus channel would have rendered as fully defocused rather
    // than with the penumbra its SpotLight is born with.
    Light.writeBeamProfile(this._id, SPOTLIGHT_PHYSICALLY_CORRECT_PENUMBRA);
    this._position = new THREE.Vector3();
    this._rotation = new THREE.Vector3();
    /** The camera the beam's depth tile is drawn from; set by hand. */
    this._depthCam = new THREE.PerspectiveCamera();
    this._depthCam.matrixWorldAutoUpdate = false;
    /** Where the beam pointed when its tile was last drawn. */
    this._depthDir = new THREE.Vector3();
    this._minAngle = data.minAngle;
    this._maxAngle = data.maxAngle;
    /**
     * The light out of the lens at full, in lumens. A light that does not
     * say is the light field's reference light.
     */
    this._lumens = Number(data.lumens) > 0 ? Number(data.lumens) : REFERENCE_LUMENS;
    /** What the shutter let through this frame, 0..1. */
    this._shutter = 1.0;
    /**
     * The shutter's behaviour over time, shared with the strobe fixture. Open
     * until a shutter channel says otherwise.
     */
    this._flashes = new Shutter();
    this._flashes.mode = SHUTTER_MODES.ON;
    /** OFL's random-timing flag, kept so the effect can be re-derived. */
    this._strobeRandom = false;
    this._strobeEffect = 'Open';
    /**
     * Every wheel the profile has, by name, sorted by what its slots hold.
     * A light may carry any number of gobo wheels and prism wheels; the
     * shaders draw the first two gobos and the first prism that is in the
     * beam.
     */
    this._wheels = Light.buildWheels(data.wheels || {});
    /** What the wheels and the lamp start as, for `resetOptics`. */
    this._wheelData = data.wheels || {};
    this._lampColorTemp = data.colorTemp;
    /**
     * What "slow" and "fast" mean for this fixture, in turns a minute. A
     * profile only says how far along that range a value sits.
     */
    this._goboSpeed = { min: 1, max: 60, ...(data.goboSpeed || {}) };
    /** What a shake's slow and fast are for this fixture, in shakes a second. */
    this._shakeSpeed = { min: 1, max: 8, ...(data.shakeSpeed || {}) };
    this._prismSpeed = { min: 1, max: 120, ...(data.prismSpeed || {}) };
    /** How far a prism throws its copies, as a fraction of the field's radius. */
    this._prismSpread = data.prismSpread === undefined ? 0.6 : data.prismSpread;
    /**
     * A prism put in by a Prism capability rather than a wheel slot: on or
     * off, its facets, and its spin. A prism wheel's slot sets the facets
     * when there is one; without a wheel the prism has three.
     */
    /**
     * How blurred the gobo image is from the focus, in mip levels of the
     * pattern: 0 in focus. Carried in the prism data's spare slot.
     */
    this._goboDefocus = Light.goboDefocusFor(SPOTLIGHT_PHYSICALLY_CORRECT_PENUMBRA);
    /**
     * The lens before frost: the field's half angle from the zoom, and the
     * penumbra from the focus. Frost is applied over both; see `applyLensAngle` and `applyLensEdge`.
     */
    this._baseAngle = null;
    this._basePenumbra = SPOTLIGHT_PHYSICALLY_CORRECT_PENUMBRA;
    /**
     * Frost, 0 none to 1 full, from a frost channel or a frost slot on a
     * wheel; `_frostWheel` names the wheel that set it. `_frostEffect` is a
     * ramp or pulse running it, or null.
     */
    this._frost = 0;
    this._frostWheel = null;
    this._frostEffect = null;
    /**
     * How far the iris is open, 1 fully to 0 closed, as a fraction of the
     * field's radius. It crops the beam to a smaller circle without
     * shrinking the gobo in it. Set by an iris channel or an iris slot on a
     * wheel; `_irisWheel` names the wheel that set it, so moving that wheel
     * off its iris slot opens it again.
     */
    this._iris = 1;
    this._irisWheel = null;
    this._prism = {
      on: false, facets: PRISM_DEFAULT_FACETS, linear: false, angle: 0, speedRpm: 0,
    };
    this._colorWheel = data.colorWheel;
    this._colorWheelData = data.colorWheel;
    /**
     * A colour wheel parked between two slots: the colour on the far side of
     * the boundary, null for an open slot, and how far across the beam the
     * boundary has come, 0 none to 1 all. Both colours are distinct on
     * screen with a line between them, sharpened by the focus as a gobo is.
     */
    this._wheelColorB = null;
    this._wheelSplit = 0;
    /** The beam colour on the far side of a split, the same mix as `color`. */
    this._colorB = new THREE.Color(1, 1, 1);
    this._activeColorPreset = false;
    /**
     * The colour the wheel currently puts in front of the lamp, or null for an
     * open slot. Kept rather than written straight to the beam because on a
     * fixture that also mixes colour the two are in series -- see
     * `recomputeBeamColor`.
     */
    this._wheelColor = null;
    /**
     * Raw 0-1 intensity per emitter, keyed by normalised OFL colour name. The
     * beam colour is derived from these rather than written channel by channel,
     * so white and amber can add to red/green/blue instead of overwriting them.
     */
    this._emitters = {};
    this._highlighted = false;
    /**
     * The fixture's own body from its GDTF file, or null for the shipped one,
     * which every other head draws scaled to its profile's height.
     */
    this._body = data.body || null;
    this._bodyScale = this._body ? 1 : Light.bodyScaleFor(data.bodyHeight);
    /** How wide the lens is against the shipped one's; see `mountBody`. */
    this._lensScale = this._bodyScale;
    /** Where the body reaches below the origin, and the pick box; see `mountBody`. */
    this._baseDepth = null;
    this._pickMatrix = null;

    this.prepareInstance();

    this.angle = this._maxAngle;
    this.color = data.color;
    this.colorTemp = data.colorTemp;
    this.intensity = data.intensity;
    this.strobeFrequency = 0.0;
  }

  /**
   * Instance ID
   *
   * @type {Number}
   */
  set id(id) {
    this._id = id;
    // A light moved into another slot must write its matrices there, whether
    // or not they changed.
    if (this._writtenMatrices) this._writtenMatrices.forEach((m) => m.elements.fill(NaN));
    this._matrixNeedsUpdate = true;
  }

  get id() {
    return this._id;
  }

  /**
   * Beam angle
   *
   * @type {Number}
   */
  set angle(angle) {
    this._baseAngle = Math.min(angle / 2, BEAM_MAX_ANGLE);
    this.applyLensAngle();
  }

  get angle() {
    return this._angle || 10.0;
  }

  /**
   * Beam color
   *
   * @type {String}
   */
  set color(color) {
    this._color = color instanceof THREE.Color ? color : new THREE.Color(color);
    this._spotLight.color = this._color;
    color_buffer_attribute.setXYZ(this._id, this._color.r, this._color.g, this._color.b);
    color_buffer_attribute.needsUpdate = true;
    if (!this._wheelSplit) this.writeColorB();
    this.updateLensColor();
  }

  get color() {
    return this._color || new THREE.Color('white');
  }

  /**
   * Paints the lens with what the lamp is putting through it.
   *
   * Dark glass when the lamp is off, the beam's colour at full, and the mix in
   * between, so the lens reads as lit or unlit from any angle -- the beam
   * itself is invisible looked at end-on.
   *
   * @private
   */
  updateLensColor() {
    const lit = this.intensity;
    lensColor.copy(this.color).multiplyScalar(lit);
    lensColor.r += LENS_DARK * (1 - lit);
    lensColor.g += LENS_DARK * (1 - lit);
    lensColor.b += LENS_DARK * (1 - lit);
    capMesh.setColorAt(this._id, lensColor);
    capMesh.instanceColor.needsUpdate = true;
  }

  /**
   * Whether this light casts a shadow.
   *
   * Off by default and never granted automatically: shadow maps are a fixed,
   * small budget shared by the whole scene, and which few fixtures are worth
   * spending it on is a judgement about the rig, not one this can make.
   *
   * @type {Boolean}
   */
  set castsShadow(state) {
    this._castsShadow = !!state;
    if (this._spotLight) {
      this._spotLight.castShadow = this._castsShadow;
      // See `prepareInstance`: a three.js light only while it casts.
      this._spotLight.visible = this._castsShadow && !this._hidden;
    }
  }

  get castsShadow() {
    return !!this._castsShadow;
  }

  /**
   * Whether the light is hidden from the scene: not drawn and giving no light.
   *
   * Its slot in every instanced mesh is collapsed to nothing rather than
   * removed, so no other light is renumbered; its beam and lens are held dark
   * in `updateStrobe()`, which is what the surface light and the depth pass
   * read. Picking skips it by asking the fixture, not this.
   *
   * @type {Boolean}
   */
  set hidden(state) {
    this._hidden = !!state;
    if (this._spotLight) this._spotLight.visible = this._castsShadow && !this._hidden;
    // Written on the next frame's updateMatrix, either way.
    this._matrixNeedsUpdate = true;
  }

  get hidden() {
    return !!this._hidden;
  }

  /**
   * The dimmer, 0..1. Written through the shutter as it stands, so a closed
   * shutter stays dark however the dimmer moves.
   *
   * @type {Number}
   */
  set intensity(intensity) {
    this._intensity = Math.min(Math.abs(intensity), 1.0);
    this.writeLight();
  }

  get intensity() {
    return this._intensity * this._shutter || 0.0;
  }

  /**
   * Beam radius
   *
   * @type {Number}
   * @private
   */
  get radius() {
    const angle = Light.degToRad(this._angle);
    const height = BEAM_TOP_RADIUS / Math.tan(angle) + BEAM_LENGTH;
    const radius = Math.tan(angle) * height;
    return radius;
  }

  /**
   * Vertex scaling factor used for angle definition through vertex transformation
   *
   * @type {Number}
   * @todo check if it is used
   * @private
   */
  get vertexScaleFactor() {
    return this.radius / BEAM_TOP_RADIUS;
  }

  /**
   * Light position in 3D space
   *
   * @type {Object}
   */
  set position(positionVector) {
    this._position = positionVector;
    this._dummy.position.set(
      positionVector.x,
      positionVector.y,
      // The base bottom stays on the floor, whatever size the body is.
      Math.max(positionVector.z, this.baseDepth + 0.01),
    );
    this._matrixNeedsUpdate = true;
  }

  get position() {
    return this._position;
  }

  /**
   * Light rotation in 3D space
   *
   * @type {Object}
   */
  set rotation(rotationVector) {
    this._rotation = rotationVector;
    this._dummy.rotation.set(
      rotationVector.x,
      rotationVector.y,
      rotationVector.z,
    );
    this._matrixNeedsUpdate = true;
  }

  get rotation() {
    return this._rotation;
  }

  /**
   * Beam strobe frequency in Hz, from a ShutterStrobe or StrobeSpeed channel.
   *
   * @type {Number}
   */
  set strobeFrequency(frequency) {
    this._flashes.rate = Math.max(Number(frequency) || 0, 0);
  }

  get strobeFrequency() {
    return this._flashes.rate;
  }

  /**
   * The shutter effect a ShutterStrobe channel selects, in OFL's words: Open,
   * Closed, Strobe, Pulse, RampUp, RampDown, RampUpDown, Lightning, Spikes.
   *
   * Named for the capability alias so the channel dispatch reaches it.
   *
   * @type {String}
   */
  set strobeEffect(effect) {
    this._strobeEffect = effect || 'Open';
    this._flashes.mode = Shutter.modeFromEffect(this._strobeEffect, this._strobeRandom);
  }

  get strobeEffect() {
    return this._strobeEffect;
  }

  /**
   * How long each flash lasts, in milliseconds, from a StrobeDuration channel.
   *
   * @type {Number}
   */
  set strobeDuration(duration) {
    this._flashes.duration = Math.max(Number(duration) || 0, 0);
  }

  get strobeDuration() {
    return this._flashes.duration;
  }

  /**
   * OFL's random-timing flag on a strobe effect.
   *
   * @type {Boolean}
   */
  set strobeRandom(random) {
    this._strobeRandom = !!random;
    this._flashes.mode = Shutter.modeFromEffect(this._strobeEffect, this._strobeRandom);
  }

  get strobeRandom() {
    return this._strobeRandom;
  }

  /**
   * Beam instance highlighting state
   *
   * @type {Boolean}
   * @private
   */
  set highlighted(state) {
    this._highlighted = state;
    emissive_buffer_attribute.setX(this._id, this._highlighted ? 1.0 : 0.0);
    emissive_buffer_attribute.needsUpdate = true;
    if (this._bodySet) {
      this._bodySet.highlight.setX(this._bodySlot, this._highlighted ? 1.0 : 0.0);
      this._bodySet.highlight.needsUpdate = true;
    }
  }

  get highlighted() {
    return this._highlighted;
  }

  static highlight(instanceId) {
    const instance = Light.getInstance(instanceId);
    instance.highlighted = true;
  }

  static clearHighlighting() {
    instances.forEach((instance) => {
      instance.highlighted = false;
    });
  }

  set zoom(zoomValue) {
    this.setZoom(zoomValue, false);
  }

  /**
   * Takes on what another mode of the fixture states: for a GDTF fixture its
   * zoom range and output, which can differ by mode. The field goes back to
   * the widest, as a new light starts, until the mode's zoom channel says
   * otherwise.
   *
   * @public
   * @param {Object} inputs optionally `{ minAngle, maxAngle, lumens }`
   */
  setModeInputs(inputs) {
    this.resetOptics();
    if (inputs.minAngle > 0 && inputs.maxAngle > 0) {
      this._minAngle = inputs.minAngle;
      this._maxAngle = inputs.maxAngle;
    }
    if (inputs.lumens > 0) this._lumens = inputs.lumens;
    this.angle = this._maxAngle;
    this.writeLight();
  }

  /**
   * Puts everything in the light path back as a new head starts: wheels on
   * their first slot and still, no shake, prism, frost or colour preset,
   * iris open, the default edge, the shutter open and the lamp's own white.
   * What a channel set in one mode must not outlive the mode.
   *
   * @public
   */
  resetOptics() {
    this._wheels = Light.buildWheels(this._wheelData);
    this._colorWheel = this._colorWheelData;
    this._wheelColor = null;
    this._wheelColorB = null;
    this._wheelSplit = 0;
    this._activeColorPreset = false;
    this._emitters = {};
    this._prism = {
      on: false, facets: PRISM_DEFAULT_FACETS, linear: false, angle: 0, speedRpm: 0,
    };
    this._iris = 1;
    this._irisWheel = null;
    this._frostWheel = null;
    this._frostEffect = null;
    this.applyFrost(0);
    this._basePenumbra = SPOTLIGHT_PHYSICALLY_CORRECT_PENUMBRA;
    this.applyLensEdge();
    this.strobeEffect = 'Open';
    this.strobeRandom = false;
    this.strobeFrequency = 0;
    this.strobeDuration = 0;
    this.colorTemp = this._lampColorTemp;
    this.writeOptics();
  }

  /**
   * Sets the field from a zoom channel, within the lens the profile states.
   *
   * A profile gives zoom either in degrees or as a share of its range --
   * `narrow` to `wide` reads 1 to 100 -- and the share runs from the lens's
   * narrowest to its widest, not from nothing: a zoom at 0 is the narrowest
   * the fixture goes, not a beam of no width.
   *
   * @public
   * @param {Number} value degrees, or 0..100 of the range
   * @param {Boolean} inDegrees whether `value` is in degrees
   */
  setZoom(value, inDegrees) {
    const low = Math.min(this._minAngle, this._maxAngle);
    const high = Math.max(this._minAngle, this._maxAngle);
    const wanted = Number(value) || 0;
    const angle = inDegrees
      ? Math.min(Math.max(wanted, low), high)
      : low + (high - low) * (Math.min(Math.max(wanted, 0), 100) / 100);
    this._baseAngle = Math.min(angle / 2, BEAM_MAX_ANGLE);
    this.applyLensAngle();
  }

  /**
   * Writes the field's half angle, the zoom's widened by the frost, to the
   * spot light and the beam, and the gain that keeps its light constant.
   *
   * @private
   */
  applyLensAngle() {
    if (this._baseAngle === null) return;
    const half = Math.min(this._baseAngle * (1 + FROST_WIDEN * this._frost), BEAM_MAX_ANGLE);
    if (half === this._angle) return;
    this._angle = half;
    this._spotLight.angle = Light.degToRad(this._angle);
    angle_buffer_attribute.setX(this._id, this._angle);
    angle_buffer_attribute.needsUpdate = true;
  }

  /**
   * A beam's intensity on its axis, in candela: its lumens over the solid
   * angle its falloff covers.
   *
   * The beam is full out to the inner cone and falls to nothing at the
   * field as three draws it, `smoothstep(cos outer, cos inner, cos angle)`.
   * Over solid angle, `2 pi d(cos)`, that is full across `1 - cos inner`
   * and half on average across the smoothstep, so the light it carries is
   * the peak times `2 pi (1 - (cos inner + cos outer) / 2)` exactly. The
   * lens's lumens all go into it: zoom and frost change the field, focus
   * the edge, and each moves the peak so the total stays the same.
   *
   * @public
   * @param {Number} lumens light out of the lens
   * @param {Number} half the field's half angle, radians
   * @param {Number} penumbra the SpotLight's, folded past 1 as three does
   * @returns {Number} candela
   */
  static peakCandela(lumens, half, penumbra) {
    const outer = Math.min(Math.max(half, 1e-4), Light.degToRad(BEAM_MAX_ANGLE));
    const cosOuter = Math.cos(outer);
    const cosInner = Math.cos(outer * (1 - penumbra));
    const solidAngle = 2 * Math.PI * (1 - (cosInner + cosOuter) / 2);
    return lumens / Math.max(solidAngle, 1e-9);
  }

  /**
   * A light's peak at full for a zoom, with the edge it has when no focus
   * channel sets one.
   *
   * @public
   * @param {Number} lumens light out of the lens
   * @param {Number} angle the field, full angle in degrees
   * @returns {Number} candela
   */
  static peakAtZoom(lumens, angle) {
    const half = Light.degToRad(Math.min(angle / 2, BEAM_MAX_ANGLE));
    return Light.peakCandela(lumens, half, SPOTLIGHT_PHYSICALLY_CORRECT_PENUMBRA);
  }

  /**
   * This light's peak at full, in light-field units: what `lit` is at full.
   *
   * @public
   * @returns {Number}
   */
  peakUnits() {
    const candela = Light.peakCandela(
      this._lumens,
      this._spotLight.angle,
      this._spotLight.penumbra,
    );
    return candela / CANDELA_PER_UNIT / REFERENCE_INTENSITY;
  }

  /**
   * A light's output in lumens, from what its profile's physical block says.
   *
   * A stated figure is used when it is a believable efficacy for the stated
   * power; otherwise the power is turned into lumens at the library's median.
   *
   * @public
   * @param {Object} physical the profile's `physical` block
   * @returns {Number|null} lumens, or null when the profile gives neither
   */
  static lumensOf(physical = {}) {
    const stated = Number((physical.bulb || {}).lumens);
    const power = Number(physical.power);
    const [low, high] = PLAUSIBLE_LUMENS_PER_WATT;
    if (stated > 0 && !(power > 0)) return stated;
    if (stated > 0 && stated / power >= low && stated / power <= high) return stated;
    if (power > 0) return power * LUMENS_PER_WATT;
    return null;
  }

  /**
   * Writes the edge and the gobo blur, the focus's softened by the frost.
   * Full frost is a fully soft edge, and a gobo blurred past the atlas's
   * softest level and on into its mean, so the pattern is gone and only its
   * share of the light is left. The blur carries that as defocus past
   * `GOBO_DEFOCUS_MAX`, up to one more.
   *
   * @private
   */
  applyLensEdge() {
    const f = this._frost;
    const penumbra = this._basePenumbra + (PENUMBRA_DEFOCUSED - this._basePenumbra) * f;
    const defocus = Light.goboDefocusFor(this._basePenumbra);
    this._spotLight.penumbra = penumbra;
    this._goboDefocus = defocus + (GOBO_DEFOCUS_MAX + 1 - defocus) * f;
    Light.writeBeamProfile(this._id, penumbra);
    this.writeOptics();
  }

  /**
   * Puts frost in the beam: it widens the field, softens the edge and
   * diffuses the gobo away. Stops a frost effect.
   *
   * @public
   * @param {Number} amount 0 none to 1 full
   */
  setFrost(amount) {
    this._frostEffect = null;
    this.applyFrost(amount);
  }

  /**
   * @private
   * @param {Number} amount 0..1
   */
  applyFrost(amount) {
    const f = Number.isFinite(amount) ? Math.min(Math.max(amount, 0), 1) : 0;
    if (f === this._frost) return;
    this._frost = f;
    this.applyLensAngle();
    this.applyLensEdge();
  }

  /**
   * Runs the frost on its own, as a profile's frost effect names it: a ramp
   * up or a closing pulse rises and drops back, a ramp down or an opening
   * pulse falls, and a ramp both ways goes up and down. Random ones vary
   * the length of each cycle.
   *
   * @public
   * @param {String} name the effect's name and comment
   * @param {Number} [rate] cycles a second
   */
  setFrostEffect(name, rate) {
    const text = String(name || '').toLowerCase();
    let shape = 'triangle';
    if (/ramp up|closing/.test(text)) shape = 'up';
    else if (/ramp down|opening/.test(text)) shape = 'down';
    const hz = Number.isFinite(rate) && rate > 0 ? rate : 0.5;
    const effect = this._frostEffect;
    this._frostEffect = {
      shape,
      rate: hz,
      random: /random/.test(text),
      phase: effect ? effect.phase : 0,
      stretch: effect ? effect.stretch : 1,
    };
  }

  /**
   * Advances a running frost effect.
   *
   * @private
   * @param {Number} dt seconds
   */
  runFrost(dt) {
    const effect = this._frostEffect;
    if (!effect) return;
    effect.phase += (effect.rate / effect.stretch) * dt;
    if (effect.phase >= 1) {
      effect.phase %= 1;
      if (effect.random) effect.stretch = 0.5 + Math.random();
    }
    const p = effect.phase;
    let f = 1 - Math.abs(2 * p - 1);
    if (effect.shape === 'up') f = p;
    else if (effect.shape === 'down') f = 1 - p;
    this.applyFrost(f);
  }

  /**
   * Focus, 0 fully out to 100 fully in.
   *
   * One penumbra, written to two renderers: the SpotLight's, which softens
   * the pool of light this fixture throws on to surfaces, and the visible
   * shaft's in `beam.fragment.glsl`, whose falloff is the same curve so the
   * air and the pool end at the same place with the same edge.
   *
   * @type {Number}
   */
  set focus(focus) {
    // The whole channel sweeps the edge from fully soft to nearly hard, on
    // its own range rather than down from the no-channel default: tied to
    // that, lowering the default to cure overlapping pools shrank the sweep
    // to almost nothing.
    const dial = Math.min(Math.max(Number(focus) || 0, 0), 100) / 100;
    const penumbra = PENUMBRA_DEFOCUSED + (PENUMBRA_FOCUSED - PENUMBRA_DEFOCUSED) * dial;
    this._basePenumbra = penumbra;
    this._focus = focus;
    this.applyLensEdge();
  }

  get focus() {
    return this._focus;
  }

  /**
   * Puts a fixture's radial falloff into the instance buffer: the inner
   * cone, as a fraction of the field, inside which the beam is full.
   *
   * The same number three derives from the SpotLight's penumbra for the
   * pool, `angle * (1 - penumbra)` over `angle`. A penumbra past 1 folds
   * over rather than clamping to nothing, exactly as three's cosine does,
   * so the default 1.2 gives a full core out to a fifth of the radius.
   *
   * @public
   * @param {Number} id instance id
   * @param {Number} penumbra the SpotLight's, 0 a hard edge, 1 all falloff
   */
  static writeBeamProfile(id, penumbra) {
    const inner = Math.min(Math.abs(1 - penumbra), 0.99);
    angle_buffer_attribute.setZ(id, inner);
    angle_buffer_attribute.needsUpdate = true;
  }

  /**
   * Hands the beams the depth of everything solid in front of them.
   *
   * @public
   * @param {THREE.DepthTexture} texture the composer's scene depth
   * @param {THREE.Camera} camera for the near and far planes
   */
  static setSceneDepth(texture, camera) {
    if (!beamMesh || !beamMesh.material || !beamMesh.material.uniforms) return;
    const u = beamMesh.material.uniforms;
    u.sceneDepth.value = texture;
    u.cameraNear.value = camera.near;
    u.cameraFar.value = camera.far;
  }

  /**
   * Sorts a profile's wheels by what their slots hold.
   *
   * @private
   * @param {Object} wheels OFL wheels by name, each `{ slots: [...] }`
   * @returns {Object} by name: `{ kind, slots, slot, position, angle, speedRpm, wheelSpeedRpm }`
   */
  static buildWheels(wheels) {
    const built = {};
    Object.keys(wheels).forEach((name) => {
      const slots = (wheels[name] && wheels[name].slots) || [];
      let kind = 'other';
      if (slots.some((s) => s && s.type === SLOT_TYPES.GOBO)) kind = 'gobo';
      else if (slots.some((s) => s && s.type === 'Prism')) kind = 'prism';
      else if (slots.some((s) => s && s.type === SLOT_TYPES.COLOR)) kind = 'color';
      built[name] = {
        kind,
        slots,
        // Where the wheel is going, and where it is: slots, fractional
        // between two, and the same when it has arrived.
        slot: 0,
        position: 0,
        angle: 0,
        // A gobo shake in progress, or null: `{ rate, amplitude, onSlot,
        // phase, offset }`; see `setWheelShake`.
        shake: null,
        speedRpm: 0,
        wheelSpeedRpm: 0,
      };
    });
    return built;
  }

  /**
   * A profile's speed, -100..100 percent of "slow" to "fast", in turns a
   * minute for this fixture. Zero stays zero; the sign is the direction.
   *
   * @private
   * @param {Number} percent
   * @param {Object} range `{ min, max }` in rpm
   * @returns {Number} rpm, signed
   */
  static percentToRpm(percent, range) {
    const p = Math.min(Math.max(Number(percent) || 0, -100), 100);
    if (p === 0) return 0;
    return Math.sign(p) * (range.min + (Math.abs(p) / 100) * (range.max - range.min));
  }

  /**
   * Puts a wheel on one of its slots. The wheel's kind decides what that
   * means: a colour in front of the lamp, a gobo in the beam, a prism's
   * facets. A slot outside the wheel is ignored.
   *
   * @public
   * @param {String} wheelName as the profile names it
   * @param {Number} slotIndex 0-based
   */
  setWheelSlot(wheelName, slotIndex) {
    const wheel = this._wheels[wheelName];
    if (!wheel) {
      // A profile whose colour wheel channel names no wheel of its own.
      if (this._colorWheel && this._colorWheel.length) this.colorWheelSlot = slotIndex;
      return;
    }
    if (!(slotIndex >= 0) || slotIndex >= wheel.slots.length) return;
    // A colour wheel keeps the fraction, a split; gobos and prisms take the
    // slot the fraction starts from.
    wheel.slot = wheel.kind === 'color' ? slotIndex : Math.floor(slotIndex);
    // Choosing a slot stops a scroll or a shake left running by another range;
    // the wheel then travels to the slot, see `spinOptics`.
    wheel.wheelSpeedRpm = 0;
    wheel.shake = null;
    if (wheel.kind === 'color') this._colorWheel = wheel.slots;
    const irisSlot = wheel.slots[Math.floor(slotIndex)];
    if (irisSlot && irisSlot.type === 'Frost') {
      this._frostWheel = wheelName;
      this.setFrost(1);
    } else if (this._frostWheel === wheelName) {
      this._frostWheel = null;
      this.setFrost(0);
    }
    if (irisSlot && irisSlot.type === 'Iris') {
      const open = parseFloat(irisSlot.openPercent);
      this._iris = Number.isFinite(open) ? Math.min(Math.max(open / 100, 0), 1) : 1;
      this._irisWheel = wheelName;
    } else if (this._irisWheel === wheelName) {
      this._iris = 1;
      this._irisWheel = null;
    }
    if (wheel.kind === 'prism') {
      const slot = wheel.slots[slotIndex];
      if (slot && slot.type === 'Prism') {
        const described = prismFromText(slot.name);
        this._prism.on = true;
        this._prism.facets = Math.min(
          Math.max(2, Math.floor(Number(slot.facets) || described.facets || PRISM_DEFAULT_FACETS)),
          PRISM_MAX_FACETS,
        );
        this._prism.linear = described.linear;
      } else {
        this._prism.on = false;
      }
    }
    this.writeOptics();
  }

  /**
   * Shakes a wheel on one of its slots: the gobo swings quickly to and fro
   * about its place, the whole wheel rocking, or, where the profile says the
   * slot shakes, the gobo turning to and fro in its holder. Speed is the
   * fixture's slow to fast; the swing is the profile's angle where it gives
   * one.
   *
   * @public
   * @param {String} wheelName
   * @param {Object} values `{ slotNumber, shakeSpeed, shakeAngle, isShaking }`
   */
  setWheelShake(wheelName, values) {
    const wheel = this._wheels[wheelName];
    if (!wheel || !wheel.slots.length) return;
    const slot = Math.floor(values.slotNumber) - 1;
    if (!(slot >= 0) || slot >= wheel.slots.length) return;
    wheel.slot = slot;
    wheel.wheelSpeedRpm = 0;
    const percent = Number.isFinite(values.shakeSpeed) ? values.shakeSpeed : 50;
    const range = this._shakeSpeed;
    // GDTF states the rate in Hz; OFL as a share of the head's range.
    const rate = Number.isFinite(values.rate)
      ? Math.max(values.rate, 0)
      : range.min + (Math.min(Math.max(percent, 0), 100) / 100) * (range.max - range.min);
    const onSlot = values.isShaking === 'slot';
    const degrees = Number.isFinite(values.shakeAngle) && values.shakeAngle > 0
      ? values.shakeAngle : null;
    // Rocking the wheel, the swing is a share of a slot: the profile's angle
    // as a share of the wheel's turn, else a fifth of a slot. Turning in the
    // holder, the swing is an angle: the profile's, else 20 degrees.
    let amplitude = degrees ? (degrees / 360) * wheel.slots.length : 0.2;
    if (onSlot) amplitude = Light.degToRad(degrees || 20);
    const phase = wheel.shake ? wheel.shake.phase : 0;
    wheel.shake = {
      rate, amplitude, onSlot, phase, offset: 0,
    };
    this.writeOptics();
  }

  /**
   * Spins the gobo in a wheel's slot, or holds it at an angle.
   *
   * @public
   * @param {String} wheelName
   * @param {Object} values `{ speed }` in percent or `{ angle }` in degrees
   */
  setWheelSlotRotation(wheelName, values) {
    const wheel = this._wheels[wheelName];
    if (!wheel) return;
    if (Number.isFinite(values.angle)) {
      wheel.speedRpm = 0;
      wheel.angle = Light.degToRad(values.angle);
    } else if (Number.isFinite(values.rpm)) {
      wheel.speedRpm = values.rpm;
    } else if (Number.isFinite(values.speed)) {
      wheel.speedRpm = Light.percentToRpm(values.speed, this._goboSpeed);
    }
    this.writeOptics();
  }

  /**
   * Turns a whole wheel, its slots scrolling through the beam in turn.
   *
   * @public
   * @param {String} wheelName
   * @param {Object} values `{ speed }` in percent or `{ angle }` in degrees
   */
  setWheelRotation(wheelName, values) {
    const wheel = this._wheels[wheelName];
    if (!wheel) return;
    wheel.shake = null;
    if (Number.isFinite(values.angle)) {
      wheel.wheelSpeedRpm = 0;
      wheel.slot = ((values.angle / 360) * wheel.slots.length) % wheel.slots.length;
    } else if (Number.isFinite(values.rpm)) {
      wheel.wheelSpeedRpm = values.rpm;
    } else if (Number.isFinite(values.speed)) {
      wheel.wheelSpeedRpm = Light.percentToRpm(values.speed, this._goboSpeed);
    }
    this.writeOptics();
  }

  /**
   * The gobo blur the focus gives, in baked blur levels: the same penumbra that
   * softens the pool's edge, from `PENUMBRA_FOCUSED` to `PENUMBRA_DEFOCUSED`,
   * mapped onto 0 to `GOBO_DEFOCUS_MAX` levels. Focus and the image go
   * together on a real fixture; turning it sharpens the pattern.
   *
   * @private
   * @param {Number} penumbra
   * @returns {Number}
   */
  static goboDefocusFor(penumbra) {
    const t = Math.min(Math.max(
      (penumbra - PENUMBRA_FOCUSED) / (PENUMBRA_DEFOCUSED - PENUMBRA_FOCUSED),
      0,
    ), 1);
    return t * GOBO_DEFOCUS_MAX;
  }

  /**
   * How much wider than the field the cone is drawn: 1, or 1 plus the
   * prism's spread while a prism is in the beam. The vertex shader derives
   * the same number from the prism attribute.
   *
   * @type {Number}
   * @private
   */
  get drawnSpread() {
    return this._prism.on && this._prism.facets >= 2 ? 1 + this._prismSpread : 1;
  }

  /**
   * Opens or closes the iris, from an iris channel.
   *
   * @public
   * @param {Number} open 1 fully open to 0 closed
   */
  setIris(open) {
    if (!Number.isFinite(open)) return;
    this._iris = Math.min(Math.max(open, 0), 1);
    this._irisWheel = null;
    this.writeOptics();
  }

  /**
   * Puts a prism in the beam or takes it out.
   *
   * @public
   * @param {Boolean} on
   * @param {String} [text] how the profile describes it, for its facets and
   *   whether it is linear; a prism it does not describe has three, round
   */
  setPrism(on, text) {
    this._prism.on = !!on;
    if (on && text !== undefined) {
      const described = prismFromText(text);
      this._prism.facets = described.facets || PRISM_DEFAULT_FACETS;
      this._prism.linear = described.linear;
    }
    this.writeOptics();
  }

  /**
   * The prism as the shaders read it: its facet count, negative for a
   * linear prism, 0 with none in.
   *
   * @private
   * @returns {Number}
   */
  get prismCode() {
    if (!this._prism.on || this._prism.facets < 2) return 0;
    return this._prism.linear ? -this._prism.facets : this._prism.facets;
  }

  /**
   * Spins the prism, or holds it at an angle.
   *
   * @public
   * @param {Object} values `{ speed }` in percent or `{ angle }` in degrees
   */
  setPrismRotation(values) {
    if (Number.isFinite(values.angle)) {
      this._prism.speedRpm = 0;
      this._prism.angle = Light.degToRad(values.angle);
    } else if (Number.isFinite(values.rpm)) {
      this._prism.speedRpm = values.rpm;
    } else if (Number.isFinite(values.speed)) {
      this._prism.speedRpm = Light.percentToRpm(values.speed, this._prismSpeed);
    }
    this.writeOptics();
  }

  /**
   * Advances every spinning wheel and prism by a frame.
   *
   * @private
   * @param {Number} dt seconds
   */
  spinOptics(dt) {
    this.runFrost(dt);
    let moving = false;
    Object.keys(this._wheels).forEach((name) => {
      const wheel = this._wheels[name];
      const count = wheel.slots.length;
      if (wheel.speedRpm !== 0) {
        wheel.angle += (wheel.speedRpm / 60) * Math.PI * 2 * dt;
        moving = true;
      }
      if (!count) return;
      let travelled = false;
      if (wheel.shake) {
        // Swinging about the slot. Rocking the wheel moves its position,
        // which the slide draws; turning in the holder moves the gobo's
        // angle, which `goboPack` adds on.
        const { shake } = wheel;
        shake.phase = (shake.phase + shake.rate * Math.PI * 2 * dt) % (Math.PI * 2);
        shake.offset = shake.amplitude * Math.sin(shake.phase);
        wheel.position = shake.onSlot
          ? wheel.slot
          : (((wheel.slot + shake.offset) % count) + count) % count;
        travelled = true;
      } else if (wheel.wheelSpeedRpm !== 0) {
        // Scrolling: the whole wheel turns, the target going with it.
        wheel.position += (wheel.wheelSpeedRpm / 60) * count * dt;
        wheel.position = ((wheel.position % count) + count) % count;
        wheel.slot = wheel.position;
        travelled = true;
      } else if (wheel.position !== wheel.slot) {
        // Travelling to a chosen slot, the shorter way round.
        let d = wheel.slot - wheel.position;
        d = (((d % count) + count * 1.5) % count) - count / 2;
        const step = WHEEL_SLOTS_PER_SECOND * dt;
        if (Math.abs(d) <= step) wheel.position = wheel.slot;
        else wheel.position = (((wheel.position + Math.sign(d) * step) % count) + count) % count;
        travelled = true;
      }
      if (travelled) {
        moving = true;
        if (wheel.kind === 'color') {
          this._colorWheel = wheel.slots;
          this.colorWheelSlot = wheel.position;
        }
      }
    });
    if (this._prism.on && this._prism.speedRpm !== 0) {
      this._prism.angle += (this._prism.speedRpm / 60) * Math.PI * 2 * dt;
      moving = true;
    }
    if (moving) this.writeOptics();
  }

  /**
   * The pattern a gobo wheel's slot shows: an OFL image for a gobo slot, 0,
   * open, for anything else.
   *
   * @private
   * @param {Object} wheel
   * @param {Number} index slot index
   * @returns {Number}
   */
  static goboPatternAt(wheel, index) {
    const slot = wheel.slots[index];
    if (!slot || slot.type !== SLOT_TYPES.GOBO) return 0;
    // A fixture that carries its own picture of the gobo draws that one.
    if (slot.image) return goboImageCell(slot.image.key, slot.image.url);
    const goboIndex = wheel.slots.slice(0, index)
      .filter((s) => s && s.type === SLOT_TYPES.GOBO).length;
    return goboLayerFor(slot, goboIndex);
  }

  /**
   * The gobos in the beam, packed as the shaders read them: `[pattern,
   * angle, pattern, angle]`.
   *
   * At rest, the first gobo wheel's pattern and a second wheel's, pattern 0
   * being open. A wheel between two slots, travelling or scrolling, packs
   * the fraction of the way it has gone into the first pattern number, which
   * is otherwise whole, and the next slot's pattern into the second place: the
   * shader then slides the one out and the other in. A second gobo wheel
   * gives way while the first is between slots.
   *
   * @private
   * @returns {Array}
   */
  goboPack() {
    const wheels = Object.keys(this._wheels)
      .map((name) => this._wheels[name])
      .filter((wheel) => wheel.kind === 'gobo' && wheel.slots.length);
    const pack = [0, 0, 0, 0];
    wheels.forEach((wheel, n) => {
      if (n > 1) return;
      const count = wheel.slots.length;
      const whole = Math.floor(wheel.position);
      const frac = wheel.position - whole;
      const index = ((whole % count) + count) % count;
      const angle = wheel.angle
        + (wheel.shake && wheel.shake.onSlot ? wheel.shake.offset : 0);
      if (n === 0 && frac > 0.001 && frac < 0.999) {
        pack[0] = Light.goboPatternAt(wheel, index) + frac;
        pack[1] = angle;
        pack[2] = Light.goboPatternAt(wheel, (index + 1) % count);
        pack[3] = angle;
        return;
      }
      if (n === 1 && pack[0] % 1 !== 0) return;
      const at = frac >= 0.999 ? (index + 1) % count : index;
      pack[n * 2] = Light.goboPatternAt(wheel, at);
      pack[n * 2 + 1] = angle;
    });
    return pack;
  }

  /**
   * Writes the beam's gobos and prism into the instance buffers, and the
   * same into the light record on the next read.
   *
   * @private
   */
  writeOptics() {
    gobo_attribute.setXYZW(this._id, ...this.goboPack());
    gobo_attribute.needsUpdate = true;
    const facets = this.prismCode;
    const defocus = this._goboDefocus;
    prism_attribute.setXYZW(this._id, facets, this._prism.angle, this._prismSpread, defocus);
    prism_attribute.needsUpdate = true;
    depth_slot_attribute.setY(this._id, this._iris);
    depth_slot_attribute.needsUpdate = true;
  }

  /**
   * Color wheel slot value
   *
   * @type {Number}
   */
  set colorWheelSlot(slotId) {
    // A position on the wheel, fractional between slots: 2.5 is the boundary
    // between slots 3 and 4 (0-based 2 and 3) across the middle of the beam.
    // Wraps, so a turning wheel passes from the last slot back to the first.
    const count = this._colorWheel ? this._colorWheel.length : 0;
    if (!count || !Number.isFinite(slotId) || slotId < 0) return;
    const position = ((slotId % count) + count) % count;
    const first = Math.floor(position);
    const split = position - first;
    const colourOf = gelColour;
    const slotA = this._colorWheel[first];
    if (slotA && slotA.type !== SLOT_TYPES.COLOR && slotA.type !== SLOT_TYPES.OPEN) return;
    this._wheelColor = colourOf(slotA);
    // A split this close to a slot is that slot; the line would sit on the
    // beam's edge where nothing shows it.
    if (split > 0.02 && split < 0.98) {
      this._wheelColorB = colourOf(this._colorWheel[(first + 1) % count]);
      this._wheelSplit = split;
    } else {
      if (split >= 0.98) this._wheelColor = colourOf(this._colorWheel[(first + 1) % count]);
      this._wheelColorB = null;
      this._wheelSplit = 0;
    }
    // Through the mix rather than straight onto the beam: a light with a wheel
    // *and* CMY has both in the light path, and writing the beam here would
    // let whichever channel wrote last win.
    this.recomputeBeamColor();
  }

  /**
   * Color preset slot value
   *
   * @type {Number}
   */
  set colorPreset(value) {
    if (value) {
      this._activeColorPreset = true;
      this.color = value;
    } else {
      this._activeColorPreset = false;
      // Hand the beam back to the emitter mix. Without this the preset's colour
      // lingers until some other channel happens to write.
      this.recomputeBeamColor();
    }
  }

  /**
   * Bulb/Beam color temperature in Kelvin
   * props to:  http://www.tannerhelland.com/4435/convert-temperature-rgb-algorithm-code/
   *
   * @type {Number}
   */
  set colorTemp(colorTemp = DEFAULT_COLOR_TEMP) {
    this._colorTemp = colorTemp;
    this.recomputeBeamColor();
  }

  get colorTemp() {
    return this._colorTemp || DEFAULT_COLOR_TEMP;
  }

  /**
   * Colour temperature control, in Kelvin, as driven by a CTC channel.
   *
   * Named for the capability alias so the channel dispatch reaches it. Setting
   * it moves the white point; it does not overwrite the colour mix.
   *
   * @type {Number}
   */
  set colorTemperature(kelvin) {
    if (!kelvin) return;
    this.colorTemp = kelvin;
  }

  get colorTemperature() {
    return this.colorTemp;
  }

  /**
   * The fixture's white point as linear RGB, normalised so its largest
   * component is 1 -- the hue of the white, with brightness left to the
   * emitters and the dimmer.
   *
   * @readonly
   * @type {Array}
   */
  get whitePoint() {
    const rgb = kelvinToRgb(this.colorTemp);
    const peak = Math.max(rgb[0], rgb[1], rgb[2]) || 1;
    return [rgb[0] / peak, rgb[1] / peak, rgb[2] / peak];
  }

  /**
   * Derives the beam colour from every emitter currently lit.
   *
   * Additive emitters sum, each carrying its own tint and white taking the
   * fixture's white point; subtractive ones then remove from what is left. The
   * result is normalised only when it clips, so a single emitter at half stays
   * half-lit rather than being pushed to full.
   *
   * @public
   */
  recomputeBeamColor() {
    if (this._activeColorPreset) return;
    const a = this.mixThrough(this._wheelColor);
    const b = this._wheelSplit > 0 ? this.mixThrough(this._wheelColorB) : a;
    this.color = a;
    this._colorB.copy(b);
    this.writeColorB();
  }

  /**
   * Writes the far side of a colour split into the instance buffer.
   *
   * @private
   */
  writeColorB() {
    const b = this._wheelSplit > 0 ? this._colorB : this.color;
    color_b_attribute.setXYZW(this._id, b.r, b.g, b.b, this._wheelSplit);
    color_b_attribute.needsUpdate = true;
  }

  /**
   * The beam's colour with a given filter from the colour wheel in the light
   * path, or none: the head's own emitters, or its lamp through the wheel,
   * less whatever the CMY filters take.
   *
   * @private
   * @param {THREE.Color|null} wheelColor
   * @returns {THREE.Color}
   */
  mixThrough(wheelColor) {
    const white = this.whitePoint;
    const mix = [0, 0, 0];

    // What the head *makes*: the sum of its own emitters.
    let additive = false;
    Object.keys(this._emitters).forEach((name) => {
      if (SUBTRACTIVE_EMITTERS[name] !== undefined) return;
      const level = this._emitters[name];
      if (!level) return;
      const tint = WHITE_EMITTERS.includes(name) ? white : EMITTER_TINTS[name];
      if (!tint) return;
      additive = true;
      mix[0] += tint[0] * level;
      mix[1] += tint[1] * level;
      mix[2] += tint[2] * level;
    });

    // A light with no emitters of its own does not make colour, it *removes* it:
    // one lamp, a colour wheel and a set of CMY filters in the light path. So
    // the mix starts as what the lamp is actually putting out -- the wheel's
    // slot if one is in, the fixture's own white otherwise -- and the filters
    // below take from it.
    //
    // Starting from black would take a light like the Ayrton Diablo-S dark the
    // moment its Cyan channel is written: it has no additive emitter to sum,
    // so the mix stays [0,0,0] and the subtractive step multiplies zero by
    // zero. It would also discard the colour wheel, written earlier in the
    // same frame by a lower channel number.
    if (!additive) {
      const [r, g, b] = wheelColor
        ? [wheelColor.r, wheelColor.g, wheelColor.b]
        : white;
      mix[0] = r;
      mix[1] = g;
      mix[2] = b;
    }

    Object.keys(SUBTRACTIVE_EMITTERS).forEach((name) => {
      const level = this._emitters[name];
      if (!level) return;
      mix[SUBTRACTIVE_EMITTERS[name]] *= 1.0 - level;
    });

    // Summed emitters past full are scaled back. A measured filter is not: a
    // deep blue passing its share of the light may need more than full blue.
    const peak = Math.max(mix[0], mix[1], mix[2]);
    const scale = additive && peak > 1 ? 1 / peak : 1;
    // Never fully black: a zero-length colour vector leaves the beam shader
    // with nothing to work with, which is why the original clamped too.
    return new THREE.Color(
      Math.max(mix[0] * scale, 0.00001),
      Math.max(mix[1] * scale, 0.00001),
      Math.max(mix[2] * scale, 0.00001),
    );
  }

  /**
   * Single color-chanel intensity value (RGBCMY...)
   *
   * @type {Object}
   */
  set colorIntensity(channelData) {
    if (this._activeColorPreset || !channelData || !channelData.color) return;
    // Whole name, not its initial: 'Cold White' and 'Cyan' both start with a c.
    const name = channelData.color.toLowerCase().replace(/[^a-z]/g, '');
    if (!EMITTER_TINTS[name]
      && !WHITE_EMITTERS.includes(name)
      && SUBTRACTIVE_EMITTERS[name] === undefined) return;
    this._emitters[name] = channelData.colorBrightness;
    this.recomputeBeamColor();
  }

  /**
   * Hilight a single light within the pool
   *
   * @param {Boolean} state highlighting state
   * @memberof Light
   */
  setSinglyHighlighted(state) {
    instances.forEach((instance) => {
      instance.highlighted = false;
    });
    this.highlighted = state;
  }

  /**
   * Prepares a new light
   *
   * @private
   */
  prepareInstance() {
    this._dummy = new THREE.Object3D();
    // The body's frame in the fixture's: identity for the shipped body; a
    // GDTF body stands it up from its file in `mountBody`.
    this._bodyRoot = new THREE.Object3D();
    this._beamDummy = new THREE.Object3D();
    this._targetDummy = new THREE.Object3D();
    this._boundingBoxDummy = new THREE.Object3D();

    this._spotLight = new THREE.SpotLight(
      this.colorTemp,
      SPOTLIGHT_PHYSICALLY_CORRECT_INTENSITY,
      SPOTLIGHT_PHYSICALLY_CORRECT_DISTANCE,
      Light.degToRad(this.angle),
      SPOTLIGHT_PHYSICALLY_CORRECT_PENUMBRA,
      SPOTLIGHT_PHYSICALLY_CORRECT_DECAY,
    );

    // The light sits ahead of the head (see the translation below), so the
    // fixture's own body stays behind the shadow frustum and cannot black out
    // its own beam. Shadow camera fov tracks the cone angle automatically.
    //
    // Off unless asked for. Each shadow-casting light costs one fragment
    // texture image unit and a GPU offers few of them -- 16 is common -- so if
    // every light claimed one, two dozen movers would exhaust the pool, the
    // standard material's program would fail to validate, and everything drawn
    // with it -- the floor included -- would stop rendering.
    this._spotLight.castShadow = !!this._castsShadow;
    // Kept as an object, hidden as a light. Every parameter a light writes --
    // colour, angle, penumbra, intensity -- still lands here, and the scene
    // graph still carries it around with the beam so its world transform is
    // maintained. What `visible = false` removes is three's *collection* of
    // it: `projectObject` returns early, so it never reaches the uniform
    // array that cannot hold two hundred of them. Its contribution arrives
    // through `LightField` instead.
    //
    // A shadow caster is the exception, because three's shadow machinery is
    // driven from the light itself and there is no reason to reimplement it
    // for the eight that are allowed one.
    this._spotLight.visible = !!this._castsShadow;
    this._spotLight.shadow.mapSize.width = SPOTLIGHT_SHADOW_MAP_SIZE;
    this._spotLight.shadow.mapSize.height = SPOTLIGHT_SHADOW_MAP_SIZE;
    this._spotLight.shadow.camera.near = SPOTLIGHT_SHADOW_NEAR;
    this._spotLight.shadow.camera.far = SPOTLIGHT_SHADOW_FAR;
    // Depth offsets: bias kills surface acne on the floor, normalBias closes
    // the gap it opens at grazing angles.
    this._spotLight.shadow.bias = SPOTLIGHT_SHADOW_BIAS;
    this._spotLight.shadow.normalBias = SPOTLIGHT_SHADOW_NORMAL_BIAS;

    this._spotLight.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
    this._spotLight.applyMatrix4(new THREE.Matrix4().makeTranslation(0, 0, 0.9));

    this._dummy.add(this._bodyRoot);
    this.buildJoints().add(this._beamDummy);
    this._beamDummy.attach(this._targetDummy);
    this._beamDummy.attach(this._spotLight);

    this._spotLight.target = this._targetDummy;
    if (this._body) this.mountBody();

    // On the root, so the yoke pivot, the head, the lens and the selection box
    // all shrink or grow together. The beam is taken back out: see
    // `rigidBeamMatrix`. Set only now: `attach` above keeps each child's world
    // transform, and would have cancelled a scale already on the root.
    this._dummy.scale.setScalar(this._bodyScale);

    baseMesh.count = instanceCount;
    yokeMesh.count = instanceCount;
    headMesh.count = instanceCount;
    beamMesh.count = instanceCount;
    capMesh.count = instanceCount;
    boundingBoxMesh.count = instanceCount;

    scene_handle.add(this._dummy);
    instances.push(this);
    LightField.register(this);
    // What was last uploaded for this light: body, yoke, head, beam, lens.
    // NaN so the first comparison always fails and the first frame uploads.
    this._writtenMatrices = Array.from({ length: 5 }, () => {
      const unwritten = new THREE.Matrix4();
      unwritten.elements.fill(NaN);
      return unwritten;
    });
    this._matrixNeedsUpdate = true;
  }

  /**
   * The joints between the body and the lens, built under `_bodyRoot`; the
   * beam hangs from what this returns. A light has none: its lens is fixed
   * to its body.
   *
   * @protected
   * @returns {THREE.Object3D}
   */
  buildJoints() {
    return this._bodyRoot;
  }

  /**
   * Sets the joints from a GDTF body, and answers where the body pivots: the
   * point that goes to the fixture's origin. A light has no joints and
   * pivots at the file's origin, the centre of its base plate.
   *
   * @protected
   * @param {Object} body from `gdtf_body.js`
   * @returns {THREE.Matrix4} the pivot's frame in the file's
   */
  mountJoints(body) { // eslint-disable-line class-methods-use-this, no-unused-vars
    return new THREE.Matrix4();
  }

  /**
   * The body's parts at rest, each with its frame in the body's: what the
   * pick box and the floor depth are measured from. A light's body is its
   * base.
   *
   * @protected
   * @param {Object} body from `gdtf_body.js`
   * @returns {Array} `[geometry, matrix]` pairs
   */
  restingParts(body) { // eslint-disable-line class-methods-use-this
    return [[body.base, new THREE.Matrix4()]];
  }

  /**
   * The parts as they are posed now, each with the node that poses it: a
   * light's base, and none of the parts a moving head turns.
   *
   * @protected
   * @returns {Object} `{ base, yoke, head }` nodes, null for a part it has not
   */
  posedParts() {
    return { base: this._bodyRoot, yoke: null, head: null };
  }

  /**
   * Hangs a GDTF body on the rig: each part where its file puts it, the beam
   * leaving its lens, and the slot its type's meshes draw it in.
   *
   * The file's frame is the fixture hanging from the centre of its base
   * plate. Stood upright, its pivot goes to the fixture's origin, so the
   * beam leaves upwards at rest. The beam runs along the lens's -Z, the way
   * the file hangs its light.
   *
   * @private
   */
  mountBody() {
    const body = this._body;
    const tilt = this.mountJoints(body);
    const pivot = new THREE.Vector3().setFromMatrixPosition(tilt).applyMatrix4(UPRIGHT);
    const root = new THREE.Matrix4()
      .makeTranslation(-pivot.x, -pivot.y, -pivot.z)
      .multiply(UPRIGHT);
    setLocal(this._bodyRoot, root);
    setLocal(this._beamDummy, body.lensFrame.clone()
      .multiply(UPRIGHT)
      .multiply(new THREE.Matrix4().makeTranslation(0, 0, -BEAM_START)));
    // The lens as wide as the file's, the cap and the beam scaled to it.
    if (body.lensRadius > 0) this._lensScale = body.lensRadius / BEAM_TOP_RADIUS;
    this._targetDummy.scale.set(this._lensScale, this._lensScale, 1);

    // The body at rest, in the fixture's frame: how far it reaches below the
    // origin, and the pick box fitted round it.
    const bounds = new THREE.Box3();
    this.restingParts(body).forEach(([geometry, matrix]) => {
      if (!geometry) return;
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      bounds.union(geometry.boundingBox.clone().applyMatrix4(root.clone().multiply(matrix)));
    });
    this._baseDepth = Math.max(-bounds.min.z, 0);
    const size = bounds.getSize(new THREE.Vector3()).divide(PICK_BOX_SIZE);
    const centre = bounds.getCenter(new THREE.Vector3());
    const back = PICK_BOX_CENTRE.clone().negate();
    const toCentre = new THREE.Matrix4().makeTranslation(back.x, back.y, back.z);
    this._pickMatrix = new THREE.Matrix4().makeTranslation(centre.x, centre.y, centre.z)
      .multiply(new THREE.Matrix4().makeScale(size.x, size.y, size.z))
      .multiply(toCentre);

    this._bodySet = bodySetFor(body);
    this._bodySlot = claimBodySlot(this._bodySet);
  }

  /**
   * How far the body reaches below the fixture's origin, in metres.
   *
   * @readonly
   * @type {Number}
   */
  get baseDepth() {
    return this._baseDepth !== null ? this._baseDepth : modelBaseDepth * this._bodyScale;
  }

  /**
   * Writes one matrix into a slot of every GDTF body part, or collapses them.
   *
   * @private
   */
  writeBodySlot(base, yoke, head) {
    const set = this._bodySet;
    const parts = { base, yoke, head };
    Object.keys(set.meshes).forEach((part) => {
      set.meshes[part].setMatrixAt(this._bodySlot, parts[part]);
      set.meshes[part].instanceMatrix.needsUpdate = true;
    });
  }

  /**
   * Updates the light's matrices
   *
   * @private
   */
  updateMatrix() {
    if (this._hidden) {
      if (this._collapsed) return;
      [baseMesh, yokeMesh, headMesh, beamMesh, capMesh, boundingBoxMesh].forEach((mesh) => {
        mesh.setMatrixAt(this._id, COLLAPSED);
        mesh.instanceMatrix.needsUpdate = true;
      });
      if (this._bodySet) this.writeBodySlot(COLLAPSED, COLLAPSED, COLLAPSED);
      // So showing it again finds every matrix changed and uploads them all.
      this._writtenMatrices.forEach((written) => written.copy(COLLAPSED));
      this._collapsed = true;
      return;
    }
    this._collapsed = false;
    if (this._matrixNeedsUpdate) {
      this._dummy.updateMatrixWorld();
      const posed = this.posedParts();
      const yoke = posed.yoke ? posed.yoke.matrixWorld : COLLAPSED;
      const head = posed.head ? posed.head.matrixWorld : COLLAPSED;
      this._beamDummy.updateMatrixWorld();
      this._targetDummy.updateMatrixWorld();
      this.rigidBeamMatrix();
      // The flag stays set, because a light dragged in a group moves through
      // its parent and nothing else tells it so. Uploading only on a real
      // change keeps the instance buffers' versions still while the rig is
      // still; the depth tiles hash those versions, so an upload every frame
      // would owe every tile a redraw every frame.
      const written = this._writtenMatrices;
      if (written[0].equals(this._bodyRoot.matrixWorld)
        && written[1].equals(yoke)
        && written[2].equals(head)
        && written[3].equals(rigidMatrix)
        && written[4].equals(this._targetDummy.matrixWorld)) return;
      written[0].copy(this._bodyRoot.matrixWorld);
      written[1].copy(yoke);
      written[2].copy(head);
      written[3].copy(rigidMatrix);
      written[4].copy(this._targetDummy.matrixWorld);
      if (this._bodySet) {
        // Drawn by its type's meshes; its slot in the shipped body's is empty.
        baseMesh.setMatrixAt(this._id, COLLAPSED);
        yokeMesh.setMatrixAt(this._id, COLLAPSED);
        headMesh.setMatrixAt(this._id, COLLAPSED);
        this.writeBodySlot(this._bodyRoot.matrixWorld, yoke, head);
        boundingBoxMesh.setMatrixAt(
          this._id,
          pickScratch.multiplyMatrices(this._dummy.matrixWorld, this._pickMatrix),
        );
      } else {
        baseMesh.setMatrixAt(this._id, this._bodyRoot.matrixWorld);
        yokeMesh.setMatrixAt(this._id, yoke);
        headMesh.setMatrixAt(this._id, head);
        boundingBoxMesh.setMatrixAt(this._id, this._dummy.matrixWorld);
      }
      beamMesh.setMatrixAt(this._id, rigidMatrix);
      // The lens is part of the body, so it takes the scaled frame.
      capMesh.setMatrixAt(this._id, this._targetDummy.matrixWorld);
      baseMesh.instanceMatrix.needsUpdate = true;
      yokeMesh.instanceMatrix.needsUpdate = true;
      headMesh.instanceMatrix.needsUpdate = true;
      beamMesh.instanceMatrix.needsUpdate = true;
      capMesh.instanceMatrix.needsUpdate = true;
      boundingBoxMesh.instanceMatrix.needsUpdate = true;
    }
  }

  /**
   * How far the beam's origin sits ahead of the head pivot's, along the axis,
   * beyond where the shipped model puts it. The beam geometry carries the
   * model's own lens offset; this is the rest of the way to the scaled lens.
   *
   * @type {Number}
   * @private
   */
  get beamOriginShift() {
    return LENS_FACE_OFFSET * (this._bodyScale - 1);
  }

  /**
   * The beam's frame, left in `rigidMatrix`.
   *
   * The beam hangs under the scaled head, but a beam is optics, not bodywork:
   * its length and spread come from the profile's angle, and the head's scale
   * on its axis would shorten it and change its angle. So it takes the head's
   * position and orientation, moved along the axis to where the scaled head's
   * face now is, and the body's scale across the axis only: the beam leaves a
   * lens that scaled with the body, and starts as wide as that lens. The
   * vertex shader reads that radial scale back out of the instance matrix to
   * keep the far end at the profile's angle.
   *
   * @private
   */
  rigidBeamMatrix() {
    this._beamDummy.matrixWorld.decompose(rigidPosition, rigidQuaternion, rigidScale);
    beamAxis.set(0, 0, 1).applyQuaternion(rigidQuaternion);
    rigidPosition.addScaledVector(beamAxis, this.beamOriginShift);
    beamScale.set(this._lensScale, this._lensScale, 1);
    rigidMatrix.compose(rigidPosition, rigidQuaternion, beamScale);
  }

  /**
   * Aims the depth tile's camera down the beam.
   *
   * The same origin and orientation the instance matrix gives the cone,
   * without the body's scale, times the fixed basis; its frustum is the
   * beam's field plus a margin. Matrices are set by hand and the automatic
   * pass is off, as the laser's are, because three would otherwise rebuild
   * them from an untouched position.
   *
   * @private
   */
  updateDepthCamera() {
    this.rigidBeamMatrix();
    const cam = this._depthCam;
    cam.matrixWorld.compose(rigidPosition, rigidQuaternion, depthScale).multiply(depthBasis);
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    // Wide enough for the whole drawn cone, which a prism widens by its
    // spread: a sample outside the tile counts as lit, so a tile narrower
    // than the cone would let the prism's copies through every wall.
    const tanHalf = Math.tan(Light.degToRad(this._angle))
      * DEPTH_FOV_MARGIN * this.drawnSpread;
    cam.fov = 2 * Math.atan(tanHalf) * (180 / Math.PI);
    cam.aspect = 1;
    cam.near = MOVER_DEPTH.near;
    cam.far = MOVER_DEPTH.far;
    cam.updateProjectionMatrix();
  }

  /**
   * Draws each lit beam's view of the scene into its tile, within the frame's
   * budget, and tells the beams which tiles are theirs.
   *
   * Dark beams submit nothing: a tile no one can see is not worth a pass.
   * Priority is how much the beam matters on screen -- its intensity, how
   * near it is, and how far it has turned since its tile was drawn -- so a
   * chase spends the budget on the beams the eye is on.
   *
   * @public
   * @param {Object} renderer THREE.WebGLRenderer
   * @param {Object} scene
   */
  static renderDepth(renderer, scene) {
    if (!beamMesh || !beamMesh.material || !beamMesh.material.uniforms) return;
    const u = beamMesh.material.uniforms;
    if (!occlusionEnabled) {
      instances.forEach((instance) => depth_slot_attribute.setX(instance._id, -1));
      depth_slot_attribute.needsUpdate = true;
      return;
    }
    scene.updateMatrixWorld();
    const projections = [];
    instances.forEach((instance) => {
      const id = instance._id;
      if (id >= MOVER_DEPTH.maxProjections || instance.intensity <= 0 || instance._hidden) return;
      instance.updateDepthCamera();
      instance._beamDummy.getWorldDirection(vector_beam);
      const turned = 1 - Math.max(vector_beam.dot(instance._depthDir), 0);
      const distance = Math.max(vector_cam_pos.distanceTo(rigidPosition), 1);
      projections[id] = {
        camera: instance._depthCam,
        priority: (instance.intensity / distance) * (1 + 4 * turned),
      };
    });
    const drawn = MOVER_DEPTH.render(renderer, scene, projections, DEPTH_TILE_BUDGET);
    drawn.forEach((slot) => {
      const instance = instances[slot];
      if (instance) instance._beamDummy.getWorldDirection(instance._depthDir);
    });
    instances.forEach((instance) => {
      const id = instance._id;
      const has = projections[id] !== undefined && MOVER_DEPTH.hasTile(id);
      depth_slot_attribute.setX(id, has ? id : -1);
    });
    depth_slot_attribute.needsUpdate = true;
    u.depthAtlas.value = MOVER_DEPTH.texture();
    u.depthColumns.value = MOVER_DEPTH.columns;
    u.depthRows.value = MOVER_DEPTH.rows;
    u.depthFar.value = MOVER_DEPTH.far;
    u.depthBias.value = DEPTH_BIAS;
    // The surfaces read the same tiles, so the pool stops where the beam does.
    LightField.uniforms.lightFieldDepth.value = MOVER_DEPTH.texture();
    LightField.uniforms.lightFieldDepthFar.value = MOVER_DEPTH.far;
    LightField.uniforms.lightFieldDepthBias.value = DEPTH_BIAS;
    LightField.uniforms.lightFieldDepthTile.value = MOVER_DEPTH.tile;
    LightField.uniforms.lightFieldGobo.value = goboTexture();
  }

  /**
   * Draws one shader term as greyscale instead of the beam. A diagnostic
   * for the debug panel, never stored; see `debugTerm` in the shader.
   *
   * @public
   * @param {Number} term 0 for the beam
   */
  static setDebugTerm(term) {
    if (!beamMesh || !beamMesh.material || !beamMesh.material.uniforms) return;
    beamMesh.material.uniforms.debugTerm.value = Math.max(0, Math.floor(Number(term) || 0));
  }

  /** @public @param {Boolean} on whether beams stop at surfaces */
  static setOcclusion(on) {
    occlusionEnabled = !!on;
  }

  /** @public @returns {Boolean} */
  static occlusion() {
    return occlusionEnabled;
  }

  updateDirectionVector() {
    this._beamDummy.getWorldDirection(vector_beam.normalize());
    direction_buffer_attribute.setXYZ(this._id, vector_beam.x, vector_beam.y, vector_beam.z);
    direction_buffer_attribute.needsUpdate = true;
    // The same origin the instance matrix puts the geometry at: the fragment
    // shader measures its cone from here, and the drawn cone must agree.
    this._beamDummy.getWorldPosition(vector_beam_pos);
    vector_beam_pos.addScaledVector(vector_beam, this.beamOriginShift);
    position_buffer_attribute.setXYZ(
      this._id,
      vector_beam_pos.x,
      vector_beam_pos.y,
      vector_beam_pos.z,
    );
    position_buffer_attribute.needsUpdate = true;
  }

  /**
   * Advances the shutter one frame and writes what it let through.
   *
   * The frame is an interval, not an instant: a 25 Hz strobe sampled at the
   * frame time beats against 60 fps, where counting the flashes that fell
   * inside the frame does not. See `shutter.js`.
   *
   * @param {Number} t seconds
   */
  updateStrobe(t) {
    this._shutter = this._flashes.sample(t);
    this.writeLight();
  }

  /**
   * Writes the light out: dimmer times shutter times the peak, nothing when
   * hidden. The one place it is written, so the dimmer and the shutter
   * cannot disagree about it.
   *
   * @private
   */
  writeLight() {
    // The pool, the shadow-casting light and the beam in the air all carry
    // the same peak, so they agree. See `peakCandela`.
    // The dimmer alone, not the `intensity` getter, which has the shutter in
    // it already: counted twice, a flash covering half a frame came out a
    // quarter as bright rather than half.
    const lit = this._hidden ? 0
      : this._intensity * this._shutter * this.peakUnits();
    this._spotLight.intensity = SPOTLIGHT_PHYSICALLY_CORRECT_INTENSITY * lit;
    intensity_buffer_attribute.setX(this._id, lit);
    intensity_buffer_attribute.needsUpdate = true;
    this.updateLensColor();
  }

  /**
   * Grows a box to contain this light.
   *
   * A nominal cube rather than measured geometry: every light is drawn from the
   * same low-poly model, and the selection box only has to read as "this one".
   *
   * @public
   * @param {Object} box THREE.Box3 to expand, in world space
   */
  /**
   * Grows a box to contain the fixture's actual body.
   *
   * `expandBounds` reports a nominal cube, which is the right thing for a
   * selection outline -- it is stable whichever way the head is pointing. It
   * is the wrong thing for asking how low a fixture reaches, which is a
   * question about the model. Each part's geometry box is transformed by the
   * node that poses it, so the answer follows pan and tilt.
   *
   * The box of a rotated box is bigger than the shape inside it, so this errs
   * outward: a structure placed from it may sit a centimetre high, never
   * buried.
   *
   * @public
   * @param {Object} box THREE.Box3 to expand
   */
  expandGeometryBounds(box) {
    this._dummy.updateMatrixWorld();
    const body = this._body;
    const posed = this.posedParts();
    [[body ? body.base : baseGeo, posed.base],
      [body ? body.yoke : yokeGeo, posed.yoke],
      [body ? body.head : headGeo, posed.head]]
      .forEach(([geometry, node]) => {
        if (!node) return;
        if (!geometry) return;
        if (!geometry.boundingBox) geometry.computeBoundingBox();
        if (!geometry.boundingBox) return;
        partBounds.copy(geometry.boundingBox).applyMatrix4(node.matrixWorld);
        box.union(partBounds);
      });
  }

  expandBounds(box) {
    const halfExtent = SELECTION_HALF_EXTENT * this._bodyScale;
    boundsCorner.set(
      this._position.x - halfExtent,
      this._position.y - halfExtent,
      this._position.z - halfExtent,
    );
    box.expandByPoint(boundsCorner);
    boundsCorner.set(
      this._position.x + halfExtent,
      this._position.y + halfExtent,
      this._position.z + halfExtent,
    );
    box.expandByPoint(boundsCorner);
  }

  /**
   * How far the body reaches below the fixture's origin. A light is positioned
   * by its base, so nothing does.
   *
   * @readonly
   * @type {Number}
   */
  get floorOffset() {
    return 0;
  }

  /**
   * Moves on by one frame: the strobe, the matrices and the beam's direction.
   *
   * @public
   * @param {Number} t seconds since the animation clock started
   */
  update(t) {
    this.updateStrobe(t);
    this.updateMatrix();
    this.updateDirectionVector();
  }

  static degToRad(degAngle) {
    return degAngle * (Math.PI / 180);
  }

  /**
   * How much to scale the shipped body so it stands `height` metres tall.
   *
   * A profile without a usable height keeps the model's own size.
   *
   * @param {Number} height fixture height in metres, from the profile
   * @returns {Number}
   */
  static bodyScaleFor(height) {
    if (!(height > 0) || !(modelHeight > 0)) return 1;
    return THREE.MathUtils.clamp(height / modelHeight, BODY_SCALE_MIN, BODY_SCALE_MAX);
  }

  static prepareModelInstance() {
    const model = ModelInstancer.models.visualizer.models.scenography.beam.scene.children[0];
    const base = model.children[0];
    const yoke = model.children[2];
    const head = model.children[1];

    base.geometry.rotateX(Math.PI / 2);
    yoke.geometry.rotateX(Math.PI / 2);
    head.geometry.rotateX(Math.PI / 2);

    base.geometry.translate(0, 0, -0.5);
    yoke.geometry.translate(0, 0, -0.40);

    // Measured after the parts are posed, so the numbers describe the model as
    // it stands.
    partBounds.makeEmpty();
    [base, yoke, head].forEach((part) => {
      part.geometry.computeBoundingBox();
      partBounds.union(part.geometry.boundingBox);
    });
    modelHeight = partBounds.max.z - partBounds.min.z;
    modelBaseDepth = -partBounds.min.z;

    THREE.BufferGeometry.prototype.copy.call(baseGeo, base.geometry);
    THREE.BufferGeometry.prototype.copy.call(yokeGeo, yoke.geometry);
    THREE.BufferGeometry.prototype.copy.call(headGeo, head.geometry);

    baseGeo.setAttribute('highlight', emissive_buffer_attribute);
    yokeGeo.setAttribute('highlight', emissive_buffer_attribute);
    headGeo.setAttribute('highlight', emissive_buffer_attribute);

    baseMesh = new THREE.InstancedMesh(baseGeo, MODEL_MATERIAL, capacity);
    yokeMesh = new THREE.InstancedMesh(yokeGeo, MODEL_MATERIAL, capacity);
    headMesh = new THREE.InstancedMesh(headGeo, MODEL_MATERIAL, capacity);

    baseMesh.frustumCulled = false;
    yokeMesh.frustumCulled = false;
    headMesh.frustumCulled = false;

    // Fixture bodies block light and take shadow from each other. The beam
    // (custom shader) and the emissive lens cap are deliberately left out.
    baseMesh.castShadow = true;
    yokeMesh.castShadow = true;
    headMesh.castShadow = true;
    baseMesh.receiveShadow = true;
    yokeMesh.receiveShadow = true;
    headMesh.receiveShadow = true;
    // And stain the floor under them -- see `contact_shadows.js`.
    [baseMesh, yokeMesh, headMesh].forEach(castsContactShadow);

    baseMesh.count = instanceCount;
    yokeMesh.count = instanceCount;
    headMesh.count = instanceCount;

    baseMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    yokeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    headMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    baseMesh.instanceMatrix.needsUpdate = true;
    yokeMesh.instanceMatrix.needsUpdate = true;
    headMesh.instanceMatrix.needsUpdate = true;
  }

  static prepareBeamInstance() {
    const beamGeometry = new THREE.CylinderGeometry(
      BEAM_TOP_RADIUS,
      BEAM_TOP_RADIUS,
      BEAM_LENGTH,
      BEAM_RESOLUTION,
      BEAM_SEGMENTS,
      // Closed. A convex solid drawn back-face only is crossed by every view
      // ray exactly once, from anywhere -- the open tube left rays entering
      // through its ends with no fragment at all, and rays through both
      // walls with two.
      false,
    );

    beamGeometry.applyMatrix4(new THREE.Matrix4().makeTranslation(
      0,
      -beamGeometry.parameters.height / 2,
      0,
    ));
    beamGeometry.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
    beamGeometry.applyMatrix4(new THREE.Matrix4().setPosition(0, 0, BEAM_START));

    THREE.BufferGeometry.prototype.copy.call(beamGeo, beamGeometry);

    const verticesIndexBuffer = [];
    for (let i = 0; i < beamGeo.attributes.position.count; i++) {
      verticesIndexBuffer[i] = i;
    }
    const indexAttributes = new THREE.BufferAttribute(
      new Float32Array(verticesIndexBuffer),
      1,
    ).setUsage(THREE.StaticDrawUsage);

    beamGeo.setAttribute('index', indexAttributes);
    beamGeo.setAttribute('wpos', position_buffer_attribute);
    beamGeo.setAttribute('direction', direction_buffer_attribute);
    beamGeo.setAttribute('color', color_buffer_attribute);
    beamGeo.setAttribute('intensity', intensity_buffer_attribute);
    beamGeo.setAttribute('angle', angle_buffer_attribute);
    beamGeo.setAttribute('depthSlot', depth_slot_attribute);
    beamGeo.setAttribute('gobo', gobo_attribute);
    beamGeo.setAttribute('prism', prism_attribute);
    beamGeo.setAttribute('colorB', color_b_attribute);

    beamMesh = new THREE.InstancedMesh(beamGeo, new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      clipping: true,
      // One fragment per ray. `beamProfile` works out the whole path a view
      // ray takes through the cone from the ray and the axis alone, so the
      // fragment only has to exist once, and a closed convex solid drawn
      // back-face only guarantees exactly that from every camera position,
      // inside the beam included. No depth test, or the exit face under the
      // floor would take its ray with it: the shader clips the ray's lit
      // stretch against the scene depth itself, which is what ends a beam at
      // a surface without the wall drawing a line into it.
      depthTest: false,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      vertexShader: VOLUMETRIC_BEAM_VERTEX_SHADER,
      fragmentShader: BEAM_FRAGMENT_SHADER,
      fog: false,
      toneMapped: false,
      // Three's own banding remedy, and the beam is its textbook case: large
      // smooth gradients are where quantisation contours form and where the
      // eye's lateral inhibition (Mach banding) then draws lines that are not
      // in the data.
      dithering: true,
      uniforms: {
        cameraDir: {
          type: 'v3',
          value: vector_cam,
        },
        cameraPos: {
          type: 'v3',
          value: vector_cam_pos,
        },
        vertexCount: {
          type: 'f',
          value: beamGeo.attributes.position.count,
        },
        topRadius: {
          type: 'f',
          value: BEAM_TOP_RADIUS,
        },
        length: {
          type: 'f',
          value: BEAM_LENGTH,
        },
        time: {
          type: 'f',
          value: 0.0,
        },
        // Born at the room's current values, not at 1.0, so a beam is never
        // drawn through haze the room does not have. `syncEnvironment` keeps
        // them level from here on.
        fogState: {
          type: 'b',
          value: SceneEnv.hazeEnabled,
        },
        fogFactor: {
          type: 'f',
          value: SceneEnv.hazeAmount,
        },
        fogScale: {
          type: 'f',
          value: SceneEnv.hazeScale,
        },
        fogTurbulence: {
          type: 'f',
          value: SceneEnv.hazeDriftRate,
        },
        // Candela in light-field units into scene luminance per unit of
        // scattering coefficient: the light field's own scale, so the air
        // and a surface it lights are on the same exposure.
        beamUnits: { value: SPOTLIGHT_PHYSICALLY_CORRECT_INTENSITY },
        hazeScatter: { value: HAZE_SCATTER_AT_FULL },
        // Which shader term the debug panel is drawing instead of the beam.
        debugTerm: { value: 0 },
        glowFactor: {
          type: 'f',
          value: 1.0,
        },
        // The opaque scene's depth, blitted by the EffectComposer for the
        // ambient haze and borrowed here -- see where `stableDepthTexture` is
        // handed over in `visualizer.js`. It softens the line the cone would
        // otherwise draw across whatever it passes through. Where the beam
        // *ends* is a different question, answered at z = 0 in the shader.
        sceneDepth: {
          value: null,
        },
        // Every gobo pattern, one texture array layer each.
        goboAtlas: { value: goboTexture() },
        // What each beam's own lens sees, from `renderDepth`.
        depthAtlas: { value: null },
        depthColumns: { value: MOVER_DEPTH.columns },
        depthRows: { value: MOVER_DEPTH.rows },
        depthFar: { value: MOVER_DEPTH.far },
        depthBias: { value: DEPTH_BIAS },
        cameraNear: {
          type: 'f',
          value: 0.01,
        },
        cameraFar: {
          type: 'f',
          value: 1000.0,
        },
        // The shared haze field: the volume itself, and the cycling amount
        // when the scene is built with it. Empty in mode 0.
        ...hazeUniforms(),
      },
    }), capacity);

    beamMesh.count = instanceCount;
    beamMesh.frustumCulled = false;
    beamMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    beamMesh.instanceMatrix.needsUpdate = true;
  }

  static prepareCapInstance() {
    const capGeometry = new THREE.CircleGeometry(BEAM_TOP_RADIUS, 40);
    const capMaterial = new THREE.MeshBasicMaterial({
      // No depth, or the beam fades against the very disc it comes out of --
      // the surface fade reads the scene's depth, and this sits exactly at the
      // beam's origin. It is a lens face, not an obstacle.
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    capGeometry.applyMatrix4(new THREE.Matrix4().makeTranslation(0, 0, LENS_FACE_OFFSET));

    THREE.BufferGeometry.prototype.copy.call(targetGeo, capGeometry);

    capMesh = new THREE.InstancedMesh(targetGeo, capMaterial, capacity);
    capMesh.frustumCulled = false;
    capMesh.count = instanceCount;
    capMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    capMesh.instanceMatrix.needsUpdate = true;
    // Per-instance colour, so each lens shows its own lamp. Allocated up front
    // rather than on the first write, so the material compiles with it once.
    capMesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(capacity * 3).fill(LENS_DARK),
      3,
    );
    capMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  }

  static prepareBoxHelperInstance() {
    const boundingBoxGeometry = new THREE.BoxGeometry(0.5, 0.5, 0.8);
    const boundingBoxMaterial = new THREE.MeshBasicMaterial({
      color: 'rgb(255, 0, 0)',
      opacity: 0.0,
      transparent: true,
    });

    boundingBoxGeometry.applyMatrix4(new THREE.Matrix4().makeTranslation(0, 0, -0.15));

    THREE.BufferGeometry.prototype.copy.call(boundingBoxGeo, boundingBoxGeometry);

    boundingBoxMesh = new THREE.InstancedMesh(boundingBoxGeo, boundingBoxMaterial, capacity);
    boundingBoxMesh.frustumCulled = false;
    boundingBoxMesh.count = instanceCount;
    boundingBoxMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    boundingBoxMesh.instanceMatrix.needsUpdate = true;
    boundingBoxMesh.visible = false;
  }

  static prepareInstanciation(camera, scene) {
    camera_handle = camera;
    scene_handle = scene;
    Light.prepareModelInstance();
    Light.prepareBeamInstance();
    Light.prepareCapInstance();
    Light.prepareBoxHelperInstance();

    // The bodies are lit surfaces like any other, so they read the field too.
    // They are nearly black, so they gain little from it -- but a light standing
    // in another head's beam should not be the one thing in the room that the
    // beam misses.
    LightField.receive(MODEL_MATERIAL);

    scene.add(baseMesh, yokeMesh, headMesh, beamMesh, capMesh, boundingBoxMesh);
  }

  /**
   * Fills in what this light contributes to the light field.
   *
   * Read off the `SpotLight` rather than tracked separately, so there is one
   * account of a light's colour and cone rather than two that can disagree --
   * the light object is written by every setter, it simply is not collected
   * by three.
   *
   * Direction is `position - target`, pointing back up the beam, because that
   * is the convention `getSpotLightInfo` uses and the field's shader does the
   * same arithmetic.
   *
   * @public
   * @param {Object} record scratch to fill; see `light_field.js`
   * @returns {Boolean} whether this light is lighting anything at all
   */
  readLight(record) {
    // Nothing to add, and cheap to say so: a closed shutter or a dark lamp is
    // most of a rig at any moment, and each one skipped is a light every
    // fragment does not test.
    if (!this._spotLight || this._spotLight.intensity <= 0) return false;
    // A shadow caster is already a real light in three's own pass; adding it
    // here as well would light everything twice.
    if (this._spotLight.visible) return false;

    this._spotLight.getWorldPosition(record.position);
    this._targetDummy.getWorldPosition(vector_light_target);
    record.direction.copy(record.position).sub(vector_light_target).normalize();
    record.color.copy(this._spotLight.color);
    record.colorB.copy(this._wheelSplit > 0 ? this._colorB : this._spotLight.color);
    record.split = this._wheelSplit || 0;
    record.intensity = this._spotLight.intensity;
    record.range = SPOTLIGHT_RANGE;
    // A prism throws copies of the pool out past the cone, so the cone test
    // that bounds the light's reach widens with it; the pool's own shape
    // comes from the field fraction once the light has a tile.
    const prismOn = this._prism.on && this._prism.facets >= 2;
    const outer = prismOn
      ? Math.atan(Math.tan(this._spotLight.angle) * (1 + this._prismSpread))
      : this._spotLight.angle;
    record.cosOuter = Math.cos(outer);
    // The same penumbra three derives, so the soft edge matches.
    record.cosInner = Math.cos(this._spotLight.angle * (1 - this._spotLight.penumbra));
    record.inner = Math.min(Math.abs(1 - this._spotLight.penumbra), 0.99);

    // The gobos and the prism in the beam, the same numbers the beam draws.
    record.gobo.set(...this.goboPack());
    record.prism.set(
      prismOn ? this.prismCode : 0,
      this._prism.angle,
      this._prismSpread,
      this._goboDefocus,
    );
    record.iris = this._iris;

    // The beam's depth tile, so the pool stops where the beam does. The slot
    // is last frame's, written by `renderDepth` after the field is read,
    // which is one frame of lag on a tile that changes rarely. The tile's
    // frame is the beam's rigid frame, the same one the tile camera and the
    // beam shader use.
    const slot = depth_slot_attribute.getX(this._id);
    record.hasTile = occlusionEnabled && slot >= 0;
    if (record.hasTile) {
      const column = slot % MOVER_DEPTH.columns;
      const row = Math.floor(slot / MOVER_DEPTH.columns);
      record.tile.set(
        column / MOVER_DEPTH.columns,
        row / MOVER_DEPTH.rows,
        1 / MOVER_DEPTH.columns,
        1 / MOVER_DEPTH.rows,
      );
      this.rigidBeamMatrix();
      record.tileOrigin.copy(rigidPosition);
      record.axisX.set(1, 0, 0).applyQuaternion(rigidQuaternion);
      record.axisY.set(0, 1, 0).applyQuaternion(rigidQuaternion);
      record.tanHalf = Math.tan(Light.degToRad(this._angle))
        * DEPTH_FOV_MARGIN * this.drawnSpread;
    }
    return true;
  }

  static update(t) {
    // Seconds since the last frame, for the wheels and prisms that spin.
    // Clamped so a stalled tab does not whip every gobo round on resume.
    const dt = lastUpdateTime === null ? 0 : Math.min(Math.max(t - lastUpdateTime, 0), 0.1);
    lastUpdateTime = t;
    instances.forEach((instance) => {
      instance.update(t);
      instance.spinOptics(dt);
    });
    beamMesh.material.uniforms.time.value = t;
    camera_handle.getWorldDirection(vector_cam.normalize());
    beamMesh.material.uniforms.cameraDir.value = vector_cam;
    camera_handle.getWorldPosition(vector_cam_pos.normalize());
    beamMesh.material.uniforms.cameraPos.value = vector_cam_pos;
  }

  /**
   * Makes room for `needed` lights, growing the instanced buffers if it must.
   *
   * Called before an id is handed out, which is the only moment the count can
   * outrun the buffers. Doubling rather than growing by one: a reallocation
   * copies six matrix buffers and six per-instance attributes, so it should
   * happen a handful of times over a rig's life, not once per fixture.
   *
   * @public
   * @param {Number} needed how many instances must fit
   * @returns {Boolean} whether there is room
   */
  static ensureCapacity(needed) {
    if (needed <= capacity) return true;
    if (needed > ABSOLUTE_MAX_INSTANCES) {
      // Refused rather than allowed to corrupt the draw. Every light shares
      // these buffers, so writing past the end loses all of them, not the
      // extra one -- silently.
      // eslint-disable-next-line no-console
      console.error(`[light] refusing to place light ${needed}: the limit is `
        + `${ABSOLUTE_MAX_INSTANCES}. Nothing has been added.`);
      return false;
    }
    while (capacity < needed) capacity *= 2;

    position_buffer_attribute = grownAttribute(position_buffer_attribute);
    direction_buffer_attribute = grownAttribute(direction_buffer_attribute);
    intensity_buffer_attribute = grownAttribute(intensity_buffer_attribute);
    color_buffer_attribute = grownAttribute(color_buffer_attribute);
    emissive_buffer_attribute = grownAttribute(emissive_buffer_attribute);
    angle_buffer_attribute = grownAttribute(angle_buffer_attribute);
    depth_slot_attribute = grownAttribute(depth_slot_attribute);
    depth_slot_attribute.array.set(slotIrisArray(capacity - instanceCount), instanceCount * 2);
    gobo_attribute = grownAttribute(gobo_attribute);
    prism_attribute = grownAttribute(prism_attribute);
    color_b_attribute = grownAttribute(color_b_attribute);

    // Re-attached because `setAttribute` stores the attribute, not a reference
    // to whatever the variable holds now.
    baseGeo.setAttribute('highlight', emissive_buffer_attribute);
    yokeGeo.setAttribute('highlight', emissive_buffer_attribute);
    headGeo.setAttribute('highlight', emissive_buffer_attribute);
    beamGeo.setAttribute('wpos', position_buffer_attribute);
    beamGeo.setAttribute('direction', direction_buffer_attribute);
    beamGeo.setAttribute('color', color_buffer_attribute);
    beamGeo.setAttribute('intensity', intensity_buffer_attribute);
    beamGeo.setAttribute('angle', angle_buffer_attribute);
    beamGeo.setAttribute('depthSlot', depth_slot_attribute);
    beamGeo.setAttribute('gobo', gobo_attribute);
    beamGeo.setAttribute('prism', prism_attribute);
    beamGeo.setAttribute('colorB', color_b_attribute);

    baseMesh = grownMesh(baseMesh);
    yokeMesh = grownMesh(yokeMesh);
    headMesh = grownMesh(headMesh);
    beamMesh = grownMesh(beamMesh);
    capMesh = grownMesh(capMesh);
    boundingBoxMesh = grownMesh(boundingBoxMesh);
    return true;
  }

  static deleteInstance(instance) {
    // Its slot in its type's body meshes is emptied and given to the next.
    if (instance._bodySet) {
      instance.writeBodySlot(COLLAPSED, COLLAPSED, COLLAPSED);
      instance._bodySet.free.push(instance._bodySlot);
      instance._bodySet = null;
    }
    scene_handle.remove(instance._beamDummy);
    scene_handle.remove(instance._spotLight);
    scene_handle.remove(instance._dummy);

    LightField.unregister(instance);
    instances.splice(instance.id, 1);
    for (let i = instance.id; i < instanceCount - 1; i++) {
      instances[i].id--;
    }
    instance = null;
    instanceCount--;

    baseMesh.count = instanceCount;
    yokeMesh.count = instanceCount;
    headMesh.count = instanceCount;
    beamMesh.count = instanceCount;
    capMesh.count = instanceCount;
    boundingBoxMesh.count = instanceCount;
  }

  static getBA() {
    return position_buffer_attribute;
  }

  static get instancedMesh() {
    boundingBoxMesh.computeBoundingSphere();
    return boundingBoxMesh;
  }

  /**
   * Objects a raycast should test.
   *
   * The same question `LedBar` and `SceneObjects` answer, asked the same way,
   * so the caller need not know lights are instanced and bars are not.
   *
   * @static
   * @returns {Array} pick proxies
   */
  static pickObjects() {
    return [this.instancedMesh].filter(Boolean);
  }

  /**
   * Visits every light with its world position, for rectangle selection.
   *
   * Where the instance loop belongs: reading matrices out of a shared
   * `InstancedMesh` is how *this* renderer stores positions, and no caller
   * should have to know that -- so adding a renderer needs no change to
   * selection code.
   *
   * @static
   * @param {Function} visit called with (fixtureHandle, worldPosition)
   */
  static eachSelectable(visit) {
    const mesh = this.instancedMesh;
    if (!mesh) return;
    for (let i = 0; i < mesh.count; i += 1) {
      mesh.getMatrixAt(i, selectionMatrix);
      selectionOrigin.setFromMatrixPosition(selectionMatrix);
      const instance = instances[i];
      if (instance && instance.fixtureHandle) visit(instance.fixtureHandle, selectionOrigin);
    }
  }

  static getInstance(id) {
    return instances[id];
  }
}

/**
 * Copies the room's haze onto the beam material.
 *
 * The beams pull rather than being pushed, as `LedField` and `LedPanel` do:
 * the beam mesh does not exist until the scene is built, and a value pushed
 * before then would be lost.
 *
 * Silent before there is a mesh: the uniforms are born from `SceneEnv` when it
 * is built, so there is nothing to catch up on.
 */
function syncEnvironment() {
  if (!beamMesh || !beamMesh.material || !beamMesh.material.uniforms) return;
  const { uniforms } = beamMesh.material;
  uniforms.fogState.value = SceneEnv.hazeEnabled;
  uniforms.fogFactor.value = SceneEnv.hazeAmount;
  uniforms.fogScale.value = SceneEnv.hazeScale;
  uniforms.fogTurbulence.value = SceneEnv.hazeDriftRate;
}

SceneEnv.on('changed', syncEnvironment);

export default Light;
