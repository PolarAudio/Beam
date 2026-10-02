import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { TDSLoader } from 'three/examples/jsm/loaders/TDSLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { modelFiles } from '../../models/DMX/gdtf/gdtf_reader';

/**
 * @file A moving head's body from its GDTF file: the meshes the file carries,
 * cut into the three parts a head moves -- what stays still, what pans, what
 * tilts -- and the frames that join them.
 *
 * The file draws the fixture hanging, Z up, from the centre of the base
 * plate. Each geometry's Position places it relative to its parent, each mesh
 * is drawn around its own suspension point, and each is scaled to its
 * Model's Length (X), Width (Y) and Height (Z) whatever units it was drawn
 * in. A `.glb` is Y-up, as glTF is, and is turned onto Z first; a `.3ds` is
 * Z-up already.
 *
 * A geometry with no mesh file is drawn as its primitive: a cube, cylinder
 * or sphere as that shape; any other primitive as a box of its size hanging
 * from its suspension point. A light-emitting geometry's own model is left
 * out, because the head draws its lens itself.
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
  let g;
  switch (model.primitiveType) {
    case 'Undefined': case 'Pigtail': return null;
    case 'Cube': g = new THREE.BoxGeometry(1, 1, 1); break;
    case 'Cylinder': g = new THREE.CylinderGeometry(0.5, 0.5, 1, 24).rotateX(Math.PI / 2); break;
    case 'Sphere': g = new THREE.SphereGeometry(0.5, 16, 12); break;
    // Base, Yoke, Head, Scanner, Conventional: a box hanging from its
    // suspension point, the way the file draws those parts.
    default: g = new THREE.BoxGeometry(1, 1, 1).translate(0, 0, -0.5); break;
  }
  const kept = new THREE.BufferGeometry();
  const flat = g.toNonIndexed();
  kept.setAttribute('position', flat.attributes.position);
  kept.setAttribute('normal', flat.attributes.normal);
  return kept;
}

/**
 * A model's mesh, oriented Z-up and scaled to the Model's size about its own
 * origin, or null when there is nothing to draw.
 */
async function meshOf(model, files) {
  const found = modelFiles(files, model);
  let geometry = null;
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
  if (!geometry) geometry = primitiveOf(model);
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
  return geometry;
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
 * @returns {Promise<Object|null>} `{ base, yoke, head, yokeFrame, headFrame,
 *   lensFrame, lensRadius }`: three geometries, each in its own part's frame
 *   (null when the part has nothing to draw), the yoke's frame in the base's,
 *   the head's in the yoke's and the lens's in the head's, all in the file's
 *   hanging frame; null when the file has no meshes at all
 */
export default async function buildBody(type, files) {
  const root = type.geometries[0];
  if (!root) return null;
  const axes = axesOf(type);
  const placed = { base: [], yoke: [], head: [] };
  const worldOf = { pan: null, tilt: null, lens: null };
  let lensBeam = null;
  let lensModel = null;

  // Where every model sits and which part it moves with, walking the tree
  // once; the meshes are read after, each model once.
  const visit = (g, parentWorld, part) => {
    const world = parentWorld.clone().multiply(matrixOf(g.position));
    let here = part;
    if (g.name === axes.pan) { here = 'yoke'; worldOf.pan = world.clone(); }
    if (g.name === axes.tilt) { here = 'head'; worldOf.tilt = world.clone(); }
    if (g.beam && !worldOf.lens && here === 'head') {
      worldOf.lens = world.clone();
      lensBeam = g.beam;
      lensModel = g.model ? type.index.model.get(g.model) : null;
    }
    const model = g.model ? type.index.model.get(g.model) : null;
    if (model && !EMITTERS.has(g.type)) placed[here].push({ model, world });
    if (g.type === 'GeometryReference') {
      const template = type.index.geometry.get(g.geometry);
      if (template) template.children.forEach((kid) => visit(kid, world, here));
    }
    g.children.forEach((kid) => visit(kid, world, here));
  };
  visit(root, new THREE.Matrix4(), 'base');

  const models = [...new Set(Object.values(placed).flat().map((p) => p.model))];
  const loaded = await Promise.all(models.map((model) => meshOf(model, files)));
  const meshes = new Map(models.map((model, i) => [model, loaded[i]]));
  const pieces = {};
  Object.keys(placed).forEach((part) => {
    pieces[part] = placed[part]
      .filter((p) => meshes.get(p.model))
      .map((p) => ({ mesh: meshes.get(p.model), world: p.world }));
  });
  if (!pieces.base.length && !pieces.yoke.length && !pieces.head.length) return null;

  const identity = new THREE.Matrix4();
  const panWorld = worldOf.pan || identity;
  const tiltWorld = worldOf.tilt || panWorld;
  const lensWorld = worldOf.lens || tiltWorld;
  const frameOf = { base: identity, yoke: panWorld, head: tiltWorld };
  const merged = {};
  Object.keys(pieces).forEach((part) => {
    const inverse = frameOf[part].clone().invert();
    const inPart = pieces[part].map(({ mesh, world }) => mesh.clone()
      .applyMatrix4(inverse.clone().multiply(world)));
    merged[part] = inPart.length ? mergeGeometries(inPart) : null;
  });
  // The lens is as wide as its model, else the beam's stated radius.
  let lensRadius = null;
  if (lensModel && lensModel.length > 0) {
    lensRadius = Math.max(lensModel.length, lensModel.width) / 2;
  } else if (lensBeam && lensBeam.beamRadius > 0) {
    lensRadius = lensBeam.beamRadius;
  }
  return {
    ...merged,
    yokeFrame: panWorld.clone(),
    headFrame: panWorld.clone().invert().multiply(tiltWorld),
    lensFrame: tiltWorld.clone().invert().multiply(lensWorld),
    lensRadius,
  };
}
