import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * @file GDTF's primitive models as shapes, for a geometry whose Model names a
 * PrimitiveType and no mesh file.
 *
 * GDTF names the primitives and leaves their look to whoever draws them. Each
 * is built here in a one-metre box, in the file's hanging frame (Z up, the
 * light leaving along -Z), and fitted to the Model's Length (X), Width (Y)
 * and Height (Z) by the caller. Base and Conventional hang below their
 * suspension point, as a base hangs from its clamp; Yoke, Head and Scanner
 * are centred on it, which is where a file puts the pan and tilt pivots. The
 * `1_1` variants are the same shapes.
 */

const SEGMENTS = 32;

/** Positions and normals only, unindexed, so any two can be merged. */
function toNonIndexed(g) {
  const flat = g.index ? g.toNonIndexed() : g;
  const kept = new THREE.BufferGeometry();
  kept.setAttribute('position', flat.attributes.position);
  kept.setAttribute('normal', flat.attributes.normal);
  return kept;
}

/** A box with rounded edges, one metre a side unless told otherwise. */
const rounded = (x, y, z, radius) => new RoundedBoxGeometry(x, y, z, 3, radius);

/** A cylinder along Z. */
const along = (radius, height) => new THREE.CylinderGeometry(radius, radius, height, SEGMENTS)
  .rotateX(Math.PI / 2);

/** A low box with rounded edges, hanging from its top face. */
function base() {
  return rounded(1, 1, 1, 0.12).translate(0, 0, -0.5);
}

/**
 * A U: a crossbar at the top and an arm down each end in X, open where the
 * head hangs between them.
 */
function yoke() {
  const arm = 0.14;
  const bar = 0.2;
  return mergeGeometries([
    rounded(1, 1, bar, 0.06).translate(0, 0, 0.5 - bar / 2),
    rounded(arm, 1, 1, 0.05).translate(-0.5 + arm / 2, 0, 0),
    rounded(arm, 1, 1, 0.05).translate(0.5 - arm / 2, 0, 0),
  ]);
}

/** A drum along the beam, closed by a rounded back, its lens end at -Z. */
function head() {
  const back = new THREE.SphereGeometry(0.5, SEGMENTS, 12, 0, Math.PI * 2, 0, Math.PI / 2)
    .rotateX(Math.PI / 2)
    .scale(1, 1, 0.4)
    .translate(0, 0, 0.3);
  return mergeGeometries([along(0.5, 0.8).translate(0, 0, -0.1), back].map(toNonIndexed));
}

/**
 * A profile spot hanging from its clamp: the lamp housing at the top and a
 * narrower lens barrel below it, the light leaving at the bottom.
 */
function conventional() {
  return mergeGeometries([
    along(0.5, 0.45).translate(0, 0, -0.225),
    along(0.36, 0.55).translate(0, 0, -0.725),
  ].map(toNonIndexed));
}

/** A box with its mirror end rounded off. */
function scanner() {
  return rounded(1, 1, 1, 0.1);
}

/** A short cable along X. */
function pigtail() {
  return new THREE.CylinderGeometry(0.5, 0.5, 1, 12).rotateZ(Math.PI / 2);
}

const SHAPES = {
  Cube: () => new THREE.BoxGeometry(1, 1, 1),
  Cylinder: () => along(0.5, 1),
  Sphere: () => new THREE.SphereGeometry(0.5, SEGMENTS, 16),
  Base: base,
  Base1_1: base,
  Yoke: yoke,
  Head: head,
  Scanner: scanner,
  Scanner1_1: scanner,
  Conventional: conventional,
  Conventional1_1: conventional,
  Pigtail: pigtail,
};

/**
 * A primitive's shape at unit size, or null for one GDTF leaves undefined.
 *
 * @param {String} primitiveType the Model's PrimitiveType
 * @returns {THREE.BufferGeometry|null} positions and normals only
 */
export default function primitiveShape(primitiveType) {
  const build = SHAPES[primitiveType];
  return build ? toNonIndexed(build()) : null;
}
