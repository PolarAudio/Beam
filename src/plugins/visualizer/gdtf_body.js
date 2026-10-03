import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { TDSLoader } from 'three/examples/jsm/loaders/TDSLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { modelFiles } from '../../models/DMX/gdtf/gdtf_reader';
import primitiveShape from './gdtf_primitives';

/**
 * @file A light's body from its GDTF file: the meshes the file carries, cut
 * into the three parts a moving head moves -- what stays still, what pans,
 * what tilts -- and the frames that join them. A static light is all base,
 * with its lens wherever its first beam is.
 *
 * The file draws the fixture hanging, Z up, from the centre of the base
 * plate. Each geometry's Position places it relative to its parent, each mesh
 * is drawn around its own suspension point, and each is scaled to its
 * Model's Length (X), Width (Y) and Height (Z) whatever units it was drawn
 * in. A `.glb` is Y-up, as glTF is, and is turned onto Z first; a `.3ds` is
 * Z-up already.
 *
 * A moving head with no mesh at all is no body: the head draws the shipped
 * one, scaled to the height the file gives, as it does for a profile. There
 * is no shipped static light, so a static light's geometries are drawn as
 * their primitives, as is any geometry without a mesh in a file that has
 * some. A light-emitting geometry's own model is left out, because the head
 * draws its lens itself.
 */

/** glTF's Y-up onto GDTF's Z-up: +90 degrees about X. */
const Y_UP_TO_Z_UP = new THREE.Matrix4().makeRotationX(Math.PI / 2);

/** Geometries that give light; their models are lenses the head draws itself. */
const EMITTERS = new Set(['Beam', 'Laser', 'Display']);

/** A typed-array view's bytes as an ArrayBuffer of their own. */
const bufferOf = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

/** A GDTF Position, row-major, as a Matrix4; identity when absent. */
function matrixOf(position) {
  const m = new THREE.Matrix4();
  if (position && position.length === 16) m.set(...position);
  return m;
}

/**
 * One geometry for an object's meshes, with only positions and normals, so
 * any two can be merged.
 */
function flatten(object) {
  object.updateMatrixWorld(true);
  const parts = [];
  object.traverse((node) => {
    if (!node.isMesh || !node.geometry || !node.geometry.attributes.position) return;
    let g = node.geometry.index ? node.geometry.toNonIndexed() : node.geometry.clone();
    const kept = new THREE.BufferGeometry();
    kept.setAttribute('position', g.attributes.position);
    if (g.attributes.normal) kept.setAttribute('normal', g.attributes.normal);
    g = kept;
    g.applyMatrix4(node.matrixWorld);
    if (!g.attributes.normal) g.computeVertexNormals();
    parts.push(g);
  });
  return parts.length ? mergeGeometries(parts) : null;
}

/** A Model with no mesh file, as its primitive at unit size. */
function primitiveOf(model) {
  if (!(model.length > 0 && model.width > 0 && model.height > 0)) return null;
  return primitiveShape(model.primitiveType);
}

/**
 * A model's mesh, oriented Z-up and scaled to the Model's size about its own
 * origin, as `{ geometry, fromFile }`: `fromFile` false for a primitive drawn
 * in its place. Null when there is nothing to draw.
 */
async function meshOf(model, files) {
  const found = modelFiles(files, model);
  let geometry = null;
  let fromFile = false;
  try {
    if (found.gltf) {
      const gltf = await new GLTFLoader().parseAsync(bufferOf(files[found.gltf]), '');
      geometry = flatten(gltf.scene);
      if (geometry) geometry.applyMatrix4(Y_UP_TO_Z_UP);
    } else if (found['3ds']) {
      geometry = flatten(new TDSLoader().parse(bufferOf(files[found['3ds']]), ''));
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[gdtf body] cannot read the mesh of ${model.name}: ${err.message}`);
    geometry = null;
  }
  if (geometry) fromFile = true;
  else geometry = primitiveOf(model);
  if (!geometry) return null;
  geometry.computeBoundingBox();
  const size = new THREE.Vector3();
  geometry.boundingBox.getSize(size);
  const scale = (target, raw) => (target > 0 && raw > 1e-9 ? target / raw : 1);
  geometry.scale(
    scale(model.length, size.x),
    scale(model.width, size.y),
    scale(model.height, size.z),
  );
  return { geometry, fromFile };
}

/** The geometry names a mode's pan and tilt channels move. */
function axesOf(type) {
  const axes = { pan: null, tilt: null };
  type.modes.forEach((mode) => mode.channels.forEach((c) => c.logicalChannels.forEach((l) => {
    if (l.attribute === 'Pan' && !axes.pan) axes.pan = c.geometry;
    if (l.attribute === 'Tilt' && !axes.tilt) axes.tilt = c.geometry;
  })));
  return axes;
}

/**
 * A moving head's body from its fixture type.
 *
 * @param {Object} type a GDTF fixture type
 * @param {Object} files the archive's files, from `readGdtf`
 * Every beam in the part that carries the light is a lens: all of a static
 * light's, the head's for a moving head. A geometry reference places an
 * instance of the geometry it names at its own position, its Model, if it
 * has one, standing for the referenced geometry's -- which is how a file
 * repeats one pixel or one lens across a fixture.
 *
 * @param {Object} type a GDTF fixture type
 * @param {Object} files the archive's files, from `readGdtf`
 * @returns {Promise<Object|null>} `{ base, yoke, head, yokeFrame, headFrame,
 *   lensFrame, lensRadius, lenses }`: three geometries, each in its own part's
 *   frame (null when the part has nothing to draw), the yoke's frame in the
 *   base's, the head's in the yoke's and the first lens's in the head's, all
 *   in the file's hanging frame; `lenses` every lens, first first, as
 *   `{ frame, radius, face, beam, path }`, `frame` in the head's frame, `face`
 *   `{ rect, halfX, halfY, radius, out }` the lens's shape and how
 *   far its face stands out along the beam, and `path`
 *   the names of every geometry from the root to it; for a static light,
 *   `lensSets`, the lenses of each top-level geometry by its name, since a
 *   file may describe the fixture once per set of modes and a mode names the
 *   one it uses; null for a moving head whose file has no mesh of its own
 */
export default async function buildBody(type, files) {
  const root = type.geometries[0];
  if (!root) return null;
  const axes = axesOf(type);
  // A light that neither pans nor tilts: its lens is wherever its first beam is.
  const still = !axes.pan && !axes.tilt;
  const placed = { base: [], yoke: [], head: [] };
  const worldOf = { pan: null, tilt: null };
  const found = [];

  // Where every model and lens sits and which part it moves with, walking
  // the tree once; the meshes are read after, each model once. A referenced
  // geometry is visited at the reference's place, `at`, with its model.
  const visit = (g, parentWorld, part, path, at = null, modelName = null, referenced = false) => {
    const world = at ? at.clone() : parentWorld.clone().multiply(matrixOf(g.position));
    const here = [...path, g.name];
    let moves = part;
    if (g.name === axes.pan) { moves = 'yoke'; worldOf.pan = world.clone(); }
    if (g.name === axes.tilt) { moves = 'head'; worldOf.tilt = world.clone(); }
    const name = modelName || g.model;
    const model = name ? type.index.model.get(name) : null;
    if (g.beam && (moves === 'head' || still)) {
      found.push({
        world: world.clone(), beam: g.beam, model, path: here, referenced,
      });
    }
    if (model && !EMITTERS.has(g.type)) placed[moves].push({ model, world });
    if (g.type === 'GeometryReference') {
      const template = type.index.geometry.get(g.geometry);
      if (template) visit(template, world, moves, here, world, g.model, true);
    }
    g.children.forEach((kid) => visit(kid, world, moves, here, null, null, referenced));
  };
  visit(root, new THREE.Matrix4(), 'base', []);

  const models = [...new Set(Object.values(placed).flat().map((p) => p.model))];
  const loaded = await Promise.all(models.map((model) => meshOf(model, files)));
  // Primitives alone are not a moving head's shape; the shipped body is closer.
  if (!still && !loaded.some((m) => m && m.fromFile)) return null;
  const meshes = new Map(models.map((model, i) => [model, loaded[i] && loaded[i].geometry]));
  const pieces = {};
  Object.keys(placed).forEach((part) => {
    pieces[part] = placed[part]
      .filter((p) => meshes.get(p.model))
      .map((p) => ({ mesh: meshes.get(p.model), world: p.world }));
  });
  // A static light with nothing to draw still has its lens and beam.
  if (!still && !pieces.base.length && !pieces.yoke.length && !pieces.head.length) return null;

  const identity = new THREE.Matrix4();
  const panWorld = worldOf.pan || identity;
  const tiltWorld = worldOf.tilt || panWorld;
  // The lens the light's own beam leaves: a static light's first; a moving
  // head's first that is not a referenced instance, the one it has always
  // drawn its single beam from.
  const main = still ? found[0] : found.find((lens) => !lens.referenced);
  const lensWorld = main ? main.world : tiltWorld;
  const frameOf = { base: identity, yoke: panWorld, head: tiltWorld };
  const merged = {};
  Object.keys(pieces).forEach((part) => {
    const inverse = frameOf[part].clone().invert();
    const inPart = pieces[part].map(({ mesh, world }) => mesh.clone()
      .applyMatrix4(inverse.clone().multiply(world)));
    merged[part] = inPart.length ? mergeGeometries(inPart) : null;
  });
  // A lens's face is its model: a Cube a rectangle, a Cylinder a disc or an
  // oval, Length by Width; any other model as wide as its longer side. With
  // no model, a disc of the beam's stated radius. `radius` is the disc of the
  // same area, which the beam leaves.
  const shape = (rect, halfX, halfY, radius, out = 0) => ({
    rect, halfX, halfY, radius, out,
  });
  // The face is the model's outer side, half its height out along the beam.
  const faceOf = ({ model, beam }) => {
    if (model && model.length > 0) {
      const out = model.height > 0 ? model.height / 2 : 0;
      const halfX = model.length / 2;
      const halfY = (model.width > 0 ? model.width : model.length) / 2;
      if (model.primitiveType === 'Cube') {
        return shape(true, halfX, halfY, Math.sqrt((4 * halfX * halfY) / Math.PI), out);
      }
      if (model.primitiveType === 'Cylinder') {
        return shape(false, halfX, halfY, Math.sqrt(halfX * halfY), out);
      }
      const half = Math.max(halfX, halfY);
      return shape(false, half, half, half, out);
    }
    if (beam && beam.beamRadius > 0) {
      const r = beam.beamRadius;
      return shape(false, r, r, r);
    }
    return null;
  };
  const radiusOf = (lens) => {
    const face = faceOf(lens);
    return face ? face.radius : null;
  };
  const toHead = tiltWorld.clone().invert();
  const asLens = (lens) => ({
    frame: toHead.clone().multiply(lens.world),
    radius: radiusOf(lens),
    face: faceOf(lens),
    beam: lens.beam,
    path: lens.path,
  });
  const lenses = found.map(asLens);
  // Every beam under a top-level geometry, where the walk above finds them.
  const lensesIn = (top) => {
    const out = [];
    const walk = (g, parentWorld, path, at = null, modelName = null) => {
      const world = at ? at.clone() : parentWorld.clone().multiply(matrixOf(g.position));
      const here = [...path, g.name];
      const name = modelName || g.model;
      if (g.beam) {
        out.push({
          world, beam: g.beam, model: name ? type.index.model.get(name) : null, path: here,
        });
      }
      if (g.type === 'GeometryReference') {
        const template = type.index.geometry.get(g.geometry);
        if (template) walk(template, world, here, world, g.model);
      }
      g.children.forEach((kid) => walk(kid, world, here));
    };
    walk(top, new THREE.Matrix4(), []);
    return out.map(asLens);
  };
  const lensSets = still
    ? Object.fromEntries(type.geometries.map((top) => [top.name, lensesIn(top)]))
    : null;
  return {
    ...merged,
    yokeFrame: panWorld.clone(),
    headFrame: panWorld.clone().invert().multiply(tiltWorld),
    lensFrame: toHead.clone().multiply(lensWorld),
    lensRadius: main ? radiusOf(main) : null,
    lensFace: main ? faceOf(main) : null,
    lenses,
    lensSets,
  };
}
