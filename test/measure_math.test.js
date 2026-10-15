/* eslint-disable no-console */
/**
 * The measure tool's geometry: feature edges, nearest points, and what two
 * picked ends report.
 *
 * Usage:
 *   npm test
 */
import * as THREE from 'three';
import {
  featureEdges, closestOnSegment, closestOnLine, footOnPlane, closestOnLineToRay,
  lineAngle, angleAt, distanceBetween, formatLength, formatAngle,
} from '@/plugins/visualizer/measure_math';

let failures = 0;

function check(label, got, want) {
  const ok = Object.is(got, want);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(56)} `
    + `got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`,
  );
}

const r = (n, places = 6) => Math.round(n * 10 ** places) / 10 ** places;
const v = (x, y, z) => new THREE.Vector3(x, y, z);
const out = new THREE.Vector3();

console.log('-- feature edges --');
check(
  'a box has 12 edges, not its 18 triangle sides',
  featureEdges(new THREE.BoxGeometry(1, 1, 1)).length / 6,
  12,
);
const plane = new THREE.PlaneGeometry(1, 1, 4, 4);
check(
  'a flat plane split into 32 triangles keeps only its border',
  featureEdges(plane).length / 6,
  16,
);
check('worked out once per geometry', featureEdges(plane), featureEdges(plane));

console.log('-- nearest points --');
closestOnSegment(v(0.5, 1, 0), v(0, 0, 0), v(1, 0, 0), out);
check('segment: foot inside', [out.x, out.y, out.z].join(), '0.5,0,0');
closestOnSegment(v(3, 1, 0), v(0, 0, 0), v(1, 0, 0), out);
check('segment: clamped to the end', out.x, 1);
closestOnLine(v(3, 1, 0), v(0, 0, 0), v(1, 0, 0), out);
check('line: not clamped', out.x, 3);
footOnPlane(v(2, 3, 1.76), v(0, 0, 0.4), v(0, 0, 1), out);
check('plane: foot of a lens on a 0.4 m deck', [out.x, out.y, r(out.z)].join(), '2,3,0.4');

const ray = new THREE.Ray(v(5, -10, 2), v(0, 1, 0));
closestOnLineToRay(ray, v(0, 0, 0), v(1, 0, 0), out);
check('axis lock: x axis under a ray crossing x = 5', r(out.x), 5);
closestOnLineToRay(new THREE.Ray(v(0, 0, 5), v(1, 0, 0)), v(0, 0, 0), v(1, 0, 0), out);
check('axis lock: a ray along the axis keeps the start', out.x, 0);

console.log('-- angles --');
check('lines at 45 degrees', r(lineAngle(v(1, 0, 0), v(1, 1, 0).normalize()), 3), 45);
check('opposite arrows are the same line', r(lineAngle(v(1, 0, 0), v(-1, 0, 0)), 3), 0);
check('angle at a vertex', r(angleAt(v(1, 0, 0), v(0, 0, 0), v(0, 1, 0)), 3), 90);
check('angle with a zero arm', Number.isNaN(angleAt(v(0, 0, 0), v(0, 0, 0), v(1, 0, 0))), true);

console.log('-- two ends --');
const plain = distanceBetween({ point: v(0, 0, 0) }, { point: v(3, 4, 12) });
check('distance', r(plain.distance), 13);
check('horizontal', r(plain.horizontal), 5);
check('vertical keeps its sign', distanceBetween({ point: v(0, 0, 2) }, { point: v(0, 0, 0) }).vertical, -2);
check('no face, no perpendicular', plain.perpA, undefined);

const deck = { point: v(-1, -1, 0.4), normal: v(0, 0, 1) };
const lens = { point: v(1.55, -2.9, 1.76) };
check('face to point: perpendicular from the face', r(distanceBetween(deck, lens).perpA), 1.36);
check('point to face: perpendicular to the face', r(distanceBetween(lens, deck).perpB), 1.36);

const wall = { point: v(0, 3, 1), normal: v(0, -1, 0) };
const hedge = { point: v(2, 2.82, 0.3), normal: v(0, 1, 0) };
const parallel = distanceBetween(wall, hedge);
check('parallel faces: gap', r(parallel.gap), 0.18);
check('parallel faces: no angle', parallel.faceAngle, undefined);
const slope = THREE.MathUtils.degToRad(15);
const ramp = { point: v(0, 0, 0), normal: v(0, -Math.sin(slope), Math.cos(slope)) };
const tilted = distanceBetween({ point: v(0, 0, 0), normal: v(0, 0, 1) }, ramp);
check('faces at 15 degrees: angle', r(tilted.faceAngle, 3), 15);
check('faces at 15 degrees: no gap', tilted.gap, undefined);
const edges = distanceBetween(
  { point: v(0, 0, 0), dir: v(1, 0, 0) },
  { point: v(0, 1, 0), dir: v(1, 1, 0).normalize() },
);
check('two edges: angle', r(edges.edgeAngle, 3), 45);

console.log('-- writing --');
check('millimetres', formatLength(2.41649), '2.416 m');
check('whole metres keep three places', formatLength(3), '3.000 m');
check('tenths of a degree', formatAngle(37.46), '37.5°');

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
